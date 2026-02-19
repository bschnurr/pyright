# Type Evaluator: Modular Architecture (Work in Progress)

This document describes an incremental refactor of the monolithic evaluator implementation in
`packages/pyright-internal/src/analyzer/typeEvaluator.ts` into smaller, topic-focused modules.

Pyright historically implements the evaluator as a single large closure for performance reasons.
The goal of this refactor is to preserve behavior while making the codebase easier to navigate and
incrementally evolve.

## Guiding principles

- Keep the public surface stable: `createTypeEvaluator` and the `TypeEvaluator` interface should not change
  unless a deliberate cross-cutting refactor is planned.
- Avoid cycles at all costs. In particular:
  - `codeFlowEngine.ts` must not import `typeEvaluator.ts`.
  - Shared helper modules must not import the evaluator façade.
- Prefer passing a small context object to extracted modules over importing back into the evaluator.

## Invariant checklist (must hold for every extraction slice)

- **Public evaluator surface remains stable**
  - Keep `createTypeEvaluator` in `analyzer/typeEvaluator.ts` and the `TypeEvaluator` contract in
    `analyzer/typeEvaluatorTypes.ts` behavior-compatible across slices.
- **Type cache semantics remain unchanged**
  - Preserve the `readTypeCacheEntry` / `writeTypeCache` contract, including `incompleteGenCount` updates and
    flag consistency checks.
  - Keep the "write incomplete result before flow refinement" recursion guard behavior used by member/index access
    code-flow paths.
- **Speculative evaluation semantics remain unchanged**
  - Preserve `useSpeculativeMode` enter/leave pairing and keep speculative cache tracking behavior
    (`trackEntry`, optional `addSpeculativeType`) intact.
  - Diagnostic suppression behavior that depends on speculative mode must remain identical.
- **Symbol resolution ordering remains unchanged**
  - Preserve `lookUpSymbolRecursive` behavior for:
    - flow-reachability filtering of declarations,
    - class-scope fallback rules,
    - `preferGlobalScope` handling used for forward-reference contexts.
- **Diagnostics behavior remains unchanged**
  - Keep suppression stack semantics and reachability gating behavior as currently implemented in
    `typeEvaluator/diagnostics.ts`.
  - Continue honoring `@no_type_check` and unannotated-function suppression behaviors.
- **No new cycles**
  - `codeFlowEngine.ts` must remain independent of `typeEvaluator.ts`.
  - Extracted helper modules must consume context objects rather than importing evaluator internals.

## Current module layout

Extracted modules live under:

- `packages/pyright-internal/src/analyzer/typeEvaluator/`

### `diagnostics.ts`

Contains evaluator-specific diagnostics behavior that was formerly embedded in the evaluator closure:

- Suppression stack management (`suppressDiagnostics`)
- Emission helpers (`addDiagnostic`, `addInformation`, `addDeprecated`, `addUnreachableCode`)
- Suppression queries (`isDiagnosticSuppressedForNode`, `canSkipDiagnosticForNode`)

This module accepts a `DiagnosticsContext` so it can operate without importing the evaluator.

## Progress tracking

- Completed:
  - `diagnostics.ts` extraction.
  - `flowAnalysis.ts` helpers (flow graph delegators, constrained typevar narrowing, `printControlFlowGraph`).
  - `narrowing.ts` helpers for assignment-based narrowing, literal/type-guard stripping, truthiness handling (including direct-reference and `not` matching), `None`/ellipsis comparisons, class/literal equality comparisons (including equality matchers), discriminated equality helpers (tuple/dict/member), tuple length/containment/TypedDict-key narrowing, len(x) and `in`-operator comparison matching, call-expression matching for isinstance/issubclass, bool, and TypeGuard/TypeIs, literal enumeration, `type(x) is y` matching/narrowing, `X is <literal/class>` matching, indexed-literal and member-access discriminated matching, isinstance/issubclass narrowing (including class-type parsing and name-scope checks), aliased-condition and assignment-expression narrowing, and user-defined TypeGuard/TypeIs narrowing.
  - `evaluatorCore.ts` extraction (89 exported functions, ~2,688 lines):
    - **Phase 2** (pure helpers, no closure deps): Return-type-inference context stack (7), symbol resolution stack (5), declaration helpers (3), type alias helpers (4), type checking helpers (3), utility helpers (12), `expandTypedKwargsForFunction`, `setConstraintsForFreeTypeVarsInType`.
    - **Phase 3a** (prefetched context injection): Prefetched type accessors (8), `parseStringAsTypeAnnotationNode`, `convertSpecialFormToRuntimeValueWithPrefetched`.
    - **Phase 3b** (`AddDiagnosticFn` callback injection): 20 functions including `createSpecialTypeFromArgs`, `createCallableTypeFromArgs`, `createAnnotatedTypeFromArgs`, `createOptionalTypeFromArgs`, `createTypeFormTypeFromArgs`, `createTypeGuardTypeFromArgs`, `createUnionTypeFromArgs`.
    - **Phase 4** (`TypeEvaluator` param injection): 22 functions including `adjustTypeArgsForTypeVarTuple` (144), `transformTypeForTypeAlias` (125), `isTypeComparable` (129), `adjustSourceParamDetailsForDestVariadic` (97), `createRequiredOrReadOnlyType` (96), `getTypeOfExpressionExpectingType` (82), `computeEffectiveMetaclass` (63), `isUnambiguousInference` (59), `convertToTypeFormType` (51), `assignConditionalTypeToTypeVar` (66), `createSubclass` (49), `isTypeHashable` (45), `isProperSubtype` (39), `isOverrideMethodApplicable` (37), `expandPromotionTypes` (34), `assignRecursiveTypeAliasToSelf` (34), `getTypeOfSlice` (41), `transformVariadicParamType` (41), `getTypeOfYieldFrom` (30), `isPossibleTypeDictFactoryCall` (32), `validateTypeIsInstantiable` (45), `reportPossibleUnknownAssignment` (43).
- Current state:
  - `typeEvaluator.ts` reduced from ~28,000 to ~22,410 lines (~5,590 lines extracted or removed).
  - Phase 4 extraction is effectively complete — all remaining ~300 functions depend on deep closure state (`writeTypeCache`, `readTypeCache`, `speculativeTypeTracker`, `codeFlowEngine`, `evaluatorOptions`, etc.) or call multiple inner functions that themselves depend on closure state.
  - Further extraction would require broader architectural changes (e.g., class-based refactor or extensive callback interfaces).

## Planned breakdown (future slices)

- `evaluatorCore.ts` — main entrypoints (e.g. `getTypeOfExpression`, `getTypeOfExpressionCore`)
- `narrowing.ts` — `isinstance` / truthiness / equality narrowing (truthiness, equality, isinstance, and user-defined TypeGuard/TypeIs extracted)
- `flowAnalysis.ts` — flow graph traversal hooks (delegating to `codeFlowEngine.ts`)
- `symbolScope.ts` — symbol lookup by scope (e.g. `lookUpSymbolRecursive`)
- `expressionVisitors.ts` — per-expression-node handling (Name, Attribute, Call, Await, ...)
- `statementVisitors.ts` — per-statement handling (assignment, if, match, try, loops)
- `patternMatching.ts` — evaluator glue around existing `analyzer/patternMatching.ts`
- `typeEvaluatorIndex.ts` — factory/build + exports (entry point; can merge with API if both become wiring)
- `typeEvaluatorAPI.ts` — public interface type + thin wrapper (optional; merge into Index if redundant)

### Recommended extraction order

1. `evaluatorCore.ts` (entrypoint logic and cache-adjacent orchestration, no behavior changes)
2. `symbolScope.ts` (`lookUpSymbolRecursive` and closely-related symbol-resolution helpers)
3. `expressionVisitors.ts` (node-specific expression handlers, preserving `EvalFlags` behavior)
4. `statementVisitors.ts` (statement evaluators and assignment/delete pathways)
5. `patternMatching.ts` (glue around `analyzer/patternMatching.ts`)
6. `typeEvaluatorIndex.ts` (final factory assembly and exports)

### Intended dependency diagram

```
typeEvaluatorIndex.ts  (factory / entry point)
  └── typeEvaluator.ts  (closure: state, caches, core dispatch)
        ├── evaluatorCore.ts       (extracted helpers, no state ownership)
        ├── expressionVisitors.ts  (calls core, never calls other visitors)
        ├── statementVisitors.ts   (calls core, never calls other visitors)
        ├── symbolScope.ts         (calls core for state, pure lookups)
        ├── narrowing.ts           (library: called BY core, never calls back into visitors)
        ├── flowAnalysis.ts        (library: called BY core, delegates to codeFlowEngine)
        ├── patternMatching.ts     (library: called BY core)
        └── diagnostics.ts         (library: accepts DiagnosticsContext)
```

**Rules to prevent cycles:**
- Visitors call core methods, **not each other directly**.
- `narrowing` and `flowAnalysis` are "libraries" called by core — they never call back into visitors.
- If callbacks are needed, use a tiny interface with a fixed set of functions, not a big dependency bag.
- All state (caches, scope, config, recursion guards, speculative contexts) stays in `typeEvaluator.ts` (the closure) or a single `context.ts` — never split across multiple modules.

## V8 / performance guardrails

These constraints apply to any deeper refactoring beyond the current Phase 4 extractions.

### 1. Keep hot dispatch as switch statements

`getTypeOfExpressionCore` uses a big `switch (node.nodeType)`. **Keep it as a switch** — do NOT
convert to a megamorphic handler map (`{ [kind]: fn }`) which creates polymorphic call sites in V8.

```ts
// GOOD: static dispatch, monomorphic call sites
switch (node.nodeType) {
    case ParseNodeType.Name: return getTypeOfName(node);
    case ParseNodeType.Call: return getTypeOfCall(node);
    ...
}

// BAD: megamorphic, polymorphic call sites
const handlers = { [ParseNodeType.Name]: getTypeOfName, ... };
return handlers[node.nodeType](node);  // V8 can't optimize this
```

Even if `getTypeOfName` lives in `expressionVisitors.ts`, the dispatch switch must call it
directly. The 5–10 most common expression cases (Name, Attribute, Call, MemberAccess, Index,
Await) must remain monomorphic call sites.

### 2. Avoid "component object soup"

Do NOT create lots of "bags of functions" passed around as loosely-typed dependency objects —
this causes shape churn in V8's hidden classes.

```ts
// BAD: shape churn, new object per call
visitExpression(node, { getType, assignType, addDiag, printType, ... });

// GOOD: single stable object, constructed once
const evaluator = createTypeEvaluator(importLookup, ...);
// Pass 'evaluator' (or 'this') everywhere — one stable shape
```

Construct **one stable evaluator object** with all fields initialized once. Pass around a single
`ctx` object (or `this`) rather than multiple loosely-typed dependency objects.

### 3. Keep state & caches centralized

All evaluator state (caches, scope, config flags, recursion guards, speculative contexts) must live
in one place. Do NOT split state across 9 modules where each owns partial state and cross-calls
with "options objects."

The current closure variables (`writeTypeCache`, `readTypeCache`, `speculativeTypeTracker`,
`symbolResolutionStack`, etc.) enforce this naturally. A class-based refactor must preserve this
centralization.

### 4. Hot-path allocation guardrails

- Avoid allocating closures or arrays in tight loops (especially in `doForEachSubtype`,
  `mapSubtypes`, `assignType` recursion).
- Avoid handler maps/dictionaries for dispatch in hot code — use `switch` statements.
- Keep call sites monomorphic: call functions directly, don't route through generic dispatchers.
- When re-checking hotspots after deeper extraction, the usual suspects to "keep close" are:
  - `getTypeOfExpressionCore` + the 5–10 most common expression cases
  - Narrowing entrypoints used constantly during expression typing
  - Union combine/simplify helpers if they're hammered

### Verification gate for each extraction slice

Run these checks for every slice before moving to the next:

1. `cd packages/pyright-internal && npm run webpack:testserver`
2. `cd packages/pyright-internal && npm run test:norebuild -- fourSlashRunner.test`
3. `cd packages/pyright-internal && npm run test:norebuild -- importResolver.test`
4. `cd packages/pyright-internal && npm test`
5. `npm run typecheck`

If a slice changes semantics (diagnostics, narrowing, recursion behavior, or cache behavior), revert that slice and
re-apply with smaller extraction boundaries.

## Established context-injection patterns

When extracting functions from the evaluator closure, two patterns have been validated:

### 1. Prefetched type context

For functions that access `prefetched` (pre-resolved built-in class types), pass
`prefetched: Partial<PrefetchedTypes> | undefined` as a parameter:

```ts
// In evaluatorCore.ts
export function getTypedDictClassTypeFromPrefetched(
    prefetched: Partial<PrefetchedTypes> | undefined
): ClassType | undefined { ... }

// In typeEvaluator.ts (delegate)
function getTypedDictClassType(): ClassType | undefined {
    return TypeEvaluatorCore.getTypedDictClassTypeFromPrefetched(prefetched);
}
```

### 2. `AddDiagnosticFn` callback injection

For functions whose only closure dependency is `addDiagnostic`, pass a callback:

```ts
// In evaluatorCore.ts
export type AddDiagnosticFn = (
    rule: DiagnosticRule, message: string, node: ParseNode, range?: TextRange
) => Diagnostic | undefined;

export function createFinalTypeFromArgs(
    classType: ClassType, errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags, addDiagnosticFn: AddDiagnosticFn
): Type { ... }

// In typeEvaluator.ts (delegate)
function createFinalType(...): Type {
    return TypeEvaluatorCore.createFinalTypeFromArgs(
        classType, errorNode, typeArgs, flags, addDiagnostic
    );
}
```

This pattern cascades: extracting one function can unlock others that call it (e.g.,
`createSpecialType` unlocked `createConcatenateType` and `createGenericType`).

### 3. `TypeEvaluator` param injection (Phase 4)

For functions that need multiple closure functions (e.g., `getTypingType`, `getTypeOfClass`,
`printType`, `addDiagnostic`), pass the `TypeEvaluator` interface directly. Since
`evaluatorInterface` already implements `TypeEvaluator`, this is a natural fit:

```ts
// In evaluatorCore.ts
export function adjustTypeArgsForTypeVarTupleWithEvaluator(
    evaluator: TypeEvaluator,
    typeArgs: TypeResultWithNode[],
    typeParams: TypeVarType[],
    errorNode: ExpressionNode
): TypeResultWithNode[] { ... }

// In typeEvaluator.ts (delegate)
function adjustTypeArgsForTypeVarTuple(...): TypeResultWithNode[] {
    return TypeEvaluatorCore.adjustTypeArgsForTypeVarTupleWithEvaluator(
        evaluatorInterface, typeArgs, typeParams, errorNode
    );
}
```

This pattern unlocks ~50+ functions whose deps are entirely satisfied by `TypeEvaluator` methods.

## Notes on narrowing and code flow

Narrowing and code flow analysis already have dedicated subsystems:

- `packages/pyright-internal/src/analyzer/typeGuards.ts`
- `packages/pyright-internal/src/analyzer/codeFlowEngine.ts`

The evaluator should treat these as core dependencies and provide thin, well-documented hooks.
When adding explanatory placeholder logic (for learning/architecture documentation), prefer comments
near these hooks rather than re-implementing the narrowing or flow engine in the evaluator.

## Future performance improvement ideas

Observations captured during the refactoring process. All items should be profiled and benchmarked before implementation — no premature optimization.

### Type evaluator / caching

- **`writeTypeCache` / `readTypeCache` hot path**: The most heavily called closure functions. Profile whether the current `Map`-based cache has significant overhead for very large projects; consider whether a `WeakMap` keyed on parse nodes could reduce GC pressure.
- **Speculative evaluation cost**: `useSpeculativeMode` / `isSpeculativeModeInUse` wrap many call sites. Investigate whether speculative evaluation is triggered unnecessarily in cases where the result is never used (e.g., abandoned overload candidates).
- **`makeTopLevelTypeVarsConcrete` redundant calls**: Called repeatedly on the same type in many code paths. Consider memoizing results or adding an "already concretized" flag to `TypeBase`.
- **`assignType` recursion depth**: Deep class hierarchies and generic types can cause deep recursion. Profile whether iterative approaches or early bailouts for common cases (e.g., same-class assignment) would help.
- **`typePromotions` map lookups**: Currently a small static map (3 entries), checked on every `expandPromotionTypes` call. If this ever becomes a bottleneck, could be replaced with a flag on `ClassType.shared`.

### Broader Pyright performance

- **Incremental re-analysis granularity**: Currently file-level. Investigate whether function-level or scope-level incremental analysis is feasible for large files.
- **Import resolution caching**: Profile whether import resolution (`importResolver`) is doing redundant work across files in the same package.
- **Diagnostic string formatting**: `LocMessage.*.format()` allocates strings eagerly. Consider lazy formatting (only format when the diagnostic is actually emitted/displayed).
- **`doForEachSubtype` / `mapSubtypes` allocation**: These create closures and intermediate arrays on every call. For hot paths, consider providing a reusable-buffer variant.
- **Parse tree node allocation**: Large files create millions of parse nodes. Investigate whether a flyweight or arena-based allocator would reduce GC overhead.

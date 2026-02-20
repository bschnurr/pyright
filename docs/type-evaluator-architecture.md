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

Extracted modules live under `packages/pyright-internal/src/analyzer/typeEvaluator/`:

### `pureHelpers.ts` (45 lines)
Stateless utility functions shared across modules with no TypeEvaluator dependency:
- `isTypeFormSupportedForNode` — checks if experimental TypeForm features are enabled
- `applyUnpackToTupleLikeType` — applies unpack to tuple-like types

### `specialFormCreation.ts` (1,474 lines)
Special form type creation functions (originally `AddDiagnosticFn`-injected):
- `createXxxFromArgs` functions: ClassVar, Final, Annotated, Callable, Optional, TypeForm, TypeGuard, Unpack, Concatenate, Generic, Union, Required/ReadOnly
- Validation helpers: `validateTypeVarTupleIsUnpackedCheck`, `validateTypeArgCheck`, `transformTypeArgsForParamSpecCheck`, `verifyGenericTypeParamsCheck`, `validateTypeParamDefaultCheck`, `validateAnnotatedMetadataCheck`
- Type alias transforms: `adjustTypeArgsForTypeVarTupleWithEvaluator`, `transformTypeForTypeAliasWithEvaluator`, `adjustSourceParamDetailsForDestVariadicWithEvaluator`
- Utility: `getBooleanValueFromNode`, `reportUseOfTypeCheckOnlySymbol`, `enforceClassTypeVarScopeCheck`

### `evaluatorCore.ts` (~7,483 lines)
Core evaluation logic — re-exports functions from `specialFormCreation.ts` and `pureHelpers.ts` so the `TypeEvaluatorCore.*` import namespace in `typeEvaluator.ts` continues to work. Contains:
- Expression type evaluation (~2,200 lines): getTypeOfSuperCall, getDeclaredTypeForExpression, createSpecializedClassType, getTypeOfIterator, etc.
- TypeVar/type form handling, type comparisons, member access, symbol resolution
- Miscellaneous helpers and validation

### `collectionInference.ts` (~1,037 lines)
Collection type inference functions for dictionaries, lists, sets, comprehensions, and strings:
- Dictionary: getKeyAndValueTypesFromDictionary, getTypeOfDictionaryWithContext, getTypeOfDictionaryInferred
- List/Set: getTypeOfListOrSetWithContext, getTypeOfListOrSetInferred, getExpectedEntryTypeForIterable
- Comprehension: getElementTypeFromComprehension
- String: getTypeOfStringList, getTypeOfComprehension
- Imported from `typeEvaluator.ts` via dual-import pattern (`CollectionInference.*`)

### `assignFunctions.ts` (~1,843 lines)
All type assignment/compatibility logic:
- `assignFunctionWithEvaluator` (~850 lines) — function-to-function type assignment
- `assignFromUnionTypeWithEvaluator` (~274 lines) — union source assignment
- `assignToUnionTypeWithEvaluator` (~191 lines) — union destination assignment
- `assignClassWithEvaluator` (~177 lines) — class-to-class assignment
- `assignClassWithTypeArgsWithEvaluator` (~127 lines) — class type args assignment
- `assignParamWithEvaluator` (~83 lines) — parameter-level assignment
- `assignConditionalTypeToTypeVarWithEvaluator` (~71 lines)
- `assignRecursiveTypeAliasToSelfWithEvaluator` (~36 lines)
- Local helper `getEffectiveReturnTypeForAssign`
- Zero dependencies on evaluatorCore — cleanest module extraction
- Imported from `typeEvaluator.ts` via dual-import pattern (`AssignFunctions.*`)

### `overrideValidation.ts` (~603 lines)
Override method validation logic:
- `validateOverrideMethodWithEvaluator` (~136 lines) — entry point for override validation
- `validateOverrideMethodInternalWithEvaluator` (~412 lines) — detailed override checking
- `isOverrideMethodApplicableWithEvaluator` (~40 lines) — applicability check
- Zero internal callers in evaluatorCore — leaf functions
- Imported from `typeEvaluator.ts` via dual-import pattern (`OverrideValidation.*`)

### `diagnostics.ts`
Contains evaluator-specific diagnostics behavior that was formerly embedded in the evaluator closure:
- Suppression stack management (`suppressDiagnostics`)
- Emission helpers (`addDiagnostic`, `addInformation`, `addDeprecated`, `addUnreachableCode`)
- Suppression queries (`isDiagnosticSuppressedForNode`, `canSkipDiagnosticForNode`)

### `narrowing.ts`
Type narrowing: isinstance/truthiness/equality narrowing, TypeGuard/TypeIs, discriminated unions, etc.

### `flowAnalysis.ts`
Flow graph traversal hooks (delegating to `codeFlowEngine.ts`).

### Dependency diagram (current)
```
typeEvaluator.ts  (17,415 lines — closure: state, caches, core dispatch)
  ├── import * as TypeEvaluatorCore from './typeEvaluator/evaluatorCore'
  ├── import * as CollectionInference from './typeEvaluator/collectionInference'
  ├── import * as AssignFunctions from './typeEvaluator/assignFunctions'
  └── import * as OverrideValidation from './typeEvaluator/overrideValidation'
        evaluatorCore.ts (~7,483 lines)
          ├── imports from specialFormCreation.ts (internal use)
          ├── imports from pureHelpers.ts (internal use)
          ├── re-exports specialFormCreation.ts (external visibility)
          └── re-exports pureHelpers.ts (external visibility)
        collectionInference.ts (~1,037 lines)
          ├── imports from evaluatorCore.ts (one-way, no cycle)
          └── imports from pureHelpers.ts
        assignFunctions.ts (~1,843 lines)
          ├── imports from specialFormCreation.ts
          └── imports from evaluatorCore.ts (typePromotions constant only)
        overrideValidation.ts (~603 lines)
          └── no evaluatorCore imports (fully independent)
        specialFormCreation.ts (1,474 lines)
          └── imports from pureHelpers.ts
        pureHelpers.ts (45 lines)
          └── no evaluator dependencies
        narrowing.ts (library: called BY core)
        flowAnalysis.ts (library: called BY core)
        diagnostics.ts (library: accepts DiagnosticsContext)
```

No circular dependencies. Dual-import pattern used for `collectionInference.ts`, `assignFunctions.ts`,
and `overrideValidation.ts` to avoid cycles.

## Progress tracking

- **Phase 1**: Invariant checklist documented.
- **Phase 2**: Pure helpers extraction (34 functions, ~550 lines).
- **Phase 3a**: Prefetched context injection (10 functions).
- **Phase 3b**: AddDiagnosticFn injection (20 functions).
- **Phase 4**: TypeEvaluator param injection (22 functions).
- **Phase 5**: Deeper extraction with context patterns (19 functions, ~2,900 lines).
- **Phase 6**: Interface-method extraction (100+ functions, ~6,000+ lines across 17 batches).
- **Phase 7**: Module splitting — `evaluatorCore.ts` split into topic-focused modules:
  - `specialFormCreation.ts` (1,474 lines) — special form type creation
  - `pureHelpers.ts` (45 lines) — stateless shared utilities
  - `collectionInference.ts` (~1,037 lines) — list/set/dict/comprehension inference (dual-import pattern)
  - `assignFunctions.ts` (~1,843 lines) — all type assignment/compatibility logic (dual-import pattern)
  - `overrideValidation.ts` (~603 lines) — override method validation (dual-import pattern)
- Current state:
  - `typeEvaluator.ts`: **17,415 lines** (down from ~28,000, **38% reduction**)
  - `evaluatorCore.ts`: **~7,483 lines** (core evaluation, member access, TypeVar handling)
  - `assignFunctions.ts`: **~1,843 lines**
  - `specialFormCreation.ts`: **1,474 lines**
  - `collectionInference.ts`: **~1,037 lines**
  - `overrideValidation.ts`: **~603 lines**
  - `pureHelpers.ts`: **45 lines**
  - **200+ functions** delegated from typeEvaluator.ts to modules
  - All **2,323 tests** passing, typecheck clean
  - **Remaining ~150 non-delegated functions** blocked by closure variables (see architecture decisions below)
  - **Next module split candidates**: expression type evaluation, TypeVar/type form handling, member resolution

## Planned breakdown (future slices)

### Near-term: Further module splitting of evaluatorCore.ts
Split the remaining 10,883-line evaluatorCore.ts into topic-focused modules (same re-export pattern):
- `assignmentLogic.ts` (~2,800 lines) — `assignFunction`, `assignClass`, `assignParam`, `assignFromUnionType`, `assignToUnionType`, `assignClassWithTypeArgs`, etc.
- `collectionInference.ts` (~2,100 lines) — list/set/dict/comprehension type inference functions
- `memberAccess.ts` (~2,200 lines) — `getTypeOfSuperCall`, `getDeclaredTypeForExpression`, `createSpecializedClassType`, `getTypeOfIterator`, etc.
- `evaluatorCore.ts` (~3,800 lines) — remaining core functions, re-exports

### Medium-term: Closure variable barrier
The remaining ~150 functions in typeEvaluator.ts are blocked by closure variables. Options:
- **Option A: TypeEvaluatorContext class** — bundle all closure state into a class
- **Option B: Expand TypeEvaluator interface** — add missing state accessors
- **Option C: Internal EvaluatorState object** — non-exported context bundle

### Long-term: Full visitor architecture
- `expressionVisitors.ts` — per-expression-node handling (Name, Attribute, Call, Await, ...)
- `statementVisitors.ts` — per-statement handling (assignment, if, match, try, loops)
- `patternMatching.ts` — evaluator glue around existing `analyzer/patternMatching.ts`
- `typeEvaluatorIndex.ts` — factory/build + exports

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

### Current baseline audit (verified)

- ✅ **Dispatch pattern**: `getTypeOfExpressionCore` uses a pure `switch (node.nodeType)` with direct function calls for all ~27 expression types. No handler maps or dynamic dispatch.
- ✅ **Object shape stability**: `evaluatorInterface` is constructed as a single object literal (~110 properties) with zero post-construction mutations. Stable V8 hidden class.
- ✅ **No import cycles**: `typeEvaluator.ts` → `typeEvaluator/` subdirectory (one-way). Subdirectory modules import `typeEvaluatorTypes.ts` only. `codeFlowEngine.ts` imports `typeEvaluatorTypes.ts` only — no back-imports into `typeEvaluator.ts`.
- ✅ **Centralized state**: All mutable state (`typeCache`, `speculativeTypeTracker`, `symbolResolutionStack`, `returnTypeInferenceContextStack`, `evaluatorOptions`, `prefetched`, `codeFlowEngine`) lives in the `createTypeEvaluator` closure — not split across modules.

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

- **`writeTypeCache` / `readTypeCache` hot path**: ✅ Investigated. Cache uses `Map<number, CacheEntry>` keyed by `node.id` — V8 optimizes integer-keyed Maps very well. Each write allocates a small `{typeResult, flags, incompleteGenCount}` object. `WeakMap` not applicable since keys are numeric IDs. No obvious optimization without changing cache semantics.
- **Speculative evaluation cost**: ✅ Investigated. 18 `useSpeculativeMode` call sites + 14 `isSpeculativeModeInUse` checks. Each call allocates a closure and enters/leaves a speculative context (try/finally). Triggered for overload resolution, lambda typing, and string annotation parsing. All call sites properly guard with `speculativeNode` check — no evidence of unnecessary triggering. Not actionable without workload-specific benchmarking.
- **`makeTopLevelTypeVarsConcrete` redundant calls**: ✅ Investigated. 88 call sites across the analyzer. For non-TypeVar, non-Union types (the common case), the function is a no-op but still allocates a `mapSubtypes` closure and iterates. **Potential optimization**: add an early-return guard (`if (type.category !== TypeCategory.TypeVar && !isUnion(type)) return type;`) after `transformPossibleRecursiveTypeAlias`. Needs benchmarking to confirm impact.
- **`assignType` recursion depth**: ✅ Investigated. Already uses `recursionCount` parameter with `maxTypeRecursionCount` bailout. Has early-exit for same-object types without TypeVars (line 22116). ~206 call sites. No actionable optimization without benchmarking deep-hierarchy workloads.
- **`typePromotions` map lookups**: Currently a small static map (3 entries), checked on every `expandPromotionTypes` call. If this ever becomes a bottleneck, could be replaced with a flag on `ClassType.shared`.

### Broader Pyright performance

- **Incremental re-analysis granularity**: ✅ Investigated. Currently file-level (`markDirty()` clears all analysis state, `_markFileDirtyRecursive` propagates to importers). Function/scope-level incremental analysis would require tracking per-function type dependencies and invalidation — a major architectural change beyond current scope.
- **Import resolution caching**: Profile whether import resolution (`importResolver`) is doing redundant work across files in the same package.
- **Diagnostic string formatting**: ✅ Investigated. 274 `LocMessage` uses and 197 `.format()` calls in typeEvaluator.ts. `addDiagnostic` suppresses output when `diagLevel === 'none'` or in unannotated functions — all `.format()` allocations before the call are wasted in those cases. **Potential optimization**: lazy formatting (pass format args, defer `.format()` until diagnostic is actually emitted). Moderate effort (~274 call sites to update).
- **`doForEachSubtype` / `mapSubtypes` allocation**: ✅ Investigated. `mapSubtypes` is already well-optimized — avoids memory allocations until a change is detected (lazy slicing on first mismatch). `doForEachSubtype` allocates `[type]` array for non-union types on every call (~75 call sites). Main unavoidable overhead is callback closure allocation at call sites (~139 combined). Low priority — V8 optimizes short-lived closures well.
- **Parse tree node allocation**: Large files create millions of parse nodes. Investigate whether a flyweight or arena-based allocator would reduce GC overhead.

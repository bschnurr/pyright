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
  - `evaluatorCore.ts` extraction (73 exported functions, ~1,956 lines):
    - **Phase 2** (pure helpers, no closure deps): Return-type-inference context stack (7), symbol resolution stack (5), declaration helpers (3), type alias helpers (4), type checking helpers (3), utility helpers (12), `expandTypedKwargsForFunction`, `setConstraintsForFreeTypeVarsInType`.
    - **Phase 3a** (prefetched context injection): Prefetched type accessors (8), `parseStringAsTypeAnnotationNode`, `convertSpecialFormToRuntimeValueWithPrefetched`.
    - **Phase 3b** (`AddDiagnosticFn` callback injection): 20 functions including `createSpecialTypeFromArgs`, `createCallableTypeFromArgs`, `createAnnotatedTypeFromArgs`, `createOptionalTypeFromArgs`, `createTypeFormTypeFromArgs`, `createTypeGuardTypeFromArgs`, `createUnionTypeFromArgs`.
    - **Phase 4** (`TypeEvaluator` param injection): `adjustTypeArgsForTypeVarTupleWithEvaluator` (144 lines), `transformTypeForTypeAliasWithEvaluator` (125 lines), `adjustSourceParamDetailsForDestVariadicWithEvaluator` (97 lines), `createRequiredOrReadOnlyTypeFromArgs` (96 lines), `validateTypeIsInstantiableWithEvaluator` (45 lines), `reportPossibleUnknownAssignmentWithEvaluator` (43 lines).
- Current state:
  - `typeEvaluator.ts` reduced from ~28,000 to ~23,049 lines (~4,951 lines extracted or removed).
  - Phase 4 established: pass `TypeEvaluator` interface to unlock functions needing `getTypeOfClass`, `getTypingType`, `printType`, `makeTupleObject`, etc.
  - ~50 additional functions identified as Phase 4 candidates (functions with deps exclusively on TypeEvaluator interface methods).

## Planned breakdown (future slices)

- `evaluatorCore.ts` — main entrypoints (e.g. `getTypeOfExpression`, `getTypeOfExpressionCore`)
- `narrowing.ts` — `isinstance` / truthiness / equality narrowing (truthiness, equality, isinstance, and user-defined TypeGuard/TypeIs extracted)
- `flowAnalysis.ts` — flow graph traversal hooks (delegating to `codeFlowEngine.ts`)
- `symbolScope.ts` — symbol lookup by scope (e.g. `lookUpSymbolRecursive`)
- `expressionVisitors.ts` — per-expression-node handling (Name, Attribute, Call, Await, ...)
- `statementVisitors.ts` — per-statement handling (assignment, if, match, try, loops)
- `patternMatching.ts` — evaluator glue around existing `analyzer/patternMatching.ts`
- `typeEvaluatorAPI.ts` — centralized construction of the exported `TypeEvaluator` object
- `typeEvaluatorIndex.ts` — wiring / factory entry that builds the evaluator from all components

### Recommended extraction order

1. `evaluatorCore.ts` (entrypoint logic and cache-adjacent orchestration, no behavior changes)
2. `symbolScope.ts` (`lookUpSymbolRecursive` and closely-related symbol-resolution helpers)
3. `expressionVisitors.ts` (node-specific expression handlers, preserving `EvalFlags` behavior)
4. `statementVisitors.ts` (statement evaluators and assignment/delete pathways)
5. `patternMatching.ts` (glue around `analyzer/patternMatching.ts`)
6. `typeEvaluatorAPI.ts` then `typeEvaluatorIndex.ts` (final API assembly and wiring split)

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

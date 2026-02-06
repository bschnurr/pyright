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
  - `narrowing.ts` helpers for assignment-based narrowing, literal/type-guard stripping, truthiness handling, `None`/ellipsis comparisons, class/literal equality comparisons, discriminated equality helpers (tuple/dict/member), tuple length/containment/TypedDict-key narrowing, literal enumeration, `type(x) is y` narrowing, isinstance/issubclass narrowing (including class-type parsing and name-scope checks), and user-defined TypeGuard/TypeIs narrowing.
- In progress:
  - None.

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

## Notes on narrowing and code flow

Narrowing and code flow analysis already have dedicated subsystems:

- `packages/pyright-internal/src/analyzer/typeGuards.ts`
- `packages/pyright-internal/src/analyzer/codeFlowEngine.ts`

The evaluator should treat these as core dependencies and provide thin, well-documented hooks.
When adding explanatory placeholder logic (for learning/architecture documentation), prefer comments
near these hooks rather than re-implementing the narrowing or flow engine in the evaluator.

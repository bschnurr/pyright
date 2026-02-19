# Copilot Instructions for Pyright

## Build, test, and lint commands

- Install all workspace dependencies from repo root:
  - `npm run install:all`
- Type-check all TypeScript packages:
  - `npm run typecheck`
- Run style/lint checks used by CI:
  - `npm run check`
- Run the full internal test suite:
  - `cd packages/pyright-internal && npm test`
- Run import resolver tests (used in CI with Python env variants):
  - `cd packages/pyright-internal && npm run test:imports`
- Run one test file without rebuilding testserver bundle:
  - `cd packages/pyright-internal && npm run webpack:testserver && npm run test:norebuild -- importResolver.test`
- Build CLI package:
  - `cd packages/pyright && npm run build`
- Build VS Code extension package:
  - `cd packages/vscode-pyright && npm run package`

## High-level architecture

- This is a lerna-managed monorepo (`packages/*`) with three key packages:
  - `packages/pyright-internal`: core analyzer, parser, language server, and tests.
  - `packages/pyright`: thin CLI wrapper package that delegates to `pyright-internal`.
  - `packages/vscode-pyright`: VS Code extension client that starts and communicates with the language server.
- Core analysis pipeline in `pyright-internal` is staged:
  - tokenizer -> parser -> binder (scopes + reverse code flow graph) -> checker/type evaluator.
- Runtime model:
  - `AnalyzerService` owns a `Program`; `Program` manages `SourceFile` instances, file watching, import closure, and analysis prioritization.
  - `ImportResolver` is shared infrastructure used during analysis for module resolution.
- Entry points:
  - CLI entry: `packages/pyright-internal/src/pyright.ts`
  - LSP server entry: `packages/pyright-internal/src/server.ts`
  - VS Code client entry: `packages/vscode-pyright/src/extension.ts`

## Key conventions for this repository

- Preserve documented external contracts in CLI code (`packages/pyright-internal/src/pyright.ts`), especially exit statuses and JSON output schemas marked as publicly documented.
- CI conventions are authoritative for validation: run install, typecheck, style checks, and `packages/pyright-internal` tests; CI also checks that install does not introduce unexpected file diffs.
- For ongoing type evaluator modularization work (`docs/type-evaluator-architecture.md`):
  - Keep `createTypeEvaluator` and `TypeEvaluator` public surface stable unless intentionally planned.
  - Avoid import cycles (especially around `typeEvaluator.ts` and `codeFlowEngine.ts`).
  - Prefer context-object injection between extracted modules rather than back-importing evaluator internals.
- Test organization convention:
  - Standard Jest tests live under `packages/pyright-internal/src/tests`.
  - Fourslash scenarios are discovered via `*.fourslash.ts` files and executed through `src/tests/fourSlashRunner.test.ts`.

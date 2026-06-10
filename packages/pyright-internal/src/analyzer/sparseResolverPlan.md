# Sparse Resolver Feature Plan

## Summary

The Sparse Resolver is a conservative resolution fast path for Pyright. Its purpose is to answer narrow semantic questions without forcing broad dependency expansion. The initial implementation target is wildcard import resolution, especially large-library cases such as:

```py
from pandas import *

def f(x: DataFrame) -> Series:
    ...
```

Today, a small query like `DataFrame` can cause Pyright to inspect or bind a large export surface. The Sparse Resolver should eventually make resolution proportional to the requested name where it can do so safely.

This is not a replacement for the binder, import resolver, or type evaluator. It is a guarded front door that either returns a provably safe answer or falls back to existing behavior.

## Design Principles

1. Preserve existing Pyright semantics.
2. Never return a sparse negative result unless absence is proven from a complete export surface.
3. Prefer logging-only and measurement before behavior changes.
4. Keep the first target small: wildcard imports only.
5. Reuse existing trusted resolver and binder data rather than duplicating semantic logic.
6. Make every fallback reason explicit and observable.
7. Make the feature easy to disable.

## Initial Target: Wildcard Import Export Lookup

Wildcard imports are a good first target because the query shape is narrow:

```txt
Resolve name X exported by module M.
```

The current binder path for `from M import *` computes the wildcard names using the target module's import lookup result, then binds each exported name into the importing scope. This is correct, but it can be expensive for large modules with many re-exports.

The Sparse Resolver prototype should first model the decision layer around this work:

```txt
Given module M and name X:
  - Is there a cached result?
  - Is there a complete static export surface?
  - Can absence be proven?
  - Can a positive candidate be identified?
  - Otherwise, fallback.
```

## Proposed Rollout

### Phase 0: Prototype Scaffold

Status: started.

Add a standalone `sparseResolver.ts` module with:

- `SparseResolver`
- `SparseResolverCache`
- sparse export query/result types
- export index completeness model
- fallback reasons
- unit tests for conservative behavior

This phase should not change Pyright behavior.

### Phase 1: Logging-only Binder Integration

Add a binder-side hook near wildcard import handling. The hook should construct a sparse export index from the existing `ImportLookupResult` and ask the sparse resolver what it would do.

Important: in this phase, the binder must ignore the sparse result and continue using existing wildcard import binding.

Desired log examples:

```txt
SparseResolver: wildcard import candidate pandas.DataFrame, index=complete, result=fallback:incompleteIndex
SparseResolver: wildcard import negative candidate pandas.MissingName, index=complete, result=notFound
SparseResolver: wildcard import fallback numpy.X, reason=dynamicAll
```

Useful counters:

```txt
sparse.resolve.query
sparse.resolve.hit
sparse.resolve.notFound
sparse.resolve.fallback
sparse.resolve.positiveCacheHit
sparse.resolve.negativeCacheHit
sparse.resolve.exportIndex.complete
sparse.resolve.exportIndex.partial
sparse.resolve.exportIndex.unknown
```

### Phase 2: Export Metadata Refinement

Build better export-surface metadata from existing binder/import data.

Potential sources:

- static `__all__`
- `dunderAllNames` from `ImportLookupResult`
- target module symbol table keys
- stub-file top-level symbols
- py.typed package metadata
- implicit imports from packages

Represent completeness explicitly:

```ts
complete:
  Absence is safe to answer as not found.

partial:
  Presence may be useful, but absence must fallback.

unknown:
  No sparse answer except cache hits.
```

Rules:

- Static `__all__` with no unsupported form is complete.
- Dynamic or unsupported `__all__` is unknown.
- Binder symbol-table keys are partial unless Pyright can prove the module has no dynamic export behavior.
- Namespace packages are partial by default.

### Phase 3: Safe Negative Cache

Enable negative sparse results only for complete export surfaces.

Example:

```py
# lib.py
__all__ = ["A"]
class A: ...

# app.py
from lib import *
B
```

For a lookup of `B`, the sparse resolver can safely answer `notFound` if `lib.__all__` is static and complete.

Cache key should include:

- module URI
- export name
- operation kind
- execution environment identity, eventually
- Python version/platform, eventually
- type-checking mode, if relevant

### Phase 4: Positive Per-name Resolution

Allow sparse positive resolution only when the actual symbol can be supplied using existing trusted data.

Potential approach:

1. Sparse resolver says name is present in the export index.
2. Binder/evaluator asks an existing helper to bind or resolve only that name.
3. If the helper cannot resolve exactly one name without full expansion, fallback.

This phase should avoid creating a parallel semantic engine. The sparse layer decides whether the query is worth attempting; existing resolver code remains authoritative for symbol creation and alias semantics.

### Phase 5: Behavior-enabled Wildcard Import Path

Once differential testing shows parity, enable sparse wildcard import behavior behind an internal flag.

Modes:

```ts
off:
  Never use sparse resolver.

loggingOnly:
  Compute decisions and log/measure, but do not affect behavior.

enabled:
  Use sparse results where safe, fallback otherwise.
```

The default should remain `off` until metrics show low fallback overhead and no correctness risk.

### Phase 6: Expand Targets

After wildcard imports are stable, consider additional targets:

- alias resolution
- member lookup candidate filtering
- overload prefiltering
- rename/reference candidate file pruning
- completion candidate filtering

Each new target should have its own safety model and fallback reasons.

## Correctness Model

Sparse resolution is allowed to replace existing behavior only when at least one condition is true:

1. The result is backed by the same semantic source the full resolver would use.
2. A negative result is backed by a complete static export surface.
3. The resolved symbol is already available in binder metadata.
4. Final resolution is delegated to existing trusted Pyright code.
5. The sparse answer is used only for logging/telemetry.

Otherwise the result must be:

```ts
{ kind: 'fallback', reason }
```

## Fallback Reasons

Initial fallback reasons:

```ts
featureDisabled
unknownExportSurface
dynamicAll
incompleteIndex
cacheInvalidated
```

Likely future fallback reasons:

```ts
conditionalImport
ambiguousReExport
requiresTypeEvaluation
cyclicImport
unsupportedSyntax
namespacePackage
nativeModule
```

Fallbacks are expected and healthy. A fallback means the sparse layer chose correctness over speculation.

## Cache Plan

### Positive Cache

Maps a specific export query to a resolved symbol.

```ts
moduleUri + operation + name -> Symbol
```

Positive cache entries are safe only if they are derived from binder data or existing resolver logic.

### Negative Cache

Stores names known not to exist in a complete export surface.

```ts
moduleUri + operation + name -> notFound
```

Negative cache must not be populated from partial or unknown export surfaces.

### Invalidation

Invalidate sparse entries when:

- source file changes
- stub file changes
- import search path changes
- execution environment changes
- Python version/platform changes
- `py.typed` state changes
- typeshed version changes
- user configuration changes

The prototype cache currently supports module-level invalidation only. Full integration should add richer environment-aware keys.

## Binder Integration Sketch

Current wildcard import area:

```ts
if (node.d.isWildcardImport) {
    const lookupInfo = this._fileInfo.importLookup(resolvedPath);
    if (lookupInfo) {
        const wildcardNames = getWildcardImportNames(lookupInfo);
        wildcardNames.forEach((name) => {
            // existing binding and alias declaration logic
        });
    }
}
```

Logging-only sparse hook:

```ts
const exportIndex = SparseResolver.createExportIndex(resolvedPath, lookupInfo);

for (const queriedName of namesObservedFromCurrentFile) {
    const sparseResult = sparseResolver.resolveExport({
        moduleUri: resolvedPath,
        name: queriedName,
        exportIndex,
    });

    logSparseDecision(sparseResult);
}
```

A later behavior-enabled path should not iterate every export just to use the sparse resolver. It should instead be driven by actual name lookups from the importing scope.

## Testing Plan

### Unit Tests

Add focused tests for:

- complete static `__all__`
- dynamic `__all__`
- partial symbol table export surface
- negative cache only for complete export surfaces
- fallback when feature disabled
- fallback when star imports target disabled
- cache invalidation

### Analyzer Tests

Add sample-based tests for:

```py
from lib_with_static_all import *
from lib_with_dynamic_all import *
from package_with_reexports import *
from namespace_package import *
```

Expected result: diagnostics and inferred types match baseline with sparse resolver off.

### Differential Tests

For sparse-enabled tests:

1. Run with sparse resolver off.
2. Run with logging-only.
3. Run with enabled.
4. Compare diagnostics, inferred types, declarations, and hover/completion results.

### Performance Tests

Benchmark large export surfaces:

- pandas
- numpy
- matplotlib.pyplot
- scipy
- torch
- tensorflow
- transformers
- django

Measure:

- full wildcard expansion count
- queried wildcard name count
- fallback rate
- positive hit rate
- negative hit rate
- binder time
- type evaluation time
- hover latency
- completion latency
- memory usage

## Success Criteria

Initial success criteria:

- No diagnostics or type inference regressions.
- Sparse logging produces understandable decisions.
- No negative result from partial or unknown export surfaces.
- Complete static `__all__` supports safe negative results.
- Prototype tests pass.

Longer-term success criteria:

- Reduce full wildcard import expansion for large libraries.
- Reduce lookup latency for names imported via large wildcard imports by at least 30% in benchmark workspaces.
- Resolve queried names without expanding the full export surface in at least 70% of safe large-library wildcard import cases.

## Open Questions

1. Should sparse resolver live under analyzer, program, or evaluator ownership?
2. How should actual user-facing config be exposed, if at all?
3. Should logging-only mode be wired to existing console/debug logging or a dedicated performance channel?
4. Can the binder expose enough metadata to avoid touching the type evaluator for first-phase wildcard import work?
5. What is the right abstraction for per-name wildcard import binding without duplicating binder alias logic?
6. How should namespace package export completeness be represented?
7. Should export indices be retained across files or rebuilt from existing cached parse/bind state?
8. Should negative cache keys include type-checking mode?

## Implementation Checklist

- [x] Add sparse resolver scaffold.
- [x] Add basic unit tests for conservative sparse decisions.
- [ ] Add this feature plan.
- [ ] Wire logging-only binder hook.
- [ ] Add config/internal option plumbing.
- [ ] Add metrics counters.
- [ ] Add cache invalidation tests.
- [ ] Add wildcard import sample tests.
- [ ] Add differential test mode.
- [ ] Add performance benchmarks.

## Notes

The current scaffold intentionally falls back for positive export hits because it stores export names but not trusted resolved symbols. This is deliberate. Positive sparse resolution should be added only once the integration can delegate final symbol creation to existing binder/evaluator helpers.

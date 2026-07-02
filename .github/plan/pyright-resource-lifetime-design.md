# Improving Resource Lifetimes in Pyright Incremental Analysis

## Context

Pyright already keeps long-lived workspace resources in language-server and watch-mode scenarios. A persistent `Service` owns a `Program`; the `Program` tracks `SourceFileInfo` and `SourceFile` objects; and `SourceFile` stores parse, bind, check, diagnostics, import, and versioning state.

The current behavior is broadly safe and file-granular:

- If file contents are unchanged, cached file state can be reused.
- If file text changes, `SourceFile.setClientVersion` detects a length/hash change and calls `markDirty()`.
- `markDirty()` increments file and semantic versions, marks binding/checking required, clears the module symbol table, and causes the file to be reparsed on next analysis.
- `Program.markFilesDirty` can propagate dirtiness to dependent files.
- Some broader changes recreate the evaluator, effectively shortening the lifetime of evaluator/type-cache entries.
- Resolver and filesystem caches generally survive ordinary source edits unless import/config state changes.

The design goal is to make expensive resources die only when their actual inputs changed, not merely because their owning file changed.

## Goal

Improve resource lifetime across edits by separating the lifetimes of:

1. Raw text
2. Tokens
3. Syntax tree
4. Binding/scope graph
5. Module export surface
6. Local body type state
7. Evaluator/type cache entries
8. Resolver/library summaries
9. Diagnostics

This turns a coarse invalidation model:

```text
file text changed -> dirty file -> reparse -> rebind -> recheck -> dirty dependents
```

into a dependency-sensitive model:

```text
text edit
  -> classify syntactic/semantic impact
  -> preserve unaffected syntax nodes
  -> rebind only affected scopes
  -> diff public export surface
  -> dirty only affected dependents
  -> reuse evaluator entries whose dependency fingerprints still match
```

## Proposed Lifetime Tiers

| Lifetime tier | Resource examples | Invalidated by |
|---|---|---|
| Workspace epoch | Config, import resolver, execution environment, builtins epoch | Config/env/import path changes |
| File identity | URI, file ID, open/closed state, dependency edge ownership | Delete, rename, path remap |
| Text version | Raw text, line map, text snapshot | Any actual text edit |
| Token version | Token stream, comment/directive scan | Lexically relevant edit |
| Syntax version | Parse tree / green tree | Syntax-affecting edit |
| Binding version | Scopes, symbol declarations, import table | Declaration/import/scope-shape edit |
| Export-surface version | Public module API, `__all__`, imported/exported names, class/function signatures | Externally visible semantic change |
| Body semantic version | Function body types, local flow graph, diagnostics | Local body change |
| Evaluator cache epoch | Type results, overload attempts, constrained TypeVar solving, speculative cache entries | Dependency fingerprint mismatch or memory pressure |
| Library summary epoch | Typeshed/package parse+bind/type summaries | Library file hash, Python version, platform, `py.typed`, config epoch |

## Invalidation Taxonomy

Introduce an explicit invalidation classification instead of treating all text changes alike.

```ts
enum InvalidationKind {
    NoChange,
    TriviaOnly,
    TokenOnly,
    SyntaxOnly,
    LocalBodyOnly,
    LocalDeclarationShape,
    ModuleImportSurface,
    ModuleExportSurface,
    BuiltinsOrConfig,
}
```

Example behavior:

```ts
switch (kind) {
    case InvalidationKind.NoChange:
        preserveEverything();
        break;

    case InvalidationKind.TriviaOnly:
        preserveParseBindCheck();
        recomputeCommentDiagnosticsOnly();
        break;

    case InvalidationKind.SyntaxOnly:
        reuseUnchangedSyntaxNodes();
        rebindContainingScopeIfNeeded();
        recheckAffectedDiagnostics();
        break;

    case InvalidationKind.LocalBodyOnly:
        preserveModuleSymbolTable();
        invalidateFunctionBodyTypes(changedFunctionId);
        recheckLocalDiagnostics(changedFunctionId);
        break;

    case InvalidationKind.LocalDeclarationShape:
        rebindContainingScope();
        invalidateSymbolUsers(changedSymbolId);
        break;

    case InvalidationKind.ModuleImportSurface:
        updateImportTable();
        dirtyAffectedImportDependents();
        break;

    case InvalidationKind.ModuleExportSurface:
        diffExportSurface();
        dirtyOnlyDependentsThatImportChangedSymbols();
        break;

    case InvalidationKind.BuiltinsOrConfig:
        bumpWorkspaceEpoch();
        invalidateBroadly();
        break;
}
```

## Design 1: Use `changedRange` for Incremental Syntax Reuse

The language-server path already accepts an optional `changedRange`, but the effective file invalidation path still works from full text length/hash. Use `changedRange` to classify edits and preserve stable syntax nodes.

Target shape:

```ts
setClientVersion(version, contents, changedRange?) {
    const edit = computeEdit(previousText, contents, changedRange);
    const syntaxDelta = incrementalParser.update(previousGreenTree, edit);

    if (syntaxDelta.onlyTriviaOrComments) {
        updateLineMapAndCommentDiagnostics();
        preserveBindAndTypeState();
        return;
    }

    if (syntaxDelta.changedTopLevelNodes.size === 0) {
        preserveModuleBinding();
        invalidateOnlyAffectedDiagnostics();
        return;
    }

    invalidateByChangedNodes(syntaxDelta.changedStableNodeIds);
}
```

This likely requires a persistent syntax representation, such as a green/red tree or parse tree with stable node IDs.

## Design 2: Add Stable Semantic Node IDs

Today, type-evaluator caches are likely vulnerable to full parse-tree rebuilds because cache entries are associated with parse nodes. If a reparse creates new node identities, useful type results may die even when the semantic construct is unchanged.

Introduce stable node IDs derived from structural location and semantic fingerprint:

```ts
type StableNodeId = {
    fileId: string;
    symbolPath: string;
    nodeKind: ParseNodeType;
    ordinalWithinParent: number;
    declarationFingerprint: Hash;
};
```

Example symbol paths:

```text
module:foo
module:foo.ClassA
module:foo.ClassA.method
module:foo.function.inner
```

For local expressions, use a body-local stable ID:

```ts
type LocalStableNodeId = {
    functionId: StableNodeId;
    controlFlowRegionId: number;
    expressionOrdinal: number;
    expressionFingerprint: Hash;
};
```

This allows type results to survive comment edits, whitespace edits, and unrelated edits elsewhere in the same file.

## Design 3: Add Export-Surface Fingerprints

Dependent files should not be dirtied merely because an imported file changed internally. They should be dirtied when the imported file's observable export surface changes.

Add a per-module export summary:

```ts
interface ExportSurface {
    moduleUri: Uri;
    exportsHash: Hash;
    importTableHash: Hash;
    dunderAllHash?: Hash;
    symbolFingerprints: Map<string, SymbolFingerprint>;
}

interface SymbolFingerprint {
    name: string;
    kind: SymbolKind;
    declarationHash: Hash;
    typeSignatureHash?: Hash;
    visibility: "public" | "private" | "unknown";
}
```

Then:

```ts
const oldSurface = getExportSurface(oldBoundModule);
const newSurface = getExportSurface(newBoundModule);

if (oldSurface.exportsHash === newSurface.exportsHash) {
    keepDependentFilesClean();
} else {
    const changedSymbols = diffExportSurface(oldSurface, newSurface);
    dirtyOnlyDependentsThatImport(changedSymbols);
}
```

Examples:

```py
# Should recheck this file but not import dependents.
def _private_helper():
    ...

# Should dirty importers of f.
def f(x: int) -> str:
    ...

# Should dirty wildcard importers.
__all__ = ["f", "g"]
```

## Design 4: Separate Binder Lifetime from Checker Lifetime

Pyright already has a lighter `markReanalysisRequired(forceRebinding)` path that can preserve parse results and restart later semantic analysis. Generalize this idea.

Current-style coarse state:

```text
isBindingNeeded = true
isCheckingNeeded = true
moduleSymbolTable = undefined
```

Proposed state:

```ts
interface FileAnalysisState {
    textVersion: number;
    syntaxVersion: number;
    bindingVersion: number;
    exportSurfaceVersion: number;
    bodySemanticVersions: Map<StableNodeId, number>;
    diagnosticsVersion: number;
}
```

For a local body edit:

```ts
bodySemanticVersions.set(functionId, oldVersion + 1);
isCheckingNeededForFunction.add(functionId);
```

For a declaration edit:

```ts
bindingVersion++;
invalidateContainingScope(scopeId);
invalidateSymbol(symbolId);
```

For an export edit:

```ts
exportSurfaceVersion++;
dirtyAffectedDependents(symbolId);
```

## Design 5: Make Evaluator Cache Dependency-Aware

Instead of tying the evaluator cache lifetime to a whole evaluator instance, allow cache entries to declare their dependencies.

```ts
interface TypeCacheKey {
    fileId: string;
    stableNodeId: StableNodeId;
    nodeKind: ParseNodeType;
    semanticFingerprint: Hash;
    binderEpoch: number;
    evaluatorOptionsEpoch: number;
    builtinsEpoch: number;
    importResolverEpoch: number;
    narrowedFlowKey?: FlowFingerprint;
}

interface TypeCacheEntry {
    result: Type;
    dependencies: DependencyFingerprint[];
    epochs: EvaluatorEpochSnapshot;
    cost: number;
    sizeEstimate: number;
    lastAccessed: number;
}
```

Dependency examples:

```ts
type DependencyFingerprint =
    | { kind: "symbol"; symbolId: SymbolId; version: number }
    | { kind: "moduleExportSurface"; uri: Uri; version: number }
    | { kind: "builtins"; version: number }
    | { kind: "config"; version: number }
    | { kind: "flow"; flowNodeId: number; version: number };
```

Validation:

```ts
function isTypeCacheEntryValid(entry: TypeCacheEntry, current: CurrentEpochs): boolean {
    if (entry.epochs.importResolverEpoch !== current.importResolverEpoch) {
        return false;
    }

    if (entry.epochs.builtinsEpoch !== current.builtinsEpoch) {
        return false;
    }

    return entry.dependencies.every(dep => isDependencyCurrent(dep));
}
```

This lets most type results survive unrelated edits.

## Design 6: Keep Summaries Longer Than Full Artifacts

Under memory pressure, do not evict all resources equally. Keep small summaries that prevent large downstream recomputation.

Evict first:

```text
Speculative overload attempts
Large union/intersection intermediate results
Flow-sensitive local narrowing caches
Tokenizer output for closed files
Full diagnostics for non-open files
```

Keep longer:

```text
Module export surfaces
Symbol fingerprints
Import graph
Stub/library parse summaries
Stub/library bind summaries
Builtins/typeshed summaries
```

Rationale: a 2 KB export surface summary may avoid rechecking hundreds of dependent files.

## Design 7: Treat Libraries and Stubs as Long-Lived Resources

Installed packages, typeshed files, and closed third-party stubs are usually immutable during ordinary editing. Give them stronger lifetime rules.

```ts
interface LibraryResourceKey {
    uri: Uri;
    fileContentHash: Hash;
    pythonVersion: string;
    platform: string;
    pyTypedState: PyTypedState;
    typeshedEpoch: number;
    configEpoch: number;
}
```

Cacheable library artifacts:

```text
Token stream, if memory allows
Parse summary
Bind summary
Export surface
Class/function type summaries
Import-resolution results
```

These should survive normal user-file edits.

## Design 8: Add Resource Lifetime Telemetry

Before making the cache more complex, add telemetry that explains why resources are invalidated or evicted.

```ts
resourceCreated(kind, key, size);
resourceReused(kind, key);
resourceInvalidated(kind, key, reason);
resourceEvicted(kind, key, memoryPressure);
resourceRecomputed(kind, key, costMs);
```

Useful trace output:

```text
Edit: foo.py line 120
- Invalidation kind: LocalBodyOnly
- Preserved parse tree: 96%
- Rebound scopes: 0 of 43
- Rechecked functions: 2 of 118
- Dependent modules dirtied: 0 of 27
- Type cache hit rate: 86%
- Eviction reason: none
```

This makes it possible to measure whether resource lifetimes actually improve.

## Suggested Implementation Plan

### Phase 1: Instrumentation

Add tracing around:

- `SourceFile.setClientVersion`
- `SourceFile.markDirty`
- `SourceFile.markReanalysisRequired`
- `SourceFile.parse`
- `SourceFile.bind`
- `SourceFile.check`
- `Program.markFilesDirty`
- Evaluator creation/recreation
- Type cache hits/misses/evictions
- Import resolver cache invalidation

Goal: establish baseline resource lifetimes.

### Phase 2: Export-Surface Hashing

Implement module export summaries and use them to avoid dirtying dependents when the public API did not change.

This is likely the best ROI because it does not require a full incremental parser.

### Phase 3: Per-Scope and Per-Function Invalidation

Track changed top-level declarations and function bodies. Preserve module binding when only function body contents changed.

Target wins:

- Editing a function body does not dirty unrelated functions.
- Editing a private helper does not dirty importers.
- Editing comments or whitespace does not rebind/recheck.

### Phase 4: Stable Node IDs

Introduce stable IDs for declarations, scopes, and key expression nodes.

Target wins:

- Type cache entries survive reparses when the semantic construct is unchanged.
- Diagnostics can be mapped across edits more accurately.
- Incremental parser work becomes easier later.

### Phase 5: Dependency-Aware Evaluator Cache

Replace broad evaluator cache invalidation with entry-level dependency validation.

Target wins:

- Recreating evaluator options no longer necessarily kills unrelated type results.
- Type cache entries can survive local edits in other files.
- Speculative cache entries can be retained when their speculative dependencies remain valid.

### Phase 6: Incremental Parser / Green Tree

Use `changedRange` to update syntax trees structurally instead of full-file reparsing.

Target wins:

- Trivial edits preserve most syntax node identity.
- Large files become much cheaper to edit interactively.
- Type and binder caches get a better foundation for reuse.

## Recommended Priority

If implementing this incrementally, prioritize:

1. **Resource lifetime telemetry**
2. **Export-surface hashing**
3. **Per-function body invalidation**
4. **Stable declaration IDs**
5. **Evaluator cache dependency fingerprints**
6. **Memory-tiered eviction**
7. **Incremental parser / green tree**

The first three should provide meaningful wins without requiring a full rewrite of the parser or evaluator.

## Mental Model

The core shift is:

```text
Old model:
Resource dies when its file changes.

New model:
Resource dies when one of its declared inputs changes.
```

That gives Pyright longer-lived resources, fewer unnecessary dependent invalidations, better cache hit rates, and more predictable incremental behavior in large workspaces.

## Source Pointers

Primary files to inspect in the Pyright repository:

- `packages/pyright-internal/src/analyzer/sourceFile.ts`
- `packages/pyright-internal/src/analyzer/program.ts`
- `packages/pyright-internal/src/analyzer/backgroundAnalysisProgram.ts`
- `packages/pyright-internal/src/analyzer/sourceFileInfo.ts`
- `packages/pyright-internal/src/analyzer/cacheManager.ts`
- `packages/pyright-internal/src/analyzer/importResolver.ts`
- `docs/internals.md`
- `docs/features.md`

Useful public context:

- Pyright repository: <https://github.com/microsoft/pyright>
- Internals doc: <https://raw.githubusercontent.com/microsoft/pyright/main/docs/internals.md>
- Features doc: <https://github.com/microsoft/pyright/blob/main/docs/features.md>
- SourceFile implementation: <https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/analyzer/sourceFile.ts>
- Program implementation: <https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/analyzer/program.ts>
- ImportResolver implementation: <https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/analyzer/importResolver.ts>
- CacheManager implementation: <https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/analyzer/cacheManager.ts>

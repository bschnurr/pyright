# Plan: Correct Resource Lifetime Improvements for Pyright

## Objective

Move Pyright from coarse file-level invalidation toward dependency-sensitive resource lifetimes, while keeping behavior correct and avoiding stale type/evaluator state. The current branch mainly improves cleanup boundaries and memory retention; this plan focuses on making resources live longer only when their declared inputs are still valid.

## Current Results

Status as of 2026-07-01: the initial implementation pass is complete. All fleet todos were marked done:

- `lifetime-telemetry`
- `no-change-updates`
- `edit-classifier-scaffold`
- `export-surface-fingerprints`
- `binder-checker-lifetime`
- `stable-declaration-ids`
- `dependency-aware-evaluator-cache`
- `library-stub-summaries`
- `incremental-syntax-reuse`

Implemented results:

- Added internal/test-facing resource lifetime telemetry with reasoned events for source, program, evaluator, and import-resolver lifetime decisions, plus opt-in JSONL/summary file output for benchmark runs.
- Added conservative edit invalidation classification and changed-range plumbing.
- Changed byte-identical open-file content updates to avoid dirtying files or recreating evaluator state.
- Added module export summaries/fingerprints and deferred dependent invalidation until after rebind.
- Added conservative declaration/import/scope-shape tracking so internal body edits can avoid dirtying import dependents when the export surface is unchanged.
- Added stable declaration ID scaffolding with collision/ambiguity fallback.
- Added library/stub resource summaries that survive full syntax release where safe and invalidate on conservative epoch/content boundaries.
- Added dependency-aware evaluator cache scaffolding and parse-generation stamping so parse-node-ID cache entries are not reused after reparse.
- Added conservative incremental syntax-reuse scaffolding that preserves syntax only for proven no-change edits and records reuse decisions.

Validation completed:

```powershell
cd packages\pyright-internal
npm run build -- --pretty false
npx jest service.test editInvalidationClassifier.test stableDeclarationId.test dependencyAwareEvaluatorCache.test resourceLifetimeTelemetry.test --forceExit
```

Result: build passed; targeted lifetime test suite passed with 88 passing tests.

## Key Behavior Changes and Expected Wins

This implementation is architecturally much better than upstream, but it has not yet been benchmarked end-to-end. The proven gains are correctness and invalidation precision; performance impact should be measured separately on representative workspaces.

| Scenario | Upstream / previous behavior | New behavior | Expected win |
|---|---|---|---|
| Byte-identical open-file update | Could dirty the file and recreate evaluator state | Updates client metadata without dirtying or evaluator recreation | Avoids unnecessary work from no-op editor updates |
| Internal implementation edit in imported module | Import dependents were dirtied broadly | Dependents can stay clean when export surface and declaration shape are unchanged | Fewer dependent rechecks during local implementation edits |
| Public API edit | Recursive invalidation happened immediately/coarsely | Dirtying is deferred until after rebind and export-surface comparison | Keeps correctness while avoiding false dependent invalidation |
| Changed parse tree and type cache | Parse-node-ID cache entries were tied to evaluator generation and could be unsafe across reparses | Parse generation stamps reject stale parse-node-ID cache entries after reparse | Prevents stale type reuse and prepares stable cache reuse |
| Closed/library/stub resources | Full syntax, bind state, and summaries had coarse shared lifetimes | Compact module/library/stub summaries can survive full syntax release when safe | Preserves cheap dependency/export data under memory pressure |
| Diagnosing invalidation behavior | Hard to tell why resources were recreated or retained | Telemetry records reasoned lifetime events and syntax reuse decisions | Makes future tuning and regression triage practical |
| Incremental syntax path | `changedRange` existed but did not drive safe reuse decisions | `changedRange` is plumbed into conservative classification/reuse scaffolding | Foundation for future green-tree or trivia/local reuse work |

Important caveat: changed text still conservatively drops/rebuilds syntax unless the edit is proven safe. Expression-level evaluator cache reuse is intentionally not enabled yet; the current dependency-aware cache layer is scaffolding plus validation/freshness protection.

## Old Pyright Resource Lifetime Model

The old system is best described as a memo table over the current evaluator and current parse trees, not as a durable semantic cache across text edits.

Core lifetime facts:

- `Program` owns `SourceFileInfo`/`SourceFile` objects, the dependency graph, and one `TypeEvaluator`.
- `SourceFile` owns file text/version state, parse/tokenizer output, binder/module symbol table, diagnostics, and dirty flags.
- `TypeEvaluator` owns caches such as `typeCache`, effective-type cache, expected-type cache, code-flow cache, and speculative type machinery.
- The main type cache is keyed by `ParseNode.id`, not by stable semantic identity such as module/symbol/signature/dependency fingerprints.
- A real text edit normally calls `markDirty`, causing the file to be reparsed/rebound/rechecked. Reparse creates new parse node IDs, so old same-file type-cache entries usually stop hitting even if the evaluator object survives.
- `markReanalysisRequired` is lighter: it can keep the parse tree alive, so node-ID-keyed type cache entries can still hit when no reparse is required.
- Whole evaluator recreation clears all evaluator caches. This can happen through recursive dependent dirtying, memory pressure, explicit cache emptying, unexpected evaluator errors, or invalid cancellation.

| Event | Parse tree | Bind info | Same-file type cache | Other-file type cache | Evaluator |
|---|---|---|---|---|---|
| Repeated hover/type query with no edit | survives | survives | can hit | can hit | survives |
| Open-file text edit | invalidated | invalidated | effectively misses after reparse | may survive | may survive |
| Reanalysis without reparse | survives | may survive unless forced | can hit | can hit | survives |
| Dependency dirtying with evaluator recreation | changed files invalidated | changed files invalidated | gone | gone | recreated |
| Memory-pressure empty cache | discarded | discarded | gone | gone | recreated |
| Speculative context exits | survives | survives | temporary speculative entries removed | unaffected | survives |

This is why the central improvement opportunity is to move from `parse node identity` toward `semantic identity + dependency fingerprints`. The current implementation does not yet make expression-level type results durable across changed text, but it adds the safe prerequisites: stable declaration IDs, export/declaration fingerprints, library resource summaries, parse-generation checks, and telemetry to prove when reuse is safe.

## How the Scenario Changes Were Achieved

### Byte-identical open-file updates

The persistent edit path was split so `Program.setFileOpened` remains the low-level content replacement operation, while `Program.updateOpenFileContents` is responsible for persistent invalidation decisions.

Implementation details:

- `SourceFile.setClientVersion` continues to compare new contents against the last observed length/hash and returns whether contents actually changed.
- `Program.setFileOpened` now returns that `contentsChanged` result to callers.
- `Program.updateOpenFileContents` calls `setFileOpened` and returns immediately when contents are byte-identical.
- Because the method returns before dirtying the file, no dependent invalidation or evaluator recreation happens for a pure version bump/no-op editor update.
- The no-change path still updates client document version/content metadata, so diagnostic delivery state remains consistent.

Result: editor churn that sends identical text no longer kills syntax/evaluator state.

### Internal implementation edits in imported modules

The coarse "changed file dirties all importers" model was replaced with a deferred export-surface comparison for normal source edits.

Implementation details:

- Changed open-file contents mark the edited file dirty and add its URI to `_pendingExportSurfaceInvalidation`.
- The evaluator is still recreated for the changed file because parse-node-keyed type cache entries are not safe across reparse.
- During bind, `Program` captures the previous `ModuleExportSummary`, binds the edited module, builds the new summary, and then compares old/new summaries.
- `ModuleExportSummary` records compact fingerprints for:
  - imports
  - declaration shape
  - stable declaration identity
  - public export surface
  - `__all__`
  - reliability/uncertainty
- If both summaries are reliable and both declaration shape and export fingerprints match, import dependents are left clean.
- If summaries are unreliable or differ, `Program` falls back to recursively marking import dependents for reanalysis.

Result: edits inside function/method bodies can recheck the edited file without dirtying importers when the public surface and declaration shape are unchanged.

### Public API edits

Public API changes still invalidate dependents, but invalidation is delayed until Pyright can compare the actual public surface rather than assuming every text edit is externally visible.

Implementation details:

- Function/class/type-alias/import/assignment surface text contributes to declaration and export fingerprints.
- `__all__` contributes a separate fingerprint and unsupported/dynamic forms make the summary unreliable.
- Class and function headers are included, so signature/header changes alter declaration/export fingerprints.
- Import table changes alter import fingerprints.
- Any change in these fingerprints causes `_markImportDependentsIfExportSurfaceChanged` to dirty importers.

Result: public signature/import/export changes remain correct, while internal-only edits avoid false dependent invalidation.

### Binder/checker lifetime split

The first safe split was implemented through declaration/import/scope-shape fingerprints rather than per-function checker reuse.

Implementation details:

- Declaration shape is compared separately from the full export fingerprint.
- If declaration/import/scope shape changes, dependent reanalysis is required.
- If only local implementation details change and export/declaration shape remains stable, dependents can stay clean.
- The edited file can still be reparsed, rebound, and rechecked conservatively; the win is avoiding unnecessary dependent work.

Result: this avoids the risky step of reusing checker results inside a changed file while still reducing workspace-wide invalidation.

### Stable declaration IDs

Stable declaration identity scaffolding was added so future summary and evaluator-cache work can refer to declarations by stable semantic identity rather than transient parse-node object identity.

Implementation details:

- `stableDeclarationId.ts` creates identities from:
  - file identity
  - symbol path
  - parse node kind
  - ordinal within the relevant declaration scope
  - declaration fingerprint
  - source range
- Duplicate symbols in the same scope and ID collisions are marked unstable.
- Unstable declarations do not participate in unsafe reuse; their summaries force conservative behavior.
- `ModuleExportSummary` includes a stable declaration identity fingerprint and a flag for unstable declaration IDs.

Result: summaries can tell whether declarations remained semantically identifiable across edits, while ambiguous cases fall back safely.

### Type cache safety and dependency-aware evaluator cache scaffolding

The existing evaluator type cache remains parse-node-ID based for within-generation speed, but it is now protected against stale reuse after reparse.

Implementation details:

- `AnalyzerFileInfo` carries a parse generation.
- `TypeCacheEntry` now stores `parseGeneration`.
- `writeTypeCache` stamps each entry with the node's parse generation.
- `readTypeCacheEntry` compares the cached parse generation to the node's current parse generation and rejects mismatches.
- `dependencyAwareEvaluatorCache.ts` adds a stable-keyed cache scaffold with dependency fingerprints over:
  - stable declaration ID/fingerprint
  - module export/import/declaration fingerprints
  - local file content and semantic versions
  - builtins/config/import resolver epochs
  - library summary epochs
  - library resource key fingerprint
  - dependent module fingerprints
- Validation returns explicit reasons such as `ModuleExportFingerprintChanged`, `BuiltinsEpochChanged`, or `LibraryResourceKeyChanged`.
- The stable-keyed layer is currently conservative scaffolding and validation infrastructure, not broad expression-level result reuse.

Memory-usage note: this pass did **not** add per-entry memory usage, `sizeEstimate`, `cost`, or `lastAccessed` fields to type-cache entries. The new cache statistics track entry/store/validation hit/miss/rejection/eviction counts. Per-entry memory estimates remain a future enhancement if we want tiered eviction based on retained cost.

Result: stale parse-node cache reuse is blocked, and the data model for future dependency-validated stable cache reuse is in place.

### Closed files, library files, and stubs

Compact summaries were separated from full syntax/bind artifacts so useful dependency/export information can survive memory pressure.

Implementation details:

- `libraryResourceSummary.ts` defines `LibraryResourceKey` from URI, content hash, Python version, platform, py.typed state, typeshed epoch, config epoch, partial-stub epoch, and resource kind.
- `LibraryStubSummary` stores the compact library key plus `ModuleExportSummary`.
- `SourceFile` can retain module/library summaries independently from parser output, tokenizer output, and module symbol table.
- `Program.emptyCache` can drop full syntax/bind state while preserving summaries where safe.
- Import resolver/config/partial-stub changes bump conservative epochs and invalidate affected summaries.

Result: memory pressure can release large syntax artifacts without throwing away cheap export/dependency summaries for libraries and stubs.

### Incremental syntax reuse and `changedRange`

The implementation intentionally avoids a full green-tree parser rewrite. Instead, it adds safe plumbing and metrics.

Implementation details:

- `editInvalidationClassifier.ts` defines `InvalidationKind` and a conservative classifier.
- `incrementalSyntaxReuse.ts` consumes old/new text plus optional `changedRange`.
- Syntax is preserved only for proven `NoChange`.
- Trivia/comment changes still fall back because comments can carry `type: ignore`, `pyright: ignore`, and other directive semantics.
- Telemetry records syntax reuse decisions, invalidation kind, changed-range length, and delta.

Result: `changedRange` now reaches a reuse decision layer, but changed-text syntax reuse remains conservative until directive-safe trivia/local-body classification is implemented.

### Telemetry benchmark files

Resource lifetime telemetry can now write opt-in benchmark artifacts without changing normal Pyright output.

Implementation details:

- Set `PYRIGHT_RESOURCE_LIFETIME_TELEMETRY=1`, `true`, or `workspace` to write workspace-local telemetry under `.pyright/`.
  - Events: `.pyright/resource-lifetime-events.jsonl`
  - Summary: `.pyright/resource-lifetime-summary.json`
- Set `PYRIGHT_RESOURCE_LIFETIME_TELEMETRY` to an events file path to enable telemetry at an explicit JSONL path.
- Set `PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_SUMMARY` to choose a summary path; otherwise the summary is written next to the event file as `<events>.summary.json`.
- Set `PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_INCLUDE_URIS=1` to include raw URIs. By default, file output hashes URIs and omits raw paths.
- Environment-enabled file output does not retain the raw event list in memory; it keeps aggregate counters and streams events to disk.
- Summary output includes total event count, retained in-memory event count, and counts grouped by event kind/reason.

Result: NumPy/PyTorch benchmark runs can capture evaluator churn, dirty fanout, export-surface skips, syntax reuse decisions, and cache invalidation reasons without parsing large diagnostic logs.

## Original Baseline

The branch already improves several lifetime boundaries:

- Source and evaluator retainers are cleared on program disposal, file removal, cache pressure, and invalid type-cache cancellation.
- Closed tracked files can preserve syntax until an explicit cache/removal boundary.
- Direct temporary/edit-mode `setFileOpened` can preserve evaluator state.
- Cache stats and heap probes exist for evaluator, source syntax, and import resolver cleanup.

Previously important limitation: normal open-file updates used coarse invalidation. The first implementation pass now treats byte-identical updates as no-ops, defers dependent invalidation through export-surface comparison, and prevents stale parse-node-ID cache reuse after reparse. Changed text still conservatively drops/rebuilds syntax unless proven safe.

## Principles

1. Preserve resources only when their inputs are provably unchanged.
2. Prefer narrow invalidation over broad evaluator recreation, but never reuse parse-node-keyed cache entries across reparses unless the cache key is made stable.
3. Separate temporary/edit-mode preservation from persistent workspace updates.
4. Add observability before adding complex reuse.
5. Land in small phases with tests that prove both reuse and invalidation.

## Phase 1: Make Lifetime Decisions Observable

Goal: establish a clear baseline and make later reuse decisions debuggable.

Tasks:

- Add internal lifetime trace counters/events around:
  - `SourceFile.setClientVersion`
  - `SourceFile.markDirty`
  - `SourceFile.markDirtyAndDropSyntax`
  - `SourceFile.markReanalysisRequired`
  - `SourceFile.parse`
  - `SourceFile.bind`
  - `SourceFile.check`
  - `Program.markFilesDirty`
  - evaluator creation/disposal
  - import resolver cache invalidation
- Record reasons, not just counts:
  - text changed
  - closed-file disk changed
  - config/import resolver changed
  - dependency dirtied
  - cache pressure
  - file removed
  - cancellation invalidated type cache
- Keep telemetry internal/test-facing first. Do not add user-facing logging until the counters are useful.
- Extend current cache stats tests so they assert meaningful reason-specific behavior, not only "all caches were cleared".

Exit criteria:

- A targeted test can show why a file was reparsed, rebound, rechecked, and whether the evaluator was recreated.
- Existing cleanup tests still pass.

## Phase 2: Separate Content Updates from Dependent Invalidation

Goal: fix the current mismatch where direct `setFileOpened` preserves too much for temporary edits while normal updates invalidate too broadly.

Tasks:

- Keep `Program.setFileOpened` as a low-level content replacement operation.
- Introduce or document a higher-level persistent edit path that:
  - applies new contents
  - classifies the update
  - dirties the edited file
  - dirties dependents only when required
  - recreates evaluator only when parse-node-keyed caches may be unsafe
- Make `updateOpenFileContents` skip dirtying/recreating evaluator when contents are byte-identical.
- Add tests for:
  - byte-identical version bump preserves diagnostics/evaluator/syntax
  - actual text edit invalidates the edited file
  - temporary edit-mode mutation remains isolated and is restored/cleared correctly

Exit criteria:

- No-change edits are true no-ops except client version/diagnostic delivery metadata.
- Persistent content changes do not accidentally rely on stale evaluator entries.

## Phase 3: Add Edit Classification Without Reuse Yet

Goal: compute invalidation kinds conservatively before using them to preserve expensive state.

Introduce:

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

Tasks:

- Use `changedRange` when available, but fall back to full text comparison.
- Implement a conservative classifier:
  - `NoChange`: identical hash/length
  - `TriviaOnly`: changed span affects only whitespace/comments and no type-ignore/pyright-ignore/directive meaning changed
  - `BuiltinsOrConfig`: builtins/config/import resolver changes
  - all uncertain cases initially collapse to `ModuleExportSurface` or equivalent broad invalidation
- Add tests that verify classification only; do not yet preserve parse/bind/type state based on the classifier except for `NoChange`.

Exit criteria:

- Classifier is conservative and test-covered.
- Ambiguous edits choose correctness over reuse.

## Phase 4: Export-Surface Fingerprints

Goal: avoid dirtying import dependents for purely internal implementation changes.

Tasks:

- Add a compact module export summary stored outside the full parse tree:
  - module URI
  - import table hash
  - public export hash
  - `__all__` hash
  - public symbol fingerprints
- Start with declarations that are straightforward to fingerprint:
  - top-level functions/classes/variables
  - imports and re-exports
  - `__all__`
  - annotation/signature text spans
- Compare old/new summaries after rebind.
- Dirty dependents only when:
  - imported symbol fingerprint changed
  - wildcard import may be affected
  - import table changed
  - summary computation is unavailable or uncertain
- Store summaries independently from `parserOutput` and `moduleSymbolTable` so they can survive closed-file syntax release.

Tests:

- Editing a private helper body does not dirty importers.
- Editing a public function signature dirties direct importers of that symbol.
- Editing `__all__` dirties wildcard importers.
- Uncertain dynamic export cases fall back to broad invalidation.

Exit criteria:

- Internal-only changes no longer recursively dirty unrelated dependents.
- Conservative fallback preserves existing correctness.

## Phase 5: Binder and Checker Lifetime Split

Goal: preserve binding when only local bodies change.

Tasks:

- Track declaration-shape fingerprints for top-level declarations and class/function scopes.
- Distinguish:
  - module import surface changes
  - module export declaration changes
  - local body-only changes
  - trivia/comment-only changes
- For local body-only edits:
  - preserve module symbol table when safe
  - mark checking needed for the edited function/file region
  - do not dirty import dependents if export summary is unchanged
- Avoid per-function checker reuse until dependencies are explicit. Initially it is acceptable to recheck the edited file but not dependents.

Tests:

- Editing a function body rechecks the file but does not rebind dependents.
- Editing a class attribute annotation rebinding occurs.
- Editing imports rebinding occurs and import graph updates.

Exit criteria:

- Local implementation edits avoid dependent invalidation.
- Binding is reused only when declaration/import/scope shape is unchanged.

## Phase 6: Stable Declaration IDs

Goal: create stable keys that can survive reparses for declarations and eventually expression nodes.

Tasks:

- Add stable IDs for declarations:
  - file identity
  - symbol path
  - node kind
  - ordinal within parent
  - declaration fingerprint
- Use stable IDs initially for summaries and diagnostics mapping, not type-cache reuse.
- Add collision/fallback handling:
  - duplicate/ambiguous IDs disable reuse for that scope
  - moved declarations with changed ordinal should not be trusted until fingerprints match

Tests:

- Comment edit preserves declaration IDs.
- Adding unrelated function preserves existing declaration IDs when unambiguous.
- Reordering duplicate names falls back conservatively.

Exit criteria:

- Stable declaration identity is available and validated independently of evaluator cache changes.

## Phase 7: Dependency-Aware Evaluator Cache

Goal: reuse type results only when cache keys and dependencies prove validity.

Tasks:

- Do not reuse existing parse-node-ID cache entries across reparses.
- Introduce a new cache layer keyed by stable IDs for safe declarations first.
- Record dependency fingerprints:
  - symbol version
  - module export-surface version
  - builtins epoch
  - config/import resolver epoch
  - flow/body semantic version where applicable
- Validate entries before reuse.
- Keep old parse-node-ID cache for within-generation fast paths.
- Add eviction stats for retained stable-cache entries.

Tests:

- Type cache survives unrelated edit in another file.
- Type cache invalidates when imported public signature changes.
- Type cache invalidates on builtins/config/import resolver epoch change.
- Speculative/incomplete entries are either dependency-validated or not retained.

Exit criteria:

- Evaluator cache reuse is no longer tied only to evaluator instance lifetime.
- Stale parse-node-keyed entries cannot be observed after reparse.

## Phase 8: Library and Stub Summary Lifetimes

Goal: make immutable library/stub artifacts long-lived without retaining full syntax unnecessarily.

Tasks:

- Add library resource keys:
  - URI
  - content hash
  - Python version
  - platform
  - py.typed state
  - typeshed epoch
  - config epoch
- Preserve compact summaries for typeshed/package files:
  - export surface
  - import graph edges
  - bind summaries
  - selected type summaries
- Evict full parse/token state before summaries under memory pressure.
- Invalidate summaries on file hash/config/platform/python-version changes.

Tests:

- User-file edit does not evict library summaries.
- Python-version change invalidates version-gated stdlib summaries.
- Partial stub remapping invalidates affected summaries only.

Exit criteria:

- Library summaries survive normal editing.
- Full syntax can be dropped without losing dependency/export information.

## Phase 9: Incremental Syntax Reuse

Goal: use `changedRange` and stable syntax infrastructure after semantic invalidation is correct.

Tasks:

- Prototype green-tree or stable-node parse representation.
- Reuse unchanged syntax nodes for trivia/local edits.
- Preserve line maps and diagnostics range data when safe.
- Integrate stable node IDs with syntax reuse.

Exit criteria:

- Large-file edits preserve most syntax identity.
- Binder/evaluator reuse benefits from stable syntax rather than fighting full-tree rebuilds.

## Validation Strategy

Targeted commands:

```powershell
cd packages\pyright-internal
npx jest service.test importResolver.test sourceFileLifetime.probe.test --forceExit
npm run build -- --pretty false
```

Run heap probes separately only when needed:

```powershell
cd packages\pyright-internal
$env:PYRIGHT_RUN_HEAP_PROBES='1'
node --expose-gc .\node_modules\jest\bin\jest.js sourceFileLifetime.probe.test --forceExit
```

Escalate to broader tests when a phase touches binder/evaluator behavior:

```powershell
cd packages\pyright-internal
npm run test:norebuild
```

## Recommended Implementation Order

1. Reasoned lifetime telemetry and no-change update behavior.
2. Conservative invalidation classifier.
3. Export-surface summaries and dependent dirtying.
4. Binder/checker lifetime split for local body edits.
5. Stable declaration IDs.
6. Dependency-aware evaluator cache.
7. Long-lived library/stub summaries.
8. Incremental parser/green tree.

## Non-Goals for Early Phases

- Do not retain parse-node-ID evaluator cache entries across reparses.
- Do not implement expression-level stable IDs before declaration-level IDs are proven.
- Do not optimize memory eviction before summaries are independent of full syntax.
- Do not make trivia/comment edits skip diagnostics until type-ignore, pyright-ignore, and directive behavior is explicitly handled.

## Main Risks

- Unsound dependent reuse if export summaries miss dynamic exports or wildcard import behavior.
- Stale type results if stable IDs collide or dependencies are incomplete.
- Memory regressions if summaries are added without dropping full syntax at the right boundaries.
- Test brittleness if telemetry is asserted too directly instead of through stable counters/reasons.

## Definition of Done

The resource lifetime work is correct when Pyright can prove and test the following:

- No-change edits preserve all analysis resources.
- Trivia-only edits preserve parse/bind/type state except directive/comment diagnostics.
- Local body edits do not dirty import dependents when export surface is unchanged.
- Public API edits dirty only affected dependents when import relationships are known.
- Evaluator cache entries survive unrelated edits only when stable keys and dependencies validate.
- Memory pressure drops large full artifacts before compact summaries.
- Program disposal, file removal, and invalidation still release stale syntax/evaluator retainers.

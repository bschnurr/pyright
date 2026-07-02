Updated todo list

I’ll map this directly from the codebase so the answer is precise: first I’m pulling a targeted RPG context bundle for “type cache invalidation/lifecycle”, then I’ll verify key files and summarize event-by-event behavior (text edit vs library change vs full rebuild).

Ran `pylanceRpgContextBundle` 
Completed with input: {
  "query": "Pyright type cache lifecycle: what is cached by TypeEvaluator/program, invalidation on text edit vs library file change, full cache rebuild triggers, resource lifetime and events",
  "graph": "pyright",
  "maxFiles": 12,
  "maxTests": 8,
  "maxDocs": 6
}

I found the ranked context bundle and now I’m extracting the generated report and top candidate files so I can cite the exact implementation points for cache creation and invalidation.

Read [](file:///c%3A/Users/bschnurr/AppData/Roaming/Code%20-%20Insiders/User/workspaceStorage/09c625064a776a0d56e38bcecf9efd8f/GitHub.copilot-chat/chat-session-resources/68e95c79-4a0b-4958-8498-10980625aa24/call_WBBGO9BhbwURnpVWb8YgG3pW__vscode-1782920725811/content.json#1-1), lines 1 to 260

Read [](file:///c%3A/Users/bschnurr/AppData/Roaming/Code%20-%20Insiders/User/workspaceStorage/09c625064a776a0d56e38bcecf9efd8f/GitHub.copilot-chat/chat-session-resources/68e95c79-4a0b-4958-8498-10980625aa24/call_WBBGO9BhbwURnpVWb8YgG3pW__vscode-1782920725811/content.json#260-260), lines 260 to 560

Next I’m verifying the actual implementation in Pyright source files (Program, AnalyzerService, SourceFile, evaluator caches) and extracting the exact invalidation paths for edits, library watcher changes, and restart/full rebuild scenarios.

Ran terminal command: Set-Location 'c:/dev/pyrx'; rg -n "class Program|emptyCache\(|markAllFilesDirty|markFilesDirty|invalidateAndForceReanalysis|libraryUpdated|setFileOpened|setFileClosed|updateOpenFileContents|restart\(|_discardCachedParseResults|createNewEvaluator|type cache|TypeCache|cache" packages/pyright/packages/pyright-internal/src/analyzer/program.ts packages/pyright/packages/pyright-internal/src/analyzer/sourceFile.ts packages/pyright/packages/pyright-internal/src/analyzer/backgroundAnalysisProgram.ts packages/pyright/packages/pyright-internal/src/analyzer/service.ts packages/pyright/packages/pyright-internal/src/analyzer/cacheManager.ts

Ran terminal command: cd /c/dev/pyrx ; command -v rg ; where rg ; which rg
Completed with input: cd /c/dev/pyrx ; command -v rg ; where rg ; which rg

I hit shell quirks and missing ripgrep in PATH, so I’m switching to workspace-native code search to pull the same symbols reliably and quickly.

Searched for regex `class Program|emptyCache\(|markAllFilesDirty\(|markFilesDirty\(|setFileOpened\(|setFileClosed\(|setTrackedFiles\(|updateOpenFileContents\(|_discardCachedParseResults\(|_createNewEvaluator\(|createNewEvaluatorInternal\(|invalidateAndForceReanalysis` (`**/packages/pyright/packages/pyright-internal/src/analyzer/{program.ts,backgroundAnalysisProgram.ts,service.ts,cacheManager.ts,sourceFile.ts}`), 74 results

Searched for regex `typeCache|cache.*type|protocol compatibility|speculative|clear.*cache|invalidate.*cache` (`**/packages/pyright/packages/pyright-internal/src/analyzer/{typeEvaluatorTypes.ts,typeCacheUtils.ts,typeEvaluator*.ts,program.ts,sourceFile.ts}`), 200 results

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#150-150), lines 150 to 360

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#400-400), lines 400 to 620

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#1060-1060), lines 1060 to 1210

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#1680-1680), lines 1680 to 1775

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#2280-2280), lines 2280 to 2335

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/typeEvaluator.ts#640-640), lines 640 to 840

I now have core Program and evaluator behavior; I’m pulling SourceFile and AnalyzerService watcher logic to separate incremental invalidation from full invalidation/restart paths.

Searched for regex `setClientVersion\(|markDirty\(|markReanalysisRequired\(|dropParseAndBindInfo\(|didContentsChangeOnDisk\(|isParseRequired\(|parse\(|clearCachedModuleName\(|isBindingRequired\(|isCheckingRequired\(|isFileDeleted` (`**/packages/pyright/packages/pyright-internal/src/analyzer/sourceFile.ts`), 29 results

Searched for regex `enum InvalidatedReason|invalidateAndForceReanalysis\(|library|watch|markAllFilesDirty|markFilesDirty|restart\(|reanalysis` (`**/packages/pyright/packages/pyright-internal/src/analyzer/{service.ts,backgroundAnalysisProgram.ts,backgroundAnalysisBase.ts}`), 200 results

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/service.ts#520-520), lines 520 to 585

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/service.ts#1500-1500), lines 1500 to 1585

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/service.ts#1810-1810), lines 1810 to 1885

Searched for text `enum InvalidatedReason` (`**/packages/pyright/packages/pyright-internal/src/analyzer/**`), 1 result

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/backgroundAnalysisProgram.ts)

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/sourceFile.ts#400-400), lines 400 to 760

Searched for regex `libraryUpdated\(|invalidateAndForceReanalysis\(|markFilesDirty\(|markAllFilesDirty\(|restart\(` (`**/packages/pyright/packages/pyright-internal/src/backgroundAnalysis*.ts`), 19 results

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/backgroundAnalysisBase.ts#250-250), lines 250 to 320

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/backgroundAnalysisBase.ts#720-720), lines 720 to 770

Searched for regex `libraryUpdated\(\): boolean|libraryUpdated\(` (`**/packages/pyright/packages/pyright-internal/src/**/*.ts`), 2 results

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#248-248), lines 248 to 312

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/service.ts#288-288), lines 288 to 340

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/cacheManager.ts#1-1), lines 1 to 190

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/common/cancellationUtils.ts#1-1), lines 1 to 150

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#1140-1140), lines 1140 to 1205

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/program.ts#2300-2300), lines 2300 to 2335

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/service.ts#1768-1768), lines 1768 to 1868

Read [](file:///c%3A/dev/pyrx/packages/pyright/packages/pyright-internal/src/analyzer/typeCacheUtils.ts)

I have enough code evidence now; I’m doing one quick pass over memory notes (currently empty) and then I’ll give you a concrete lifecycle summary with direct code links for each invalidation path.

Read memory

Short answer first: Pyright’s type cache is mostly the in-memory evaluator cache inside a Program instance. It is usually invalidated incrementally per changed file/dependents, and only fully rebuilt in specific paths (new evaluator, emptyCache, restart, hard error/cancellation-invalid states).

I verified this using the RPG bundle tool plus direct source reads.

1. What the “type cache” is
- The evaluator keeps multiple per-node caches (typeCache, effectiveTypeCache, expectedTypeCache, etc.) in typeEvaluator.ts.
- Cache reads/writes are keyed by parse node id via readTypeCache and writeTypeCache in typeEvaluator.ts.
- Speculative cache entries are scoped and automatically removed when speculative context exits in typeCacheUtils.ts.

2. Text edit path (editor content change)
- Editor update flows through updateOpenFileContents, which sets new open contents and then marks that file dirty for reanalysis in backgroundAnalysisProgram.ts.
- setClientVersion marks the SourceFile dirty only if content hash/length changed in sourceFile.ts.
- Dirty propagation to import dependents happens in markFilesDirty/_markFileDirtyRecursive in program.ts.
- If dependents were marked, Program creates a new evaluator (type cache rebuild for that Program instance) in program.ts.

3. Source file watcher path (disk changes in workspace)
- For content-only file change events, service uses markFilesDirty(false) and schedules reanalysis in service.ts.
- For structural events (add/remove, or py.typed marker changes), it forces invalidation and tracked-file refresh in service.ts.

4. Library change path (site-packages / search path changes)
- Library watcher changes are debounced and accumulated in _pendingLibraryChanges in service.ts.
- On timer fire, it raises either:
- LibraryWatcherContentOnlyChanged (if only content changed, with changedFileUris tracked), or
- LibraryWatcherChanged (structural install/uninstall style changes)
in service.ts.
- BackgroundAnalysisProgram.invalidateAndForceReanalysis then:
- invalidates import resolver cache always,
- marks only changed files dirty for content-only library changes,
- otherwise marks all files dirty
in backgroundAnalysisProgram.ts.

5. When the whole type cache is rebuilt
- “Rebuild evaluator/type cache” means Program._createNewEvaluator called in program.ts.
- Main triggers:
- Config/options change: program.ts
- Import resolver swap: program.ts
- Edit mode exit with mutations: program.ts
- Dirty propagation paths needing reevaluation: program.ts
- Cancellation/exception that may poison type cache: program.ts, with cancellation poison marker from cancellationUtils.ts

6. When the whole cache is fully purged (not just evaluator map reset)
- Program.emptyCache does:
- new evaluator,
- drop all parse/bind info,
- reset parsed file counter
in program.ts.
- Memory pressure can trigger CacheManager.emptyCache across owners in cacheManager.ts, and Program calls this from high-usage checks in program.ts.

7. Resource lifecycle summary
- Program lifecycle:
- registers with CacheManager at construction and unregisters on dispose in program.ts.
- Service lifecycle:
- dispose tears down background program, source/config/library watchers, and timers in service.ts.
- Background worker lifecycle:
- request queue + restart/invalidate messages in backgroundAnalysisBase.ts, and handler-side invalidation in backgroundAnalysisBase.ts.

Practical mental model:
- Text edit: usually incremental dirtying plus dependency recheck; evaluator may be recreated when dependency propagation requires it.
- Library content-only change: targeted dirtying if changed file list is known.
- Library structural/source-structure change: import resolver invalidation + broad dirtying.
- Full rebuild/purge: explicit emptyCache, restart/config resolver swap, or hard failure/cancellation-invalid paths.

Created 5 todos


Updated todo list

I can answer this directly from the cache lifecycle paths I just traced; I’ll give a prioritized set of concrete improvements split into low-risk wins and deeper architectural changes, tied to the exact hotspots in the analyzer.

Top improvements I’d prioritize, based on the current cache lifecycle and invalidation paths:

1. Avoid full evaluator recreation on many incremental edits
- Today, dependency dirtying often ends up recreating the evaluator, which drops all type cache state and causes expensive re-evaluation in program.ts and program.ts.
- Improvement: keep evaluator instance and add selective invalidation by file semantic version plus dependent subgraph keys.
- Impact: large win for typing latency in big workspaces where edits are local.

2. Make library content-only invalidation truly targeted end-to-end
- You already accumulate changed library files and route content-only changes separately in service.ts and backgroundAnalysisProgram.ts.
- Improvement: ensure only affected import closure is reanalyzed, not broad mark-all fallback when changed files are known.
- Impact: much less churn during pip install upgrades that touch many files but not import graph roots used by current workspace.

3. Add cache generations instead of map replacement for frequent invalidations
- Current design often replaces full maps in evaluator disposal paths in typeEvaluator.ts.
- Improvement: add generation-tagged cache entries and advance generation on invalidation scopes.
- Impact: less allocation pressure and GC spikes than wholesale map replacement.

4. Tighten cancellation resilience without discarding full evaluator
- Cancellation with possibly invalid partial state currently triggers evaluator recreation via isTypeCacheInvalid in cancellationUtils.ts and catch paths in program.ts.
- Improvement: isolate risky partial writes (function/lambda inference paths) into transactional mini-caches committed only on success.
- Impact: fewer global cache resets during heavy cancellation storms from rapid editor activity.

5. Introduce adaptive cache budgets per workspace shape
- Cache pressure is currently managed by global ratios and hard thresholds in program.ts and cacheManager.ts.
- Improvement: tune limits dynamically from user-file count, open-file count, and cold-start vs steady-state phase.
- Impact: better memory stability on low-memory machines and better warm-cache retention on large-memory machines.

6. Reduce parse/bind retention for cold files more aggressively
- Parse/bind drops are available via dropParseAndBindInfo in sourceFile.ts and used in empty cache flows in program.ts.
- Improvement: proactively age out parse/bind for cold, closed, non-error files during idle windows, not only high-memory events.
- Impact: lower steady-state RSS without impacting active-file responsiveness much.

7. Separate import-resolution cache invalidation domains
- Import resolver cache gets broadly invalidated in invalidation flows like backgroundAnalysisProgram.ts.
- Improvement: split resolver cache by root/search-path segment and invalidate by affected subtree.
- Impact: faster recovery from structural file events, especially monorepos with many roots.

8. Improve watcher event coalescing semantics
- Source watcher and library watcher already debounce and classify event kinds in service.ts and service.ts.
- Improvement: add event coalescing by canonical package boundary and ignore transient installer temp patterns more aggressively.
- Impact: fewer redundant invalidate-and-reanalyze cycles during package manager operations.

9. Add high-value telemetry before changing architecture
- Add counters/timers around:
- evaluator recreations by reason
- markAllFilesDirty vs markFilesDirty ratio
- library content-only changes that still fall back to broad dirtying
- cache miss cost by node category
- Then optimize the dominant causes first.

If you want, I can turn this into a concrete implementation plan with 2 quick wins first:
1. targeted invalidation hardening for library content-only changes
2. cancellation-safe mini-cache for inference paths
and map each to exact edit points and tests.
# Refactor Retrospective: Type Evaluator Modularization

## Original Goals & Constraints

### Goal
Refactor `typeEvaluator.ts` (~28,000 lines) — one of the largest single files in the Pyright codebase — into smaller, topic-focused modules while **preserving exact behavior**, public API, and performance characteristics.

### Constraints
1. **Zero semantic changes** — every extraction must be purely mechanical (move function, add import, delegate)
2. **No import cycles** — `codeFlowEngine.ts` must never import evaluator; sub-modules must not import the façade
3. **V8 performance preservation** — no megamorphic dispatch, no shape churn, no state splitting
4. **Incremental validation** — `npm run typecheck` after every extraction, full test suite (2,323 tests) periodically
5. **Commit after each validated slice** — atomic, reviewable, revertable history

### Approach
Phase-based extraction using context-injection patterns:
- Phase 2: Pure helpers (no deps)
- Phase 3: Prefetched context + AddDiagnosticFn callback injection
- Phase 4: TypeEvaluator interface param injection
- Phase 5-6: Deep extraction via expanded TypeEvaluator interface (~100+ functions)
- Phase 7: Split evaluatorCore.ts into topic-focused sub-modules with dual-import pattern

---

## What We Accomplished

### Quantitative Results
- **typeEvaluator.ts**: 28,000 → 17,415 lines (**38% reduction**)
- **evaluatorCore.ts**: Created at 0 → grew to 10,883 → split down to 2,757 lines
- **8 new topic modules** created (11,756 lines total)
- **200+ functions** delegated from closure to modules
- **134 commits** on `typeEval-explained` branch
- **58 tracked todos** completed
- **13 checkpoints** saved
- **All 2,323 tests passing** throughout

### Modules Created
| Module | Lines | Functions | Description |
|--------|-------|-----------|-------------|
| expressionEvaluation.ts | 2,162 | 25 | Expression type evaluation |
| assignFunctions.ts | 1,843 | 8 | Type assignment/compatibility |
| specialFormCreation.ts | 1,474 | 31 | ClassVar, Final, Annotated, etc. |
| memberResolution.ts | 1,120 | 23 | Member access, symbol resolution |
| typeVarHandling.ts | 1,108 | 15 | TypeVar/variance/expansion |
| collectionInference.ts | 1,039 | 9 | Dict/list/set/comprehension inference |
| overrideValidation.ts | 603 | 3 | Override method validation |
| pureHelpers.ts | 45 | 2 | Stateless utilities |

---

## Tools Used & How Time Was Spent

### Primary Tools
| Tool | Usage Pattern | Frequency |
|------|--------------|-----------|
| **powershell** (sync) | `npm run typecheck`, `npm test`, `git commit`, Python scripts for multi-block deletion | Very high — dominant tool |
| **view** | Reading file sections to understand function boundaries, imports | Very high |
| **edit** | Surgical import additions, function body removal, delegation wrapper creation | Very high |
| **create** | New module files (8 modules) | Low (8 times) |
| **grep** | Finding import sources, function call sites, checking leaf vs non-leaf | High |
| **glob** | Finding files by pattern | Low |
| **task (explore)** | Analyzing function groupings in evaluatorCore | Moderate |
| **store_memory** | Recording build commands, conventions | Low (a few times) |
| **sql** | Todo tracking (58 items) | Moderate |
| **ask_user** | Confirming approach, direction changes | Low |

### Time Sinks (Where Bottlenecks Were)

#### 1. **Import Resolution** (~30-40% of effort)
Every function extraction required:
- Identify all types/functions the moved code references
- Find where each symbol is exported from (which file, which import path)
- Add the correct import statement to the new module
- Run typecheck → discover more missing imports → repeat

This was the single biggest time sink. Each extraction required 2-5 typecheck cycles just to resolve imports. The `Select-String` approach worked but was slow and error-prone.

**Specific pain points:**
- Symbols exported from unexpected locations (`ParamKind` from `parameterUtils` not `types`, `isPrivateOrProtectedName` from `analyzer/symbolNameUtils` not `common/`)
- Namespace imports (`import * as ScopeUtils`) vs named imports
- Re-exported symbols (available through evaluatorCore but actually defined in specialFormCreation)
- Type-only imports vs value imports

#### 2. **Multi-Block Deletion from evaluatorCore.ts** (~15-20% of effort)
When removing multiple non-contiguous function blocks, line numbers shift after each deletion. Required:
- Bottom-up deletion (highest line numbers first)
- Python scripts for reliable multi-block removal
- Manual verification that the right code was removed
- PowerShell regex proved unreliable for this

#### 3. **Cross-Module Import Updates** (~10% of effort)
When function X moves from evaluatorCore to moduleA, any other sub-module importing X from evaluatorCore must be updated. Easy to miss; discovered only at typecheck time.

#### 4. **Typecheck Iteration** (~15% of effort)
Each `npm run typecheck` took ~60-90 seconds. With 2-5 cycles per extraction × ~30 extractions = 60-150 typecheck runs. Pure wall-clock time.

#### 5. **Delegation Wrapper Creation** (~10% of effort)
Each function needs a wrapper in `typeEvaluator.ts` that calls the module version. Mechanical but tedious — copy signature, add namespace prefix, pass `evaluatorInterface`/`prefetched`.

---

## Ideas to Improve for Next Time

### MCP Tools That Could Have Helped

#### 1. **TypeScript Language Server MCP** ⭐⭐⭐ (Highest impact)
A language server running `tsserver` or `typescript-language-server` could have:
- **Auto-resolved imports**: "Where is `ParamKind` exported from?" → instant answer
- **Find all references**: "Who calls `getAbstractSymbolInfoWithEvaluator`?" → instant leaf/non-leaf classification
- **Rename symbol**: Safely rename across files
- **Go to definition**: Jump to actual source of re-exported symbols
- **Diagnostics on save**: Incremental errors without full `tsc --noEmit` runs (seconds vs 60-90s)

This single tool would have eliminated ~50% of the import resolution time sink and drastically cut typecheck iteration. **The IDE already has this running** — an MCP bridge to it would be transformative.

#### 2. **AST/Code Analysis MCP** ⭐⭐⭐
A tool that could parse TypeScript and answer structural questions:
- "List all exported functions in evaluatorCore.ts with their line ranges and parameter lists"
- "Which functions in evaluatorCore.ts call `createSpecializedClassTypeWithEvaluator`?"
- "Extract function body at lines 1642-2157 with all its local references"
- "Generate import statements needed for these symbols: [list]"

We built ad-hoc Python/PowerShell scripts for this repeatedly. A purpose-built AST tool would be faster and more reliable.

#### 3. **Incremental TypeScript Type Checker MCP** ⭐⭐
Instead of running full `tsc --noEmit` (60-90s), an incremental checker that:
- Watches for file changes
- Reports errors for just the changed files (seconds, not minutes)
- Could be `tsc --watch` piped through an MCP

We could have used `tsc --watch` in async mode, but the MCP integration would make error consumption smoother.

#### 4. **Code Transformation MCP** ⭐⭐
A tool specialized for mechanical code moves:
- "Move function `foo` from file A to file B, updating all imports"
- "Create delegation wrapper for function `foo` in file C using namespace `Bar`"
- "Remove lines 500-850 and 1200-1400 from file A" (bottom-up safe)

This would automate the most mechanical 60% of each extraction.

#### 5. **Git Diff Review MCP** ⭐
The `code-review` agent was available but underused. Could have caught:
- Accidentally deleted re-export blocks (happened once with specialFormCreation)
- Missing cross-module import updates
- Incomplete function body removals

### Process Improvements

#### 1. **Batch Import Resolution Before Extraction**
Instead of: move code → typecheck → fix imports → typecheck → fix more → typecheck
Do: analyze all symbols in target functions → resolve all imports upfront → move code → single typecheck

We partially did this for later extractions (memberResolution had most imports pre-resolved) but could have been more systematic from the start.

#### 2. **Use `tsc --watch` Throughout**
Running `tsc --watch` in async mode would give ~5-second feedback instead of 60-90 seconds per typecheck. We never set this up, despite it being available. Would have saved enormous wall-clock time.

#### 3. **Build a Reusable Extraction Script**
A Python script that:
1. Takes a list of function names
2. Finds their boundaries in the source file
3. Extracts them (bottom-up removal)
4. Analyzes all referenced symbols
5. Resolves import sources
6. Generates the new module file with imports
7. Generates delegation wrappers

We built pieces of this ad-hoc but never consolidated. For ~30 extraction batches, the upfront investment would have paid off after batch 3.

#### 4. **Leaf Function Pre-Classification**
We repeatedly analyzed "which functions are leaf vs non-leaf." This should have been done once upfront with a comprehensive script and stored in a SQL table, updated as functions were moved.

#### 5. **Import Source Cache**
We looked up "where is symbol X exported from?" dozens of times, often for the same symbols. Should have built a lookup table early:
```sql
CREATE TABLE import_sources (symbol TEXT, file_path TEXT, import_style TEXT);
```

#### 6. **Parallel Agent Usage**
The `explore` agent was used occasionally but could have been used more aggressively:
- Parallel exploration of multiple function dependencies
- Parallel verification of multiple module import correctness
- Pre-screening cross-module dependencies before extraction

### What Worked Well

1. **Dual-import pattern** — Clean cycle prevention, no architectural rework needed
2. **Bottom-up deletion via Python** — Once discovered, this was reliable
3. **Atomic commits** — Every extraction was independently revertable
4. **SQL todo tracking** — Made progress visible across context compactions
5. **Checkpoint summaries** — Preserved critical context across 13 compaction events
6. **Full test suite gates** — Caught real issues (missing re-export block, wrong import paths)
7. **Architecture doc as living document** — Kept the team (and future AI assistants) aligned

### Key Lessons Learned

1. **Import resolution dominates refactoring time** in TypeScript. Any tool that accelerates this has outsized impact.
2. **Incremental type checking is essential** for iterative refactoring. 60-90s per cycle is too slow for this workflow.
3. **Mechanical refactoring should be scripted**, not done by hand — even by an AI. The error rate for manual multi-block operations is too high.
4. **Context window management is a first-class concern**. With 13 compactions, each requiring careful state preservation, ~20-30% of cognitive overhead went to "remember what we were doing."
5. **The closure variable barrier is the real challenge**. Moving functions between files is mechanical; breaking the closure dependency is an architectural decision that requires human input.

---

## Remaining Work

### Immediate (evaluatorCore further extraction)
- 76 functions (~2,757 lines) remain, 63 are leaf — diminishing returns
- Largest cluster: type specialization (~850 lines, non-leaf, must move together)

### Strategic (closure variable barrier)
- ~150 functions (~17,400 lines) in typeEvaluator.ts blocked by closure variables
- Options A (Context class), B (Expand interface), C (Internal state object) — needs human decision
- This is the real unlock for getting typeEvaluator.ts below 5,000 lines

### Documentation
- Architecture doc is current
- No code-level documentation added to new modules (JSDoc, etc.)

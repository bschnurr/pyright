# Fast Parse Tree Walking for Pyright

## Background

The Reflex article “Why AST Walk When You Can AST Sprint?” argues that generic AST traversal can become a major performance bottleneck. The core issue is not that AST traversal is inherently slow, but that many standard traversal implementations do unnecessary work:

* allocate temporary child arrays;
* use generic reflection-style APIs;
* create iterator/generator overhead;
* yield field/value tuples;
* repeatedly perform dynamic checks;
* visit every node even when a pass only cares about a small subset;
* walk the same tree multiple times for separate analyses.

The transferable idea for Pyright is:

> Do not use a generic parse-tree walker when the pass only needs predictable, typed child traversal.

Pyright already has a strongly typed parse tree and `ParseNodeType` enum, so it does not suffer from the same Python reflection overhead described in the Reflex article. But Pyright still has opportunities to reduce traversal overhead, especially in places where walkers allocate child arrays, call generic visitor methods, or repeat similar scans.

The goal of this prototype is to bring the “AST sprint” idea into Pyright in a low-risk, TypeScript-native way.

---

# 1. Main Design Idea

## Current Pattern

Pyright’s current generic walker shape is roughly:

```ts
walk(node: ParseNode) {
    const childrenToWalk = this.visitNode(node);
    if (childrenToWalk.length > 0) {
        this.walkMultiple(childrenToWalk);
    }
}
```

This pattern has several costs:

* `getChildNodes` may allocate a fresh array for each non-leaf node.
* Some node implementations use spread operators to assemble child lists.
* `walkMultiple` may use callback-style iteration.
* Every traversal pays the same generic visitor cost, even when the pass only cares about a few node kinds.

## Proposed Pattern

Replace child-list materialization with direct child walking:

```ts
walk(node: ParseNode): void {
    if (this.visit(node)) {
        walkChildren(this, node);
    }
}
```

`walkChildren` is generated from a declarative description of parse-node child fields:

```ts
export function walkChildren(walker: ParseTreeWalker, node: ParseNode): void {
    switch (node.nodeType) {
        case ParseNodeType.Call:
            walker.walk(node.d.leftExpr);
            for (let i = 0; i < node.d.args.length; i++) {
                walker.walk(node.d.args[i]);
            }
            return;

        case ParseNodeType.Function:
            for (let i = 0; i < node.d.decorators.length; i++) {
                walker.walk(node.d.decorators[i]);
            }

            walker.walk(node.d.name);

            if (node.d.typeParams) {
                walker.walk(node.d.typeParams);
            }

            for (let i = 0; i < node.d.params.length; i++) {
                walker.walk(node.d.params[i]);
            }

            if (node.d.returnAnnotation) {
                walker.walk(node.d.returnAnnotation);
            }

            if (node.d.funcAnnotationComment) {
                walker.walk(node.d.funcAnnotationComment);
            }

            walker.walk(node.d.suite);
            return;
    }
}
```

This preserves traversal order while avoiding temporary arrays.

## Implemented Prototype Update

The prototype has now moved beyond the initial compatibility phase:

* `getChildNodes` delegates to generated `forEachChild`.
* `ParseTreeWalker.walk` uses generated `walkChildren` directly.
* `ParseTreeWalker.visitNode` returns a boolean that controls whether children are walked.
* Binder, Checker, and lower-risk utility/language-service walkers have been validated on the generated traversal path.
* Code that genuinely needs child arrays, such as `TestWalker`, `TreeDumper`, `findNodeByOffset`, and the benchmark array baseline, now calls `getChildNodes` explicitly.
* The temporary `DirectParseTreeWalker` compatibility alias has been removed; migrated walkers now extend `ParseTreeWalker` directly.

---

# 2. Goals

## Primary Goals

* Eliminate temporary child-array allocation from hot parse-tree traversal.
* Preserve existing traversal order and visitor behavior.
* Generate child-walking code from a declarative child-field table.
* Keep `getChildNodes` available for existing utilities.
* Add a sparse visitor mode for passes that care about only a few node types.
* Fuse repeated scans into a single module-level scan where possible.
* Add instrumentation so the performance effect is measurable.

## Non-Goals

* Do not rewrite the parser.
* Do not replace the object parse tree initially.
* Do not port traversal logic to Rust, Go, C++, or WASM.
* Do not change binder or checker semantics.
* Do not use unordered traversal in passes where order matters.
* Do not prematurely optimize type-evaluator logic until parse-tree traversal overhead is measured.

---

# 3. Architecture

## 3.1 Generated `walkChildren`

Create a generated file:

```ts
packages/pyright-internal/src/parser/generated/walkChildren.ts
```

Exports:

```ts
export function walkChildren(walker: ParseTreeWalker, node: ParseNode): void;
export function forEachChild(node: ParseNode, callback: (child: ParseNode) => void): void;
```

`walkChildren` is used by the high-performance walker.

`forEachChild` is used by compatibility APIs like `getChildNodes`.

## 3.2 Child Field Specification

Create a source-of-truth child-field table:

```ts
packages/pyright-internal/src/parser/childFields.ts
```

Example shape:

```ts
export const childFields = {
    [ParseNodeType.Call]: {
        single: ["leftExpr"],
        arrays: ["args"],
    },

    [ParseNodeType.Function]: {
        arrays: ["decorators", "params"],
        single: ["name", "suite"],
        optional: ["typeParams", "returnAnnotation", "funcAnnotationComment"],
    },
};
```

The generator reads this table and emits direct TypeScript switch statements.

## 3.3 Updated `ParseTreeWalker`

Current walker should be refactored from:

```ts
const children = getChildNodes(node);
this.walkMultiple(children);
```

to:

```ts
if (this.visit(node)) {
    walkChildren(this, node);
}
```

The existing visitor methods remain unchanged.

## 3.4 Compatibility `getChildNodes`

Keep:

```ts
export function getChildNodes(node: ParseNode): ParseNode[];
```

But implement it using `forEachChild`:

```ts
export function getChildNodes(node: ParseNode): ParseNode[] {
    const children: ParseNode[] = [];
    forEachChild(node, (child) => {
        children.push(child);
    });
    return children;
}
```

This prevents duplicated child-field logic.

---

# 4. Sparse Visitor Design

Many passes only care about a small subset of nodes.

Examples:

* import collectors;
* symbol indexers;
* semantic doc builders;
* name occurrence collectors;
* call-site scanners;
* decorator scanners;
* docstring extractors;
* simple refactor detectors.

A sparse walker avoids calling `visitXXX` for every node.

## Proposed API

```ts
export abstract class SparseParseTreeWalker {
    private readonly _interestedNodeTypes: Uint8Array;

    constructor(interestedNodeTypes: readonly ParseNodeType[]) {
        this._interestedNodeTypes = buildNodeTypeBitset(interestedNodeTypes);
    }

    walk(node: ParseNode): void {
        if (this._interestedNodeTypes[node.nodeType]) {
            if (!this.visitInterestedNode(node)) {
                return;
            }
        }

        walkChildrenSparse(this, node);
    }

    protected abstract visitInterestedNode(node: ParseNode): boolean;
}
```

A pass that only cares about calls and names could say:

```ts
class NameAndCallScanner extends SparseParseTreeWalker {
    constructor() {
        super([
            ParseNodeType.Name,
            ParseNodeType.Call,
            ParseNodeType.MemberAccess,
        ]);
    }

    protected visitInterestedNode(node: ParseNode): boolean {
        switch (node.nodeType) {
            case ParseNodeType.Name:
                this._recordName(node);
                return true;

            case ParseNodeType.Call:
                this._recordCall(node);
                return true;

            case ParseNodeType.MemberAccess:
                this._recordMemberAccess(node);
                return true;
        }

        return true;
    }
}
```

This avoids method dispatch for every uninterested node.

---

# 5. Fused Module Scan

The biggest long-term gain may come from walking less often.

Instead of separate scans for:

* imports;
* top-level symbols;
* classes;
* functions;
* decorators;
* docstrings;
* calls;
* name occurrences;
* member accesses;
* string annotations;
* `__all__`;
* semantic metadata;

create one module scan that collects a compact sidecar.

## Proposed Interface

```ts
export interface ModuleScan {
    imports: ImportInfo[];
    classes: ClassInfo[];
    functions: FunctionInfo[];
    variables: VariableInfo[];
    names: NameOccurrence[];
    memberAccesses: MemberOccurrence[];
    calls: CallOccurrence[];
    decorators: DecoratorInfo[];
    docstrings: DocStringInfo[];
    stringAnnotations: StringAnnotationInfo[];
    dunderAllAssignments: DunderAllInfo[];
}
```

This sidecar is not meant to replace type checking. It is for cheap structural metadata.

Potential consumers:

* import completions;
* document symbols;
* semantic doc generation;
* AI semantic metadata;
* rename previews;
* code navigation;
* indexing;
* usage search;
* quick fixes that do not require full type evaluation.

---

# 6. Traversal Modes

## 6.1 Ordered Traversal

Use ordered traversal for:

* binder;
* checker;
* diagnostics;
* semantic token generation where order matters;
* any pass that depends on Python execution or declaration order.

## 6.2 Unordered or Stack-Based Traversal

Use unordered traversal only when order does not matter.

Possible candidates:

* broad indexing;
* “does this file contain X?” scans;
* import-name discovery;
* AI metadata extraction;
* search-oriented sidecar generation;
* parse-tree statistics.

Stack-based traversal can avoid recursion overhead and may improve cache behavior, but should be introduced separately from the first prototype.

---

# 7. Prototype Tasks

## Phase 1 — Direct Child Walker

### Task 1.1 — Audit Current `ParseTreeWalker`

Find all direct and indirect uses of:

```ts
getChildNodes
walkMultiple
visitNode
```

Classify usages:

* core walker usage;
* binder/checker usage;
* utility usage;
* tests;
* rare/debug-only usage.

Deliverable:

```md
docs/design/parse-tree-walker-audit.md
```

Estimated effort: Small.

---

### Task 1.2 — Define Child-Field Specification

Create:

```ts
packages/pyright-internal/src/parser/childFields.ts
```

The file maps each `ParseNodeType` to child fields.

Example:

```ts
export const childFields = {
    [ParseNodeType.Call]: {
        single: ["leftExpr"],
        arrays: ["args"],
    },
    [ParseNodeType.Function]: {
        arrays: ["decorators", "params"],
        single: ["name", "suite"],
        optional: ["typeParams", "returnAnnotation", "funcAnnotationComment"],
    },
} as const;
```

Design requirements:

* include every `ParseNodeType`;
* distinguish required single child, optional child, and child arrays;
* preserve exact traversal order;
* avoid derived/non-child fields;
* include tests that detect missing node kinds.

Estimated effort: Medium.

---

### Task 1.3 — Build Generator

Create:

```ts
packages/pyright-internal/src/parser/tools/generateWalkChildren.ts
```

The generator emits:

```ts
packages/pyright-internal/src/parser/generated/walkChildren.ts
```

Generated exports:

```ts
export function walkChildren(walker: ParseTreeWalker, node: ParseNode): void;
export function forEachChild(node: ParseNode, callback: (child: ParseNode) => void): void;
```

Generation rules:

* use `switch (node.nodeType)`;
* use plain `for` loops for arrays;
* avoid `.forEach`;
* avoid spread operators;
* avoid temporary child arrays;
* preserve child order;
* null-check optional fields;
* return immediately after each case.

Estimated effort: Medium.

---

### Task 1.4 — Refactor `ParseTreeWalker`

Change the main walker from child-array traversal to direct traversal.

Before:

```ts
const childrenToWalk = this.visitNode(node);
if (childrenToWalk.length > 0) {
    this.walkMultiple(childrenToWalk);
}
```

After:

```ts
if (this.visitNode(node)) {
    walkChildren(this, node);
}
```

Potential compatibility bridge:

```ts
protected visitNode(node: ParseNode): boolean {
    // Existing visit dispatch.
}
```

If current APIs return `ParseNode[]`, introduce a compatibility adapter first, then migrate to boolean-returning visitors.

Estimated effort: Medium.

---

### Task 1.5 — Keep `getChildNodes`

Update `getChildNodes` to use `forEachChild`.

```ts
export function getChildNodes(node: ParseNode): ParseNode[] {
    const children: ParseNode[] = [];
    forEachChild(node, (child) => children.push(child));
    return children;
}
```

This preserves external behavior while consolidating child-field knowledge.

Estimated effort: Small.

---

### Task 1.6 — Add Equivalence Tests

For every parse-node type:

* compare old `getChildNodes` output with generated `forEachChild`;
* verify same number of children;
* verify same identity/order of children;
* run on a corpus of Python snippets.

Test corpus should include:

* functions;
* classes;
* decorators;
* comprehensions;
* match statements;
* type aliases;
* imports;
* calls;
* lambdas;
* unions;
* string annotations;
* nested suites.

Estimated effort: Medium.

---

## Phase 2 — Remove Iteration Overhead

### Task 2.1 — Replace `walkMultiple` Callback Loops

Refactor any `forEach` or callback-style traversal into plain loops:

```ts
for (let i = 0; i < nodes.length; i++) {
    this.walk(nodes[i]);
}
```

Estimated effort: Small.

---

### Task 2.2 — Remove Spread-Based Child Assembly

Find code patterns like:

```ts
return [node.d.leftExpr, ...node.d.args];
```

Replace with generated direct traversal.

Estimated effort: Small.

---

### Task 2.3 — Add Debug Allocation Counters

Add debug-only counters:

```ts
interface ParseTreeWalkStats {
    nodesVisited: number;
    childArraysAllocated: number;
    childEdgesVisited: number;
    maxDepth: number;
}
```

Use these to compare old vs new traversal.

Estimated effort: Small.

---

## Phase 3 — Sparse Visitors

### Task 3.1 — Implement `SparseParseTreeWalker`

Create:

```ts
packages/pyright-internal/src/analyzer/sparseParseTreeWalker.ts
```

Skeleton:

```ts
export abstract class SparseParseTreeWalker {
    private readonly _interestedNodeTypes: Uint8Array;

    constructor(interestedNodeTypes: readonly ParseNodeType[]) {
        this._interestedNodeTypes = createNodeTypeBitset(interestedNodeTypes);
    }

    walk(node: ParseNode): void {
        if (this._interestedNodeTypes[node.nodeType]) {
            if (!this.visitInterestedNode(node)) {
                return;
            }
        }

        walkChildrenSparse(this, node);
    }

    protected abstract visitInterestedNode(node: ParseNode): boolean;
}
```

Estimated effort: Medium.

---

### Task 3.2 — Create Helper for Bitsets

Create:

```ts
function createNodeTypeBitset(nodeTypes: readonly ParseNodeType[]): Uint8Array {
    const bitset = new Uint8Array(ParseNodeType.Count);
    for (let i = 0; i < nodeTypes.length; i++) {
        bitset[nodeTypes[i]] = 1;
    }
    return bitset;
}
```

If `ParseNodeType.Count` does not exist, add a safe equivalent.

Estimated effort: Small.

---

### Task 3.3 — Convert One Simple Pass

Pick one low-risk pass.

Candidate passes:

* import collector;
* docstring scanner;
* symbol/name collector;
* semantic metadata scanner;
* call-site collector.

Convert it to sparse traversal.

Measure:

* wall-clock time;
* nodes visited;
* visitor dispatches avoided;
* memory allocations.

Estimated effort: Medium.

---

### Task 3.4 — Convert Additional Passes

After one successful conversion, migrate more passes.

Priority order:

1. Import collector.
2. Symbol indexer.
3. Docstring scanner.
4. Semantic document builder.
5. AI metadata scanner.
6. Rename-preview scanner.

Estimated effort: Large.

---

## Phase 4 — Fused Module Scan

### Task 4.1 — Design `ModuleScan`

Create:

```ts
packages/pyright-internal/src/analyzer/moduleScan.ts
```

Initial structure:

```ts
export interface ModuleScan {
    imports: ImportInfo[];
    classes: ClassInfo[];
    functions: FunctionInfo[];
    variables: VariableInfo[];
    names: NameOccurrence[];
    memberAccesses: MemberOccurrence[];
    calls: CallOccurrence[];
    docstrings: DocStringInfo[];
    stringAnnotations: StringAnnotationInfo[];
}
```

Keep this sidecar cheap and syntax-oriented.

Estimated effort: Medium.

---

### Task 4.2 — Implement `ModuleScanner`

Create:

```ts
export function scanModule(parseTree: ModuleNode): ModuleScan;
```

Use sparse traversal or direct `walkChildren`.

The scanner should collect:

* import statements;
* class definitions;
* function definitions;
* decorators;
* assignment targets;
* name usages;
* member access expressions;
* call expressions;
* docstrings;
* string annotations.

Estimated effort: Large.

---

### Task 4.3 — Add Sidecar Cache

Cache `ModuleScan` per source file version.

Invalidation key:

* file path;
* parse tree version;
* text version;
* config-affecting options if needed.

Estimated effort: Medium.

---

### Task 4.4 — Refactor Consumers

Move selected utilities from “walk the parse tree yourself” to “consume `ModuleScan`.”

Best initial consumers:

* document symbols;
* import completions;
* AI semantic document generation;
* simple code search helpers.

Estimated effort: Large.

---

## Phase 5 — Benchmarking

### Task 5.1 — Add Walker Timing

Use Node `perf_hooks` or existing Pyright timing utilities.

Track:

```ts
interface WalkerBenchmarkStats {
    passName: string;
    totalMs: number;
    nodesVisited: number;
    childEdgesVisited: number;
    visitorDispatches: number;
    childArraysAllocated: number;
}
```

Estimated effort: Small.

---

### Task 5.2 — Build Benchmark Harness

Create:

```ts
packages/pyright-internal/src/tests/harness/parseTreeWalkerPerf.test.ts
```

Benchmark targets:

* large generated file;
* deeply nested expressions;
* many small functions;
* many imports;
* NumPy/Pandas stubs;
* transformer-style `__init__.py`;
* match-heavy code;
* decorator-heavy code;
* type-annotation-heavy code.

Estimated effort: Medium.

---

### Task 5.3 — Compare Old vs New Walker

Add a temporary flag:

```ts
useGeneratedWalkChildren: boolean
```

Run both implementations on the same input.

Compare:

* total analysis time;
* traversal-only time;
* allocations;
* GC pressure;
* memory peak;
* correctness test results.

Estimated effort: Medium.

---

### Task 5.4 — Record Results

Create:

```md
docs/design/parse-tree-walker-results.md
```

Include:

* benchmark setup;
* before/after numbers;
* flamegraphs if available;
* regressions;
* surprising findings;
* recommendation for rollout.

Estimated effort: Medium.

---

## Phase 6 — Optional Flat Sidecar AST

This is a future optimization, not part of the first implementation.

Represent parse-tree metadata as typed arrays:

```ts
interface FlatAst {
    nodeType: Uint16Array;
    start: Uint32Array;
    length: Uint32Array;
    firstChild: Uint32Array;
    nextSibling: Uint32Array;
}
```

Potential advantages:

* linear memory layout;
* better cache locality;
* faster broad scans;
* easier worker-thread transfer;
* compact index storage.

Potential disadvantages:

* duplicates parse-tree structure;
* adds parser complexity;
* requires mapping back to object nodes;
* may not help type-checker logic.

Prototype only after generated direct traversal is benchmarked.

---

# 8. Rollout Plan

## Step 1

Landed generated `forEachChild` behind tests.

No behavior change.

## Step 2

Updated `getChildNodes` to use generated `forEachChild`.

Still no behavior change.

## Step 3

Added an opt-in direct walker path and migrated low-risk internal passes.

Full test suite and focused traversal tests passed.

## Step 4

Enabled generated traversal for Binder and Checker after lower-risk passes were validated.

Full test suite, benchmark smoke, and real-world PyTorch diagnostics parity passed.

## Step 5

Switched `ParseTreeWalker` itself to generated `walkChildren`.

## Step 6

Future work: consider sparse visitors and fused module scans only if additional profiling shows repeated syntax scans remain significant.

---

# 9. Risks

## Risk: Child order mismatch

Mitigation:

* equivalence tests against old `getChildNodes`;
* corpus-based tests;
* full Pyright test suite.

## Risk: Missing child field

Mitigation:

* generator completeness checks;
* exhaustive `ParseNodeType` coverage;
* tests for every node type.

## Risk: Harder maintenance

Mitigation:

* declarative child-field table;
* generated code clearly marked;
* CI check that generated output is up to date.

## Risk: Small whole-program win

Mitigation:

* benchmark before broad migration;
* focus on traversal-heavy passes first;
* use sparse visitors and fused scans where direct walker alone is insufficient.

## Risk: Binder/checker subtle regression

Mitigation:

* migrate lower-risk walkers first;
* preserve traversal order exactly;
* run focused analyzer tests, full test suite, benchmark smoke, and real-world PyTorch corpus;
* verify diagnostics parity against upstream.

---

# 10. Expected Impact

The Reflex article reports very large speedups because Python’s standard AST walking has high generic overhead.

Pyright should not expect that scale because:

* it already uses typed nodes;
* it runs on V8;
* many hot costs are in type evaluation, not traversal;
* not all passes are traversal-bound.

Realistic expectations:

* `getChildNodes`-heavy passes: possibly 1.2× to 2× faster.
* Sparse visitor passes: potentially bigger wins if they currently dispatch on every node.
* Whole-program type checking: likely smaller unless traversal is visible in profiles.
* Pylance indexing and semantic metadata: potentially meaningful improvement.
* Memory and GC pressure: likely improved due to fewer temporary arrays.

---

# 11. Measured Results

## Parse-Tree Walker Microbenchmark

The final benchmark smoke after switching the base `ParseTreeWalker` to generated traversal showed the clearest signal on the scaled corpus:

| Corpus | Array child traversal | Generated child traversal | Allocation change |
| --- | ---: | ---: | ---: |
| `large_stdlib_10x` | 7.17ms | 4.01ms | 83,821 child arrays to 0 |

This is about a 1.8x raw traversal speedup on the scaled corpus. Smaller corpora are noisier, but generated traversal generally remains competitive or faster while eliminating child-list allocations.

## PyTorch End-to-End CLI Benchmark

Benchmark setup:

* Current worktree CLI was rebuilt with `npm run build:cli:dev`.
* Upstream CLI was built from `upstream/main` in `C:\dev\pyright-upstream-bench`.
* The upstream benchmark commit was `f744c7803`, which is also the merge-base for the worktree branch.
* Command shape: `node <pyright-index.js> C:\dev\pytorch --stats`.
* PyTorch had no root `pyrightconfig.json`, so both runs used the same default CLI behavior.
* Diagnostics matched across runs: 117,260 errors, 1,870 warnings, 83 informations.

Warmed comparison:

| CLI | Wall time | Pyright completed time | Bind | Check |
| --- | ---: | ---: | ---: | ---: |
| upstream warm | 623.9s | 622.7s | 75.35s | 473.73s |
| worktree | 608.5s | 606.9s | 73.29s | 460.27s |

The worktree was about 15.8s faster end-to-end, or roughly 2.5% on this PyTorch run. Bind improved by about 2.7%, and Check improved by about 2.8%. The first upstream run completed in 731.4s because it included cold filesystem effects, so the warmed upstream run is the fairer comparison.

## How This Reduces Allocations

The old generic walker asked every node for a child list:

```ts
const childrenToWalk = this.visitNode(node);
this.walkMultiple(childrenToWalk);
```

That shape forced the traversal path to allocate a fresh child array for each visited node, even though the array was immediately consumed and discarded. Many child-list cases also used spreads or other temporary array assembly. On large repositories, this creates a stream of short-lived allocations that increases young-generation garbage collection pressure.

The generated traversal turns the child list into direct field visits:

```ts
if (this.visitNode(node)) {
    walkChildren(this, node);
}
```

`walkChildren` is generated from `childFields`, so each parse-node case directly calls `walker.walk` on known child fields and uses plain `for` loops for child arrays already stored on the parse node. The traversal no longer constructs a separate array just to tell the walker what to visit next.

For an engineering team, the important distinction is:

* We are not changing the parse tree shape.
* We are not changing analysis order.
* We are removing an allocation layer between “visit this node” and “walk its known children.”
* The few APIs that truly need a child array still call `getChildNodes`, so the allocation cost is now paid only by those explicit consumers, not by every default tree walk.

Correctness is protected by generated-output freshness checks, child-field coverage tests, runtime child-oracle tests, full Pyright tests, and real-world PyTorch diagnostics parity.

## Profiling and PGO Guidance

The next optimization pass should be profile-guided engineering rather than speculative traversal work. In a TypeScript/Node CLI, classic native compiler PGO is not directly available in the same way it is for C/C++ binaries. V8 already collects runtime feedback and JITs hot JavaScript dynamically. The practical equivalent for Pyright is to use CPU, heap, and GC profiles to choose the next code changes.

Recommended profiling commands:

```powershell
node --cpu-prof --cpu-prof-dir C:\temp\pyright-profiles `
    C:\dev\pyright-ast\packages\pyright\index.js C:\dev\pytorch --stats

node --heap-prof --heap-prof-dir C:\temp\pyright-profiles `
    C:\dev\pyright-ast\packages\pyright\index.js C:\dev\pytorch --stats

node --trace-gc C:\dev\pyright-ast\packages\pyright\index.js C:\dev\pytorch --stats `
    *> C:\temp\pyright-profiles\worktree-trace-gc.txt
```

Use the same commands against `C:\dev\pyright-upstream-bench\packages\pyright\index.js` for upstream comparison. CPU profiles can be loaded into Chrome DevTools or speedscope. Heap profiles and GC logs should answer whether the generated traversal change reduced allocation and GC pressure in a real workload, not just in the microbenchmark.

The decision rule for future work should be:

1. If CPU profiles still show parse-tree traversal or visitor dispatch as hot, pursue sparse visitors or remaining `getChildNodes` reductions.
2. If allocation profiles still show child-array or traversal-adjacent churn, target those allocation sites first.
3. If Check/Bind internals dominate, move optimization effort into the specific checker, binder, type evaluator, or import-resolution functions shown in the profile.
4. Do not start sparse visitors, fused module scans, or flat AST sidecars unless profiles show repeated syntax walking remains material.

## Captured Profiling Results

Profile artifacts were captured under:

```txt
C:\Users\bschnurr\.copilot\session-state\13a85e3b-5f4f-48be-8256-d0a3003cfdfc\files\pytorch-pyright-profiles
```

Key artifacts:

| Artifact | Size | Notes |
| --- | ---: | --- |
| `upstream.cpuprofile` | 746MB | V8 CPU profile for upstream PyTorch run |
| `worktree.cpuprofile` | 702MB | V8 CPU profile for worktree PyTorch run |
| `upstream.heapprofile` | 229KB | V8 sampled heap profile for upstream |
| `worktree.heapprofile` | 97KB | V8 sampled heap profile for worktree |
| `upstream-trace-gc-run.txt` | 23.5MB | Upstream `--trace-gc` output and Pyright stats |
| `worktree-trace-gc-run.txt` | 23.4MB | Worktree `--trace-gc` output and Pyright stats |

CPU-profiled comparison:

| CLI | Wall time | Pyright completed time | Bind | Check | GC samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| upstream CPU-profiled | 736.5s | 709.3s | 87.13s | 527.70s | 114,646 / 435,973 (26.30%) |
| worktree CPU-profiled | 718.3s | 692.5s | 86.36s | 524.40s | 110,416 / 422,653 (26.12%) |

The top non-GC CPU samples were filesystem calls (`lstat`, `readFileUtf8`, `readdir`, `existsSync`) and type comparison hot paths like `isTypeSame` / `_addTypeIfUnique`. This suggests the next optimization target should be chosen from CPU profiles rather than assuming parse-tree walking remains the dominant cost.

Heap-profiled comparison:

| CLI | Wall time | Pyright completed time | Bind | Check | Sampled heap bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| upstream heap-profiled | 714.9s | 713.9s | 92.88s | 534.31s | 29.9MB |
| worktree heap-profiled | 691.3s | 690.2s | 84.89s | 525.09s | 26.0MB |

The heap profiles are sampled and relatively small, so they should be treated as directional rather than exhaustive. In both runs, sampled allocations were dominated by `readFileSync` and broad checker/type-evaluator paths, not obvious parse-tree child-array frames.

GC trace comparison:

| CLI | Pyright completed time | GC events | GC pause total | Scavenge pause | Mark-Compact pause | Max heap before GC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| upstream trace-gc | 687.6s | 16,326 | 114.85s | 106.93s | 7.92s | 3,768.8MB |
| worktree trace-gc | 626.5s | 16,092 | 112.56s | 101.48s | 11.08s | 3,756.1MB |

The worktree trace had fewer GC events and about 2.3s less total GC pause, but GC remains a large share of runtime. The larger win in this trace was reduced Check time (525.89s to 473.42s). Future investigation should inspect CPU profiles for the checker/type-evaluator hot paths and use heap/GC data to verify whether any proposed change reduces allocation churn.

---

# 12. Best First Prototype

The best first prototype is intentionally narrow:

1. Generate `forEachChild`.
2. Rewrite `getChildNodes` using generated `forEachChild`.
3. Generate `walkChildren`.
4. Add a new walker path behind a flag.
5. Benchmark one traversal-heavy pass.
6. Only then migrate more code.

This avoids risky checker changes and gives measurable data quickly.

---

# 13. Example Generated Walker

Example generated output for `Call` and `Function`:

```ts
export function walkChildren(walker: ParseTreeWalker, node: ParseNode): void {
    switch (node.nodeType) {
        case ParseNodeType.Call: {
            const typedNode = node as CallNode;
            walker.walk(typedNode.d.leftExpr);

            for (let i = 0; i < typedNode.d.args.length; i++) {
                walker.walk(typedNode.d.args[i]);
            }

            return;
        }

        case ParseNodeType.Function: {
            const typedNode = node as FunctionNode;

            for (let i = 0; i < typedNode.d.decorators.length; i++) {
                walker.walk(typedNode.d.decorators[i]);
            }

            walker.walk(typedNode.d.name);

            if (typedNode.d.typeParams) {
                walker.walk(typedNode.d.typeParams);
            }

            for (let i = 0; i < typedNode.d.params.length; i++) {
                walker.walk(typedNode.d.params[i]);
            }

            if (typedNode.d.returnAnnotation) {
                walker.walk(typedNode.d.returnAnnotation);
            }

            if (typedNode.d.funcAnnotationComment) {
                walker.walk(typedNode.d.funcAnnotationComment);
            }

            walker.walk(typedNode.d.suite);
            return;
        }
    }
}
```

---

# 14. Example Generated `forEachChild`

```ts
export function forEachChild(node: ParseNode, callback: (child: ParseNode) => void): void {
    switch (node.nodeType) {
        case ParseNodeType.Call: {
            const typedNode = node as CallNode;
            callback(typedNode.d.leftExpr);

            for (let i = 0; i < typedNode.d.args.length; i++) {
                callback(typedNode.d.args[i]);
            }

            return;
        }

        case ParseNodeType.Function: {
            const typedNode = node as FunctionNode;

            for (let i = 0; i < typedNode.d.decorators.length; i++) {
                callback(typedNode.d.decorators[i]);
            }

            callback(typedNode.d.name);

            if (typedNode.d.typeParams) {
                callback(typedNode.d.typeParams);
            }

            for (let i = 0; i < typedNode.d.params.length; i++) {
                callback(typedNode.d.params[i]);
            }

            if (typedNode.d.returnAnnotation) {
                callback(typedNode.d.returnAnnotation);
            }

            if (typedNode.d.funcAnnotationComment) {
                callback(typedNode.d.funcAnnotationComment);
            }

            callback(typedNode.d.suite);
            return;
        }
    }
}
```

---

# 15. Example Generator Input

```ts
export const childFields = {
    Call: [
        { kind: "single", name: "leftExpr" },
        { kind: "array", name: "args" },
    ],

    Function: [
        { kind: "array", name: "decorators" },
        { kind: "single", name: "name" },
        { kind: "optional", name: "typeParams" },
        { kind: "array", name: "params" },
        { kind: "optional", name: "returnAnnotation" },
        { kind: "optional", name: "funcAnnotationComment" },
        { kind: "single", name: "suite" },
    ],
} as const;
```

This preserves explicit traversal order.

---

# 16. Example Benchmark Output

Target format:

```txt
ParseTreeWalker benchmark: pandas-stubs

Old walker:
  total ms: 142.3
  nodes visited: 2,910,233
  child arrays allocated: 812,410
  visitor dispatches: 2,910,233

Generated walker:
  total ms: 96.8
  nodes visited: 2,910,233
  child arrays allocated: 0
  visitor dispatches: 2,910,233

Delta:
  traversal speedup: 1.47x
  child array allocation reduction: 100%
```

Sparse visitor benchmark:

```txt
Import scanner benchmark: transformers

Generic walker:
  total ms: 31.4
  nodes visited: 602,100
  visitor dispatches: 602,100

Sparse walker:
  total ms: 12.7
  nodes visited: 602,100
  interested dispatches: 4,982

Delta:
  speedup: 2.47x
  dispatch reduction: 99.2%
```

---

# 17. Open Questions

Resolved by the prototype:

1. Generated `walkChildren.ts` is checked in.
2. `childFields` is hand-maintained from parse-node traversal order.
3. `ParseTreeWalker.visitNode` now returns a boolean.
4. Low-risk walkers migrated first, followed by Binder, Checker, and then the base walker.
5. Existing code that needs child arrays now calls `getChildNodes` explicitly.
6. Generated walker drift is guarded by `check:walkchildren` as part of root `npm run check`.

Still open for future work:

1. What do CPU, heap, and GC profiles show after the generated traversal change?
2. Should sparse visitor live beside `ParseTreeWalker` or replace parts of it later?
3. Should module scans be cached per source-file version?
4. Should module scans become part of the existing indexer pipeline?
5. Should we add a flat AST sidecar only for indexing?

---

# 18. Completed First PR

Title:

```txt
Prototype generated parse-tree child traversal
```

Scope:

* Add `childFields.ts`.
* Add `generateWalkChildren.ts`.
* Add generated `walkChildren.ts`.
* Add `forEachChild`.
* Rewrite `getChildNodes` using `forEachChild`.
* Add equivalence tests.
* Add benchmark scaffold.

Do not yet migrate the main checker/binder walker.

This first PR should be behavior-preserving and easy to review.

---

# 19. Completed Follow-Up PRs

Titles included:

```txt
Use direct walker for parse tree utility scans
Use direct walker for binder finders
Use direct walker for language-service scans
Use direct walker for analyzer utilities
Use direct walker for binder
Use direct walker for checker
Use generated traversal in base parse tree walker
```

Scope:

* Migrate low-risk walkers first.
* Migrate Binder and Checker after confidence was established.
* Switch the base `ParseTreeWalker` to generated `walkChildren`.
* Keep `getChildNodes` only for explicit array consumers.
* Run focused tests, full tests, benchmark smoke, and PyTorch CLI comparison.

---

# 20. Recommended Next PR

Title:

```txt
Add profile-guided benchmark artifacts
```

Scope:

* Add or document repeatable upstream-vs-worktree benchmark commands.
* Capture CPU, heap, and GC profiles for PyTorch upstream and worktree runs.
* Use profile data to choose the next optimization target.

---

# 21. Recommended Later PR

Title:

```txt
Introduce sparse parse-tree walker for syntax-only scans
```

Scope:

* Add `SparseParseTreeWalker` only if profiles show visitor dispatch remains meaningful.
* Convert one simple scanner.
* Add benchmarks.
* Document migration pattern.

---

# 22. Recommended Later PR

Title:

```txt
Prototype fused module scan sidecar
```

Scope:

* Add `ModuleScan`.
* Add `scanModule`.
* Convert one or two consumers.
* Benchmark repeated-walk reduction.

---

# 23. Summary

The practical Pyright version of the Reflex AST sprint idea is:

1. Stop allocating child arrays during traversal.
2. Generate direct child walkers from parse-node metadata.
3. Skip visitor dispatch for uninterested node types.
4. Fuse repeated syntax scans into one module scan.
5. Use CPU, heap, and GC profiles to choose the next optimization.

This should provide real wins in Pylance indexing, semantic metadata generation, document symbols, import scanning, and other traversal-heavy features, while keeping the core type checker safe and maintainable.

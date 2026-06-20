# Fix NumPy overload performance in unannotated call sites

## Problem statement

`numpy/lib/tests/test_function_base.py::TestQuantile.test_quantile_add_and_multiply_constant` is slow in Pyright because repeated `np.quantile(...)` calls force expensive overload resolution against NumPy's broad overload set. The selected function itself does not generate diagnostics in the hot range we checked.

Observed from the focused benchmark and direct diagnostic filtering:

- Target file: `Q:\dev\benchmark-lsp\numpy-pyrefly-direct\numpy\lib\tests\test_function_base.py`
- Selected range checked: lines 4147-4210
- Diagnostics in selected range: 0
- Baseline benchmark average: about 19.10s
- Prototype overload cache average: about 15.83s
- Current unannotated-discriminator fast path plus prototype cache average: about 15.92s
- Improvement from prototype: about 17%

This strongly suggests the hot work is not paying for user-visible errors in this function. It is mostly overload selection, argument compatibility checks, return-type inference, and expression cache population for repeated calls with unannotated pytest parameters and broad NumPy types.

The key detail is that `test_quantile_add_and_multiply_constant(self, weights, method, alpha)` has no parameter annotations. Its pytest parametrization gives humans concrete values, but Pyright does not execute pytest parameterization to specialize the method body. Within the static body, `weights`, `method`, and `alpha` therefore provide little or no useful type information for selecting among NumPy's overloads.

## Pyrefly comparison

Pyrefly does not appear to special-case NumPy or pytest-parametrized functions directly. Its overload implementation does, however, include two behaviors that are relevant to this case:

- `pyrefly/lib/alt/overload.rs` pre-infers call arguments once before trying overloads, avoiding repeated expression inference across overload candidates. It deliberately keeps mutable container literals as expressions so contextual typing can still apply.
- Pyrefly defaults `spec_compliant_overloads` to `false`. In that mode, when multiple overloads match, it materializes `Any` arguments only if the corresponding parameter type differs across candidate overloads. If arguments do not change under materialization, it keeps the first matching overload and drops the rest. In spec-compliant mode, Pyrefly follows the typing spec more closely and falls back to `Any` more often for ambiguous calls.

Pyrefly also records an argument-to-parameter map (`ArgMap.range_to_param`) during callable inference. That map is used to decide whether an argument maps to varying parameter types across overloads. This is similar in spirit to using Pyright's shape-filtered `MatchArgsToParamsResult.argParams` before full overload validation.

The takeaway for Pyright is that the optimization should be framed as an overload-disambiguation shortcut for low-information arguments, not as a NumPy-specific workaround. Pyrefly's default is intentionally non-spec-compliant for ecosystem compatibility and precision, so Pyright should be careful not to broadly turn explicit `Any` into ambiguous `Unknown`/`Any` in cases where current behavior selects a useful overload.

## Working hypothesis

Pyrefly wins partly by doing less repeated work in overload calls and by using a pragmatic non-spec-compliant ambiguity policy. The behavior we should consider for Pyright is similar but narrower: when arguments are unknown because they come from unannotated parameters and they discriminate among overloads, avoid exhaustively validating every overload when a cheaper approximation preserves useful behavior.

For this specific function, exhaustive overload resolution is especially low-value because the unannotated parameters make several call arguments imprecise before overload resolution even starts. Spending hundreds of milliseconds trying to select the most precise `np.quantile` overload cannot recover much real precision from `method`, `weights`, or `alpha`.

For Pyright, the important distinction is that overload resolution serves two purposes:

1. Diagnostics: report that no overload matches or that arguments are incompatible.
2. Inference: choose a return type and populate expression caches even when no diagnostic is emitted.

The NumPy case appears to spend heavily on (2), while producing no diagnostics in the hot selected function.

## Current prototype

A prototype cache in `typeEvaluator.ts` stores the winning overload index for repeated overloaded calls with the same context-free argument shape. On a cache hit, Pyright revalidates only the cached winning overload at the new call site, which preserves local type-cache population and diagnostics for that winner.

Current cache lifecycle:

- The cache is a `WeakMap<OverloadedType, OverloadedCallResultCacheEntry[]>` scoped to a single `TypeEvaluator` instance.
- It is reset in `disposeEvaluator()` along with the other evaluator-local caches.
- Because keys are weak, entries are also eligible for garbage collection once the `OverloadedType` key is no longer strongly reachable.
- Practically, in normal analysis, the cache lives for the lifetime of the evaluator/program analysis pass and is freed when the evaluator is disposed.

The prototype is a useful proof of direction, but it is not yet the final design. The cache key and eligibility rules need review before upstreaming.

## Current fast-path implementation

The current implementation adds a narrower fast path before full overload validation. After shape filtering, it looks for an argument that:

- has Any or Unknown type,
- comes from a simple-name parameter with no annotation or annotation comment,
- maps to different parameter types across the surviving overload candidates,
- is used in a call without constraints, expected return type, return override, or lambda arguments requiring contextual typing.

When that condition is met, Pyright avoids exhaustive overload validation and approximates the result from the surviving overload return types. If the returns collapse to one type, it keeps that type. If they differ, it returns `UnknownType.createPossibleType(combineTypes(...))`, preserving possible types for tooling.

Validation so far:

- `npx jest src/tests/typeEvaluator6.test.ts --runInBand`: 147/147 passing
- `npm run build` in `packages/pyright-internal`: passing
- `npm run build:cli:dev`: passing
- `npm run test:benchmark:numpy`: average about 15.92s, median about 15.86s

## Work completed in this branch

The branch currently contains a focused benchmark, a semantic regression test, a prototype cache, and a narrower overload fast path.

Files changed or added:

- `packages/pyright-internal/src/analyzer/typeEvaluator.ts`
	- Added a prototype overloaded-call winner cache keyed by `OverloadedType` and context-free argument shape.
	- Added cache helpers for extracting context-free argument types, checking cache eligibility, comparing argument shapes, reading cache entries, and adding cache entries.
	- Added a targeted fast path for overload calls where an Any/Unknown argument comes from an unannotated function parameter and maps to varying parameter types across surviving overload candidates.
	- Added helper logic to identify unannotated parameter arguments, use `MatchArgsToParamsResult.argParams` to detect overload-discriminating arguments, and approximate the return type from surviving overload return types.
	- Kept the fast path out of calls with constraints, expected return type context, return-type override, or lambda arguments that need contextual typing.
- `packages/pyright-internal/src/tests/samples/overloadCall11.py`
	- Added a focused sample where an unannotated parameter is passed to an overload-discriminating keyword-only parameter.
	- Verifies that the ambiguous unannotated call reveals `Unknown`, while literal calls still reveal the precise overload return types.
- `packages/pyright-internal/src/tests/typeEvaluator6.test.ts`
	- Registered the new `overloadCall11.py` sample as `OverloadCall11`.
- `packages/pyright-internal/src/tests/benchmarks/pyrightNumpyBenchmark.test.ts`
	- Added a benchmark harness for the NumPy `test_function_base.py` target.
	- Creates or reuses a generated benchmark venv, installs NumPy requirements, runs the local Pyright CLI with `--stats --pythonversion 3.12`, and writes JSON benchmark reports.
	- Uses one warmup and five measured iterations, gated behind `PYRIGHT_RUN_BENCHMARKS=1`.
- `packages/pyright-internal/package.json`
	- Added `test:benchmark:numpy` to run the focused benchmark through Jest.
- `packages/pyright-internal/src/pyright.ts`
	- Temporarily changed during profiling to escalate logging for `--stats --verbose`.
	- The temporary logging change has now been removed; this file has no remaining diff.
- `.github/plan/fix-numpy-overloads.md`
	- Captures the investigation, Pyrefly comparison, current prototype, benchmark results, latest profile, and recommended next step.

Investigation steps completed:

- Created and used the `q:\dev\pyright-numpy-speed` worktree from upstream main.
- Added the focused NumPy benchmark and got it running against `q:\dev\benchmark-lsp\numpy-pyrefly-direct\numpy\lib\tests\test_function_base.py`.
- Narrowed the hot NumPy case to `TestQuantile.test_quantile_add_and_multiply_constant` and confirmed the selected range around lines 4147-4210 produces no diagnostics.
- Checked whether disabling diagnostics alone would avoid the work; it did not materially remove the overload inference cost.
- Compared Pyright behavior with Pyrefly's overload implementation in `pyrefly/lib/alt/overload.rs`, `pyrefly/lib/alt/callable.rs`, and `pyrefly/lib/alt/function.rs`.
- Learned that Pyrefly pre-infers call arguments once, tracks argument-to-parameter mapping, and defaults to a pragmatic non-spec-compliant overload ambiguity mode.
- Rejected a broad explicit-Any shortcut after it broke existing `overloadCall6.py` expectations by returning `Any` where Pyright currently preserves a precise overload result.
- Narrowed the optimization to unannotated-parameter Any/Unknown values that actually discriminate among overload candidates.
- Removed the temporary verbose logging escalation and captured a clean CPU profile with only `--stats` enabled.

Measured results:

- Baseline focused benchmark average: about 19.10s.
- Prototype overload cache average: about 15.83s.
- Current unannotated-discriminator fast path plus prototype cache average: about 15.92s.
- Current improvement versus baseline: about 17%.
- Latest CPU-profiled normal CLI run: 17.612s under profiler, 198 expected errors, 1 file checked.

Current worktree footprint:

- Tracked diff: `packages/pyright-internal/package.json`, `packages/pyright-internal/src/analyzer/typeEvaluator.ts`, and `packages/pyright-internal/src/tests/typeEvaluator6.test.ts`.
- Untracked additions: `.github/plan/`, `packages/pyright-internal/src/tests/benchmarks/pyrightNumpyBenchmark.test.ts`, and `packages/pyright-internal/src/tests/samples/overloadCall11.py`.

## Latest profile after removing extra logging

The temporary `--stats --verbose` logger escalation was removed from `packages/pyright-internal/src/pyright.ts`, and the CLI was rebuilt with `npm run build:cli:dev`. A new CPU profile was captured through the normal Pyright CLI with only `--stats` enabled:

- Profile: `Q:\dev\pyright-numpy-speed\packages\pyright-internal\src\tests\benchmarks\.generated\profiles\CPU.20260620.114318.37224.0.001.cpuprofile`
- Run summary: `198 errors, 0 warnings, 0 informations`
- Runtime under profiler: `17.612sec`
- Total files checked: `1`

The profile confirms that the remaining hot path is still entered through call validation, but the self-time is no longer concentrated in one obvious overload dispatcher. Top inclusive analyzer frames include:

- `getTypeOfCall`: about 14.33s inclusive
- `validateCallArgs`: about 14.08s inclusive
- `useSpeculativeMode`: about 14.07s inclusive
- `getTypeOfExpression`: about 14.92s inclusive

Top self-time frames include:

- `isTypeSame` in `src/analyzer/types.ts`: about 1.22s self
- garbage collection: about 0.92s self
- `TypeWalker` / `walk`: about 1.14s combined self
- `assignType`: about 0.66s self
- `containsLiteralType` / `ContainsLiteralTypeWalker` in `src/analyzer/typeUtils.ts`: about 0.81s combined self
- `isDerivedFrom`: about 0.36s self
- `assignClass`: about 0.33s self
- `getProtocolCompatibility` in `src/analyzer/protocols.ts`: about 0.31s self
- `assignFunction`: about 0.27s self
- `isSameGenericClass`: about 0.27s self
- `assignClassToProtocol` in `src/analyzer/protocols.ts`: about 0.25s self
- `printObjectTypeForClassInternal` / `printTypeInternal` in `src/analyzer/typePrinter.ts`: about 0.45s combined self

Interpretation: the overload fast path reduced some repeated overload work, but the next largest costs appear to be lower-level type comparison, type walking, assignability, protocol compatibility, and diagnostic/stat type printing. This points away from adding more broad overload-loop shortcuts as the only next step. A better next investigation is to measure repeated assignability/protocol/equality checks within the NumPy overload calls and determine whether existing caches are missing this case.

## Proposed optimization direction

Focus on the common unannotated/unknown-heavy overloaded-call case rather than a broad generic cache.

The most promising gate is not simply "large overload set". It is "large overload set plus call arguments whose types originate from unannotated parameters or Any/Unknown values". In that situation, full overload validation often cannot produce a precise, actionable result, so Pyright should avoid doing the maximum amount of work unless diagnostics or an expected type make that work valuable.

### Fast path criteria

Consider a fast path when all of the following are true:

- The call target is an overloaded function.
- The overload shape filter (`matchArgsToParams`) leaves multiple candidates.
- One or more overload-discriminating arguments are Any or Unknown, or come from unannotated parameters.
- There is no expected return type context that could usefully disambiguate overloads.
- We are not analyzing a lambda argument whose body depends strongly on contextual typing.
- Either diagnostics are disabled/suppressed for the relevant call or the first pass finds a plausible overload and later overload exploration is unlikely to improve diagnostics.

### Candidate behaviors to test

1. Cache winning overload for repeated same-shape unknown-heavy calls.
2. Prefer the first plausible overload when Any/Unknown arguments make overload choice ambiguous and return-type precision is already limited.
3. Avoid constructing expensive no-overload diagnostics when the call site is speculative or diagnostics are disabled.
4. Avoid repeated protocol assignability checks against the same NumPy array-like protocols for the same source/destination pair during overload validation.
5. Add a fast path specifically for calls where overload-discriminating keyword arguments are sourced from unannotated parameters.

The first item has already shown a measurable win. The fourth item may be a more generally correct root-cause optimization if most time is in repeated protocol assignability rather than overload loop mechanics.

## Test plan

### Correctness tests

Add focused evaluator samples around overloaded calls with unknown-heavy arguments:

- Repeated calls to an overloaded function with unannotated parameters should preserve the same revealed return type as today.
- Calls whose overload-discriminating arguments come from unannotated parameters should avoid exhaustive overload work when there is no expected type and no useful diagnostic to report.
- Calls with lambda arguments should not reuse a cached overload if contextual typing changes lambda body checking.
- Calls with an expected return type context should preserve current overload selection behavior.
- Ambiguous Any/Unknown overloads should preserve existing return-type rules, including possible-type Unknown behavior where applicable.

### Performance tests

Keep the focused NumPy benchmark:

- Script: `npm run test:benchmark:numpy` from `packages/pyright-internal`
- Target: `numpy/lib/tests/test_function_base.py`
- Command uses `--stats --pythonversion 3.12`
- Assert that `Total files checked: 1` remains present.

Use the benchmark as the red/green signal for the NumPy regression. A deterministic unit test should guard semantics; the benchmark guards the performance behavior.

## Open questions

- Should Pyright's fast path be tied to diagnostic suppression, Any/Unknown arguments, or both?
- Is a winner cache sufficient, or should the root fix be assignability/protocol memoization used by overload validation?
- How much return-type precision is lost if Pyright short-circuits unknown-heavy overloads earlier, and is that acceptable only under basic/off modes?

## Recommended next step

Instrument the overload and lower-level assignability paths with temporary counters for the NumPy target:

- number of overload candidates after shape filtering
- number of candidates fully type-validated
- number of calls with Any/Unknown arguments
- number of overload-discriminating arguments sourced from unannotated parameters
- number of no-diagnostic hot calls
- cache hit/miss count if the prototype cache is enabled
- repeated `assignType` source/destination pairs reached from overload validation
- repeated protocol compatibility checks reached from overload validation
- repeated `isTypeSame` checks reached from overload ambiguity/result construction
- type printing cost with and without `--stats`

Use those counters to decide between:

1. upstreamable overload winner cache with tight eligibility, or
2. lower-level assignability/protocol/equality memoization that improves overload validation without changing overload search semantics.

Given the latest profile, option 2 currently looks more promising for the next optimization pass unless counters show that the remaining lower-level cost is caused by only a few overload calls that can be safely short-circuited earlier.

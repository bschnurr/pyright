/*
 * lspServerBenchmark.test.ts
 *
 * Opt-in benchmark for Pyright as an LSP server.
 *
 * Run with:
 *   cd packages\pyright-internal
 *   npm run webpack:testserver
 *   cross-env PYRIGHT_RUN_BENCHMARKS=1 node --max-old-space-size=8192 --expose-gc ./node_modules/jest/bin/jest --forceExit --testTimeout=300000 --runInBand src/tests/benchmarks/lspServerBenchmark.test.ts
 *
 * Results are written as JSON to:
 *   src/tests/benchmarks/.generated/benchmark-results/lsp-server/
 */

import assert from 'assert';
import { join } from 'path';

import { ConfigurationItem, DocumentDiagnosticRequest } from 'vscode-languageserver-protocol';

import { normalizeSlashes } from '../../common/pathUtils';
import {
    changeFile,
    cleanupAfterAll,
    DEFAULT_WORKSPACE_ROOT,
    openFile,
    getServerMemoryUsage,
    PyrightServerInfo,
    runPyrightServer,
} from '../lsp/languageServerTestUtils';
import {
    BenchmarkMemoryUsage,
    BenchmarkStats,
    calculateStats,
    getBenchmarkSuite,
    getSystemInfo,
    toBenchmarkMemoryUsage,
    writeBenchmarkReport,
} from './benchmarkUtils';

const WARMUP_ITERATIONS = 1;
const BENCHMARK_ITERATIONS = 5;
const MODULE_COUNT = 12;
const FUNCTIONS_PER_MODULE = 18;
const OUTPUT_DIR = join(__dirname, '.generated', 'benchmark-results', 'lsp-server');
const PROJECT_ROOT = DEFAULT_WORKSPACE_ROOT;
const HOT_MARKER = 'hot';
const DEPENDENT_MARKER = 'dependent';
const BENCHMARK_TIMEOUT_MS = 300000;

interface ScenarioResult extends BenchmarkStats {
    scenario: string;
    iterations: number;
    timesMs: number[];
    diagnosticCount: number;
    memorySamples: ScenarioMemorySample[];
    maxRssMB: number;
    maxHeapUsedMB: number;
}

interface ScenarioMemorySample {
    iteration: number;
    phase: 'warmup' | 'run';
    before: BenchmarkMemoryUsage;
    after: BenchmarkMemoryUsage;
}

interface BenchmarkReport {
    timestamp: string;
    system: ReturnType<typeof getSystemInfo>;
    config: {
        warmupIterations: number;
        benchmarkIterations: number;
        moduleCount: number;
        functionsPerModule: number;
        supportsPullDiagnostics: boolean;
        backgroundAnalysis: boolean;
    };
    scenarios: ScenarioResult[];
}

const benchmarkSuite = getBenchmarkSuite();

benchmarkSuite('LSP Server Benchmark', () => {
    const results: ScenarioResult[] = [];

    afterAll(async () => {
        await cleanupAfterAll();

        if (results.length === 0) {
            return;
        }

        printResultTable(results);
        const outputPath = writeBenchmarkReport(OUTPUT_DIR, 'lsp-server-benchmark', {
            timestamp: new Date().toISOString(),
            system: getSystemInfo(),
            config: {
                warmupIterations: WARMUP_ITERATIONS,
                benchmarkIterations: BENCHMARK_ITERATIONS,
                moduleCount: MODULE_COUNT,
                functionsPerModule: FUNCTIONS_PER_MODULE,
                supportsPullDiagnostics: true,
                backgroundAnalysis: false,
            },
            scenarios: results,
        } satisfies BenchmarkReport);
        console.log(`\nBenchmark results written to: ${outputPath}`);
    });

    test(
        'cold initialize and first diagnostics',
        async () => {
            const result = await runScenario('cold_initialize_and_first_diagnostics', async (iteration) => {
                const start = performance.now();
                const info = await createServer(iteration);
                try {
                    const memoryBefore = await measureServerMemory(info);
                    const diagnostics = await measureDiagnostics(info, HOT_MARKER);
                    const elapsedMs = performance.now() - start;
                    const memoryAfter = await measureServerMemory(info);
                    return {
                        elapsedMs,
                        diagnosticCount: diagnostics,
                        memoryBefore,
                        memoryAfter,
                    };
                } finally {
                    await info.dispose();
                }
            });

            results.push(result);
            expect(result.diagnosticCount).toBeGreaterThan(0);
            expect(result.medianMs).toBeLessThan(BENCHMARK_TIMEOUT_MS);
        },
        BENCHMARK_TIMEOUT_MS
    );

    test(
        'open file and document diagnostics',
        async () => {
            const result = await runScenario('open_file_and_document_diagnostics', async (iteration) => {
                const info = await createServer(iteration, /* openHotFile */ false);
                try {
                    const memoryBefore = await measureServerMemory(info);
                    const start = performance.now();
                    await openFile(info, HOT_MARKER);
                    const diagnostics = await measureDiagnostics(info, HOT_MARKER);
                    const elapsedMs = performance.now() - start;
                    const memoryAfter = await measureServerMemory(info);
                    return {
                        elapsedMs,
                        diagnosticCount: diagnostics,
                        memoryBefore,
                        memoryAfter,
                    };
                } finally {
                    await info.dispose();
                }
            });

            results.push(result);
            expect(result.diagnosticCount).toBeGreaterThan(0);
            expect(result.medianMs).toBeLessThan(BENCHMARK_TIMEOUT_MS);
        },
        BENCHMARK_TIMEOUT_MS
    );

    test(
        'repeated edits and diagnostics',
        async () => {
            const info = await createServer(0);
            try {
                await openFile(info, HOT_MARKER);
                const result = await runScenario('repeated_edits_and_diagnostics', async (iteration) => {
                    const text = createHotModule(iteration);
                    const memoryBefore = await measureServerMemory(info);
                    const start = performance.now();
                    await changeFile(info, HOT_MARKER, iteration + 2, text);
                    const diagnostics = await measureDiagnostics(info, HOT_MARKER);
                    const elapsedMs = performance.now() - start;
                    const memoryAfter = await measureServerMemory(info);
                    return {
                        elapsedMs,
                        diagnosticCount: diagnostics,
                        memoryBefore,
                        memoryAfter,
                    };
                });

                results.push(result);
                expect(result.diagnosticCount).toBeGreaterThan(0);
                expect(result.medianMs).toBeLessThan(BENCHMARK_TIMEOUT_MS);
            } finally {
                await info.dispose();
            }
        },
        BENCHMARK_TIMEOUT_MS
    );

    test(
        'dependent diagnostics after imported module edit',
        async () => {
            const info = await createServer(0);
            try {
                await openFile(info, HOT_MARKER);
                await openFile(info, DEPENDENT_MARKER);

                const result = await runScenario('dependent_diagnostics_after_import_edit', async (iteration) => {
                    const text = createHotModule(iteration);
                    const memoryBefore = await measureServerMemory(info);
                    const start = performance.now();
                    await changeFile(info, HOT_MARKER, iteration + 2, text);
                    const diagnostics = await measureDiagnostics(info, DEPENDENT_MARKER);
                    const elapsedMs = performance.now() - start;
                    const memoryAfter = await measureServerMemory(info);
                    return {
                        elapsedMs,
                        diagnosticCount: diagnostics,
                        memoryBefore,
                        memoryAfter,
                    };
                });

                results.push(result);
                expect(result.diagnosticCount).toBeGreaterThan(0);
                expect(result.medianMs).toBeLessThan(BENCHMARK_TIMEOUT_MS);
            } finally {
                await info.dispose();
            }
        },
        BENCHMARK_TIMEOUT_MS
    );
});

async function runScenario(
    scenario: string,
    runIteration: (iteration: number) => Promise<{
        elapsedMs?: number | undefined;
        diagnosticCount: number;
        memoryBefore?: BenchmarkMemoryUsage | undefined;
        memoryAfter?: BenchmarkMemoryUsage | undefined;
    }>
): Promise<ScenarioResult> {
    const times: number[] = [];
    const memorySamples: ScenarioMemorySample[] = [];
    let diagnosticCount = 0;

    for (let iteration = 0; iteration < WARMUP_ITERATIONS + BENCHMARK_ITERATIONS; iteration++) {
        const start = performance.now();
        const result = await runIteration(iteration);
        const elapsedMs = result.elapsedMs ?? performance.now() - start;
        diagnosticCount = result.diagnosticCount;
        const phase = iteration < WARMUP_ITERATIONS ? 'warmup' : 'run';

        if (result.memoryBefore && result.memoryAfter) {
            memorySamples.push({
                iteration: phase === 'warmup' ? iteration + 1 : iteration + 1 - WARMUP_ITERATIONS,
                phase,
                before: result.memoryBefore,
                after: result.memoryAfter,
            });
        }

        if (iteration >= WARMUP_ITERATIONS) {
            times.push(elapsedMs);
        }

        console.log(
            `  ${scenario} ${phase} ${
                phase === 'warmup' ? iteration + 1 : iteration + 1 - WARMUP_ITERATIONS
            }: diagnostics=${diagnosticCount}${
                result.memoryAfter ? ` rss=${result.memoryAfter.rssMB.toFixed(2)}MB` : ''
            }`
        );
    }

    const stats = calculateStats(times);
    const runMemorySamples = memorySamples.filter((sample) => sample.phase === 'run');
    return {
        scenario,
        iterations: BENCHMARK_ITERATIONS,
        timesMs: times,
        ...stats,
        diagnosticCount,
        memorySamples,
        maxRssMB: Math.max(...runMemorySamples.map((sample) => sample.after.rssMB)),
        maxHeapUsedMB: Math.max(...runMemorySamples.map((sample) => sample.after.heapUsedMB)),
    };
}

async function measureServerMemory(info: PyrightServerInfo): Promise<BenchmarkMemoryUsage> {
    if (global.gc) {
        global.gc();
    }

    return toBenchmarkMemoryUsage(await getServerMemoryUsage(info));
}

async function createServer(iteration: number, openHotFile = true): Promise<PyrightServerInfo> {
    const settings: { item: ConfigurationItem; value: any }[] = [
        {
            item: {
                scopeUri: `file://${normalizeSlashes(PROJECT_ROOT, '/')}`,
                section: 'python.analysis',
            },
            value: {
                diagnosticMode: 'openFilesOnly',
                typeCheckingMode: 'strict',
            },
        },
    ];

    const info = await runPyrightServer(
        PROJECT_ROOT,
        createWorkspace(iteration),
        /* callInitialize */ true,
        settings,
        undefined,
        /* backgroundAnalysis */ false,
        /* supportPullDiagnostics */ true
    );

    if (openHotFile) {
        await openFile(info, HOT_MARKER);
    }

    return info;
}

async function measureDiagnostics(info: PyrightServerInfo, markerName: string): Promise<number> {
    const marker = info.testData.markerPositions.get(markerName);
    assert(marker);

    const result = await info.connection.sendRequest(DocumentDiagnosticRequest.type, {
        textDocument: {
            uri: marker.fileUri.toString(),
        },
    });
    const items = 'items' in result ? result.items : [];
    return items.length;
}

function createWorkspace(iteration: number): string {
    const files: string[] = [
        `
// @filename: pyrightconfig.json
//// {
////   "typeCheckingMode": "strict"
//// }
`,
    ];

    for (let moduleIndex = 0; moduleIndex < MODULE_COUNT; moduleIndex++) {
        files.push(createModule(moduleIndex));
    }

    files.push(`
// @filename: hot.py
//// [|/*${HOT_MARKER}*/|]
${toFourSlash(createHotModule(iteration))}
`);
    files.push(`
// @filename: dependent.py
//// [|/*${DEPENDENT_MARKER}*/|]
${toFourSlash(createDependentModule())}
`);

    return files.join('\n');
}

function createModule(moduleIndex: number): string {
    const lines = [
        `// @filename: pkg/module_${moduleIndex}.py`,
        '//// from __future__ import annotations',
        '//// from typing import Generic, TypeVar',
        '////',
        `//// T${moduleIndex} = TypeVar("T${moduleIndex}")`,
        '////',
        `//// class Box${moduleIndex}(Generic[T${moduleIndex}]):`,
        `////     value: T${moduleIndex}`,
        '////',
        `////     def __init__(self, value: T${moduleIndex}) -> None:`,
        '////         self.value = value',
        '////',
        `////     def get(self) -> T${moduleIndex}:`,
        '////         return self.value',
        '////',
    ];

    for (let functionIndex = 0; functionIndex < FUNCTIONS_PER_MODULE; functionIndex++) {
        lines.push(
            `//// def transform_${moduleIndex}_${functionIndex}(value: int) -> int:`,
            `////     local = value + ${moduleIndex + functionIndex}`,
            '////     return local',
            '////'
        );
    }

    return lines.join('\n');
}

function createHotModule(iteration: number): string {
    const lines = [
        'from __future__ import annotations',
        'from typing import Iterable',
        '',
        'from pkg.module_0 import Box0, transform_0_0',
        'from pkg.module_1 import Box1, transform_1_1',
        'from pkg.module_2 import transform_2_2',
        '',
        'def summarize(values: Iterable[int]) -> int:',
        '    total = 0',
        '    for value in values:',
        '        total += transform_0_0(value)',
        `    total += ${iteration}`,
        '    return total',
        '',
        'def make_box(value: int) -> Box0[int]:',
        '    return Box0(value)',
        '',
        'def combine(left: int, right: int) -> int:',
        '    first = Box0(left).get()',
        '    second = Box1(right).get()',
        '    return transform_2_2(first + second)',
        '',
        'hot_result: str = summarize([1, 2, 3])',
    ];
    return lines.join('\n');
}

function createDependentModule(): string {
    const lines = [
        'from __future__ import annotations',
        '',
        'from hot import combine, make_box, summarize',
        '',
        'def consume() -> int:',
        '    box = make_box(3)',
        '    return combine(box.get(), summarize([1, 2, 3]))',
        '',
        'dependent_result: str = consume()',
    ];
    return lines.join('\n');
}

function toFourSlash(text: string): string {
    return text
        .split(/\r?\n/)
        .map((line) => `//// ${line}`)
        .join('\n');
}

function printResultTable(results: ReadonlyArray<ScenarioResult>) {
    console.log('\n=== LSP Server Benchmark Results ===\n');
    console.log(
        `${'Scenario'.padEnd(42)} ${'Median'.padStart(10)} ${'Min'.padStart(10)} ${'Max'.padStart(10)} ${'Avg'.padStart(
            10
        )} ${'p95'.padStart(10)} ${'Diagnostics'.padStart(12)} ${'Max RSS'.padStart(10)} ${'Max Heap'.padStart(10)}`
    );
    console.log('-'.repeat(132));

    for (const result of results) {
        console.log(
            `${result.scenario.padEnd(42)} ${result.medianMs.toFixed(2).padStart(10)} ${result.minMs
                .toFixed(2)
                .padStart(10)} ${result.maxMs.toFixed(2).padStart(10)} ${result.avgMs
                .toFixed(2)
                .padStart(10)} ${result.p95Ms.toFixed(2).padStart(10)} ${String(result.diagnosticCount).padStart(
                12
            )} ${formatMB(result.maxRssMB).padStart(10)} ${formatMB(result.maxHeapUsedMB).padStart(10)}`
        );
    }
    console.log('');
}

function formatMB(value: number): string {
    return `${value.toFixed(2)}MB`;
}

/*
 * parseTreeWalkerBenchmark.test.ts
 * Copyright (c) Microsoft Corporation.
 *
 * Microbenchmark for parse-tree traversal.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { DiagnosticSink } from '../../common/diagnosticSink';
import { getChildNodes, ParseTreeWalker } from '../../analyzer/parseTreeWalker';
import { walkChildren } from '../../parser/generated/walkChildren';
import { ParseNode } from '../../parser/parseNodes';
import { ParseOptions, Parser } from '../../parser/parser';

const WARMUP_ITERATIONS = 3;
const BENCHMARK_ITERATIONS = 10;

const BENCHMARK_OUTPUT_DIR = path.join(__dirname, '.generated', 'benchmark-results', 'parse-tree-walker');

interface WalkerStats {
    nodesVisited: number;
    childEdgesVisited: number;
    visitorDispatches: number;
    childArraysAllocated: number;
}

interface WalkerBenchmarkResult {
    corpus: string;
    walker: string;
    fileSizeBytes: number;
    iterations: number;
    timesMs: number[];
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    nodesVisited: number;
    childEdgesVisited: number;
    visitorDispatches: number;
    nodesPerSec: number;
    childArraysAllocated: number;
}

interface WalkerBenchmarkReport {
    timestamp: string;
    system: {
        platform: string;
        arch: string;
        cpus: string;
        cpuCount: number;
        totalMemoryMB: number;
        nodeVersion: string;
    };
    config: {
        warmupIterations: number;
        benchmarkIterations: number;
    };
    results: WalkerBenchmarkResult[];
}

const corpora: { name: string; file: string }[] = [
    { name: 'large_stdlib', file: 'large_stdlib.py' },
    { name: 'fstring_heavy', file: 'fstring_heavy.py' },
    { name: 'comment_heavy', file: 'comment_heavy.py' },
    { name: 'large_class', file: 'large_class.py' },
    { name: 'import_heavy', file: 'import_heavy.py' },
    { name: 'union_heavy', file: 'union_heavy.py' },
];

class ArrayChildWalker extends ParseTreeWalker {
    private _nodesVisited = 0;
    private _childEdgesVisited = 0;
    private _visitorDispatches = 0;
    private _childArraysAllocated = 0;

    override walk(node: ParseNode): void {
        this._nodesVisited++;
        this._visitorDispatches++;

        const childrenToWalk = this.visit(node) ? getChildNodes(node) : [];
        this._childArraysAllocated++;

        for (let i = 0; i < childrenToWalk.length; i++) {
            const child = childrenToWalk[i];
            if (child) {
                this._childEdgesVisited++;
                this.walk(child);
            }
        }
    }

    getStats(): WalkerStats {
        return {
            nodesVisited: this._nodesVisited,
            childEdgesVisited: this._childEdgesVisited,
            visitorDispatches: this._visitorDispatches,
            childArraysAllocated: this._childArraysAllocated,
        };
    }
}

class GeneratedChildWalker extends ParseTreeWalker {
    private _nodesVisited = 0;
    private _visitorDispatches = 0;

    override walk(node: ParseNode): void {
        this._nodesVisited++;
        this._visitorDispatches++;

        if (this.visit(node)) {
            walkChildren(this, node);
        }
    }

    getStats(): WalkerStats {
        return {
            nodesVisited: this._nodesVisited,
            childEdgesVisited: Math.max(0, this._nodesVisited - 1),
            visitorDispatches: this._visitorDispatches,
            childArraysAllocated: 0,
        };
    }
}

function loadCorpus(filename: string): string {
    const filePath = path.resolve(__dirname, '..', 'benchmarkData', filename);
    return fs.readFileSync(filePath, 'utf-8');
}

function parseText(code: string): ParseNode {
    const parser = new Parser();
    const diagSink = new DiagnosticSink();
    const parseOptions = new ParseOptions();
    return parser.parseSourceFile(code, parseOptions, diagSink).parserOutput.parseTree;
}

function calculateStats(times: ReadonlyArray<number>): {
    median: number;
    p95: number;
    min: number;
    max: number;
    avg: number;
} {
    const sorted = [...times].sort((a, b) => a - b);
    const len = sorted.length;

    const median = len % 2 === 0 ? (sorted[len / 2 - 1] + sorted[len / 2]) / 2 : sorted[Math.floor(len / 2)];
    const p95Index = Math.ceil(len * 0.95) - 1;
    const p95 = sorted[Math.min(p95Index, len - 1)];
    const min = sorted[0];
    const max = sorted[len - 1];
    const avg = times.reduce((a, b) => a + b, 0) / len;

    return { median, p95, min, max, avg };
}

function getSystemInfo(): WalkerBenchmarkReport['system'] {
    const cpus = os.cpus();
    return {
        platform: os.platform(),
        arch: os.arch(),
        cpus: cpus[0]?.model ?? 'unknown',
        cpuCount: cpus.length,
        totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
        nodeVersion: process.version,
    };
}

function writeReport(report: WalkerBenchmarkReport): void {
    fs.mkdirSync(BENCHMARK_OUTPUT_DIR, { recursive: true });
    const filename = `parse-tree-walker-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const outputPath = path.join(BENCHMARK_OUTPUT_DIR, filename);
    fs.writeFileSync(outputPath, JSON.stringify(report, undefined, 2), 'utf-8');
    console.log(`\nBenchmark results written to: ${outputPath}`);
}

function printResultTable(results: ReadonlyArray<WalkerBenchmarkResult>): void {
    console.log('\n=== Parse Tree Walker Benchmark Results ===\n');
    console.log(
        `${'Corpus'.padEnd(25)} ${'Walker'.padEnd(16)} ${'Size'.padStart(8)} ${'Nodes'.padStart(8)} ${'Edges'.padStart(
            8
        )} ${'Visits'.padStart(8)} ${'Arrays'.padStart(8)} ${'Median'.padStart(10)} ${'P95'.padStart(
            10
        )} ${'Min'.padStart(10)} ${'Max'.padStart(10)} ${'Avg'.padStart(10)} ${'Nodes/s'.padStart(12)}`
    );
    console.log('-'.repeat(153));

    for (const r of results) {
        const sizeKB = `${(r.fileSizeBytes / 1024).toFixed(1)}KB`;
        console.log(
            `${r.corpus.padEnd(25)} ${r.walker.padEnd(16)} ${sizeKB.padStart(8)} ${String(r.nodesVisited).padStart(
                8
            )} ${String(r.childEdgesVisited).padStart(8)} ${String(r.visitorDispatches).padStart(8)} ${String(
                r.childArraysAllocated
            ).padStart(8)} ${r.medianMs.toFixed(2).padStart(10)} ${r.p95Ms.toFixed(2).padStart(10)} ${r.minMs
                .toFixed(2)
                .padStart(10)} ${r.maxMs.toFixed(2).padStart(10)} ${r.avgMs.toFixed(2).padStart(10)} ${Math.round(
                r.nodesPerSec
            )
                .toLocaleString()
                .padStart(12)}`
        );
    }
    console.log('');
}

function benchmarkWalker(
    corpus: string,
    code: string,
    createWalker: () => ArrayChildWalker | GeneratedChildWalker,
    walkerName: string
): WalkerBenchmarkResult {
    const parseTree = parseText(code);
    const timesMs: number[] = [];
    let stats: WalkerStats = {
        nodesVisited: 0,
        childEdgesVisited: 0,
        visitorDispatches: 0,
        childArraysAllocated: 0,
    };

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        createWalker().walk(parseTree);
    }

    for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
        const walker = createWalker();
        const start = performance.now();
        walker.walk(parseTree);
        timesMs.push(performance.now() - start);
        stats = walker.getStats();
    }

    const timingStats = calculateStats(timesMs);

    return {
        corpus,
        walker: walkerName,
        fileSizeBytes: Buffer.byteLength(code, 'utf-8'),
        iterations: BENCHMARK_ITERATIONS,
        timesMs,
        medianMs: timingStats.median,
        p95Ms: timingStats.p95,
        minMs: timingStats.min,
        maxMs: timingStats.max,
        avgMs: timingStats.avg,
        nodesVisited: stats.nodesVisited,
        childEdgesVisited: stats.childEdgesVisited,
        visitorDispatches: stats.visitorDispatches,
        nodesPerSec: stats.nodesVisited / (timingStats.median / 1000),
        childArraysAllocated: stats.childArraysAllocated,
    };
}

describe('Parse Tree Walker Benchmark', () => {
    const allResults: WalkerBenchmarkResult[] = [];

    function benchmarkCorpus(name: string, code: string) {
        const arrayWalker = benchmarkWalker(name, code, () => new ArrayChildWalker(), 'array-child');
        const generatedWalker = benchmarkWalker(name, code, () => new GeneratedChildWalker(), 'generated-child');
        allResults.push(arrayWalker, generatedWalker);

        console.log(
            `  ${name}: array=${arrayWalker.medianMs.toFixed(2)}ms, generated=${generatedWalker.medianMs.toFixed(
                2
            )}ms, nodes=${generatedWalker.nodesVisited.toLocaleString()}`
        );

        expect(generatedWalker.nodesVisited).toBe(arrayWalker.nodesVisited);
        expect(generatedWalker.childArraysAllocated).toBe(0);
        expect(arrayWalker.childArraysAllocated).toBeGreaterThan(0);
    }

    for (const { name, file } of corpora) {
        test(`walk ${name}`, () => {
            const code = loadCorpus(file);
            benchmarkCorpus(name, code);
        });
    }

    test('scaled corpus (10x large_stdlib)', () => {
        const base = loadCorpus('large_stdlib.py');
        const scaled = Array(10).fill(base).join('\n');
        benchmarkCorpus('large_stdlib_10x', scaled);
    });

    afterAll(() => {
        if (allResults.length === 0) {
            return;
        }

        printResultTable(allResults);

        const report: WalkerBenchmarkReport = {
            timestamp: new Date().toISOString(),
            system: getSystemInfo(),
            config: {
                warmupIterations: WARMUP_ITERATIONS,
                benchmarkIterations: BENCHMARK_ITERATIONS,
            },
            results: allResults,
        };

        writeReport(report);
    });
});

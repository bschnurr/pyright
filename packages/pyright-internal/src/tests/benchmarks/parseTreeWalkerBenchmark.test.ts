/*
 * parseTreeWalkerBenchmark.test.ts
 * Copyright (c) Microsoft Corporation.
 *
 * Microbenchmark for parse-tree traversal.
 */

import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseTreeWalker } from '../../analyzer/parseTreeWalker';
import { walkChildren } from '../../parser/generated/walkChildren';
import { ParseNode } from '../../parser/parseNodes';
import { ParseOptions, Parser } from '../../parser/parser';

const WARMUP_ITERATIONS = 3;
const BENCHMARK_ITERATIONS = 10;

interface WalkerStats {
    nodesVisited: number;
    childArraysAllocated: number;
}

interface WalkerBenchmarkResult {
    corpus: string;
    walker: string;
    fileSizeBytes: number;
    timesMs: number[];
    medianMs: number;
    nodesVisited: number;
    childArraysAllocated: number;
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
    private _childArraysAllocated = 0;

    override walk(node: ParseNode): void {
        this._nodesVisited++;

        const childrenToWalk = this.visitNode(node);
        this._childArraysAllocated++;

        for (let i = 0; i < childrenToWalk.length; i++) {
            const child = childrenToWalk[i];
            if (child) {
                this.walk(child);
            }
        }
    }

    getStats(): WalkerStats {
        return {
            nodesVisited: this._nodesVisited,
            childArraysAllocated: this._childArraysAllocated,
        };
    }
}

class GeneratedChildWalker extends ParseTreeWalker {
    private _nodesVisited = 0;

    override walk(node: ParseNode): void {
        this._nodesVisited++;

        if (this.visit(node)) {
            walkChildren(this, node);
        }
    }

    getStats(): WalkerStats {
        return {
            nodesVisited: this._nodesVisited,
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

function calculateMedian(times: number[]): number {
    const sorted = [...times].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[midpoint - 1] + sorted[midpoint]) / 2 : sorted[midpoint];
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

    return {
        corpus,
        walker: walkerName,
        fileSizeBytes: Buffer.byteLength(code, 'utf-8'),
        timesMs,
        medianMs: calculateMedian(timesMs),
        nodesVisited: stats.nodesVisited,
        childArraysAllocated: stats.childArraysAllocated,
    };
}

describe('Parse Tree Walker Benchmark', () => {
    for (const { name, file } of corpora) {
        test(`walk ${name}`, () => {
            const code = loadCorpus(file);
            const arrayWalker = benchmarkWalker(name, code, () => new ArrayChildWalker(), 'array-child');
            const generatedWalker = benchmarkWalker(name, code, () => new GeneratedChildWalker(), 'generated-child');

            console.log(
                `  ${name}: array=${arrayWalker.medianMs.toFixed(2)}ms, generated=${generatedWalker.medianMs.toFixed(
                    2
                )}ms, nodes=${generatedWalker.nodesVisited.toLocaleString()}`
            );

            expect(generatedWalker.nodesVisited).toBe(arrayWalker.nodesVisited);
            expect(generatedWalker.childArraysAllocated).toBe(0);
            expect(arrayWalker.childArraysAllocated).toBeGreaterThan(0);
        });
    }
});

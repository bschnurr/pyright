/*
 * benchmarkUtils.ts
 *
 * Shared helpers for opt-in benchmark tests.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { cpus, platform, arch, totalmem } from 'os';
import { join } from 'path';

export interface BenchmarkStats {
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
}

export interface BenchmarkSystemInfo {
    platform: string;
    arch: string;
    cpus: string;
    cpuCount: number;
    totalMemoryMB: number;
    nodeVersion: string;
}

export interface BenchmarkMemoryUsage {
    rssMB: number;
    heapTotalMB: number;
    heapUsedMB: number;
    externalMB: number;
    arrayBuffersMB: number;
}

export const runBenchmarksEnvVar = 'PYRIGHT_RUN_BENCHMARKS';

export function calculateStats(times: ReadonlyArray<number>): BenchmarkStats {
    if (times.length === 0) {
        throw new Error('Cannot calculate benchmark stats from an empty sample set');
    }

    const sorted = [...times].sort((a, b) => a - b);
    const median =
        sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];
    const p95Index = Math.ceil(sorted.length * 0.95) - 1;

    return {
        medianMs: median,
        p95Ms: sorted[Math.min(p95Index, sorted.length - 1)],
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        avgMs: times.reduce((sum, value) => sum + value, 0) / times.length,
    };
}

export function getSystemInfo(): BenchmarkSystemInfo {
    const cpuInfo = cpus();
    return {
        platform: platform(),
        arch: arch(),
        cpus: cpuInfo[0]?.model ?? 'unknown',
        cpuCount: cpuInfo.length,
        totalMemoryMB: Math.round(totalmem() / (1024 * 1024)),
        nodeVersion: process.version,
    };
}

export function writeBenchmarkReport(outputDir: string, prefix: string, report: unknown): string {
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(outputPath, JSON.stringify(report, undefined, 2) + '\n', 'utf-8');
    return outputPath;
}

export function getBenchmarkSuite() {
    return process.env[runBenchmarksEnvVar] === '1' ? describe : describe.skip;
}

export function toBenchmarkMemoryUsage(memoryUsage: {
    readonly rss: number;
    readonly heapTotal: number;
    readonly heapUsed: number;
    readonly external: number;
    readonly arrayBuffers: number;
}): BenchmarkMemoryUsage {
    return {
        rssMB: bytesToMB(memoryUsage.rss),
        heapTotalMB: bytesToMB(memoryUsage.heapTotal),
        heapUsedMB: bytesToMB(memoryUsage.heapUsed),
        externalMB: bytesToMB(memoryUsage.external),
        arrayBuffersMB: bytesToMB(memoryUsage.arrayBuffers),
    };
}

function bytesToMB(value: number): number {
    return Math.round((value / (1024 * 1024)) * 100) / 100;
}

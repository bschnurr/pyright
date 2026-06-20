/*
 * pyrightNumpyBenchmark.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Benchmark for checking NumPy's test_function_base.py with the Pyright CLI.
 *
 * Run with:
 *   cd packages/pyright-internal
 *   npm run test:benchmark:numpy
 *
 * Results are written as JSON to:
 *   src/tests/benchmarks/.generated/benchmark-results/pyright-numpy/
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WARMUP_ITERATIONS = 1;
const BENCHMARK_ITERATIONS = 5;

const RUN_BENCHMARKS_ENV = 'PYRIGHT_RUN_BENCHMARKS';
const TARGET_FILE_ENV = 'PYRIGHT_NUMPY_BENCHMARK_FILE';
const PYTHON_ENV = 'PYRIGHT_NUMPY_BENCHMARK_PYTHON';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const PYRIGHT_PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'pyright');
const PYRIGHT_CLI_PATH = path.join(PYRIGHT_PACKAGE_DIR, 'index.js');
const PYRIGHT_DIST_PATH = path.join(PYRIGHT_PACKAGE_DIR, 'dist', 'pyright.js');
const BENCHMARK_GENERATED_DIR = path.join(__dirname, '.generated');
const BENCHMARK_OUTPUT_DIR = path.join(BENCHMARK_GENERATED_DIR, 'benchmark-results', 'pyright-numpy');
const BENCHMARK_VENV_DIR = path.join(BENCHMARK_GENERATED_DIR, 'numpy-benchmark-venv');
const DEFAULT_TARGET_FILE = path.resolve(
    REPO_ROOT,
    '..',
    'benchmark-lsp',
    'numpy-pyrefly-direct',
    'numpy',
    'lib',
    'tests',
    'test_function_base.py'
);

interface BenchmarkResult {
    targetFile: string;
    command: string[];
    iterations: number;
    timesMs: number[];
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface BenchmarkReport {
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
        targetFile: string;
        pythonPath: string;
    };
    result: BenchmarkResult;
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

function getSystemInfo(): BenchmarkReport['system'] {
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

function getDefaultPythonCommand(): string {
    return process.platform === 'win32' ? 'python' : 'python3';
}

function runNpmScript(scriptName: string, cwd: string): void {
    if (process.platform === 'win32') {
        execFileSync('cmd.exe', ['/d', '/s', '/c', `npm run ${scriptName}`], { cwd, stdio: 'inherit' });
        return;
    }

    execFileSync('npm', ['run', scriptName], { cwd, stdio: 'inherit' });
}

function getVenvPythonPath(): string {
    return process.platform === 'win32'
        ? path.join(BENCHMARK_VENV_DIR, 'Scripts', 'python.exe')
        : path.join(BENCHMARK_VENV_DIR, 'bin', 'python');
}

function ensurePyrightCliBuilt(): void {
    if (fs.existsSync(PYRIGHT_DIST_PATH)) {
        return;
    }

    runNpmScript('webpack', PYRIGHT_PACKAGE_DIR);
}

function ensureNumpyInstalled(): string {
    const pythonCommand = process.env[PYTHON_ENV] ?? getDefaultPythonCommand();
    const venvPython = getVenvPythonPath();

    if (!fs.existsSync(venvPython)) {
        fs.mkdirSync(BENCHMARK_GENERATED_DIR, { recursive: true });
        execFileSync(pythonCommand, ['-m', 'venv', BENCHMARK_VENV_DIR], { stdio: 'inherit' });
    }

    try {
        execFileSync(venvPython, ['-c', 'import numpy'], { stdio: 'ignore' });
    } catch {
        execFileSync(venvPython, ['-m', 'pip', 'install', 'numpy'], { stdio: 'inherit' });
    }

    return venvPython;
}

function getCommand(targetFile: string, pythonPath: string): string[] {
    return [PYRIGHT_CLI_PATH, targetFile, '--stats', '--pythonversion', '3.12', '--pythonpath', pythonPath];
}

function runPyright(command: string[]): { elapsedMs: number; exitCode: number; stdout: string; stderr: string } {
    const start = performance.now();
    const result = spawnSync(process.execPath, command, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
        throw result.error;
    }

    return {
        elapsedMs: performance.now() - start,
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
    };
}

function benchmarkPyright(targetFile: string, pythonPath: string): BenchmarkResult {
    const times: number[] = [];
    const command = getCommand(targetFile, pythonPath);
    let lastRun = { exitCode: 0, stdout: '', stderr: '' };

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        runPyright(command);
    }

    for (let i = 0; i < BENCHMARK_ITERATIONS; i++) {
        const result = runPyright(command);
        times.push(result.elapsedMs);
        lastRun = result;
    }

    const stats = calculateStats(times);
    return {
        targetFile,
        command: [process.execPath, ...command],
        iterations: BENCHMARK_ITERATIONS,
        timesMs: times,
        medianMs: stats.median,
        p95Ms: stats.p95,
        minMs: stats.min,
        maxMs: stats.max,
        avgMs: stats.avg,
        exitCode: lastRun.exitCode,
        stdout: lastRun.stdout,
        stderr: lastRun.stderr,
    };
}

function writeReport(report: BenchmarkReport): void {
    fs.mkdirSync(BENCHMARK_OUTPUT_DIR, { recursive: true });
    const filename = `pyright-numpy-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const outputPath = path.join(BENCHMARK_OUTPUT_DIR, filename);
    fs.writeFileSync(outputPath, JSON.stringify(report, undefined, 2), 'utf-8');
    console.log(`\nBenchmark results written to: ${outputPath}`);
}

const benchmarkSuite = process.env[RUN_BENCHMARKS_ENV] === '1' ? describe : describe.skip;

benchmarkSuite('Pyright NumPy Benchmark', () => {
    test('test_function_base.py stats', () => {
        const targetFile = process.env[TARGET_FILE_ENV] ?? DEFAULT_TARGET_FILE;

        expect(fs.existsSync(targetFile)).toBe(true);

        ensurePyrightCliBuilt();
        const pythonPath = ensureNumpyInstalled();
        const result = benchmarkPyright(targetFile, pythonPath);

        console.log(
            `  test_function_base.py: median=${result.medianMs.toFixed(2)}ms, min=${result.minMs.toFixed(
                2
            )}ms, max=${result.maxMs.toFixed(2)}ms, exit=${result.exitCode}`
        );
        console.log(result.stdout);
        if (result.stderr) {
            console.error(result.stderr);
        }

        const report: BenchmarkReport = {
            timestamp: new Date().toISOString(),
            system: getSystemInfo(),
            config: {
                warmupIterations: WARMUP_ITERATIONS,
                benchmarkIterations: BENCHMARK_ITERATIONS,
                targetFile,
                pythonPath,
            },
            result,
        };

        writeReport(report);

        expect(result.exitCode).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain('Total files checked: 1');
    });
});

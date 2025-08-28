/**
 * Memory testing utilities for Pyright
 *
 * Provides functionality for:
 * - Memory baseline establishment
 * - Heap snapshot management
 * - Memory leak detection
 * - Performance profiling with pprof
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { profileWithDuration } from '../../pprof/profiler';

export interface MemorySnapshot {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    timestamp: number;
}

export interface MemoryTestResult {
    baseline: MemorySnapshot;
    peak: MemorySnapshot;
    final: MemorySnapshot;
    memoryGrowth: number; // MB
    memoryLeaked: boolean;
    profilePath?: string;
}

/**
 * Main class for running memory tests
 */
export class MemoryTestRunner {
    private _outputDir: string;
    private _profileCounter = 0;

    constructor(outputDir: string = './memory-profiles') {
        this._outputDir = outputDir;
        fs.ensureDirSync(outputDir);
    }

    /**
     * Take a memory snapshot
     */
    takeSnapshot(): MemorySnapshot {
        const memUsage = process.memoryUsage();
        return {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            arrayBuffers: memUsage.arrayBuffers,
            timestamp: Date.now(),
        };
    }

    /**
     * Force garbage collection (requires --expose-gc flag)
     */
    async forceGarbageCollection(): Promise<void> {
        if (global.gc) {
            // Run garbage collection multiple times to ensure thorough cleanup
            for (let i = 0; i < 5; i++) {
                global.gc();
                // Small delay between GC cycles
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            console.log('✅ Garbage collection completed (5 cycles)');
        } else {
            console.warn('⚠️ Garbage collection not available. Run with --expose-gc flag.');
        }
    }

    /**
     * Run a memory test with automatic profiling and measurement
     */
    async runMemoryTest<T>(
        testName: string,
        testFunction: () => Promise<T>,
        options: {
            enableProfiling?: boolean;
            gcBefore?: boolean;
            gcAfter?: boolean;
            memoryGrowthThreshold?: number; // in MB
            estimatedDurationMs?: number; // For profiling duration
            intensiveProfiling?: boolean; // Whether to profile intensively during test execution
        } = {}
    ): Promise<MemoryTestResult & { result: T }> {
        const {
            enableProfiling = true,
            gcBefore = true,
            gcAfter = true,
            memoryGrowthThreshold = 50, // 50MB default threshold
            estimatedDurationMs = 10000, // 10 seconds default (increased)
            intensiveProfiling = false, // New option for intensive profiling
        } = options;

        // Force GC before test to establish clean baseline
        if (gcBefore) {
            await this.forceGarbageCollection();
        }

        const baseline = this.takeSnapshot();

        let peak = baseline;
        const originalTakeSnapshot = this.takeSnapshot.bind(this);

        // Override takeSnapshot temporarily to track peak
        this.takeSnapshot = () => {
            const snapshot = originalTakeSnapshot();
            if (snapshot.heapUsed > peak.heapUsed) {
                peak = snapshot;
            }
            return snapshot;
        };

        let result: T;
        let profilePath: string | undefined;

        try {
            if (enableProfiling) {
                // Start profiling concurrently with test execution
                const profileFilePath = path.join(this._outputDir, `${testName}-${this._profileCounter++}.pb.gz`);

                if (intensiveProfiling) {
                    // For intensive profiling, run the test multiple times during profiling window
                    const profilingPromise = profileWithDuration(estimatedDurationMs, profileFilePath);

                    // Run the test function multiple times to generate more CPU activity
                    const results: T[] = [];
                    const startTime = Date.now();

                    while (Date.now() - startTime < estimatedDurationMs - 1000) {
                        // Leave 1s buffer
                        results.push(await testFunction());
                        // Small delay to allow profiler to capture the work
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }

                    result = results[results.length - 1]; // Use the last result
                    await profilingPromise;
                    profilePath = profileFilePath;
                } else {
                    // Standard approach: run test once, then continue profiling
                    const testPromise = testFunction();
                    const profilingPromise = profileWithDuration(estimatedDurationMs, profileFilePath);

                    // Wait for test to complete (profiling may continue longer)
                    result = await testPromise;

                    // Wait for profiling to finish
                    await profilingPromise;
                    profilePath = profileFilePath;
                }
            } else {
                result = await testFunction();
            }
        } finally {
            // Restore original takeSnapshot
            this.takeSnapshot = originalTakeSnapshot;
        }

        // Force GC after test to see what remains
        if (gcAfter) {
            await this.forceGarbageCollection();
        }

        const final = this.takeSnapshot();

        const memoryGrowth = (final.heapUsed - baseline.heapUsed) / (1024 * 1024); // MB
        const memoryLeaked = memoryGrowth > memoryGrowthThreshold;

        // Log pprof instructions if profile was generated
        if (profilePath) {
            console.log('\n📊 Profile Analysis Instructions:');
            console.log('Install pprof CLI: go install github.com/google/pprof@latest');
            console.log(`View flame graph: pprof -http=:8080 ${profilePath}`);
            console.log(`Generate SVG: pprof -svg ${profilePath} > flame.svg`);
        }

        return {
            baseline,
            peak,
            final,
            memoryGrowth,
            memoryLeaked,
            profilePath,
            result,
        };
    }

    /**
     * Generate a memory test report
     */
    generateReport(results: MemoryTestResult[]): string {
        const report = [
            '# Memory Test Report',
            `Generated: ${new Date().toISOString()}`,
            '',
            '## Summary',
            `Total tests: ${results.length}`,
            `Memory leaks detected: ${results.filter((r) => r.memoryLeaked).length}`,
            '',
            '## Test Results',
            '',
        ];

        results.forEach((result, index) => {
            report.push(
                `### Test ${index + 1}`,
                `- Baseline heap: ${(result.baseline.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
                `- Peak heap: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
                `- Final heap: ${(result.final.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
                `- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`,
                `- Memory leak detected: ${result.memoryLeaked ? '⚠️ YES' : '✅ NO'}`,
                `- Profile saved: ${result.profilePath || 'N/A'}`,
                ''
            );
        });

        return report.join('\n');
    }

    /**
     * Save memory test report to file
     */
    async saveReport(results: MemoryTestResult[], filename: string = 'memory-test-report.md'): Promise<string> {
        const reportContent = this.generateReport(results);
        const reportPath = path.join(this._outputDir, filename);
        await fs.writeFile(reportPath, reportContent);
        console.log(`✅ Report saved to: ${reportPath}`);
        return reportPath;
    }
}

/**
 * Utility class for creating test data fixtures
 */
export class MemoryTestFixtures {
    /**
     * Generate a large string for memory testing
     */
    static generateLargeString(sizeInMB: number): string {
        const targetSize = sizeInMB * 1024 * 1024;
        const chunkSize = 1024;
        const chunks = Math.ceil(targetSize / chunkSize);
        const chunk = 'x'.repeat(chunkSize);
        return chunk.repeat(chunks);
    }

    /**
     * Generate a large array for memory testing
     */
    static generateLargeArray(elementCount: number): number[] {
        return new Array(elementCount).fill(0).map((_, i) => i);
    }

    /**
     * Generate a complex object structure for memory testing
     */
    static generateComplexObject(depth: number, breadth: number): any {
        if (depth === 0) {
            return { value: Math.random() };
        }

        const obj: any = {};
        for (let i = 0; i < breadth; i++) {
            obj[`property_${i}`] = this.generateComplexObject(depth - 1, breadth);
        }
        return obj;
    }

    /**
     * Generate a Python source code string for parser testing
     */
    static generatePythonCode(lines: number, complexity: string = 'simple'): string {
        const codeLines: string[] = [];

        switch (complexity) {
            case 'simple':
                for (let i = 0; i < lines; i++) {
                    codeLines.push(`variable_${i} = ${i}`);
                }
                break;

            case 'functions':
                for (let i = 0; i < lines; i++) {
                    codeLines.push(`def function_${i}(arg1, arg2):`);
                    codeLines.push(`    return arg1 + arg2 + ${i}`);
                    codeLines.push('');
                }
                break;

            case 'classes':
                for (let i = 0; i < lines / 5; i++) {
                    codeLines.push(`class Class${i}:`);
                    codeLines.push(`    def __init__(self, value):`);
                    codeLines.push(`        self.value = value`);
                    codeLines.push(`    def method_${i}(self):`);
                    codeLines.push(`        return self.value * ${i}`);
                    codeLines.push('');
                }
                break;

            case 'complex':
                for (let i = 0; i < lines / 10; i++) {
                    codeLines.push(`from typing import List, Dict, Optional, Union`);
                    codeLines.push(`class GenericClass${i}[T]:`);
                    codeLines.push(`    def __init__(self, items: List[T]):`);
                    codeLines.push(`        self.items = items`);
                    codeLines.push(`    def process(self, func: Callable[[T], U]) -> List[U]:`);
                    codeLines.push(`        return [func(item) for item in self.items]`);
                    codeLines.push(`    def filter_items(self, predicate: Callable[[T], bool]) -> 'GenericClass[T]':`);
                    codeLines.push(`        filtered = [item for item in self.items if predicate(item)]`);
                    codeLines.push(`        return GenericClass(filtered)`);
                    codeLines.push('');
                }
                break;
        }

        return codeLines.join('\n');
    }

    /**
     * Generate a large Python file for parser testing
     */
    static generateLargePythonFile(size: 'small' | 'medium' | 'large'): string {
        let lines: number;
        let complexity: string;

        switch (size) {
            case 'small':
                lines = 100;
                complexity = 'simple';
                break;
            case 'medium':
                lines = 500;
                complexity = 'functions';
                break;
            case 'large':
                lines = 1000;
                complexity = 'complex';
                break;
            default:
                lines = 100;
                complexity = 'simple';
        }

        return this.generatePythonCode(lines, complexity);
    }

    /**
     * Create test workspace with multiple Python files
     */
    static async createTestWorkspace(workspaceDir: string): Promise<string[]> {
        await fs.ensureDir(workspaceDir);

        const filePaths: string[] = [];

        // Create multiple test files
        for (let i = 0; i < 10; i++) {
            const filePath = path.join(workspaceDir, `test_file_${i}.py`);
            const content = this.generatePythonCode(50, 'simple');
            await fs.writeFile(filePath, content);
            filePaths.push(filePath);
        }

        return filePaths;
    }
}

/**
 * Memory test assertions and validation utilities
 */
export class MemoryAssertions {
    /**
     * Assert that memory growth is within acceptable limits
     */
    static assertMemoryGrowth(result: MemoryTestResult, maxGrowthMB: number, testName: string): void {
        if (result.memoryGrowth > maxGrowthMB) {
            throw new Error(
                `Memory leak detected in ${testName}: ` +
                    `Growth ${result.memoryGrowth.toFixed(2)}MB exceeds limit of ${maxGrowthMB}MB`
            );
        }
        console.log(`✅ Memory test passed for ${testName}: ${result.memoryGrowth.toFixed(2)}MB growth`);
    }

    /**
     * Assert that no memory leaks are detected
     */
    static assertNoMemoryLeaks(result: MemoryTestResult, testName: string): void {
        if (result.memoryLeaked) {
            throw new Error(`Memory leak detected in ${testName}: ${result.memoryGrowth.toFixed(2)}MB growth`);
        }
        console.log(`✅ No memory leaks detected in ${testName}`);
    }

    /**
     * Expect no memory leak with a specific threshold
     */
    static expectNoMemoryLeak(result: MemoryTestResult, maxGrowthMB: number): void {
        if (result.memoryGrowth > maxGrowthMB) {
            throw new Error(
                `Memory leak detected: Growth ${result.memoryGrowth.toFixed(2)}MB exceeds limit of ${maxGrowthMB}MB`
            );
        }
        console.log(`✅ Memory within limits: ${result.memoryGrowth.toFixed(2)}MB growth`);
    }

    /**
     * Assert that peak memory usage is within limits
     */
    static assertPeakMemory(result: MemoryTestResult, maxPeakMB: number, testName: string): void {
        const peakMB = result.peak.heapUsed / (1024 * 1024);
        if (peakMB > maxPeakMB) {
            throw new Error(
                `Peak memory usage too high in ${testName}: ` + `${peakMB.toFixed(2)}MB exceeds limit of ${maxPeakMB}MB`
            );
        }
        console.log(`✅ Peak memory within limits for ${testName}: ${peakMB.toFixed(2)}MB`);
    }
}

/**
 * Memory tests for Cache Management
 * Tests for memory leaks in cache operations and cleanup
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { CacheManager, CacheOwner } from '../../analyzer/cacheManager';
import { MemoryAssertions, MemoryTestRunner } from './memoryTestUtils';

describe('Cache Memory Tests', () => {
    let memoryRunner: MemoryTestRunner;
    let tempDir: string;

    beforeAll(async () => {
        memoryRunner = new MemoryTestRunner('cache');
        tempDir = path.join(__dirname, 'fixtures', 'temp-cache');
        await fs.ensureDir(tempDir);
    });

    afterAll(async () => {
        await fs.remove(tempDir);
    });

    beforeEach(async () => {
        // Force multiple GC cycles before each test
        await forceGarbageCollection();
    });

    afterEach(async () => {
        // Force GC after each test to clean up
        await forceGarbageCollection();
    });

    async function forceGarbageCollection(cycles = 3): Promise<void> {
        if (global.gc) {
            for (let i = 0; i < cycles; i++) {
                global.gc();
                // Wait for GC to complete
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
    }

    // Mock cache owner for testing
    class TestCacheOwner implements CacheOwner {
        private _cache = new Map<string, any>();
        private _maxSize: number;

        constructor(maxSize = 1000) {
            this._maxSize = maxSize;
        }

        getCacheUsage(): number {
            return this._cache.size / this._maxSize;
        }

        emptyCache(): void {
            this._cache.clear();
        }

        setData(key: string, value: any): void {
            this._cache.set(key, value);
        }

        getData(key: string): any {
            return this._cache.get(key);
        }

        deleteData(key: string): boolean {
            return this._cache.delete(key);
        }

        size(): number {
            return this._cache.size;
        }
    }

    test('should not leak memory when managing cache owners', async () => {
        const result = await memoryRunner.runMemoryTest(
            'cache-owner-management',
            async () => {
                const results = [];

                for (let i = 0; i < 50; i++) {
                    const cacheManager = new CacheManager();
                    const cacheOwners: TestCacheOwner[] = [];

                    // Create multiple cache owners
                    for (let j = 0; j < 10; j++) {
                        const owner = new TestCacheOwner(100);
                        cacheOwners.push(owner);
                        cacheManager.registerCacheOwner(owner);

                        // Add data to cache
                        for (let k = 0; k < 50; k++) {
                            owner.setData(`key_${i}_${j}_${k}`, {
                                data: `value_${i}_${j}_${k}`,
                                number: k,
                                array: new Array(10).fill(k),
                            });
                        }
                    }

                    // Verify cache usage reporting
                    for (const owner of cacheOwners) {
                        const usage = owner.getCacheUsage();
                        expect(usage).toBeGreaterThanOrEqual(0);
                        expect(usage).toBeLessThanOrEqual(1);
                    }

                    // Trigger cache emptying
                    for (const owner of cacheOwners) {
                        owner.emptyCache();
                    }

                    results.push(i);

                    // Force GC every 10 iterations
                    if (i % 10 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }

                    // Aggressive GC every 20 iterations
                    if (i % 20 === 0) {
                        await forceGarbageCollection(4);
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 40, // 40MB threshold for cache operations
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 40);

        console.log(`Cache Owner Management Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 60000);

    test('should properly clean up large cache data structures', async () => {
        const result = await memoryRunner.runMemoryTest(
            'large-cache-structures',
            async () => {
                const results = [];

                for (let i = 0; i < 30; i++) {
                    const cacheOwner = new TestCacheOwner(1000);

                    // Create large data structures in cache
                    for (let j = 0; j < 100; j++) {
                        const largeData = {
                            id: `${i}_${j}`,
                            content: 'x'.repeat(5000), // 5KB string
                            numbers: new Array(1000).fill(j),
                            nested: {
                                level1: new Array(200).fill(`nested_${i}_${j}`),
                                level2: {
                                    data: new Array(300).fill(j),
                                    metadata: 'y'.repeat(2000),
                                },
                            },
                        };

                        cacheOwner.setData(`large_entry_${i}_${j}`, largeData);
                    }

                    // Verify cache usage
                    const usage = cacheOwner.getCacheUsage();
                    expect(usage).toBeGreaterThan(0);

                    // Clear cache
                    cacheOwner.emptyCache();

                    results.push(i);

                    // Force GC every 5 iterations
                    if (i % 5 === 0) {
                        await forceGarbageCollection(3);
                        memoryRunner.takeSnapshot();
                    }

                    // Extra aggressive GC every 10 iterations
                    if (i % 10 === 0) {
                        await forceGarbageCollection(5);
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 60, // 60MB threshold for large structures
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 60);

        console.log(`Large Cache Structures Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 60000);

    test('should handle cache eviction patterns without memory accumulation', async () => {
        const result = await memoryRunner.runMemoryTest(
            'cache-eviction-patterns',
            async () => {
                const results = [];
                const cacheOwner = new TestCacheOwner(500); // Smaller cache for eviction testing

                for (let iteration = 0; iteration < 100; iteration++) {
                    // Fill cache beyond capacity to trigger eviction-like behavior
                    for (let i = 0; i < 200; i++) {
                        const data = {
                            iteration,
                            index: i,
                            payload: `data_${iteration}_${i}`.repeat(50), // ~1KB per entry
                            timestamp: Date.now(),
                        };

                        cacheOwner.setData(`entry_${iteration}_${i}`, data);

                        // Simulate eviction by removing old entries
                        if (cacheOwner.size() > 100) {
                            const oldKey = `entry_${iteration}_${i - 50}`;
                            cacheOwner.deleteData(oldKey);
                        }
                    }

                    // Periodically empty cache to test cleanup
                    if (iteration % 20 === 0) {
                        cacheOwner.emptyCache();
                        await forceGarbageCollection(2);
                    }

                    results.push(iteration);

                    // Force GC every 10 iterations
                    if (iteration % 10 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }

                    // Aggressive GC every 25 iterations
                    if (iteration % 25 === 0) {
                        await forceGarbageCollection(4);
                    }
                }

                // Final cleanup
                cacheOwner.emptyCache();
                await forceGarbageCollection(4);

                return results;
            },
            {
                enableProfiling: false, // Focus on memory measurement
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 35, // 35MB threshold
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 35);

        console.log(`Cache Eviction Patterns Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
    }, 45000);

    test('should handle multiple cache managers without interference', async () => {
        const result = await memoryRunner.runMemoryTest(
            'multiple-cache-managers',
            async () => {
                const results = [];

                for (let i = 0; i < 25; i++) {
                    const managers: CacheManager[] = [];
                    const owners: TestCacheOwner[][] = [];

                    // Create multiple cache managers
                    for (let j = 0; j < 5; j++) {
                        const manager = new CacheManager();
                        managers.push(manager);

                        const managerOwners: TestCacheOwner[] = [];
                        for (let k = 0; k < 5; k++) {
                            const owner = new TestCacheOwner(50);
                            managerOwners.push(owner);
                            manager.registerCacheOwner(owner);

                            // Add some data
                            for (let l = 0; l < 20; l++) {
                                owner.setData(`data_${i}_${j}_${k}_${l}`, {
                                    value: l,
                                    text: `text_${l}`.repeat(10),
                                });
                            }
                        }
                        owners.push(managerOwners);
                    }

                    // Clean up all caches
                    for (const managerOwners of owners) {
                        for (const owner of managerOwners) {
                            owner.emptyCache();
                        }
                    }

                    results.push(i);

                    // Force GC every 5 iterations
                    if (i % 5 === 0) {
                        await forceGarbageCollection(3);
                        memoryRunner.takeSnapshot();
                    }

                    // Extra aggressive GC every 10 iterations
                    if (i % 10 === 0) {
                        await forceGarbageCollection(5);
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 45, // 45MB threshold
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 45);

        console.log(`Multiple Cache Managers Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 50000);
});

/**
 * Memory tests for the Python parser
 * Tests for memory leaks in file parsing operations
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseOptions, Parser } from '../../parser/parser';
import { MemoryAssertions, MemoryTestFixtures, MemoryTestRunner } from './memoryTestUtils';

describe('Parser Memory Tests', () => {
    let memoryRunner: MemoryTestRunner;
    let tempDir: string;

    beforeAll(async () => {
        memoryRunner = new MemoryTestRunner('parser');
        tempDir = path.join(__dirname, 'fixtures', 'temp-parser');
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

    test('should not leak memory when parsing large files repeatedly', async () => {
        const iterations = 30; // Reduced for intensive profiling
        const largeFileContent = MemoryTestFixtures.generateLargePythonFile('large'); // Back to large for more CPU work

        const result = await memoryRunner.runMemoryTest(
            'large-file-parsing',
            async () => {
                const results = [];

                for (let i = 0; i < iterations; i++) {
                    const parseOptions = new ParseOptions();
                    parseOptions.isStubFile = false;
                    parseOptions.pythonVersion = { major: 3, minor: 9 };

                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();
                    const parseResult = parser.parseSourceFile(largeFileContent, parseOptions, diagSink);

                    results.push(parseResult);

                    // Force GC every 5 iterations
                    if (i % 5 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }

                    // Clear results array periodically to prevent accumulation
                    if (i % 10 === 0 && results.length > 10) {
                        results.splice(0, results.length - 5); // Keep only last 5 results
                        await forceGarbageCollection(1);
                    }
                }

                return results.slice(-5); // Return only last 5 results
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 50, // Reduced from 100MB to 50MB
                estimatedDurationMs: 15000, // 15 seconds for more profiling data
                intensiveProfiling: true, // Enable intensive profiling
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 50);

        console.log(`Parser Large File Memory Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 90000); // 90 second timeout for intensive profiling

    test('should profile intensive parsing operations with complex syntax', async () => {
        // Generate a complex Python file with nested structures that require more CPU to parse
        const complexContent = `
# Complex Python file with deep nesting and various syntax elements
import sys, os, json, typing
from typing import Dict, List, Optional, Union, Generic, TypeVar, Callable
from collections import defaultdict, deque
from dataclasses import dataclass, field
from abc import ABC, abstractmethod

T = TypeVar('T')
U = TypeVar('U', bound=str)

@dataclass
class ComplexClass(ABC, Generic[T]):
    data: Dict[str, List[Optional[Union[int, str, float]]]]
    callbacks: List[Callable[[T], Union[T, None]]] = field(default_factory=list)
    
    @abstractmethod
    async def process_data(self, 
                          input_data: Dict[str, Union[str, int, List[Dict[str, Any]]]],
                          processors: Optional[List[Callable[[Any], Any]]] = None,
                          **kwargs) -> Union[Dict[str, Any], List[Any], None]:
        pass
    
    def nested_comprehensions(self):
        return [
            {
                f"key_{i}_{j}": [
                    x**2 + y**3 for x in range(10) for y in range(5)
                    if (x * y) % 2 == 0 and x > y
                ]
                for j in range(10)
                if j % 2 == 0
            }
            for i in range(20)
            if i % 3 == 0
        ]
    
    async def complex_async_method(self):
        async def nested_async():
            for i in range(100):
                yield {
                    'value': await self.async_computation(i),
                    'metadata': {
                        'processed_at': time.time(),
                        'iteration': i,
                        'nested_data': [
                            {'sub_value': j * i, 'computed': j**i if i < 10 else j}
                            for j in range(min(i, 50))
                        ]
                    }
                }
        
        results = []
        async for item in nested_async():
            if await self.validate_item(item):
                results.append(await self.transform_item(item))
        return results

class VeryComplexClass(ComplexClass[str]):
    def __init__(self):
        super().__init__(data=defaultdict(list), callbacks=[])
        self.deep_nested_dict = {
            f"level1_{i}": {
                f"level2_{j}": {
                    f"level3_{k}": {
                        f"level4_{l}": [
                            ComplexDataStructure(
                                id=f"{i}_{j}_{k}_{l}_{m}",
                                value=i*j*k*l*m,
                                metadata={
                                    'created': time.time(),
                                    'complex_calc': (i**2 + j**3 + k**4 + l**5) % 1000
                                }
                            )
                            for m in range(5)
                        ]
                        for l in range(3)
                    }
                    for k in range(4)
                }
                for j in range(5)
            }
            for i in range(10)
        }

# Multiple function definitions with complex signatures
def ultra_complex_function(
    param1: Dict[str, List[Union[ComplexClass[Any], VeryComplexClass]]],
    param2: Optional[Callable[[T], Union[T, List[T], Dict[str, T]]]] = None,
    *args: Union[str, int, Dict[str, Any]],
    **kwargs: Union[Dict[str, Any], List[Any], ComplexClass[Any]]
) -> Union[
    Dict[str, Union[ComplexClass[Any], List[ComplexClass[Any]]]],
    List[Union[str, ComplexClass[Any]]],
    None
]:
    # Complex function body with multiple nested structures
    try:
        with complex_context_manager() as ctx:
            for i, (key, values) in enumerate(param1.items()):
                if isinstance(values, list):
                    processed = [
                        await process_complex_item(item, ctx, **{
                            f"param_{j}": value
                            for j, value in enumerate(args[:min(len(args), 10)])
                        })
                        for item in values
                        if validate_complex_condition(item, i, key)
                    ]
                    yield from process_batch(processed, batch_size=50)
                elif isinstance(values, dict):
                    for nested_key, nested_values in values.items():
                        if nested_key.startswith('complex_'):
                            async with async_context_manager(nested_key) as async_ctx:
                                async for result in process_nested_async(nested_values, async_ctx):
                                    if result and hasattr(result, 'complex_attribute'):
                                        yield transform_result(result, **kwargs)
    except (ComplexException, AnotherComplexException) as e:
        logger.error(f"Complex error in ultra_complex_function: {e}")
        return handle_complex_error(e, param1, param2, args, kwargs)
    finally:
        cleanup_complex_resources()

# Generate many similar complex patterns
${Array.from(
    { length: 10 },
    (_, i) => `
class DynamicClass${i}(ComplexClass[Union[str, int]]):
    def dynamic_method_${i}(self, param: Dict[str, List[Any]]) -> List[Dict[str, Any]]:
        return [
            {
                f"generated_{j}_{k}": [
                    complex_computation(x, y, ${i}) 
                    for x, y in itertools.product(range(${i + 5}), range(${i + 3}))
                    if complex_condition(x, y, ${i})
                ]
                for k in range(${i + 2})
            }
            for j in range(${i + 1})
        ]
`
).join('')}
        `.repeat(50); // Repeat the content 50 times to make it very large

        const result = await memoryRunner.runMemoryTest(
            'intensive-complex-parsing',
            async () => {
                const results = [];

                // Parse the complex content multiple times
                for (let iteration = 0; iteration < 20; iteration++) {
                    const parseOptions = new ParseOptions();
                    parseOptions.isStubFile = false;
                    parseOptions.pythonVersion = { major: 3, minor: 11 };

                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();

                    // Parse the complex content
                    const parseResult = parser.parseSourceFile(complexContent, parseOptions, diagSink);
                    results.push(parseResult);

                    // Also parse some additional complex patterns
                    for (let variant = 0; variant < 5; variant++) {
                        const variantContent = complexContent.replace(/Complex/g, `Complex${variant}`);
                        const variantResult = parser.parseSourceFile(variantContent, parseOptions, diagSink);
                        results.push(variantResult);
                    }

                    // Periodic cleanup but keep some work in memory
                    if (iteration % 5 === 0) {
                        results.splice(0, Math.floor(results.length / 2));
                        memoryRunner.takeSnapshot();
                    }
                }

                return results.slice(-10);
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: false, // Keep garbage to see memory patterns
                memoryGrowthThreshold: 100, // Higher threshold for complex operations
                estimatedDurationMs: 20000, // 20 seconds of profiling
                intensiveProfiling: true, // Multiple iterations during profiling
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 100); // Higher threshold

        console.log(`Intensive Complex Parsing Memory Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
        console.log(`- This profile should show detailed parsing function calls in flame graph`);
    }, 120000); // 2 minute timeout for intensive test

    test('should not leak memory when parsing many small files', async () => {
        const numFiles = 50; // Reduced from 200 to 50
        const smallFileContent = MemoryTestFixtures.generateLargePythonFile('small');

        const result = await memoryRunner.runMemoryTest(
            'many-small-files',
            async () => {
                const results = [];

                for (let i = 0; i < numFiles; i++) {
                    const parseOptions = new ParseOptions();
                    parseOptions.isStubFile = false;
                    parseOptions.pythonVersion = { major: 3, minor: 9 };

                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();
                    const parseResult = parser.parseSourceFile(smallFileContent, parseOptions, diagSink);

                    results.push(parseResult);

                    // More frequent GC - every 5 files instead of 20
                    if (i % 5 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }

                    // Clear results periodically to prevent accumulation
                    if (i % 10 === 0 && results.length > 10) {
                        results.splice(0, results.length - 5); // Keep only last 5 results
                        await forceGarbageCollection(3);
                    }
                }

                return results.slice(-10); // Return only last 10 results
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 25, // Reduced from 50MB to 25MB
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 25);

        console.log(`Many Small Files Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 30000); // Reduced timeout from 45 to 30 seconds

    test('should properly clean up parser instances with aggressive GC', async () => {
        const iterations = 30; // Reduced from 100 to 30
        const testContent = `
# Test file for parser memory testing with various constructs
from typing import Dict, List, Optional, Union, Generic, TypeVar
import asyncio

T = TypeVar('T')

class TestClass(Generic[T]):
    def __init__(self, value: T) -> None:
        self.value = value
    
    def compute(self, key: str) -> Optional[T]:
        return self.value if key else None

def simple_function(data: Union[int, str]) -> str:
    return str(data)

class Parser1: pass
`;

        const result = await memoryRunner.runMemoryTest(
            'parser-cleanup-with-gc',
            async () => {
                const results = [];

                for (let i = 0; i < iterations; i++) {
                    const parseOptions = new ParseOptions();
                    parseOptions.pythonVersion = { major: 3, minor: 9 };

                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();
                    const parseResult = parser.parseSourceFile(testContent, parseOptions, diagSink);

                    results.push(parseResult);

                    // Verify parse tree is created
                    expect(parseResult.parserOutput.parseTree).toBeDefined();

                    // More frequent GC - every 5 iterations instead of 10
                    if (i % 5 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }

                    // Clear results periodically
                    if (i % 10 === 0 && results.length > 10) {
                        results.splice(0, results.length - 5); // Keep only last 5 results
                        await forceGarbageCollection(3);
                    }
                }

                return results.slice(-5); // Return only last 5 results
            },
            {
                enableProfiling: false, // Disable profiling for faster execution
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 15, // Reduced from 20MB to 15MB
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 15);

        console.log(`Parser Cleanup with GC Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
    }, 20000); // Reduced timeout from 30 to 20 seconds

    test('should handle parse errors without memory leaks', async () => {
        const invalidPythonCode = [
            'def invalid_function(\n', // Incomplete function definition
            'class UnfinishedClass:\n    def method(self\n', // Incomplete method
            'if True\n    print("missing colon")\n', // Missing colon
        ];

        const result = await memoryRunner.runMemoryTest(
            'parse-errors',
            async () => {
                const results = [];

                for (let iteration = 0; iteration < 20; iteration++) {
                    // Reduced from 50 to 20
                    for (const invalidCode of invalidPythonCode) {
                        const parseOptions = new ParseOptions();
                        parseOptions.isStubFile = false;
                        parseOptions.pythonVersion = { major: 3, minor: 9 };

                        const parser = new Parser();
                        const diagSink = new DiagnosticSink();

                        // This should handle errors gracefully
                        const parseResult = parser.parseSourceFile(invalidCode, parseOptions, diagSink);
                        results.push(parseResult);

                        // Expect parse errors to be present in diagnostics
                        const diagnostics = diagSink.getErrors();
                        expect(diagnostics.length).toBeGreaterThan(0);
                    }

                    if (iteration % 5 === 0) {
                        // More frequent snapshots
                        memoryRunner.takeSnapshot();
                        await forceGarbageCollection(2);
                    }

                    // Clear results periodically
                    if (iteration % 10 === 0 && results.length > 15) {
                        results.splice(0, results.length - 10); // Keep only last 10 results
                        await forceGarbageCollection(3);
                    }
                }

                return results.slice(-10); // Return only last 10 results
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 20, // Reduced from 30MB to 20MB
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 20);

        console.log(`Parse Errors Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 30000); // Reduced timeout from 45 to 30 seconds

    test('should handle very long lines without excessive memory usage', async () => {
        // Create a Python file with very long lines (reduced size)
        const longLine = 'x = ' + '"a" + '.repeat(200) + '"final"'; // Reduced from 1000 to 200
        const longFileContent = [
            '# File with very long lines',
            longLine,
            'def function_after_long_line():',
            '    return True',
        ].join('\n');

        const result = await memoryRunner.runMemoryTest(
            'long-lines',
            async () => {
                const results = [];

                for (let i = 0; i < 10; i++) {
                    // Reduced from 20 to 10
                    const parseOptions = new ParseOptions();
                    parseOptions.isStubFile = false;
                    parseOptions.pythonVersion = { major: 3, minor: 9 };

                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();
                    const parseResult = parser.parseSourceFile(longFileContent, parseOptions, diagSink);

                    results.push(parseResult);

                    if (i % 3 === 0) {
                        // More frequent snapshots
                        memoryRunner.takeSnapshot();
                        await forceGarbageCollection(2);
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 20, // Reduced from 40MB to 20MB
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 20);

        console.log(`Long Lines Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 20000); // Reduced timeout from 30 to 20 seconds
});

/**
 * Memory tests for the Type Evaluator
 * Tests for memory leaks in type analysis and evaluation operations
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { ImportResolver } from '../../analyzer/importResolver';
import { Program } from '../../analyzer/program';
import { ConfigOptions } from '../../common/configOptions';
import { NullConsole } from '../../common/console';
import { FullAccessHost } from '../../common/fullAccessHost';
import { RealTempFile, createFromRealFileSystem } from '../../common/realFileSystem';
import { createServiceProvider } from '../../common/serviceProviderExtensions';
import { Uri } from '../../common/uri/uri';
import { UriEx } from '../../common/uri/uriUtils';
import { MemoryAssertions, MemoryTestRunner } from './memoryTestUtils';

describe('Type Evaluator Memory Tests', () => {
    let memoryRunner: MemoryTestRunner;
    let tempDir: string;

    beforeAll(async () => {
        memoryRunner = new MemoryTestRunner('type-evaluator');
        tempDir = path.join(__dirname, 'fixtures', 'temp-evaluator');
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

    function createTestProgram(): Program {
        const configOptions = new ConfigOptions(Uri.empty());
        configOptions.internalTestMode = true;

        const tempFile = new RealTempFile();
        const fs = createFromRealFileSystem(tempFile);
        const serviceProvider = createServiceProvider(fs, new NullConsole(), tempFile);
        const importResolver = new ImportResolver(serviceProvider, configOptions, new FullAccessHost(serviceProvider));

        return new Program(importResolver, configOptions, serviceProvider);
    }

    test('should not leak memory during type analysis of complex generics', async () => {
        const complexGenericCode = `
from typing import Dict, List, Optional, Union, Generic, TypeVar, Protocol, Callable
from abc import ABC, abstractmethod

T = TypeVar('T', bound='Comparable')
U = TypeVar('U')
V = TypeVar('V')

class Comparable(Protocol):
    def __lt__(self, other: 'Comparable') -> bool: ...

class ComplexGeneric(Generic[T, U, V]):
    def __init__(self, value: T, metadata: U, transformer: Callable[[T], V]) -> None:
        self.value = value
        self.metadata = metadata
        self.transformer = transformer
        self._cache: Dict[str, Union[T, U, V]] = {}
    
    def transform(self) -> V:
        return self.transformer(self.value)
    
    def get_cached(self, key: str) -> Optional[Union[T, U, V]]:
        return self._cache.get(key)

# Create many complex type instantiations
instances: List[ComplexGeneric[int, str, float]] = []
for i in range(100):
    instances.append(ComplexGeneric(i, f"meta_{i}", lambda x: float(x * 2)))

# Complex nested types
nested_dict: Dict[str, Dict[int, List[Optional[ComplexGeneric[str, int, bool]]]]] = {}
`;

        const testFilePath = path.join(tempDir, 'complex_generics.py');
        await fs.writeFile(testFilePath, complexGenericCode);

        const result = await memoryRunner.runMemoryTest(
            'complex-generics-analysis',
            async () => {
                const results = [];

                for (let i = 0; i < 20; i++) {
                    const program = createTestProgram();
                    const fileUri = UriEx.file(testFilePath);

                    // Set tracked files and analyze
                    program.setTrackedFiles([fileUri]);

                    // Force analysis completion
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    results.push(i);

                    // Force GC every few iterations
                    if (i % 4 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 100, // 100MB threshold for complex generics
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 100);

        console.log(`Complex Generics Analysis Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 120000);

    test('should not leak memory during repeated type checking', async () => {
        const unionTypeCode = `
from typing import Union, List, Dict, Optional, Callable, Any

# Code with many union types to stress type evaluator
def process_mixed_data(
    data: Union[int, str, float, bool, None]
) -> Union[str, int, None]:
    if isinstance(data, str):
        return len(data)
    elif isinstance(data, (int, float)):
        return str(data)
    else:
        return None

# Complex union with callables
Handler = Union[
    Callable[[int], str],
    Callable[[str], int], 
    Callable[[float], bool],
    Callable[[bool], None]
]

def apply_handler(
    handler: Handler,
    value: Union[int, str, float, bool]
) -> Union[str, int, bool, None]:
    return handler(value)

# Nested unions and generics
NestedData = Dict[str, List[Union[int, Dict[str, Union[str, List[int]]]]]]

def process_nested(data: NestedData) -> List[Union[int, str]]:
    results: List[Union[int, str]] = []
    for key, values in data.items():
        results.append(key)
        for value in values:
            if isinstance(value, int):
                results.append(value)
            elif isinstance(value, dict):
                for nested_key, nested_value in value.items():
                    results.append(nested_key)
                    if isinstance(nested_value, str):
                        results.append(nested_value)
                    elif isinstance(nested_value, list):
                        results.extend(nested_value)
    return results
`;

        const testFilePath = path.join(tempDir, 'union_types.py');
        await fs.writeFile(testFilePath, unionTypeCode);

        const result = await memoryRunner.runMemoryTest(
            'repeated-union-type-checking',
            async () => {
                const results = [];

                for (let i = 0; i < 30; i++) {
                    const program = createTestProgram();
                    const fileUri = UriEx.file(testFilePath);

                    program.setTrackedFiles([fileUri]);

                    // Complete analysis
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    results.push(i);

                    // Force GC every 5 iterations
                    if (i % 5 === 0) {
                        await forceGarbageCollection(2);
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                memoryGrowthThreshold: 80, // 80MB threshold
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 80);

        console.log(`Repeated Union Type Checking Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 90000);

    test('should handle type cache cleanup properly', async () => {
        const cacheTestCode = `
from typing import Dict, List, Set, Tuple, Union, Optional, TypeVar, Generic

T = TypeVar('T')

class CacheStressor(Generic[T]):
    def __init__(self, value: T) -> None:
        self.value = value
    
    def process(self) -> Dict[str, Union[T, List[T], Set[T], Tuple[T, ...]]]:
        return {
            "single": self.value,
            "list": [self.value] * 10,
            "set": {self.value} if isinstance(self.value, (str, int, float)) else set(),
            "tuple": tuple([self.value] * 5)
        }

# Create many instances with different types
int_stressor = CacheStressor[int](42)
str_stressor = CacheStressor[str]("test")
float_stressor = CacheStressor[float](3.14)
bool_stressor = CacheStressor[bool](True)

# Process to create type cache entries
int_result = int_stressor.process()
str_result = str_stressor.process()
float_result = float_stressor.process()
bool_result = bool_stressor.process()

# Complex type expressions
combined: Dict[str, Union[
    CacheStressor[int], 
    CacheStressor[str], 
    CacheStressor[float], 
    CacheStressor[bool]
]] = {
    "int": int_stressor,
    "str": str_stressor, 
    "float": float_stressor,
    "bool": bool_stressor
}
`;

        const testFilePath = path.join(tempDir, 'cache_stress.py');
        await fs.writeFile(testFilePath, cacheTestCode);

        const result = await memoryRunner.runMemoryTest(
            'type-cache-cleanup',
            async () => {
                const results = [];

                for (let i = 0; i < 25; i++) {
                    const program = createTestProgram();
                    const fileUri = UriEx.file(testFilePath);

                    program.setTrackedFiles([fileUri]);

                    // Complete analysis
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    results.push(i);

                    // Aggressive GC to test cache cleanup
                    if (i % 3 === 0) {
                        await forceGarbageCollection(4);
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: false, // Focus on memory measurement
                memoryGrowthThreshold: 60, // 60MB threshold
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 60);

        console.log(`Type Cache Cleanup Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
    }, 75000);

    test('should handle large function signatures without memory leaks', async () => {
        const largeFunctionCode = `
from typing import Callable, Dict, List, Optional, Union, Any, Tuple

# Function with very large signature
def large_signature_function(
    param1: int,
    param2: str,
    param3: float,
    param4: bool,
    param5: Optional[List[int]],
    param6: Dict[str, Union[int, str]],
    param7: Callable[[int, str], bool],
    param8: Tuple[int, str, float, bool],
    param9: Union[int, str, float, bool, None],
    param10: Optional[Dict[str, List[Union[int, str]]]],
    param11: Callable[[Union[int, str]], Optional[bool]],
    param12: List[Dict[str, Union[int, Callable[[str], int]]]],
    param13: Dict[str, Tuple[int, Callable[[float], str]]],
    param14: Optional[Union[int, Callable[[bool], str]]],
    param15: List[Union[str, Dict[int, bool]]],
    param16: Callable[[List[int]], Dict[str, bool]],
    param17: Tuple[Union[int, str], Optional[bool], List[float]],
    param18: Dict[Union[int, str], List[Union[bool, float]]],
    param19: Optional[Callable[[Dict[str, int]], List[bool]]],
    param20: Union[int, str, float, bool, List[Any], Dict[str, Any]]
) -> Union[
    int, str, float, bool, None,
    List[Union[int, str]],
    Dict[str, Union[int, bool]],
    Callable[[int], str],
    Tuple[int, str, bool]
]:
    # Implementation doesn't matter for memory testing
    return param1

# Create many calls to stress signature processing
for i in range(50):
    result = large_signature_function(
        i, f"str_{i}", float(i), bool(i % 2),
        [i, i+1], {"key": i}, lambda x, y: bool(x),
        (i, f"t_{i}", float(i), bool(i % 2)),
        i if i % 2 else f"str_{i}",
        {"nested": [i, f"n_{i}"]} if i % 3 else None,
        lambda x: bool(x) if isinstance(x, int) else None,
        [{"func_key": i, "func_val": lambda s: len(s)}],
        {"tuple_key": (i, lambda f: str(f))},
        i if i % 4 else lambda b: str(b),
        [f"list_str_{i}", {"dict_key": bool(i % 2)}],
        lambda lst: {"result": bool(sum(lst))},
        (i, bool(i % 2), [float(i)]),
        {i: [bool(i % 2), float(i)]},
        lambda d: [bool(v) for v in d.values()] if i % 5 else None,
        i
    )
`;

        const testFilePath = path.join(tempDir, 'large_signatures.py');
        await fs.writeFile(testFilePath, largeFunctionCode);

        const result = await memoryRunner.runMemoryTest(
            'large-signature-analysis',
            async () => {
                const results = [];

                for (let i = 0; i < 15; i++) {
                    const program = createTestProgram();
                    const fileUri = UriEx.file(testFilePath);

                    program.setTrackedFiles([fileUri]);

                    // Complete analysis
                    while (program.analyze()) {
                        // Continue analysis
                    }

                    results.push(i);

                    // Force GC every few iterations
                    if (i % 3 === 0) {
                        await forceGarbageCollection(3);
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                memoryGrowthThreshold: 70, // 70MB threshold for large signatures
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 70);

        console.log(`Large Signature Analysis Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 100000);
});

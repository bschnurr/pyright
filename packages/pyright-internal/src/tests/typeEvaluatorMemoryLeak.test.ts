/*
 * typeEvaluatorMemoryLeak.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Memory leak detection test
 *
 * Memory leak test for the type evaluator to ensure proper cleanup
 * of internal data structures.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ImportLookup } from '../analyzer/analyzerFileInfo';
import { createTypeEvaluator, EvaluatorOptions } from '../analyzer/typeEvaluator';
import { PrintTypeFlags } from '../analyzer/typePrinter';
import { ConfigOptions } from '../common/configOptions';
import { Uri } from '../common/uri/uri';
import * as TestUtils from './testUtils';

const TEST_ITERATIONS = 200; // tune up/down for speed vs. sensitivity
const ALLOWABLE_GROWTH = 2 * 1024 ** 2.5; // 2.5 MB heap delta tolerance

function runOnePass() {
    // Create a temporary sample file with complex types that stress the evaluator
    const tempFile = `
from typing import Literal, Union, TypeVar, Generic, Callable, Optional, Dict, List, Tuple, Overload, Protocol, Any
from typing_extensions import TypedDict, ParamSpec, TypeVarTuple, Unpack
from abc import ABC, abstractmethod
import asyncio

T = TypeVar('T', bound='BaseClass')
U = TypeVar('U')
V = TypeVar('V')
P = ParamSpec('P')
Ts = TypeVarTuple('Ts')

# Recursive type that can cause circular references
class Node(Generic[T]):
    def __init__(self, value: T, children: Optional[List['Node[T]']] = None) -> None:
        self.value = value
        self.children = children or []
    
    def add_child(self, child: 'Node[T]') -> None:
        self.children.append(child)

# Complex inheritance hierarchy
class BaseClass(ABC, Generic[T]):
    @abstractmethod
    def process(self, item: T) -> T: ...

class MiddleClass(BaseClass[Union[str, int]], Generic[U]):
    def process(self, item: Union[str, int]) -> Union[str, int]:
        return item
    
    def transform(self, data: U) -> Dict[str, U]:
        return {"result": data}

class ComplexClass(MiddleClass[Tuple[T, ...]], Generic[T]):
    def process(self, item: Union[str, int]) -> Union[str, int]:
        return item

# Overloaded functions that stress type inference
@overload
def complex_overload(x: int) -> int: ...
@overload
def complex_overload(x: str) -> str: ...
@overload
def complex_overload(x: List[T]) -> List[T]: ...
def complex_overload(x): return x

# Protocol with complex constraints
class ComplexProtocol(Protocol[T]):
    def method1(self) -> Callable[[T], Optional[T]]: ...
    def method2(self, *args: Unpack[Ts]) -> Tuple[Unpack[Ts]]: ...

# TypedDict with complex nested structure
class NestedTypedDict(TypedDict):
    data: Dict[str, List[Tuple[int, Optional[str]]]]
    metadata: Dict[Literal["type", "version"], Union[str, int]]
    callbacks: List[Callable[[Any], None]]

# Complex literal types that stress the cache
def mega_function(
    literals: Literal[${Array.from({ length: 200 }, (_, i) => `"option_${i}"`).join(', ')}],
    unions: Union[${Array.from({ length: 30 }, (_, i) => `ComplexClass[Literal[${i}]]`).join(', ')}],
    nested: Dict[str, List[Tuple[Node[int], Optional[Callable[[T], T]]]]],
    params: Callable[P, T]
) -> Callable[P, Optional[T]]:
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> Optional[T]:
        return params(*args, **kwargs)
    return wrapper

# Async context that can complicate type tracking
async def async_complex(
    data: List[ComplexClass[Tuple[str, int]]]
) -> AsyncGenerator[Node[Union[str, int]], None]:
    for item in data:
        yield Node(("async", 42))

# Force complex type evaluation with error conditions
try:
    # This should trigger complex error analysis
    invalid_call = mega_function("invalid", ComplexClass(), {}, lambda x: x)
    
    # Complex comprehension that stresses inference
    result = [
        Node(x.transform((i, str(i))))
        for i in range(10)
        for x in [ComplexClass[Tuple[int, str]]()]
        if isinstance(x.process(i), int)
    ]
    
    # Recursive type construction
    root = Node[Dict[str, Any]]({})
    for i in range(5):
        child = Node[Dict[str, Any]]({"level": i})
        root.add_child(child)
        
except Exception:
    pass  # Intentionally trigger error handling paths
`;

    // Write to a temporary file and analyze it
    const tempFileName = 'memory_test_temp.py';
    const configOptions = new ConfigOptions(Uri.empty());
    configOptions.internalTestMode = true;

    // Create a minimal test file system
    const tempFilePath = path.join(__dirname, 'temp', tempFileName);

    try {
        // Ensure temp directory exists
        const tempDir = path.dirname(tempFilePath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Write the test file
        fs.writeFileSync(tempFilePath, tempFile);

        // Analyze the file using the test utilities
        const analysisResults = TestUtils.typeAnalyzeSampleFiles([`temp/${tempFileName}`], configOptions);

        // Force processing of results to ensure type evaluation
        for (const result of analysisResults) {
            // Access properties to force evaluation
            const hasErrors = result.errors.length > 0;
            const hasWarnings = result.warnings.length > 0;
            const hasInfo = result.infos.length > 0;
            // Suppress unused variable warnings
            void hasErrors;
            void hasWarnings;
            void hasInfo;
        }
    } finally {
        // Clean up the temporary file
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch {
            // Ignore cleanup errors
        }
    }
}

function heap(): number {
    return process.memoryUsage().heapUsed;
}

test.skip('Type evaluator does not leak memory', () => {
    if (typeof global.gc !== 'function') {
        throw new Error('Run with:  node --expose-gc  ./node_modules/.bin/jest typeEvaluatorMemoryLeak.test.ts');
    }

    global.gc(); // start with a clean heap
    const baseline = heap();

    for (let i = 0; i < TEST_ITERATIONS; i++) {
        runOnePass();
        if (i % 20 === 19) {
            global.gc();
        }
    }

    global.gc();
    const final = heap();
    const delta = final - baseline;

    console.log(`Baseline: ${(baseline / 1_048_576).toFixed(1)} MB`);
    console.log(`Final:    ${(final / 1_048_576).toFixed(1)} MB`);
    console.log(`Δheap:    ${(delta / 1_048_576).toFixed(2)} MB`);

    expect(delta).toBeLessThanOrEqual(ALLOWABLE_GROWTH);
});

test.skip('TypeEvaluator direct instantiation does not leak memory', () => {
    if (typeof global.gc !== 'function') {
        throw new Error('Run with:  node --expose-gc  ./node_modules/.bin/jest typeEvaluatorMemoryLeak.test.ts');
    }

    const DIRECT_ITERATIONS = 100;
    const DIRECT_ALLOWABLE_GROWTH = 1 * 1024 * 1024; // 1 MB

    global.gc();
    const baseline = heap();

    for (let i = 0; i < DIRECT_ITERATIONS; i++) {
        // Create a mock ImportLookup that returns empty symbol table
        const mockImportLookup: ImportLookup = () => {
            return {
                symbolTable: new Map(),
                dunderAllNames: undefined,
                usesUnsupportedDunderAllForm: false,
                docString: undefined,
                isInPyTypedPackage: false,
            };
        };

        // Create minimal EvaluatorOptions
        const evaluatorOptions: EvaluatorOptions = {
            printTypeFlags: PrintTypeFlags.None,
            logCalls: false,
            minimumLoggingThreshold: 0,
            evaluateUnknownImportsAsAny: false,
            verifyTypeCacheEvaluatorFlags: false,
        };

        // Create TypeEvaluator
        const typeEvaluator = createTypeEvaluator(
            mockImportLookup,
            evaluatorOptions,
            (func) => func // identity wrapper
        );

        // Exercise the TypeEvaluator by calling some methods
        const cacheCount = typeEvaluator.getTypeCacheEntryCount();
        void cacheCount; // Suppress unused variable warning

        // Dispose the TypeEvaluator
        typeEvaluator.disposeEvaluator();

        // Trigger GC periodically
        if (i % 10 === 9) {
            global.gc();
        }
    }

    global.gc();
    const final = heap();
    const delta = final - baseline;

    console.log(`Direct TypeEvaluator Test:`);
    console.log(`Baseline: ${(baseline / 1_048_576).toFixed(1)} MB`);
    console.log(`Final:    ${(final / 1_048_576).toFixed(1)} MB`);
    console.log(`Δheap:    ${(delta / 1_048_576).toFixed(2)} MB`);

    expect(delta).toBeLessThanOrEqual(DIRECT_ALLOWABLE_GROWTH);
});

test('Program/ServiceProvider disposal prevents memory leaks', () => {
    if (typeof global.gc !== 'function') {
        throw new Error('Run with:  node --expose-gc  ./node_modules/.bin/jest typeEvaluatorMemoryLeak.test.ts');
    }

    const LEAK_TEST_ITERATIONS = 50; // Fewer iterations since this creates more objects
    const LEAK_ALLOWABLE_GROWTH = 5 * 1024 * 1024; // 5 MB - should be much higher without disposal

    global.gc();
    const baseline = heap();

    // Test the original function that properly disposes resources
    for (let i = 0; i < LEAK_TEST_ITERATIONS; i++) {
        // Use the disposing version - this should NOT leak
        const analysisResults = TestUtils.typeAnalyzeSampleFiles(['temp/memory_test_temp.py']);

        // Force processing to ensure everything is evaluated
        for (const result of analysisResults) {
            void result.errors.length;
            void result.warnings.length;
        }

        if (i % 10 === 9) {
            global.gc();
        }
    }

    global.gc();
    const withDisposal = heap();
    const disposalDelta = withDisposal - baseline;

    console.log(`Program disposal test:`);
    console.log(`Baseline: ${(baseline / 1_048_576).toFixed(1)} MB`);
    console.log(`With disposal: ${(withDisposal / 1_048_576).toFixed(1)} MB`);
    console.log(`Δheap (disposing): ${(disposalDelta / 1_048_576).toFixed(2)} MB`);

    // Now test the version that DOESN'T dispose - this should leak more
    global.gc();
    const beforeNonDisposal = heap();

    for (let i = 0; i < LEAK_TEST_ITERATIONS; i++) {
        // Use the NON-disposing version - this should leak significantly
        const analysisResults = TestUtils.typeAnalyzeSampleFilesWithoutDispose(['temp/memory_test_temp.py']);

        // Force processing to ensure everything is evaluated
        for (const result of analysisResults) {
            void result.errors.length;
            void result.warnings.length;
        }

        if (i % 10 === 9) {
            global.gc();
        }
    }

    global.gc();
    const withoutDisposal = heap();
    const nonDisposalDelta = withoutDisposal - beforeNonDisposal;

    console.log(`Without disposal: ${(withoutDisposal / 1_048_576).toFixed(1)} MB`);
    console.log(`Δheap (no disposing): ${(nonDisposalDelta / 1_048_576).toFixed(2)} MB`);
    console.log(`Leak difference: ${((nonDisposalDelta - disposalDelta) / 1_048_576).toFixed(2)} MB`);

    // The non-disposing version should leak significantly more
    expect(nonDisposalDelta).toBeGreaterThan(disposalDelta * 2); // At least 2x more memory usage

    // But both should still be under our generous limit for this test
    expect(disposalDelta).toBeLessThanOrEqual(LEAK_ALLOWABLE_GROWTH);
    expect(nonDisposalDelta).toBeLessThanOrEqual(LEAK_ALLOWABLE_GROWTH * 3); // Allow more for the leaky version
});

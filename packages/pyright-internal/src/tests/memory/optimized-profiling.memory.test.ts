/**
 * Optimized memory test that generates detailed flame graphs
 * Based on the successful standalone-profile-test.js approach
 */

import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseOptions, Parser } from '../../parser/parser';
import { MemoryTestRunner } from './memoryTestUtils';

// These named functions will show up clearly in flame graphs
function intensiveTypeCheckingWork(pythonCode: string, iterations: number): any[] {
    const parseOptions = new ParseOptions();
    parseOptions.isStubFile = false;
    parseOptions.pythonVersion = { major: 3, minor: 11 };

    const results = [];

    for (let i = 0; i < iterations; i++) {
        const parser = new Parser();
        const diagSink = new DiagnosticSink();

        // This should show up as parseSourceFile in flame graph
        const parseResult = parser.parseSourceFile(pythonCode, parseOptions, diagSink);

        results.push({
            iteration: i,
            result: parseResult,
            errors: diagSink.getErrors().length,
            warnings: diagSink.getWarnings().length,
        });
    }

    return results;
}

function stringManipulationWork(baseText: string, cycles: number): number {
    let text = baseText;

    for (let i = 0; i < cycles; i++) {
        text = text.replace(/def /g, `def modified_${i}_`);
        text = text.replace(/class /g, `class transformed_${i}_`);
        text = text.replace(/import /g, `import processed_${i}_`);
        text = text.split('\n').reverse().join('\n');
        text = text.toUpperCase().toLowerCase();

        // Keep text size manageable
        if (text.length > 500000) {
            text = text.substring(0, 100000);
        }
    }

    return text.length;
}

function computationalWork(iterations: number): number {
    let result = 0;

    for (let i = 0; i < iterations; i++) {
        result += Math.sqrt(i) * Math.sin(i / 10000) + Math.cos(i / 5000);

        // Prevent overflow
        if (result > 1000000) {
            result = result % 1000000;
        }
    }

    return result;
}

describe('Optimized Memory Profiling Tests', () => {
    let memoryRunner: MemoryTestRunner;

    beforeAll(() => {
        memoryRunner = new MemoryTestRunner('./memory-profiles/optimized');
    });

    test('memory test with detailed flame graph output', async () => {
        // Create a substantial Python file that requires significant parsing
        const complexPythonCode = `
# Complex Python file for memory testing
import sys, os, typing, asyncio, threading, multiprocessing, collections
from typing import Dict, List, Optional, Union, Generic, TypeVar, Callable, Awaitable, Iterator
from collections import defaultdict, deque, OrderedDict, namedtuple, Counter
from dataclasses import dataclass, field, asdict, astuple
from abc import ABC, abstractmethod, abstractproperty
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from contextlib import contextmanager, asynccontextmanager

T = TypeVar('T', bound=str)
U = TypeVar('U', bound=int)
V = TypeVar('V')

@dataclass
class ComplexDataClass(Generic[T, U]):
    data: Dict[str, List[Union[T, U, None]]]
    metadata: Dict[str, Union[str, int, float, bool, List[Any], Dict[str, Any]]]
    processors: List[Callable[[T, U], Awaitable[Union[T, U, None]]]] = field(default_factory=list)
    
    def __post_init__(self):
        self.computed_fields = {
            f"field_{i}_{j}": [
                x ** 2 + y ** 3 for x in range(20) for y in range(15)
                if (x * y) % 3 == 0 and x > y
            ]
            for i in range(50)
            for j in range(25)
        }

class ComplexInheritanceClass(ABC, ComplexDataClass[str, int]):
    def __init__(self):
        super().__init__(
            data=defaultdict(list),
            metadata={f"meta_{i}": i * 2 for i in range(100)}
        )
        self.deep_nested_structure = {
            f"level1_{i}": {
                f"level2_{j}": {
                    f"level3_{k}": {
                        f"level4_{l}": [
                            {
                                'id': f"{i}_{j}_{k}_{l}_{m}",
                                'value': i * j * k * l * m,
                                'computed': (i ** 2 + j ** 3 + k ** 4 + l ** 5) % 1000,
                                'metadata': {
                                    'created_at': time.time(),
                                    'tags': [f"tag_{x}" for x in range(min(i + j + k + l, 20))],
                                    'complex_data': {
                                        f"inner_{x}_{y}": x * y + m
                                        for x in range(10)
                                        for y in range(8)
                                        if (x + y) % 2 == 0
                                    }
                                }
                            }
                            for m in range(min(i + j, 10))
                        ]
                        for l in range(min(i + j + k, 8))
                    }
                    for k in range(min(i + j, 6))
                }
                for j in range(min(i, 5))
            }
            for i in range(15)
        }
    
    @abstractmethod
    async def process_complex_data(self,
                                  input_data: Dict[str, List[Union[str, int, Dict[str, Any]]]],
                                  processors: Optional[List[Callable[[Any], Awaitable[Any]]]] = None,
                                  batch_size: int = 100,
                                  **kwargs: Union[str, int, List[Any], Dict[str, Any]]
                                  ) -> AsyncIterator[Dict[str, Union[str, int, List[Any]]]]:
        pass
    
    async def complex_async_generator(self, data_source: AsyncIterator[Any]) -> AsyncIterator[Any]:
        async for item in data_source:
            if isinstance(item, dict):
                processed = {
                    f"processed_{key}_{i}": await self.transform_value(value, i)
                    for i, (key, value) in enumerate(item.items())
                    if await self.validate_item(key, value)
                }
                yield processed
            elif isinstance(item, (list, tuple)):
                batch_results = []
                for i, sub_item in enumerate(item):
                    if await self.should_process(sub_item, i):
                        result = await self.process_item(sub_item)
                        batch_results.append(result)
                yield batch_results

${Array.from(
    { length: 25 },
    (_, i) => `
class DynamicClass${i}(ComplexInheritanceClass):
    def __init__(self):
        super().__init__()
        self.dynamic_data_${i} = {
            f"generated_{j}_{k}": [
                complex_computation(x, y, z, ${i})
                for x in range(${i + 10})
                for y in range(${i + 5})
                for z in range(${i + 3})
                if complex_condition(x, y, z, ${i})
            ]
            for j in range(${i + 8})
            for k in range(${i + 4})
        }
    
    async def process_complex_data(self, input_data, processors=None, batch_size=100, **kwargs):
        results = []
        for batch_start in range(0, len(input_data), batch_size):
            batch = input_data[batch_start:batch_start + batch_size]
            batch_results = await asyncio.gather(*[
                self.process_single_item(item, ${i}, **kwargs)
                for item in batch
            ])
            results.extend(batch_results)
            yield {f"batch_{batch_start // batch_size}": batch_results}
    
    async def complex_method_${i}(self, param1: Dict[str, Any], param2: List[Any]) -> List[Dict[str, Any]]:
        return [
            {
                f"result_{j}_{k}_{l}": await self.compute_complex_result(
                    param1.get(f"key_{j}", {}),
                    param2[k % len(param2)] if param2 else None,
                    j, k, l, ${i}
                )
                for k in range(min(len(param2), ${i + 20}))
                for l in range(${i + 15})
                if await self.validate_complex_params(j, k, l, ${i})
            }
            for j in range(${i + 25})
        ]

def ultra_complex_function_${i}(
    param1: Dict[str, List[Union[DynamicClass${i}, ComplexDataClass, Any]]],
    param2: Optional[Callable[[Any], Union[Any, Awaitable[Any]]]] = None,
    *args: Union[str, int, float, bool, Dict[str, Any]],
    **kwargs: Dict[str, Union[str, int, List[Any], Dict[str, Any], Callable]]
) -> Union[Dict[str, Any], List[Any], AsyncIterator[Any], None]:
    try:
        async with complex_context_manager(${i}) as ctx:
            for iteration, (key, values) in enumerate(param1.items()):
                if isinstance(values, list) and len(values) > 0:
                    processed_values = []
                    for value_index, value in enumerate(values[:${i + 50}]):
                        if hasattr(value, 'process_complex_data'):
                            async for result in value.process_complex_data(
                                {f"input_{value_index}": [value]},
                                batch_size=${i + 10},
                                **kwargs
                            ):
                                processed_values.append(result)
                        else:
                            transformed = await transform_complex_value(
                                value, key, iteration, value_index, ${i}, *args
                            )
                            processed_values.append(transformed)
                    
                    yield {
                        f"processed_{key}_{iteration}": processed_values,
                        'metadata': {
                            'function_id': ${i},
                            'iteration': iteration,
                            'processed_count': len(processed_values),
                            'complex_stats': await compute_complex_statistics(processed_values)
                        }
                    }
                elif isinstance(values, dict):
                    nested_results = {
                        f"nested_{nested_key}_{nested_index}": await process_nested_value(
                            nested_value, nested_key, nested_index, ${i}, **kwargs
                        )
                        for nested_index, (nested_key, nested_value) in enumerate(values.items())
                        if await validate_nested_item(nested_key, nested_value, ${i})
                    }
                    yield nested_results
    except (ComplexException, ValidationError, ProcessingError) as e:
        logger.error(f"Error in ultra_complex_function_${i}: {e}")
        return await handle_complex_error(e, param1, param2, args, kwargs, ${i})
    finally:
        await cleanup_complex_resources(${i})
`
).join('')}
        `.repeat(2); // Double the content for more parsing work

        const result = await memoryRunner.runMemoryTest(
            'optimized-detailed-profiling',
            async () => {
                console.log('🔥 Starting optimized memory test with detailed profiling...');

                const startTime = Date.now();
                const results = [];
                let iteration = 0;

                // Run sustained work for the entire profiling window
                while (Date.now() - startTime < 18000) {
                    // 18 seconds of work
                    iteration++;

                    console.log(`🔄 Iteration ${iteration}: parsing, computing, processing...`);

                    // 1. Intensive type checking work (should show parseSourceFile)
                    const parseResults = intensiveTypeCheckingWork(complexPythonCode, 10);

                    // 2. String manipulation work (should show stringManipulationWork)
                    const stringResult = stringManipulationWork(complexPythonCode, 50);

                    // 3. Computational work (should show computationalWork)
                    const mathResult = computationalWork(200000);

                    // 4. More parsing with variations
                    const variantCode = complexPythonCode.replace(/ComplexClass/g, `VariantClass${iteration}`);
                    const variantResults = intensiveTypeCheckingWork(variantCode, 8);

                    results.push({
                        iteration,
                        parseCount: parseResults.length + variantResults.length,
                        stringLength: stringResult,
                        mathResult: mathResult.toFixed(2),
                        timestamp: Date.now() - startTime,
                    });

                    // Brief pause to allow profiler sampling
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }

                console.log(`✅ Completed ${iteration} iterations of optimized work`);
                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 250,
                estimatedDurationMs: 20000, // 20 seconds profiling
                intensiveProfiling: false, // Already doing sustained work
            }
        );

        console.log(`🎯 Optimized Memory Test Results:`);
        console.log(`- Iterations completed: ${result.result.length}`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
        console.log(`- Expected functions in flame graph:`);
        console.log(`  ★ intensiveTypeCheckingWork`);
        console.log(`  ★ stringManipulationWork`);
        console.log(`  ★ computationalWork`);
        console.log(`  ★ parseSourceFile`);
        console.log(`  ★ Parser methods`);
        console.log(`- View with: pprof -http=:8080 ${result.profilePath}`);

        expect(result.memoryGrowth).toBeLessThan(250);
        expect(result.result.length).toBeGreaterThan(5);
    }, 45000); // 45 second timeout
});

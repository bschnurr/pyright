/**
 * High-intensity CPU profiling test designed to generate meaningful flame graphs
 */

import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseOptions, Parser } from '../../parser/parser';
import { MemoryTestRunner } from './memoryTestUtils';

describe('CPU Intensive Profiling Tests', () => {
    let memoryRunner: MemoryTestRunner;

    beforeAll(() => {
        memoryRunner = new MemoryTestRunner('./memory-profiles/cpu-intensive');
    });

    test('sustained CPU load with continuous parsing operations', async () => {
        const result = await memoryRunner.runMemoryTest(
            'sustained-cpu-parsing',
            async () => {
                console.log('🔥 Starting sustained CPU load test...');

                // Generate multiple complex Python files
                const generateComplexFile = (fileIndex: number, complexity: number) => {
                    const lines = [];

                    // Add imports and type hints
                    lines.push(`# Complex Python file ${fileIndex}`);
                    lines.push('import sys, os, typing, asyncio, threading, multiprocessing');
                    lines.push('from typing import Dict, List, Optional, Union, Generic, TypeVar, Callable, Awaitable');
                    lines.push('from collections import defaultdict, deque, OrderedDict');
                    lines.push('from dataclasses import dataclass, field');
                    lines.push('from abc import ABC, abstractmethod');
                    lines.push('');

                    // Generate complex class hierarchies
                    for (let classIndex = 0; classIndex < complexity; classIndex++) {
                        lines.push(`class ComplexClass${fileIndex}_${classIndex}(ABC):`);
                        lines.push(`    def __init__(self):`);
                        lines.push(`        self.data = {`);

                        // Generate nested data structures
                        for (let dataIndex = 0; dataIndex < 20; dataIndex++) {
                            lines.push(`            f"key_{dataIndex}": [`);
                            lines.push(`                {`);
                            lines.push(`                    f"nested_{i}_{j}": i * j + ${dataIndex}`);
                            lines.push(`                    for i in range(${Math.floor(Math.random() * 50) + 10})`);
                            lines.push(`                    for j in range(${Math.floor(Math.random() * 30) + 5})`);
                            lines.push(`                    if (i + j) % ${Math.floor(Math.random() * 5) + 2} == 0`);
                            lines.push(`                }`);
                            lines.push(`                for k in range(${Math.floor(Math.random() * 25) + 10})`);
                            lines.push(`            ],`);
                        }

                        lines.push('        }');
                        lines.push('');

                        // Generate complex methods
                        for (let methodIndex = 0; methodIndex < 10; methodIndex++) {
                            lines.push(`    async def complex_method_${methodIndex}(self, `);
                            lines.push(`        param1: Dict[str, List[Union[int, str, float]]],`);
                            lines.push(`        param2: Optional[Callable[[Any], Awaitable[Any]]] = None,`);
                            lines.push(`        *args: Union[str, int],`);
                            lines.push(`        **kwargs: Dict[str, Any]`);
                            lines.push(`    ) -> Union[Dict[str, Any], List[Any], None]:`);
                            lines.push(`        results = []`);
                            lines.push(`        for item in param1.values():`);
                            lines.push(`            if isinstance(item, list):`);
                            lines.push(`                processed = [`);
                            lines.push(`                    {`);
                            lines.push(`                        f"result_{i}_{j}": await self.process_item(x, y)`);
                            lines.push(
                                `                        for i, x in enumerate(item[:${
                                    Math.floor(Math.random() * 100) + 50
                                }])`
                            );
                            lines.push(
                                `                        for j, y in enumerate(args[:${
                                    Math.floor(Math.random() * 20) + 10
                                }])`
                            );
                            lines.push(`                        if await self.validate_pair(x, y)`);
                            lines.push(`                    }`);
                            lines.push(`                    for k in range(${Math.floor(Math.random() * 50) + 25})`);
                            lines.push(`                ]`);
                            lines.push(`                results.extend(processed)`);
                            lines.push(`        return results`);
                            lines.push('');
                        }
                        lines.push('');
                    }

                    // Add complex function definitions
                    for (let funcIndex = 0; funcIndex < complexity * 2; funcIndex++) {
                        lines.push(`def ultra_complex_function_${fileIndex}_${funcIndex}(`);
                        lines.push(
                            `    param1: Dict[str, List[Union[ComplexClass${fileIndex}_${
                                funcIndex % complexity
                            }, Any]]],`
                        );
                        lines.push(`    param2: Optional[Callable[[Any], Union[Any, Awaitable[Any]]]] = None,`);
                        lines.push(`    *args: Union[str, int, float, bool],`);
                        lines.push(`    **kwargs: Dict[str, Union[str, int, List[Any], Dict[str, Any]]]`);
                        lines.push(`) -> Union[Dict[str, Any], List[Any], AsyncGenerator[Any, None], None]:`);
                        lines.push(`    try:`);
                        lines.push(`        async with some_context_manager() as ctx:`);
                        lines.push(`            for i, (key, values) in enumerate(param1.items()):`);
                        lines.push(`                if isinstance(values, (list, tuple)):`);
                        lines.push(`                    async for result in process_complex_values(values, ctx):`);
                        lines.push(`                        if await validate_complex_result(result, key, i):`);
                        lines.push(`                            yield transform_result(result, **kwargs)`);
                        lines.push(`                elif isinstance(values, dict):`);
                        lines.push(`                    nested_results = [`);
                        lines.push(`                        {`);
                        lines.push(`                            f"transformed_{j}_{k}": await complex_transform(`);
                        lines.push(`                                nested_value, key, i, j, k, *args`);
                        lines.push(`                            )`);
                        lines.push(
                            `                            for j, (nested_key, nested_value) in enumerate(values.items())`
                        );
                        lines.push(
                            `                            for k in range(${Math.floor(Math.random() * 30) + 15})`
                        );
                        lines.push(
                            `                            if await complex_condition(nested_key, nested_value, j, k)`
                        );
                        lines.push(`                        }`);
                        lines.push(`                        for _ in range(${Math.floor(Math.random() * 20) + 10})`);
                        lines.push(`                    ]`);
                        lines.push(`                    yield from filter(None, nested_results)`);
                        lines.push(`    except (ComplexException, AnotherException) as e:`);
                        lines.push(`        logger.error(f"Error in ultra_complex_function_${funcIndex}: {e}")`);
                        lines.push(`        return await handle_complex_error(e, param1, param2, args, kwargs)`);
                        lines.push(`    finally:`);
                        lines.push(`        await cleanup_complex_resources()`);
                        lines.push('');
                    }

                    return lines.join('\n');
                };

                const parseOptions = new ParseOptions();
                parseOptions.isStubFile = false;
                parseOptions.pythonVersion = { major: 3, minor: 11 };

                const results = [];
                const startTime = Date.now();
                let iteration = 0;

                // Continue parsing until profiling window is complete
                while (Date.now() - startTime < 20000) {
                    // 20 seconds of continuous work
                    iteration++;

                    // Generate increasingly complex files
                    const complexity = Math.min(50, 10 + iteration * 2);
                    const complexContent = generateComplexFile(iteration, complexity);

                    console.log(
                        `🔄 Parsing iteration ${iteration}, complexity: ${complexity}, file size: ${complexContent.length} chars`
                    );

                    // Parse the complex content - this is the main CPU work
                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();
                    const parseResult = parser.parseSourceFile(complexContent, parseOptions, diagSink);

                    results.push({
                        iteration,
                        complexity,
                        fileSize: complexContent.length,
                        parseTime: Date.now(),
                        diagnostics: diagSink.getErrors().length,
                        astNodes: parseResult ? 1 : 0, // Simplified metric
                    });

                    // Add some computational work to ensure sustained CPU usage
                    let computationResult = 0;
                    for (let i = 0; i < 50000; i++) {
                        computationResult += Math.sqrt(i) * Math.sin(i / 1000) + Math.cos(i / 500);
                    }

                    // Use the computation result to prevent optimization
                    if (computationResult > 1000000) {
                        console.log(`High computation result: ${computationResult.toFixed(2)}`);
                    }

                    // String processing work
                    let textResult = complexContent;
                    for (let i = 0; i < 5; i++) {
                        textResult = textResult.replace(/class /g, `class Modified${i}_`);
                        textResult = textResult.toUpperCase().toLowerCase();
                    }

                    // Keep memory usage reasonable
                    if (results.length > 20) {
                        results.splice(0, 10);
                    }

                    // Very short delay to allow profiler to capture the work
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }

                console.log(`✅ Completed ${iteration} parsing iterations in sustained CPU test`);
                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 300, // Allow more memory growth
                estimatedDurationMs: 25000, // 25 seconds of profiling
                intensiveProfiling: false, // Don't repeat - already doing sustained work
            }
        );

        console.log(`🔥 Sustained CPU Load Test Results:`);
        console.log(`- Iterations completed: ${result.result.length}`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
        console.log(`- This profile should show:`);
        console.log(`  ★ parseSourceFile and Parser methods`);
        console.log(`  ★ String processing functions`);
        console.log(`  ★ Mathematical computation work`);
        console.log(`  ★ Minimal idle time`);
        console.log(`- View with: pprof -http=:8080 ${result.profilePath}`);

        // Expect some memory growth but not excessive
        expect(result.memoryGrowth).toBeLessThan(300);
        expect(result.result.length).toBeGreaterThan(10); // Should complete multiple iterations
    }, 60000); // 1 minute timeout
});

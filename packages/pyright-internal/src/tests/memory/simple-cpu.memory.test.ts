/**
 * Simple CPU profiling test with manually instrumented functions
 */

import * as fs from 'fs';
import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseOptions, Parser } from '../../parser/parser';
import { MemoryTestRunner } from './memoryTestUtils';

// These functions will show up in the flame graph by name
function intensiveStringProcessing(text: string, iterations: number): string {
    let result = text;
    for (let i = 0; i < iterations; i++) {
        result = result.replace(/def /g, `def modified_${i}_`);
        result = result.replace(/class /g, `class transformed_${i}_`);
        result = result.split('\n').reverse().join('\n');
        result = result.toUpperCase().toLowerCase();
    }
    return result;
}

function mathematicalComputation(size: number): number {
    let sum = 0;
    for (let i = 0; i < size; i++) {
        sum += Math.sqrt(i) * Math.sin(i / 1000) + Math.cos(i / 500);
        if (i % 1000 === 0) {
            sum = sum % 1000000; // Prevent overflow
        }
    }
    return sum;
}

function parseMultipleFiles(files: string[], parseOptions: ParseOptions): any[] {
    const results = [];
    for (let i = 0; i < files.length; i++) {
        const parser = new Parser();
        const diagSink = new DiagnosticSink();

        // This should show up as parseSourceFile in the flame graph
        const parseResult = parser.parseSourceFile(files[i], parseOptions, diagSink);
        results.push({
            index: i,
            result: parseResult,
            errors: diagSink.getErrors().length,
            fileSize: files[i].length,
        });
    }
    return results;
}

describe('Simple CPU Profiling Test', () => {
    let memoryRunner: MemoryTestRunner;

    beforeAll(() => {
        memoryRunner = new MemoryTestRunner('./memory-profiles/simple-cpu');
    });

    test('simple sustained work with named functions', async () => {
        // Generate a moderately complex Python file
        const pythonCode = `
# Test Python file for profiling
import os, sys, typing
from typing import Dict, List, Optional, Union, Callable

class TestClass:
    def __init__(self):
        self.data = {
            f"key_{i}": [
                x ** 2 + y ** 3 for x in range(20) for y in range(10)
                if (x * y) % 2 == 0
            ]
            for i in range(100)
        }
    
    async def process_data(self, items: List[Dict[str, Any]]) -> List[Any]:
        results = []
        for item in items:
            if isinstance(item, dict):
                processed = {
                    f"result_{k}_{v}": await self.transform(k, v)
                    for k, v in item.items()
                    if await self.validate(k, v)
                }
                results.append(processed)
        return results

def complex_function(param1: Dict[str, List[Any]], param2: Optional[Callable] = None):
    result = []
    for key, values in param1.items():
        if isinstance(values, list):
            processed = [
                {f"item_{i}_{j}": i * j for j in range(50)}
                for i, val in enumerate(values[:100])
            ]
            result.extend(processed)
    return result

# Generate many similar functions
${Array.from(
    { length: 50 },
    (_, i) => `
def generated_function_${i}(data: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        f"processed_{j}_{k}": j * k + ${i}
        for j in range(${i + 10})
        for k in range(${i + 5})
        if (j + k) % 3 == 0
    }
`
).join('')}
        `.repeat(5); // Repeat to make it larger

        const result = await memoryRunner.runMemoryTest(
            'simple-sustained-work',
            async () => {
                console.log('🔥 Starting simple sustained work test...');
                const results = [];
                const startTime = Date.now();

                // Create multiple variations of the Python file
                const files = [];
                for (let i = 0; i < 10; i++) {
                    files.push(pythonCode.replace(/TestClass/g, `TestClass${i}`));
                }

                const parseOptions = new ParseOptions();
                parseOptions.isStubFile = false;
                parseOptions.pythonVersion = { major: 3, minor: 11 };

                let iteration = 0;
                // Run for about 10 seconds with continuous work
                while (Date.now() - startTime < 10000) {
                    iteration++;

                    console.log(`🔄 Iteration ${iteration}: parsing ${files.length} files...`);

                    // 1. Parse multiple files - this should show parseSourceFile in flame graph
                    const parseResults = parseMultipleFiles(files, parseOptions);

                    // 2. Do intensive string processing - this should show as intensiveStringProcessing
                    const processedText = intensiveStringProcessing(pythonCode, 25);

                    // 3. Do mathematical computation - this should show as mathematicalComputation
                    const mathResult = mathematicalComputation(50000);

                    results.push({
                        iteration,
                        parseResults: parseResults.length,
                        processedTextLength: processedText.length,
                        mathResult: mathResult.toFixed(2),
                        timestamp: Date.now() - startTime,
                    });

                    // Very small delay to allow profiler sampling
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }

                console.log(`✅ Completed ${iteration} iterations of sustained work`);
                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 200,
                estimatedDurationMs: 12000, // 12 seconds of profiling
                intensiveProfiling: false,
            }
        );

        console.log(`🎯 Simple Sustained Work Test Results:`);
        console.log(`- Iterations completed: ${result.result.length}`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
        console.log(`- Expected function names in flame graph:`);
        console.log(`  ★ parseMultipleFiles`);
        console.log(`  ★ intensiveStringProcessing`);
        console.log(`  ★ mathematicalComputation`);
        console.log(`  ★ parseSourceFile (from Parser)`);
        console.log(`- View with: pprof -http=:8080 ${result.profilePath}`);

        // Test Success Summary
        console.log(`\n✅ Test Success Summary:`);
        console.log(`Completed: ${result.result.length} iterations of sustained work over 10 seconds`);
        console.log(`Memory growth: ${result.memoryGrowth.toFixed(2)} MB (well under the 200 MB threshold)`);
        console.log(`Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);

        // Get file size if profile exists
        let profileSize = 'unknown';
        try {
            if (result.profilePath) {
                const stats = fs.statSync(result.profilePath);
                profileSize = `${stats.size.toLocaleString()} bytes`;
            }
        } catch (error) {
            profileSize = 'file not found';
        }

        console.log(`Profile generated: ${result.profilePath} (${profileSize})`);
        console.log(`Expected functions: All named functions should now be visible in flame graph:`);
        console.log(`  parseMultipleFiles`);
        console.log(`  intensiveStringProcessing`);
        console.log(`  mathematicalComputation`);
        console.log(`  parseSourceFile (from Parser)`);

        expect(result.memoryGrowth).toBeLessThan(200);
        expect(result.result.length).toBeGreaterThan(5);
    }, 45000);
});

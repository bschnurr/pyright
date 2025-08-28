/**
 * Demonstration script showing how to generate meaningful CPU profiles
 *
 * Run with: npm run test:memory -- --testNamePattern="demo CPU profiling"
 */

import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseOptions, Parser } from '../../parser/parser';
import { MemoryTestRunner } from './memoryTestUtils';

describe('Demo CPU Profiling', () => {
    let memoryRunner: MemoryTestRunner;

    beforeAll(() => {
        memoryRunner = new MemoryTestRunner('./memory-profiles/demo');
    });

    test('demo CPU profiling with sustained computational work', async () => {
        // Generate a large, complex Python file
        const generateComplexPythonFile = (size: number) => {
            const functions = [];
            for (let i = 0; i < size; i++) {
                functions.push(`
def complex_function_${i}(param1: Dict[str, List[Any]], param2: Optional[Callable] = None):
    result = []
    for j in range(100):
        nested_data = {
            f"key_{j}_{k}": [
                x**2 + y**3 for x in range(20) for y in range(10)
                if (x * y) % 3 == 0 and x > y
            ]
            for k in range(15)
        }
        result.append(nested_data)
    
    class NestedClass${i}:
        def __init__(self):
            self.data = [
                {f"item_{m}_{n}": m * n + ${i} for n in range(25)}
                for m in range(30)
            ]
        
        async def async_method_${i}(self, data: List[Dict[str, Any]]):
            async def inner_async():
                for item in data:
                    yield await self.process_item(item)
            
            results = []
            async for processed in inner_async():
                results.append(processed)
            return results
    
    return result, NestedClass${i}()
                `);
            }
            return functions.join('\n');
        };

        const result = await memoryRunner.runMemoryTest(
            'demo-sustained-cpu-work',
            async () => {
                const parseOptions = new ParseOptions();
                parseOptions.isStubFile = false;
                parseOptions.pythonVersion = { major: 3, minor: 11 };

                const results = [];

                // Continuously parse different complex files throughout the profiling window
                for (let round = 0; round < 50; round++) {
                    // 50 rounds of parsing
                    // Generate increasingly complex files
                    const complexity = 50 + round * 10; // 50 to 540 functions
                    const complexContent = generateComplexPythonFile(complexity);

                    const parser = new Parser();
                    const diagSink = new DiagnosticSink();

                    // Parse the complex content - this should show up in flame graph
                    const parseResult = parser.parseSourceFile(complexContent, parseOptions, diagSink);
                    results.push(parseResult);

                    // Add some additional computational work that will show up in profiles
                    const computationalWork = () => {
                        let sum = 0;
                        for (let i = 0; i < 100000; i++) {
                            sum += Math.sqrt(i) * Math.sin(i) + Math.cos(i * 2);
                        }
                        return sum;
                    };

                    computationalWork(); // This should show up as "computationalWork" in flame graph

                    // Simulate some string processing work
                    const textProcessing = () => {
                        let text = complexContent;
                        for (let i = 0; i < 10; i++) {
                            text = text.replace(/def /g, `def processed_${i}_`);
                            text = text.split('\n').reverse().join('\n');
                            text = text.toLowerCase().toUpperCase();
                        }
                        return text.length;
                    };

                    textProcessing(); // This should show up as "textProcessing" in flame graph

                    // Keep only recent results to prevent excessive memory usage
                    if (results.length > 10) {
                        results.splice(0, results.length - 10);
                    }

                    // Small delay but not too much (we want CPU work, not idle time)
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }

                return results;
            },
            {
                enableProfiling: true,
                gcBefore: true,
                gcAfter: true,
                memoryGrowthThreshold: 200, // Allow more memory growth
                estimatedDurationMs: 25000, // 25 seconds of profiling
                intensiveProfiling: false, // Don't repeat - just one long run
            }
        );

        console.log(`Demo CPU Profiling Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
        console.log(`- This profile should show:`);
        console.log(`  * parseSourceFile function calls`);
        console.log(`  * computationalWork function`);
        console.log(`  * textProcessing function`);
        console.log(`  * Much less idle time and GC`);
        console.log(`- View with: pprof -http=:8080 ${result.profilePath}`);
    }, 60000);
});

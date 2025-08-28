/**
 * Standalone profiling test that should show function names
 * Run with: node standalone-profile-test.js
 */

const pprof = require('pprof');
const fs = require('fs');
const { Parser, ParseOptions } = require('./out/packages/pyright-internal/src/parser/parser');

// These functions should appear in flame graph
function intensiveParsingWork() {
    console.log('🔄 Starting intensive parsing work...');

    const pythonCode = `
# Complex Python code
import sys, os, typing, asyncio
from typing import Dict, List, Optional, Union, Generic, TypeVar

class ComplexClass(Generic[T]):
    def __init__(self):
        self.data = {f"key_{i}": [x**2 for x in range(100)] for i in range(500)}
    
    async def process_items(self, items: List[Dict[str, Any]]) -> List[Any]:
        results = []
        for item in items:
            processed = {k: await self.transform(v) for k, v in item.items()}
            results.append(processed)
        return results

${Array.from(
    { length: 100 },
    (_, i) => `
def function_${i}(data: Dict[str, List[Any]]) -> List[Dict[str, Any]]:
    return [{f"result_{j}": j * ${i} for j in range(100)} for _ in range(50)]
`
).join('')}
    `.repeat(10);

    const parseOptions = new ParseOptions();
    parseOptions.pythonVersion = { major: 3, minor: 11 };

    const results = [];

    // Parse many times to generate sustained CPU load
    for (let i = 0; i < 200; i++) {
        const parser = new Parser();
        const result = parser.parseSourceFile(pythonCode, parseOptions);
        results.push(result);

        if (i % 20 === 0) {
            console.log(`  Parsed ${i} files...`);
        }
    }

    console.log(`✅ Parsing work completed: ${results.length} files processed`);
    return results.length;
}

function computationalWork() {
    console.log('🔄 Starting computational work...');
    let sum = 0;

    for (let i = 0; i < 5000000; i++) {
        // 5 million iterations
        sum += Math.sqrt(i) * Math.sin(i / 100000) + Math.cos(i / 50000);
        if (i % 500000 === 0) {
            console.log(`  Computing... ${(i / 50000).toFixed(1)}%`);
        }
    }

    console.log(`✅ Computational work completed: ${sum.toFixed(2)}`);
    return sum;
}

async function runStandaloneProfileTest() {
    console.log('🔥 Starting standalone profile test...');

    try {
        // Build the project first if needed
        console.log('📦 Checking if build is needed...');
        if (!fs.existsSync('./out/packages/pyright-internal/src/parser/parser.js')) {
            console.log('❌ Build files not found. Run: npm run build');
            return;
        }

        console.log('🎯 Starting profiling with sustained work...');

        const profilePromise = pprof.time.profile({
            durationMillis: 15000, // 15 seconds
            intervalMicros: 50, // 0.05ms sampling (very high frequency)
        });

        // Start work immediately
        const parseWork = intensiveParsingWork();
        const mathWork = computationalWork();
        const parseWork2 = intensiveParsingWork(); // Do it again

        console.log(`🎯 All work completed: parsing=${parseWork + parseWork2}, math=${mathWork.toFixed(2)}`);

        // Wait for profiling
        const profile = await profilePromise;
        const buffer = await pprof.encode(profile);

        fs.writeFileSync('./standalone-profile.pb.gz', buffer);

        console.log('✅ Standalone profile test completed!');
        console.log(`📊 Profile saved: ./standalone-profile.pb.gz (${buffer.length} bytes)`);
        console.log('🔍 View with: pprof -http=:8080 ./standalone-profile.pb.gz');
        console.log('Expected functions in flame graph:');
        console.log('  ★ intensiveParsingWork');
        console.log('  ★ computationalWork');
        console.log('  ★ parseSourceFile');
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.log('💡 Try building first: npm run build');
    }
}

runStandaloneProfileTest();

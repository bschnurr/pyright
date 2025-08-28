#!/usr/bin/env node

/**
 * Node.js Built-in Profiling Test
 * Testing Node.js built-in profiling capabilities vs npm pprof
 */

console.log('🔍 Node.js Built-in Profiling Test');
console.log('==================================');

// Check Node.js version and capabilities
console.log(`Node.js version: ${process.version}`);
console.log(`Platform: ${process.platform}`);
console.log(`Architecture: ${process.arch}`);

// Test if --prof flag is available (would need to restart Node with --prof)
console.log('\n📊 Profiling Options:');
console.log('1. Node.js built-in profiler (requires --prof flag)');
console.log('2. Chrome DevTools profiling (requires --inspect)');
console.log('3. npm pprof package (current approach)');

// Test npm pprof
console.log('\n🧪 Testing npm pprof...');
try {
    const pprof = require('pprof');
    console.log('✅ pprof package loaded successfully');

    // Test basic profiling with immediate CPU work
    async function testProfileWithWork() {
        console.log('🔄 Starting profile with immediate CPU work...');

        // Define work functions that should show up in profile
        function heavyComputationWork() {
            console.log('  🔥 Starting heavy computation...');
            let result = 0;
            for (let i = 0; i < 2000000; i++) {
                // 2 million iterations
                result += Math.sqrt(i) * Math.sin(i / 10000) + Math.cos(i / 5000);
                if (i % 200000 === 0) {
                    console.log(`    Working... ${(i / 20000).toFixed(1)}%`);
                }
            }
            console.log(`  ✅ Heavy computation done: ${result.toFixed(2)}`);
            return result;
        }

        function stringManipulationWork() {
            console.log('  📝 Starting string manipulation...');
            let text = 'function test() { return "hello world"; }'.repeat(1000);
            for (let i = 0; i < 1000; i++) {
                text = text.replace(/function/g, `func_${i}`);
                text = text.replace(/test/g, `method_${i}`);
                text = text.split(' ').reverse().join(' ');
                text = text.toUpperCase().toLowerCase();
            }
            console.log(`  ✅ String manipulation done: ${text.length} chars`);
            return text.length;
        }

        // Start profiling
        const profilePromise = pprof.time.profile({
            durationMillis: 8000, // 8 seconds
            intervalMicros: 100, // 0.1ms sampling (very frequent)
        });

        // Do work immediately and continuously
        const work1 = heavyComputationWork();
        const work2 = stringManipulationWork();
        const work3 = heavyComputationWork(); // Do it again

        console.log(
            `🎯 All work completed: computation=${work1.toFixed(2)}, strings=${work2}, computation2=${work3.toFixed(2)}`
        );

        // Wait for profiling to complete
        const profile = await profilePromise;
        console.log('✅ Profiling completed');

        // Encode and save
        const buffer = await pprof.encode(profile);
        const fs = require('fs');
        fs.writeFileSync('./node-builtin-test.pb.gz', buffer);

        console.log(`📊 Profile saved: ./node-builtin-test.pb.gz (${buffer.length} bytes)`);
        console.log('🔍 View with: pprof -http=:8080 ./node-builtin-test.pb.gz');

        return buffer.length;
    }

    testProfileWithWork().catch(console.error);
} catch (error) {
    console.error('❌ pprof package not available:', error.message);

    console.log('\n💡 Alternative: Use Node.js built-in profiling');
    console.log('Run your script with:');
    console.log('  node --prof your-script.js');
    console.log('Then process with:');
    console.log('  node --prof-process isolate-*.log > profile.txt');
}

console.log('\n📋 Summary:');
console.log('- If you see function names in the flame graph: ✅ Profiling is working');
console.log('- If you only see idle/gc: ❌ Work is too fast or profiling issues');
console.log('- Try: Longer operations, higher sampling frequency, Node.js --prof flag');

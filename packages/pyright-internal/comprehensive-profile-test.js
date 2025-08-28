#!/usr/bin/env node

/**
 * Simple working pprof test - should definitely show function names
 */

const pprof = require('pprof');
const fs = require('fs');

// Functions with clear names that should show up in flame graph
function cpuIntensiveWork() {
    console.log('🔥 Starting CPU intensive work...');
    let result = 0;

    // Mathematical computation that takes time
    for (let i = 0; i < 3000000; i++) {
        result += Math.sqrt(i) * Math.sin(i / 100000) + Math.cos(i / 50000);

        // Periodic logging to show progress
        if (i % 300000 === 0) {
            console.log(`  Progress: ${(i / 30000).toFixed(1)}%`);
        }
    }

    console.log(`✅ CPU work done: ${result.toFixed(2)}`);
    return result;
}

function stringProcessingWork() {
    console.log('📝 Starting string processing work...');

    let text = 'function test(param1, param2) { return param1 + param2; }'.repeat(5000);

    for (let i = 0; i < 2000; i++) {
        // String manipulation that takes CPU time
        text = text.replace(/function/g, `func_${i}`);
        text = text.replace(/test/g, `method_${i}`);
        text = text.replace(/param/g, `arg_${i}`);
        text = text.split(' ').reverse().join(' ');
        text = text.toUpperCase().toLowerCase();

        if (i % 200 === 0) {
            console.log(`  Processing: ${(i / 20).toFixed(1)}%`);
        }
    }

    console.log(`✅ String work done: ${text.length} chars`);
    return text.length;
}

function arrayProcessingWork() {
    console.log('🔢 Starting array processing work...');

    let arrays = [];

    // Create and process many arrays
    for (let i = 0; i < 1000; i++) {
        const arr = Array.from({ length: 1000 }, (_, j) => j * i);

        // Process the array
        const processed = arr
            .map((x) => x * 2)
            .filter((x) => x % 3 === 0)
            .reduce((sum, x) => sum + x, 0);

        arrays.push(processed);

        if (i % 100 === 0) {
            console.log(`  Arrays processed: ${i}/1000`);
        }
    }

    const total = arrays.reduce((sum, x) => sum + x, 0);
    console.log(`✅ Array work done: ${total}`);
    return total;
}

async function runComprehensiveProfileTest() {
    console.log('🎯 Starting comprehensive profile test...');
    console.log('This test should definitely show function names in the flame graph!\n');

    try {
        // Start profiling with high sampling rate
        console.log('🔍 Starting profiling (10 seconds, high sampling rate)...');

        const profilePromise = pprof.time.profile({
            durationMillis: 10000, // 10 seconds
            intervalMicros: 100, // 0.1ms sampling - very high frequency
        });

        // Do sustained CPU work during profiling
        console.log('🚀 Starting sustained work...\n');

        const work1 = cpuIntensiveWork();
        const work2 = stringProcessingWork();
        const work3 = arrayProcessingWork();
        const work4 = cpuIntensiveWork(); // Do it again for more time

        console.log('\n🎯 All work completed!');
        console.log(`- CPU work result: ${work1.toFixed(2)} + ${work4.toFixed(2)}`);
        console.log(`- String work result: ${work2}`);
        console.log(`- Array work result: ${work3}`);

        // Wait for profiling to finish
        console.log('\n⏳ Waiting for profiling to complete...');
        const profile = await profilePromise;

        // Encode and save
        const buffer = await pprof.encode(profile);
        const filename = './comprehensive-profile.pb.gz';
        fs.writeFileSync(filename, buffer);

        console.log(`\n✅ Profile saved: ${filename}`);
        console.log(`📊 Profile size: ${buffer.length} bytes`);
        console.log(`\n🔍 View the flame graph with:`);
        console.log(`   pprof -http=:8080 ${filename}`);
        console.log(`   Then open: http://localhost:8080`);
        console.log(`\n⭐ Expected function names in flame graph:`);
        console.log(`   • cpuIntensiveWork`);
        console.log(`   • stringProcessingWork`);
        console.log(`   • arrayProcessingWork`);
        console.log(`   • Much less "idle" time!`);

        return filename;
    } catch (error) {
        console.error('❌ Error:', error.message);
        return null;
    }
}

// Run the test
runComprehensiveProfileTest()
    .then((filename) => {
        if (filename) {
            console.log(`\n🎉 Test completed successfully!`);
            console.log(`Ready to view: pprof -http=:8080 ${filename}`);
        }
    })
    .catch(console.error);

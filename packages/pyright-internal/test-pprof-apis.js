/**
 * Quick test to check available pprof APIs and generate a simple profile
 */

const pprof = require('pprof');

console.log('🔍 Checking available pprof APIs:');
console.log('pprof.time:', typeof pprof.time);
console.log('pprof.heap:', typeof pprof.heap);
console.log('pprof.encode:', typeof pprof.encode);

if (pprof.time) {
    console.log('pprof.time.profile:', typeof pprof.time.profile);
    console.log('pprof.time methods:', Object.getOwnPropertyNames(pprof.time));
}

if (pprof.heap) {
    console.log('pprof.heap.profile:', typeof pprof.heap.profile);
    console.log('pprof.heap methods:', Object.getOwnPropertyNames(pprof.heap));
}

console.log('\n🧪 Testing simple CPU profiling...');

async function testProfiling() {
    try {
        // Test basic CPU profiling
        const profile = await pprof.time.profile({
            durationMillis: 2000,
            intervalMicros: 1000, // 1ms sampling
        });

        console.log('✅ CPU profiling successful');
        console.log('Profile type:', typeof profile);
        console.log('Profile properties:', Object.getOwnPropertyNames(profile));

        // Test encoding
        const buffer = await pprof.encode(profile);
        console.log('✅ Encoding successful, buffer size:', buffer.length);

        // Save a test profile
        const fs = require('fs-extra');
        await fs.writeFile('./test-profile.pb.gz', buffer);
        console.log('✅ Test profile saved to: ./test-profile.pb.gz');
    } catch (error) {
        console.error('❌ Profiling failed:', error.message);
    }
}

// Do some CPU work during profiling
function cpuWork() {
    console.log('🔄 Starting CPU work...');
    let result = 0;
    for (let i = 0; i < 1000000; i++) {
        result += Math.sqrt(i) * Math.sin(i / 1000);
        if (i % 100000 === 0) {
            console.log(`  Working... ${i / 10000}%`);
        }
    }
    console.log('✅ CPU work completed, result:', result.toFixed(2));
    return result;
}

// Start profiling and do work
testProfiling()
    .then(() => {
        // Do some work after profiling to see the difference
        cpuWork();
    })
    .catch(console.error);

/**
 * Profile analysis tool to understand what's in existing profiles
 */

const fs = require('fs-extra');
const path = require('path');

async function analyzeProfile(profilePath) {
    try {
        console.log(`\n🔍 Analyzing profile: ${profilePath}`);

        // Read the profile file
        const buffer = await fs.readFile(profilePath);
        console.log(`- File size: ${buffer.length} bytes`);

        // Try to analyze with pprof if available
        try {
            const pprof = require('pprof');

            // The profile is already encoded, we need to decode it to analyze
            // But npm pprof doesn't provide a decode function
            // Let's try to understand the format

            console.log(`- Buffer starts with: ${buffer.slice(0, 20).toString('hex')}`);
            console.log(`- Buffer first 20 bytes as string: ${buffer.slice(0, 20).toString()}`);

            // Check if it's gzipped (starts with 1f8b)
            if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
                console.log(`- ✅ File appears to be gzipped`);
            } else {
                console.log(`- ❓ File doesn't appear to be gzipped`);
            }
        } catch (error) {
            console.log(`- ❌ Could not analyze with pprof: ${error.message}`);
        }
    } catch (error) {
        console.log(`- ❌ Error reading profile: ${error.message}`);
    }
}

async function findAndAnalyzeProfiles() {
    console.log('🔍 Finding all .pb.gz profile files...');

    const profileDirs = ['./memory-profiles', './cache', './parser', './type-evaluator', './analyzer'];

    for (const dir of profileDirs) {
        try {
            if (await fs.pathExists(dir)) {
                console.log(`\n📁 Checking directory: ${dir}`);
                const files = await fs.readdir(dir);

                for (const file of files) {
                    if (file.endsWith('.pb.gz')) {
                        await analyzeProfile(path.join(dir, file));
                    }
                }
            }
        } catch (error) {
            console.log(`❌ Error checking ${dir}: ${error.message}`);
        }
    }

    // Also check current directory
    try {
        const files = await fs.readdir('.');
        for (const file of files) {
            if (file.endsWith('.pb.gz')) {
                await analyzeProfile(file);
            }
        }
    } catch (error) {
        console.log(`❌ Error checking current directory: ${error.message}`);
    }
}

// Alternative: try to create a profile manually to see what we get
async function createTestProfile() {
    console.log('\n🧪 Creating test profile to understand format...');

    try {
        const pprof = require('pprof');

        console.log('Available pprof APIs:');
        console.log('- pprof.time:', typeof pprof.time);
        console.log('- pprof.heap:', typeof pprof.heap);
        console.log('- pprof.encode:', typeof pprof.encode);

        // Create a simple profile
        const profile = await pprof.time.profile({
            durationMillis: 1000, // 1 second
            intervalMicros: 1000, // 1ms sampling
        });

        console.log('Profile created:');
        console.log('- Type:', typeof profile);
        console.log('- Properties:', Object.getOwnPropertyNames(profile));

        if (profile && typeof profile === 'object') {
            console.log('- Profile details:');
            for (const key of Object.getOwnPropertyNames(profile)) {
                const value = profile[key];
                console.log(
                    `  - ${key}: ${typeof value} ${Array.isArray(value) ? `(array length: ${value.length})` : ''}`
                );
            }
        }

        // Encode it
        const buffer = await pprof.encode(profile);
        console.log(`- Encoded size: ${buffer.length} bytes`);

        // Save it
        await fs.writeFile('./diagnostic-profile.pb.gz', buffer);
        console.log('- Saved to: ./diagnostic-profile.pb.gz');

        return buffer;
    } catch (error) {
        console.log(`❌ Failed to create test profile: ${error.message}`);
        return null;
    }
}

// Do some CPU work while profiling to see if it's captured
function doCpuWork() {
    console.log('🔄 Starting CPU work for profiling...');

    // Named function that should appear in profile
    function namedCpuIntensiveWork() {
        let result = 0;
        for (let i = 0; i < 500000; i++) {
            result += Math.sqrt(i) * Math.sin(i / 1000);
        }
        return result;
    }

    function namedStringWork() {
        let text = 'test '.repeat(10000);
        for (let i = 0; i < 100; i++) {
            text = text.replace(/test/g, `modified${i}`);
            text = text.toUpperCase().toLowerCase();
        }
        return text.length;
    }

    const mathResult = namedCpuIntensiveWork();
    const stringResult = namedStringWork();

    console.log(`✅ CPU work completed: math=${mathResult.toFixed(2)}, string=${stringResult}`);
}

// Main execution
async function main() {
    console.log('🔍 Profile Diagnostic Tool');
    console.log('========================');

    // First, analyze existing profiles
    await findAndAnalyzeProfiles();

    // Create a test profile with actual work
    console.log('\n🧪 Creating diagnostic profile with CPU work...');

    // Start profiling and do work simultaneously
    const profilePromise = createTestProfile();

    // Do CPU work during profiling
    setTimeout(() => {
        doCpuWork();
    }, 200); // Start work 200ms into profiling

    await profilePromise;

    console.log('\n✅ Diagnostic complete. Check diagnostic-profile.pb.gz with:');
    console.log('pprof -http=:8080 diagnostic-profile.pb.gz');
}

main().catch(console.error);

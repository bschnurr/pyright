/**
 * Functions used for running pyright with pprof.
 * 
 * Steps taken to get this to work:
 * 	- Install VC++ Desktop C++ workload with at least one Windows SDK
	- Git clone DataDog/pprof-nodejs: pprof support for Node.js (github.com)
		○ Going to use this to generate an electron.node file for loading the profiler
	- Switch to packages\vscode-pylance
	- Npm install --save-dev node-abi@latest
		○  this is so electron-rebuild can find the right ABI
	- Npm install --save-dev @electron/rebuild
	- Electron rebuild the git cloned datadog/pprof-nodejs based on the version in VS code
		○ .\node_modules\.bin\electron-rebuild -v <version of electron reported in VS code about> -m <directory to datadog/pprof-nodejs>
	- Npm install --save-dev @datadog/pprof
	- Copy the build output from the electron-rebuild of the datadog git repository to the node_modules datadog
		○ It should be named something like bin\win32-x64-110\pprof-nodejs.node
		○ Copy it to the node_modules\@datadog\pprof\prebuilds\win32-x64
		○ Rename it to electron-110.node (or whatever ABI version it is using)
	- Modify pylance to use pprof around problem location using the pyright\packages\pyright-internal\pprof\profiler.ts
		○ startProfile before
		○ finishProfile after, passing it a file name
	- Rebuild Pylance
	- Make sure to turn off background analysis
	- Launch the CPU profiling profile
	- Reproduce the problem
	- Install Go (Get Started - The Go Programming Language)
	- Install Graphviz
		○ Choco install graphviz
	- Install the pprof cli 
		○ go install github.com/google/pprof@latest
	- Run pprof -http to look at results. 
		○ Profile should be in same directory as vscode-pylance output.
		○ Example pprof -http=: <name of profile>
 */

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;

function getRequire(path: string) {
    const r = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require;
    try {
        // First try the relative path (for webpack builds)
        return r(`../node_modules/${path}`);
    } catch (err) {
        try {
            // Fallback to direct require (for Jest and other test environments)
            return r(path);
        } catch (err2) {
            console.log(err);
            return undefined;
        }
    }
}

let isProfileActive = false;
const activeProfiler: any = null;

export function startProfile(): void {
    const pprof = getRequire('pprof');
    if (pprof && !isProfileActive) {
        try {
            // Note: With npm pprof, we can't start/stop like this
            // Instead, we should use pprof.time.profile() with duration
            isProfileActive = true;
            console.log(`Starting profile: ${Date.now()}`);
        } catch (error) {
            console.warn('Failed to start profiling:', error instanceof Error ? error.message : String(error));
        }
    } else if (isProfileActive) {
        console.warn('Profiling already active, skipping start');
    } else {
        console.warn('pprof package not available');
    }
}

export function finishProfile(outputFile: string): void {
    const pprof = getRequire('pprof');
    if (pprof && isProfileActive) {
        try {
            // npm pprof doesn't have a stop() method on time
            // The profile should have been collected during the execution
            console.warn('finishProfile called but npm pprof uses profile() with duration');
            isProfileActive = false;
        } catch (error) {
            console.warn('Failed to stop profiling:', error instanceof Error ? error.message : String(error));
            isProfileActive = false;
        }
    } else if (!isProfileActive) {
        console.warn('No active profile to stop');
    }
}

export async function profileWithDuration(durationMs: number, outputFile: string): Promise<void> {
    const pprof = getRequire('pprof');
    if (pprof) {
        try {
            console.log(`Starting enhanced profile with duration: ${durationMs}ms`);

            // Only try CPU profiling to avoid conflicts
            let profile: any = null;

            try {
                // CPU Time profiling - the most reliable approach
                console.log('Starting CPU time profiling...');
                profile = await pprof.time.profile({
                    durationMillis: durationMs,
                    // Increase sampling frequency for more detailed capture
                    intervalMicros: 1000, // Sample every 1ms instead of default 10ms
                });
                console.log('CPU profiling completed successfully');
            } catch (error) {
                console.warn('CPU profiling failed:', error);
            }

            // Save the profile if we got one
            if (profile) {
                const fs = getRequire('fs-extra') as typeof import('fs-extra');
                if (fs) {
                    console.log('Encoding and saving profile...');
                    const buffer = await pprof.encode(profile);
                    const filename = outputFile.endsWith('.pb.gz') ? outputFile : `${outputFile}.pb.gz`;
                    await fs.writeFile(filename, buffer);
                    console.log(`Profile saved: ${filename}`);
                    console.log(`Profile size: ${buffer.length} bytes`);
                }
            } else {
                console.warn('No profile was successfully generated');
            }
        } catch (error) {
            console.warn('Failed to profile:', error instanceof Error ? error.message : String(error));
        }
    } else {
        console.warn('pprof package not available');
    }
}

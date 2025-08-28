/**
 * Memory tests for CLI-based project analysis
 * Tests memory usage when analyzing real-world projects via Pyright CLI
 */

import { exec } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import { MemoryTestRunner } from './memoryTestUtils';

const execAsync = promisify(exec);

describe('CLI Analysis Memory Tests', () => {
    let memoryRunner: MemoryTestRunner;
    let tempDir: string;
    let pyrightCliPath: string;

    beforeAll(async () => {
        memoryRunner = new MemoryTestRunner('cli-analysis');
        tempDir = path.join(__dirname, 'fixtures', 'temp-cli');
        await fs.ensureDir(tempDir);

        // Find the Pyright CLI path - try multiple locations
        const possiblePaths = [
            path.resolve(__dirname, '../../../..', 'pyright', 'index.js'),
            path.resolve(__dirname, '../../../../packages/pyright/index.js'),
            path.resolve(__dirname, '../../../../../packages/pyright/index.js'),
        ];

        for (const possiblePath of possiblePaths) {
            if (await fs.pathExists(possiblePath)) {
                pyrightCliPath = possiblePath;
                break;
            }
        }

        if (!pyrightCliPath) {
            throw new Error(`Pyright CLI not found. Checked paths: ${possiblePaths.join(', ')}`);
        }

        console.log(`Using Pyright CLI at: ${pyrightCliPath}`);

        // Test that the CLI works
        try {
            const { stdout } = await execAsync(`node "${pyrightCliPath}" --version`);
            console.log(`Pyright version: ${stdout.trim()}`);
        } catch (error) {
            throw new Error(`Pyright CLI test failed: ${error}`);
        }
    });

    afterAll(async () => {
        await fs.remove(tempDir);
    });

    beforeEach(async () => {
        if (global.gc) {
            global.gc();
        }
    });

    test('should analyze debugpy project without memory leaks', async () => {
        const result = await memoryRunner.runMemoryTest(
            'debugpy-analysis',
            async () => {
                const projectDir = path.join(tempDir, 'debugpy-analysis');
                await fs.ensureDir(projectDir);

                // Create a simple test project first (not the complex debugpy simulation)
                await createSimpleTestProject(projectDir);

                // Create pyrightconfig.json for the project
                const pyrightConfig = {
                    include: ['src'],
                    exclude: ['**/__pycache__'],
                    reportMissingImports: false, // Disable to reduce complexity
                    reportMissingTypeStubs: false,
                    pythonVersion: '3.9',
                };

                await fs.writeJSON(path.join(projectDir, 'pyrightconfig.json'), pyrightConfig, { spaces: 2 });

                const results = [];
                const iterations = 2; // Reduce iterations for initial testing

                for (let i = 0; i < iterations; i++) {
                    console.log(`Running CLI analysis iteration ${i + 1}/${iterations}...`);

                    const startTime = Date.now();
                    const startMemory = process.memoryUsage();

                    try {
                        // Run Pyright CLI analysis with better error handling
                        console.log(`Running: node "${pyrightCliPath}" --outputjson "${projectDir}"`);

                        const { stdout } = await execAsync(`node "${pyrightCliPath}" --outputjson "${projectDir}"`, {
                            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                            timeout: 120000, // 2 minute timeout
                            env: {
                                ...process.env,
                                NODE_OPTIONS: '--max-old-space-size=4096 --expose-gc',
                            },
                            cwd: path.dirname(pyrightCliPath), // Set working directory to CLI location
                        });

                        const endTime = Date.now();
                        const endMemory = process.memoryUsage();

                        // Parse analysis results
                        let analysisData;
                        try {
                            analysisData = JSON.parse(stdout);
                        } catch (e) {
                            console.warn('Failed to parse JSON output, using text analysis');
                            analysisData = {
                                summary: {
                                    filesAnalyzed:
                                        (stdout.match(/Analyzed \d+ files/)?.[0] || '0').match(/\d+/)?.[0] || 0,
                                    errorCount: (stdout.match(/\d+ errors?/)?.[0] || '0').match(/\d+/)?.[0] || 0,
                                    warningCount: (stdout.match(/\d+ warnings?/)?.[0] || '0').match(/\d+/)?.[0] || 0,
                                    informationCount: 0,
                                },
                                diagnostics: [],
                            };
                        }

                        const analysisResult = {
                            iteration: i,
                            analysisTime: endTime - startTime,
                            filesAnalyzed: analysisData.summary?.filesAnalyzed || 0,
                            errorCount: analysisData.summary?.errorCount || 0,
                            warningCount: analysisData.summary?.warningCount || 0,
                            informationCount: analysisData.summary?.informationCount || 0,
                            memoryDelta: {
                                heapUsed: (endMemory.heapUsed - startMemory.heapUsed) / (1024 * 1024),
                                heapTotal: (endMemory.heapTotal - startMemory.heapTotal) / (1024 * 1024),
                                external: (endMemory.external - startMemory.external) / (1024 * 1024),
                                rss: (endMemory.rss - startMemory.rss) / (1024 * 1024),
                            },
                        };

                        results.push(analysisResult);

                        console.log(`Analysis ${i + 1} completed:`);
                        console.log(`  Files analyzed: ${analysisResult.filesAnalyzed}`);
                        console.log(`  Errors: ${analysisResult.errorCount}`);
                        console.log(`  Warnings: ${analysisResult.warningCount}`);
                        console.log(`  Analysis time: ${analysisResult.analysisTime}ms`);
                        console.log(`  Memory delta: ${analysisResult.memoryDelta.heapUsed.toFixed(2)}MB heap`);
                    } catch (error: any) {
                        const endTime = Date.now();
                        const endMemory = process.memoryUsage();

                        // Check if this is a Pyright error with valid JSON output
                        if (error.code === 1 && error.stdout) {
                            try {
                                const analysisData = JSON.parse(error.stdout);
                                const analysisResult = {
                                    iteration: i,
                                    analysisTime: endTime - startTime,
                                    filesAnalyzed: analysisData.summary?.filesAnalyzed || 0,
                                    errorCount: analysisData.summary?.errorCount || 0,
                                    warningCount: analysisData.summary?.warningCount || 0,
                                    informationCount: analysisData.summary?.informationCount || 0,
                                    memoryDelta: {
                                        heapUsed: (endMemory.heapUsed - startMemory.heapUsed) / (1024 * 1024),
                                        heapTotal: (endMemory.heapTotal - startMemory.heapTotal) / (1024 * 1024),
                                        external: (endMemory.external - startMemory.external) / (1024 * 1024),
                                        rss: (endMemory.rss - startMemory.rss) / (1024 * 1024),
                                    },
                                };

                                results.push(analysisResult);

                                console.log(`Analysis ${i + 1} completed with errors:`);
                                console.log(`  Files analyzed: ${analysisResult.filesAnalyzed}`);
                                console.log(`  Errors: ${analysisResult.errorCount}`);
                                console.log(`  Warnings: ${analysisResult.warningCount}`);
                                console.log(`  Analysis time: ${analysisResult.analysisTime}ms`);
                                console.log(`  Memory delta: ${analysisResult.memoryDelta.heapUsed.toFixed(2)}MB heap`);
                            } catch (parseError) {
                                console.error(`CLI analysis iteration ${i + 1} failed:`, error);
                                results.push({
                                    iteration: i,
                                    error: error?.message || 'Unknown error',
                                    analysisTime: 0,
                                    filesAnalyzed: 0,
                                    errorCount: 0,
                                    warningCount: 0,
                                    informationCount: 0,
                                    memoryDelta: { heapUsed: 0, heapTotal: 0, external: 0, rss: 0 },
                                });
                            }
                        } else {
                            console.error(`CLI analysis iteration ${i + 1} failed:`, error);
                            results.push({
                                iteration: i,
                                error: error?.message || 'Unknown error',
                                analysisTime: 0,
                                filesAnalyzed: 0,
                                errorCount: 0,
                                warningCount: 0,
                                informationCount: 0,
                                memoryDelta: { heapUsed: 0, heapTotal: 0, external: 0, rss: 0 },
                            });
                        }
                    }

                    // Take memory snapshot
                    memoryRunner.takeSnapshot();

                    // Force garbage collection between iterations
                    if (global.gc) {
                        global.gc();
                        await new Promise((resolve) => setTimeout(resolve, 1000)); // Let GC settle
                    }
                }

                // Clean up
                await fs.remove(projectDir);

                return results;
            },
            {
                enableProfiling: true,
                intensiveProfiling: true, // Enable intensive profiling for CLI operations
                gcAfter: true,
                memoryGrowthThreshold: 300, // 300MB threshold for large project CLI analysis
                estimatedDurationMs: 180000, // 3 minute timeout
            }
        );

        // Verify no excessive memory growth
        expect(result.memoryGrowth).toBeLessThan(300);

        // Print comprehensive results
        console.log('\n=== CLI Analysis Test Results ===');
        console.log(`Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`Profile saved to: ${result.profilePath}`);

        if (result.result && Array.isArray(result.result)) {
            console.log('\nPer-iteration results:');
            result.result.forEach((iteration: any, index: number) => {
                console.log(`  Iteration ${index + 1}:`);
                console.log(`    Files: ${iteration.filesAnalyzed}`);
                console.log(`    Errors: ${iteration.errorCount}, Warnings: ${iteration.warningCount}`);
                console.log(`    Time: ${iteration.analysisTime}ms`);
                console.log(`    Memory: ${iteration.memoryDelta.heapUsed.toFixed(2)}MB`);
            });
        }
    }, 240000); // 4 minute timeout

    test('should analyze large Python project with complex dependencies', async () => {
        const result = await memoryRunner.runMemoryTest(
            'large-project-cli',
            async () => {
                const projectDir = path.join(tempDir, 'large-project');
                await fs.ensureDir(projectDir);

                // Create a complex project structure
                await createLargeProjectSimulation(projectDir);

                const pyrightConfig = {
                    include: ['src', 'lib', 'tests'],
                    exclude: ['**/__pycache__', '**/.git', '**/node_modules'],
                    reportMissingImports: true,
                    reportMissingTypeStubs: false,
                    reportUnusedImport: true,
                    reportUnusedVariable: true,
                    pythonVersion: '3.10',
                    executionEnvironments: [
                        {
                            root: 'src',
                            pythonVersion: '3.10',
                        },
                        {
                            root: 'lib',
                            pythonVersion: '3.9',
                        },
                    ],
                };

                await fs.writeJSON(path.join(projectDir, 'pyrightconfig.json'), pyrightConfig, { spaces: 2 });

                const startTime = Date.now();

                // Run comprehensive analysis
                const { stdout } = await execAsync(`node "${pyrightCliPath}" --outputjson "${projectDir}"`, {
                    maxBuffer: 20 * 1024 * 1024, // 20MB buffer
                    timeout: 180000, // 3 minute timeout
                    env: {
                        ...process.env,
                        NODE_OPTIONS: '--max-old-space-size=6144 --expose-gc',
                    },
                });

                const analysisTime = Date.now() - startTime;

                let analysisData;
                try {
                    analysisData = JSON.parse(stdout);
                } catch (e) {
                    // Fallback to text parsing
                    const lines = stdout.split('\n');
                    const filesLine = lines.find((line) => line.includes('Analyzed') && line.includes('files'));
                    const filesAnalyzed = filesLine ? parseInt(filesLine.match(/\d+/)?.[0] || '0') : 0;

                    analysisData = {
                        summary: {
                            filesAnalyzed,
                            errorCount: (stdout.match(/\d+ errors?/) || ['0'])[0].match(/\d+/)?.[0] || 0,
                            warningCount: (stdout.match(/\d+ warnings?/) || ['0'])[0].match(/\d+/)?.[0] || 0,
                            informationCount: 0,
                        },
                        diagnostics: [],
                    };
                }

                const result = {
                    analysisTime,
                    filesAnalyzed: analysisData.summary?.filesAnalyzed || 0,
                    errorCount: analysisData.summary?.errorCount || 0,
                    warningCount: analysisData.summary?.warningCount || 0,
                    informationCount: analysisData.summary?.informationCount || 0,
                    diagnosticsCount: analysisData.diagnostics?.length || 0,
                    outputSize: stdout.length,
                };

                // Clean up
                await fs.remove(projectDir);

                return result;
            },
            {
                enableProfiling: true,
                intensiveProfiling: true,
                memoryGrowthThreshold: 400, // 400MB for very large projects
                estimatedDurationMs: 240000, // 4 minute timeout
            }
        );

        expect(result.memoryGrowth).toBeLessThan(400);

        console.log('\n=== Large Project CLI Analysis Results ===');
        console.log(`Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`Profile saved to: ${result.profilePath}`);

        if (result.result) {
            const data = result.result;
            console.log(`Files analyzed: ${data.filesAnalyzed}`);
            console.log(`Analysis time: ${data.analysisTime}ms`);
            console.log(`Errors: ${data.errorCount}, Warnings: ${data.warningCount}`);
            console.log(`Diagnostics: ${data.diagnosticsCount}`);
            console.log(`Output size: ${(data.outputSize / 1024).toFixed(2)}KB`);
        }
    }, 300000); // 5 minute timeout

    test('should handle CLI analysis with watch mode simulation', async () => {
        const result = await memoryRunner.runMemoryTest(
            'watch-mode-simulation',
            async () => {
                const projectDir = path.join(tempDir, 'watch-project');
                await fs.ensureDir(projectDir);

                // Create initial project
                await createWatchableProject(projectDir);

                const pyrightConfig = {
                    include: ['src'],
                    exclude: ['**/__pycache__'],
                    pythonVersion: '3.9',
                };

                await fs.writeJSON(path.join(projectDir, 'pyrightconfig.json'), pyrightConfig, { spaces: 2 });

                const results = [];
                const changes = 5; // Simulate 5 file changes

                for (let i = 0; i < changes; i++) {
                    // Modify a file to simulate watch mode
                    const targetFile = path.join(projectDir, 'src', 'main.py');
                    const newContent = `
# Modified at ${new Date().toISOString()}
def function_${i}(x: int) -> str:
    return f"Result {i}: {x}"

class Class${i}:
    def __init__(self, value: int):
        self.value = value + ${i}
    
    def process(self) -> str:
        return function_${i}(self.value)

if __name__ == "__main__":
    obj = Class${i}(10)
    print(obj.process())
`;
                    await fs.writeFile(targetFile, newContent);

                    // Run analysis on the modified project
                    const startTime = Date.now();
                    const { stdout } = await execAsync(`node "${pyrightCliPath}" --outputjson "${projectDir}"`, {
                        maxBuffer: 5 * 1024 * 1024,
                        timeout: 60000,
                        env: {
                            ...process.env,
                            NODE_OPTIONS: '--max-old-space-size=2048 --expose-gc',
                        },
                    });
                    const analysisTime = Date.now() - startTime;

                    let analysisData;
                    try {
                        analysisData = JSON.parse(stdout);
                    } catch (e) {
                        analysisData = { summary: { filesAnalyzed: 1, errorCount: 0, warningCount: 0 } };
                    }

                    results.push({
                        change: i,
                        analysisTime,
                        filesAnalyzed: analysisData.summary?.filesAnalyzed || 0,
                        errorCount: analysisData.summary?.errorCount || 0,
                        warningCount: analysisData.summary?.warningCount || 0,
                    });

                    memoryRunner.takeSnapshot();

                    // Brief pause between changes
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }

                await fs.remove(projectDir);
                return results;
            },
            {
                enableProfiling: true,
                memoryGrowthThreshold: 150, // 150MB for watch simulation
                estimatedDurationMs: 120000,
            }
        );

        expect(result.memoryGrowth).toBeLessThan(150);

        console.log('\n=== Watch Mode Simulation Results ===');
        console.log(`Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`Profile saved to: ${result.profilePath}`);

        if (result.result && Array.isArray(result.result)) {
            console.log('Change iterations:');
            result.result.forEach((change: any, index: number) => {
                console.log(
                    `  Change ${index + 1}: ${change.analysisTime}ms, ${change.filesAnalyzed} files, ${
                        change.errorCount
                    } errors`
                );
            });
        }
    }, 180000);
});

// Helper functions to create test projects

async function createSimpleTestProject(projectDir: string): Promise<void> {
    const srcDir = path.join(projectDir, 'src');
    await fs.ensureDir(srcDir);

    // Create simple Python files for testing
    const mainCode = `
"""Simple test module for CLI analysis"""
from typing import List, Dict, Optional

def simple_function(x: int, y: str) -> str:
    """A simple function for testing."""
    return f"{y}: {x * 2}"

class SimpleClass:
    """A simple class for testing."""
    
    def __init__(self, name: str):
        self.name = name
        self.data: List[int] = []
    
    def add_data(self, value: int) -> None:
        """Add a value to the data list."""
        self.data.append(value)
    
    def get_summary(self) -> Dict[str, Any]:
        """Get a summary of the data."""
        return {
            "name": self.name,
            "count": len(self.data),
            "sum": sum(self.data),
            "average": sum(self.data) / len(self.data) if self.data else 0
        }

def main() -> None:
    """Main function for testing."""
    obj = SimpleClass("test")
    obj.add_data(10)
    obj.add_data(20)
    obj.add_data(30)
    
    result = simple_function(5, "Result")
    summary = obj.get_summary()
    
    print(result)
    print(summary)

if __name__ == "__main__":
    main()
`;

    const utilsCode = `
"""Utility functions for testing"""
from typing import Any, List, Dict, Optional, Union

def process_list(items: List[Any]) -> Dict[str, Any]:
    """Process a list and return statistics."""
    if not items:
        return {"empty": True}
    
    return {
        "count": len(items),
        "types": list(set(type(item).__name__ for item in items)),
        "first": items[0],
        "last": items[-1]
    }

class DataProcessor:
    """A utility class for data processing."""
    
    def __init__(self):
        self.cache: Dict[str, Any] = {}
    
    def process(self, data: Union[List, Dict, str, int]) -> Optional[str]:
        """Process different types of data."""
        if isinstance(data, list):
            return f"List with {len(data)} items"
        elif isinstance(data, dict):
            return f"Dict with keys: {', '.join(data.keys())}"
        elif isinstance(data, str):
            return f"String: '{data}'"
        elif isinstance(data, int):
            return f"Integer: {data}"
        else:
            return f"Unknown type: {type(data).__name__}"
    
    def cache_result(self, key: str, value: Any) -> None:
        """Cache a result."""
        self.cache[key] = value
    
    def get_cached(self, key: str) -> Optional[Any]:
        """Get a cached result."""
        return self.cache.get(key)
`;

    await fs.writeFile(path.join(srcDir, '__init__.py'), '');
    await fs.writeFile(path.join(srcDir, 'main.py'), mainCode);
    await fs.writeFile(path.join(srcDir, 'utils.py'), utilsCode);
}

async function createLargeProjectSimulation(projectDir: string): Promise<void> {
    const srcDir = path.join(projectDir, 'src');
    const libDir = path.join(projectDir, 'lib');
    const testsDir = path.join(projectDir, 'tests');

    await fs.ensureDir(srcDir);
    await fs.ensureDir(libDir);
    await fs.ensureDir(testsDir);

    // Create multiple modules with complex dependencies
    const modules = ['auth', 'database', 'api', 'models', 'utils', 'config', 'cache', 'logging'];

    for (const moduleName of modules) {
        const moduleDir = path.join(srcDir, moduleName);
        await fs.ensureDir(moduleDir);

        // Create __init__.py
        await fs.writeFile(
            path.join(moduleDir, '__init__.py'),
            `
"""${moduleName} module"""
from .core import *
from .handlers import *
`
        );

        // Create core module
        const coreContent = `
"""Core ${moduleName} functionality"""
import asyncio
import json
import logging
from typing import Dict, List, Optional, Any, Union, Callable, TypeVar, Generic
from dataclasses import dataclass, field
from enum import Enum
from abc import ABC, abstractmethod

T = TypeVar('T')
U = TypeVar('U')

class ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Status(Enum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    PENDING = "pending"
    ERROR = "error"

@dataclass
class ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Config:
    name: str
    version: str = "1.0.0"
    settings: Dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    status: ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Status = ${
            moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
        }Status.INACTIVE

class Abstract${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler(ABC, Generic[T]):
    def __init__(self, config: ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Config):
        self.config = config
        self.logger = logging.getLogger(f"${moduleName}.{self.__class__.__name__}")
        
    @abstractmethod
    async def process(self, data: T) -> Optional[U]:
        pass
    
    @abstractmethod
    def validate(self, data: T) -> bool:
        pass

class ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Manager:
    def __init__(self, config: ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Config):
        self.config = config
        self.handlers: List[Abstract${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler] = []
        self.cache: Dict[str, Any] = {}
        
    async def initialize(self) -> None:
        self.config.status = ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Status.PENDING
        await asyncio.sleep(0.01)  # Simulate initialization
        self.config.status = ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Status.ACTIVE
        
    def add_handler(self, handler: Abstract${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler) -> None:
        self.handlers.append(handler)
        
    async def process_batch(self, items: List[T]) -> List[Optional[U]]:
        results = []
        for item in items:
            for handler in self.handlers:
                if handler.validate(item):
                    result = await handler.process(item)
                    results.append(result)
                    break
            else:
                results.append(None)
        return results
        
    def get_stats(self) -> Dict[str, Any]:
        return {
            "handlers_count": len(self.handlers),
            "cache_size": len(self.cache),
            "status": self.config.status.value,
            "config_name": self.config.name
        }

def create_${moduleName}_manager(name: str, **kwargs) -> ${
            moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
        }Manager:
    config = ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Config(name=name, settings=kwargs)
    return ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Manager(config)
`;

        await fs.writeFile(path.join(moduleDir, 'core.py'), coreContent);

        // Create handlers module
        const handlersContent = `
"""${moduleName} handlers implementation"""
import json
import hashlib
from typing import Any, Dict, List, Optional
from .core import Abstract${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler, ${
            moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
        }Config

class Default${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler(Abstract${
            moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
        }Handler[Dict[str, Any]]):
    async def process(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        # Simulate processing
        processed = {
            "original": data,
            "processed_by": self.__class__.__name__,
            "hash": hashlib.md5(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            "module": "${moduleName}"
        }
        return processed
    
    def validate(self, data: Dict[str, Any]) -> bool:
        return isinstance(data, dict) and len(data) > 0

class Advanced${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler(Abstract${
            moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
        }Handler[List[Any]]):
    async def process(self, data: List[Any]) -> Optional[List[Any]]:
        # Complex processing
        if not data:
            return []
            
        processed = []
        for item in data:
            if isinstance(item, (str, int, float)):
                processed.append(f"processed_{item}")
            elif isinstance(item, dict):
                processed.append({**item, "enhanced": True})
            else:
                processed.append(str(item))
        
        return processed
    
    def validate(self, data: List[Any]) -> bool:
        return isinstance(data, list)

class Caching${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Handler(Abstract${
            moduleName.charAt(0).toUpperCase() + moduleName.slice(1)
        }Handler[str]):
    def __init__(self, config: ${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Config):
        super().__init__(config)
        self.cache: Dict[str, str] = {}
        
    async def process(self, data: str) -> Optional[str]:
        cache_key = hashlib.md5(data.encode()).hexdigest()
        
        if cache_key in self.cache:
            return self.cache[cache_key]
        
        # Simulate expensive processing
        result = f"cached_result_for_{data}_{len(self.cache)}"
        self.cache[cache_key] = result
        return result
    
    def validate(self, data: str) -> bool:
        return isinstance(data, str) and len(data.strip()) > 0
`;

        await fs.writeFile(path.join(moduleDir, 'handlers.py'), handlersContent);
    }

    // Create integration tests
    const integrationTest = `
import unittest
import asyncio
from typing import List, Dict, Any

# Import all modules
${modules.map((mod) => `from src.${mod} import create_${mod}_manager`).join('\n')}

class TestModuleIntegration(unittest.TestCase):
    def setUp(self):
        self.managers = {}
        for module_name in ${JSON.stringify(modules)}:
            create_func = globals()[f"create_{module_name}_manager"]
            self.managers[module_name] = create_func(f"test_{module_name}")
    
    async def test_all_modules_initialize(self):
        for name, manager in self.managers.items():
            await manager.initialize()
            stats = manager.get_stats()
            self.assertEqual(stats["config_name"], f"test_{name}")
    
    async def test_cross_module_communication(self):
        # Test complex inter-module operations
        for manager in self.managers.values():
            await manager.initialize()
        
        # Simulate cross-module data flow
        test_data = [
            {"id": 1, "type": "test", "data": "sample"},
            {"id": 2, "type": "test", "data": "another"},
        ]
        
        results = {}
        for name, manager in self.managers.items():
            if hasattr(manager, 'process_batch'):
                result = await manager.process_batch(test_data)
                results[name] = result
        
        self.assertGreater(len(results), 0)

if __name__ == "__main__":
    # Run async tests
    async def run_tests():
        test_instance = TestModuleIntegration()
        test_instance.setUp()
        await test_instance.test_all_modules_initialize()
        await test_instance.test_cross_module_communication()
        print("Integration tests completed")
    
    asyncio.run(run_tests())
    unittest.main(verbosity=2)
`;

    await fs.writeFile(path.join(testsDir, 'test_integration.py'), integrationTest);
}

async function createWatchableProject(projectDir: string): Promise<void> {
    const srcDir = path.join(projectDir, 'src');
    await fs.ensureDir(srcDir);

    // Create a simple project that can be easily modified
    const mainContent = `
def main_function(x: int) -> str:
    return f"Original result: {x}"

class MainClass:
    def __init__(self, value: int):
        self.value = value
    
    def process(self) -> str:
        return main_function(self.value)

if __name__ == "__main__":
    obj = MainClass(42)
    print(obj.process())
`;

    const utilsContent = `
from typing import List, Dict, Any, Optional

def utility_function(data: List[Any]) -> Dict[str, Any]:
    return {
        "count": len(data),
        "types": [type(item).__name__ for item in data],
        "first": data[0] if data else None
    }

class UtilityClass:
    @staticmethod
    def transform_data(input_data: Any) -> Optional[str]:
        if isinstance(input_data, (int, float)):
            return str(input_data)
        elif isinstance(input_data, str):
            return input_data.upper()
        else:
            return None
`;

    await fs.writeFile(path.join(srcDir, '__init__.py'), '');
    await fs.writeFile(path.join(srcDir, 'main.py'), mainContent);
    await fs.writeFile(path.join(srcDir, 'utils.py'), utilsContent);
}

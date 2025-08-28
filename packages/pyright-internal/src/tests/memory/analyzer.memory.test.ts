/**
 * Memory tests for the type analyzer
 * Tests for memory leaks in type analysis operations
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { ImportResolver } from '../../analyzer/importResolver';
import { Program } from '../../analyzer/program';
import { ConfigOptions, ExecutionEnvironment, getStandardDiagnosticRuleSet } from '../../common/configOptions';
import { NullConsole } from '../../common/console';
import { DiagnosticCategory } from '../../common/diagnostic';
import { FullAccessHost } from '../../common/fullAccessHost';
import { RealTempFile, createFromRealFileSystem } from '../../common/realFileSystem';
import { createServiceProvider } from '../../common/serviceProviderExtensions';
import { UriEx } from '../../common/uri/uriUtils';
import { MemoryAssertions, MemoryTestFixtures, MemoryTestRunner } from './memoryTestUtils';

describe('Analyzer Memory Tests', () => {
    let memoryRunner: MemoryTestRunner;
    let tempDir: string;

    beforeAll(async () => {
        memoryRunner = new MemoryTestRunner('analyzer');
        tempDir = path.join(__dirname, 'fixtures', 'temp-analyzer');
        await fs.ensureDir(tempDir);
    });

    afterAll(async () => {
        await fs.remove(tempDir);
    });

    beforeEach(async () => {
        // Force GC before each test
        if (global.gc) {
            global.gc();
        }
    });

    test('should not leak memory when analyzing large projects repeatedly', async () => {
        const iterations = 10;

        const result = await memoryRunner.runMemoryTest(
            'large-project-analysis',
            async () => {
                const results = [];

                for (let i = 0; i < iterations; i++) {
                    // Create a temporary project for this iteration
                    const projectDir = path.join(tempDir, `project-${i}`);
                    await fs.ensureDir(projectDir);

                    // Generate test files
                    const testFiles = await MemoryTestFixtures.createTestWorkspace(projectDir);

                    // Set up analysis environment
                    const configOptions = new ConfigOptions(UriEx.file(projectDir));
                    configOptions.internalTestMode = true;

                    const console = new NullConsole();
                    const tempFile = new RealTempFile();
                    const fileSystem = createFromRealFileSystem(tempFile);
                    const serviceProvider = createServiceProvider(fileSystem, console, tempFile);
                    const importResolver = new ImportResolver(
                        serviceProvider,
                        configOptions,
                        new FullAccessHost(serviceProvider)
                    );

                    const execEnvironment = new ExecutionEnvironment(
                        'python',
                        UriEx.file(projectDir),
                        getStandardDiagnosticRuleSet(),
                        { major: 3, minor: 9 },
                        undefined,
                        undefined
                    );

                    configOptions.executionEnvironments = [execEnvironment];

                    // Create and run analysis
                    const program = new Program(importResolver, configOptions, serviceProvider);

                    // Add files to analysis
                    const fileUris = testFiles.map((filePath) => UriEx.file(filePath));
                    program.setTrackedFiles(fileUris);

                    // Run analysis
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    // Get diagnostics
                    const sourceFiles = fileUris.map((uri) => program.getSourceFile(uri));
                    const totalDiagnostics = sourceFiles.reduce((count, sourceFile) => {
                        if (sourceFile) {
                            const diagnostics = sourceFile.getDiagnostics(configOptions) || [];
                            return count + diagnostics.length;
                        }
                        return count;
                    }, 0);

                    results.push({
                        filesAnalyzed: testFiles.length,
                        diagnosticsCount: totalDiagnostics,
                        projectDir,
                    });

                    // Clean up this iteration
                    program.dispose();
                    serviceProvider.dispose();

                    // Clean up this iteration's files
                    await fs.remove(projectDir);

                    // Take snapshot
                    if (i % 3 === 0) {
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                gcAfter: true,
                memoryGrowthThreshold: 200, // 200MB threshold for large project analysis
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 200);

        console.log(`Large Project Analysis Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Peak memory: ${(result.peak.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 120000); // 120 second timeout

    test('should not leak memory when analyzing files with type errors', async () => {
        const iterations = 30;

        const result = await memoryRunner.runMemoryTest(
            'type-error-analysis',
            async () => {
                const results = [];

                for (let i = 0; i < iterations; i++) {
                    const projectDir = path.join(tempDir, `error-project-${i}`);
                    await fs.ensureDir(projectDir);

                    // Create a file with intentional type errors
                    const errorFile = path.join(projectDir, 'errors.py');
                    const errorContent = `
# File with intentional type errors for memory testing
def function_with_errors(x: int) -> str:
    return x + 1  # Type error: returning int instead of str

class TestClass:
    def __init__(self, value: str):
        self.value = value
    
    def method(self) -> int:
        return self.value + "test"  # Type error: can't add str to str and return int

def another_error():
    x: List[int] = [1, 2, 3]  # NameError: List not imported
    y: Dict = {"key": "value"}  # Type error: Dict needs type parameters
    z = undefined_variable  # NameError
    return z

# More type errors
result: int = "string"  # Type error
numbers: List[str] = [1, 2, 3]  # Type error
`;

                    await fs.writeFile(errorFile, errorContent);

                    // Set up analysis
                    const configOptions = new ConfigOptions(UriEx.file(projectDir));
                    configOptions.internalTestMode = true;

                    const console = new NullConsole();
                    const tempFile = new RealTempFile();
                    const fileSystem = createFromRealFileSystem(tempFile);
                    const serviceProvider = createServiceProvider(fileSystem, console, tempFile);
                    const importResolver = new ImportResolver(
                        serviceProvider,
                        configOptions,
                        new FullAccessHost(serviceProvider)
                    );

                    const execEnvironment = new ExecutionEnvironment(
                        'python',
                        UriEx.file(projectDir),
                        getStandardDiagnosticRuleSet(),
                        { major: 3, minor: 9 },
                        undefined,
                        undefined
                    );

                    configOptions.executionEnvironments = [execEnvironment];

                    const program = new Program(importResolver, configOptions, serviceProvider);

                    program.setTrackedFiles([UriEx.file(errorFile)]);

                    // Run analysis (should produce errors)
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    // Verify errors were found
                    const sourceFile = program.getSourceFile(UriEx.file(errorFile));
                    let errorCount = 0;
                    if (sourceFile) {
                        const diagnostics = sourceFile.getDiagnostics(configOptions) || [];
                        errorCount = diagnostics.filter((diag) => diag.category === DiagnosticCategory.Error).length;
                    }

                    expect(errorCount).toBeGreaterThan(0);

                    results.push({
                        errorCount,
                        projectDir,
                    });

                    // Clean up
                    program.dispose();
                    serviceProvider.dispose();
                    await fs.remove(projectDir);

                    if (i % 5 === 0) {
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                memoryGrowthThreshold: 100, // 100MB threshold for error analysis
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 100);

        console.log(`Type Error Analysis Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 90000);

    test('should handle incremental analysis without memory leaks', async () => {
        const iterations = 20;

        const result = await memoryRunner.runMemoryTest(
            'incremental-analysis',
            async () => {
                const projectDir = path.join(tempDir, 'incremental-project');
                await fs.ensureDir(projectDir);

                const mainFile = path.join(projectDir, 'main.py');
                const initialContent = `
def initial_function(x: int) -> int:
    return x * 2

class InitialClass:
    def __init__(self, value: int):
        self.value = value
`;
                await fs.writeFile(mainFile, initialContent);

                // Set up analysis
                const configOptions = new ConfigOptions(UriEx.file(projectDir));
                configOptions.internalTestMode = true;

                const console = new NullConsole();
                const tempFile = new RealTempFile();
                const fileSystem = createFromRealFileSystem(tempFile);
                const serviceProvider = createServiceProvider(fileSystem, console, tempFile);
                const importResolver = new ImportResolver(
                    serviceProvider,
                    configOptions,
                    new FullAccessHost(serviceProvider)
                );

                const execEnvironment = new ExecutionEnvironment(
                    'python',
                    UriEx.file(projectDir),
                    getStandardDiagnosticRuleSet(),
                    { major: 3, minor: 9 },
                    undefined,
                    undefined
                );

                configOptions.executionEnvironments = [execEnvironment];

                const program = new Program(importResolver, configOptions, serviceProvider);

                program.setTrackedFiles([UriEx.file(mainFile)]);

                const results = [];

                for (let i = 0; i < iterations; i++) {
                    // Modify the file content
                    const modifiedContent = `
def initial_function(x: int) -> int:
    return x * 2

def added_function_${i}(y: str) -> str:
    return y.upper()

class InitialClass:
    def __init__(self, value: int):
        self.value = value
    
    def new_method_${i}(self) -> str:
        return f"Value: {self.value}"

# Added at iteration ${i}
variable_${i} = ${i}
`;

                    await fs.writeFile(mainFile, modifiedContent);

                    // Mark file as dirty and reanalyze
                    program.markFilesDirty([UriEx.file(mainFile)], true);

                    // Run incremental analysis
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    const sourceFile = program.getSourceFile(UriEx.file(mainFile));
                    let diagnosticCount = 0;
                    if (sourceFile) {
                        const diagnostics = sourceFile.getDiagnostics(configOptions) || [];
                        diagnosticCount = diagnostics.length;
                    }

                    results.push({
                        iteration: i,
                        diagnosticCount,
                    });

                    if (i % 5 === 0) {
                        memoryRunner.takeSnapshot();
                    }
                }

                // Clean up
                program.dispose();
                serviceProvider.dispose();
                await fs.remove(projectDir);

                return results;
            },
            {
                enableProfiling: true,
                memoryGrowthThreshold: 80, // 80MB threshold for incremental analysis
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 80);

        console.log(`Incremental Analysis Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 60000);

    test('should handle complex type inference without excessive memory usage', async () => {
        const iterations = 15;

        const result = await memoryRunner.runMemoryTest(
            'complex-type-inference',
            async () => {
                const results = [];

                for (let i = 0; i < iterations; i++) {
                    const projectDir = path.join(tempDir, `complex-types-${i}`);
                    await fs.ensureDir(projectDir);

                    // Create file with complex type scenarios
                    const complexFile = path.join(projectDir, 'complex.py');
                    const complexContent = `
from typing import List, Dict, Optional, Union, Callable, TypeVar, Generic, Tuple
from typing import overload
import functools

T = TypeVar('T')
U = TypeVar('U')

class GenericContainer(Generic[T]):
    def __init__(self, items: List[T]):
        self._items = items
    
    def get_items(self) -> List[T]:
        return self._items
    
    def transform(self, func: Callable[[T], U]) -> 'GenericContainer[U]':
        return GenericContainer([func(item) for item in self._items])

def complex_function(
    data: Dict[str, List[Optional[Union[int, str]]]],
    processor: Callable[[Union[int, str]], Optional[str]]
) -> Dict[str, List[str]]:
    result: Dict[str, List[str]] = {}
    for key, values in data.items():
        processed = []
        for value in values:
            if value is not None:
                processed_value = processor(value)
                if processed_value is not None:
                    processed.append(processed_value)
        result[key] = processed
    return result

@overload
def overloaded_func(x: int) -> str: ...

@overload
def overloaded_func(x: str) -> int: ...

def overloaded_func(x: Union[int, str]) -> Union[str, int]:
    if isinstance(x, int):
        return str(x)
    return len(x)

class ComplexInheritance(GenericContainer[str]):
    def __init__(self, items: List[str]):
        super().__init__(items)
    
    def complex_method(self) -> Tuple[str, ...]:
        return tuple(self._items)

# Complex decorators
def complex_decorator(func: Callable[..., T]) -> Callable[..., T]:
    @functools.wraps(func)
    def wrapper(*args, **kwargs) -> T:
        return func(*args, **kwargs)
    return wrapper

@complex_decorator
def decorated_function(x: int, y: str) -> Tuple[int, str]:
    return (x, y)
`;

                    await fs.writeFile(complexFile, complexContent);

                    // Set up analysis
                    const configOptions = new ConfigOptions(UriEx.file(projectDir));
                    configOptions.internalTestMode = true;

                    const console = new NullConsole();
                    const tempFile = new RealTempFile();
                    const fileSystem = createFromRealFileSystem(tempFile);
                    const serviceProvider = createServiceProvider(fileSystem, console, tempFile);
                    const importResolver = new ImportResolver(
                        serviceProvider,
                        configOptions,
                        new FullAccessHost(serviceProvider)
                    );

                    const execEnvironment = new ExecutionEnvironment(
                        'python',
                        UriEx.file(projectDir),
                        getStandardDiagnosticRuleSet(),
                        { major: 3, minor: 9 },
                        undefined,
                        undefined
                    );

                    configOptions.executionEnvironments = [execEnvironment];

                    const program = new Program(importResolver, configOptions, serviceProvider);

                    program.setTrackedFiles([UriEx.file(complexFile)]);

                    // Run analysis
                    while (program.analyze()) {
                        // Continue until analysis is complete
                    }

                    results.push({
                        projectDir,
                    });

                    // Clean up
                    program.dispose();
                    serviceProvider.dispose();
                    await fs.remove(projectDir);

                    if (i % 3 === 0) {
                        memoryRunner.takeSnapshot();
                    }
                }

                return results;
            },
            {
                enableProfiling: true,
                memoryGrowthThreshold: 150, // 150MB threshold for complex type inference
            }
        );

        MemoryAssertions.expectNoMemoryLeak(result, 150);

        console.log(`Complex Type Inference Test Results:`);
        console.log(`- Memory growth: ${result.memoryGrowth.toFixed(2)} MB`);
        console.log(`- Profile saved to: ${result.profilePath}`);
    }, 90000);
});

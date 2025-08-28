# Memory Testing Plan for Pyright

## Overview
This document outlines the implementation plan for adding memory leak detection tests to the Pyright project using pprof for performance profiling and memory analysis.

## Objectives
1. Add a new `test:memory` script to the root package.json
2. Create memory leak detection tests that utilize the existing pprof infrastructure
3. Generate trace logs for memory usage analysis
4. Provide a framework for detecting memory leaks in critical Pyright components

## Current State Analysis

### Existing Infrastructure
- ✅ Pyright already has pprof support in `packages/pyright-internal/src/pprof/profiler.ts`
- ✅ Jest testing framework is configured and working
- ✅ TypeScript build system is in place
- ⚠️ `@datadog/pprof` package needs to be added as a dependency

### Key Components to Test
Based on the codebase structure, the following components are critical for memory leak testing:
1. **Analysis Engine** (`analyzer/analysis.ts`, `analyzer/checker.ts`)
2. **File System Operations** (`pyrightFileSystem.ts`)
3. **Language Server** (`languageServerBase.ts`, `server.ts`)
4. **Background Analysis** (`backgroundAnalysis.ts`)
5. **Cache Manager** (`analyzer/cacheManager.ts`)

## Implementation Plan

### Phase 1: Setup and Dependencies
1. Add `@datadog/pprof` as a dev dependency to `pyright-internal`
2. Add `fs-extra` as a dev dependency (if not already present)
3. Create memory test utilities

### Phase 2: Memory Test Framework
1. Create `src/tests/memory/` directory structure
2. Implement base memory test utilities:
   - Memory baseline establishment
   - Heap snapshot comparison
   - Memory leak detection helpers
   - Test result reporting

### Phase 3: Core Memory Tests
1. **Parser Memory Tests**: Test for memory leaks in file parsing operations
2. **Analyzer Memory Tests**: Test type analysis and checker memory usage
3. **Language Server Memory Tests**: Test LSP operations for memory leaks
4. **Cache Memory Tests**: Validate cache cleanup and memory management

### Phase 4: Integration and Scripts
1. Add `test:memory` script to root package.json
2. Create memory test configuration
3. Add CI integration considerations
4. Documentation updates

## Technical Implementation Details

### Memory Test Structure
```
packages/pyright-internal/src/tests/memory/
├── memoryTestUtils.ts          # Base utilities for memory testing
├── parser.memory.test.ts       # Parser memory leak tests
├── analyzer.memory.test.ts     # Type analysis memory tests
├── languageServer.memory.test.ts # LSP memory tests
├── cache.memory.test.ts        # Cache management memory tests
└── fixtures/                   # Test files and data
    ├── large-project/          # Large codebase for stress testing
    └── memory-patterns/        # Known memory leak patterns
```

### Memory Test Utilities Features
- **Heap Snapshot Management**: Take and compare heap snapshots
- **Memory Baseline**: Establish memory baseline before tests
- **Leak Detection**: Identify objects that should have been garbage collected
- **Performance Metrics**: Track memory usage over time
- **Report Generation**: Create detailed memory usage reports

### Test Categories

#### 1. Parser Memory Tests
- Test parsing large Python files repeatedly
- Verify AST nodes are properly garbage collected
- Test incremental parsing memory efficiency

#### 2. Analyzer Memory Tests
- Test type analysis on large codebases
- Verify symbol table cleanup
- Test cross-file analysis memory usage

#### 3. Language Server Memory Tests
- Test LSP request/response cycles
- Verify workspace state cleanup
- Test file watching memory efficiency

#### 4. Cache Memory Tests
- Test cache eviction policies
- Verify proper cleanup of cached analysis results
- Test memory usage under cache pressure

### Script Integration

#### Root package.json additions:
```json
{
  "scripts": {
    "test:memory": "cd packages/pyright-internal && npm run test:memory",
    "test:memory:report": "cd packages/pyright-internal && npm run test:memory:report"
  }
}
```

#### pyright-internal package.json additions:
```json
{
  "scripts": {
    "test:memory": "jest --testPathPattern=memory --runInBand --detectOpenHandles",
    "test:memory:report": "npm run test:memory -- --verbose --collectCoverage"
  }
}
```

## Memory Test Configuration

### Jest Memory Configuration
- Use `--runInBand` to prevent parallel execution (more accurate memory measurements)
- Use `--detectOpenHandles` to identify resource leaks
- Configure longer test timeouts for memory-intensive operations
- Set up custom reporters for memory metrics

### Memory Thresholds
- Define acceptable memory growth limits
- Set heap size monitoring thresholds
- Configure garbage collection monitoring

## Success Criteria

### Immediate Goals
1. ✅ Memory test framework implemented and functional
2. ✅ At least 4 core memory test suites created
3. ✅ `test:memory` script working and integrated
4. ✅ Memory leak detection for critical components

### Long-term Goals
1. 🎯 CI integration for memory regression detection
2. 🎯 Performance benchmarking integration
3. 🎯 Automated memory usage reporting
4. 🎯 Memory optimization recommendations

## Risks and Mitigation

### Technical Risks
- **pprof dependency complexity**: Mitigation - Use existing profiler infrastructure
- **Memory test flakiness**: Mitigation - Implement stable baseline mechanisms
- **Performance impact**: Mitigation - Run memory tests separately from unit tests

### Resource Risks
- **Large test fixtures**: Mitigation - Use synthetic test data when possible
- **Test execution time**: Mitigation - Parallel test execution where safe

## Timeline
- **Week 1**: Phase 1 & 2 (Setup and Framework)
- **Week 2**: Phase 3 (Core Memory Tests)
- **Week 3**: Phase 4 (Integration and Documentation)
- **Week 4**: Testing and refinement

## Files to be Created/Modified

### New Files
- `packages/pyright-internal/src/tests/memory/memoryTestUtils.ts`
- `packages/pyright-internal/src/tests/memory/parser.memory.test.ts`
- `packages/pyright-internal/src/tests/memory/analyzer.memory.test.ts`
- `packages/pyright-internal/src/tests/memory/languageServer.memory.test.ts`
- `packages/pyright-internal/src/tests/memory/cache.memory.test.ts`
- `packages/pyright-internal/src/tests/memory/fixtures/` (directory with test files)

### Modified Files
- `package.json` (root) - Add memory test scripts
- `packages/pyright-internal/package.json` - Add dependencies and scripts
- `packages/pyright-internal/jest.config.js` - Add memory test configuration

## Analyzing Memory Profiles with pprof CLI

Once memory tests generate `.pb.gz` profile files, you can analyze them using the pprof CLI tool for detailed memory and CPU analysis.

### Prerequisites: Install Go and pprof CLI

#### **Step 1: Install Go and Graphviz**
The pprof CLI tool requires Go and Graphviz to be installed first.

**On macOS:**
```bash
# Install Go and Graphviz using Homebrew
brew install go graphviz

# Or download Go from https://golang.org/dl/
# And Graphviz from https://graphviz.org/download/
```

**On Linux (Ubuntu/Debian):**
```bash
# Install Go and Graphviz
sudo apt update
sudo apt install golang-go graphviz

# Or download from respective websites
```

**On Windows:**
1. Download Go from https://golang.org/dl/
2. Download Graphviz from https://graphviz.org/download/
3. Run both installers
4. Or use Chocolatey: `choco install golang graphviz`

#### **Step 2: Install pprof CLI**
Once Go is installed:
```bash
# Install pprof CLI tool
go install github.com/google/pprof@latest
```

#### **Step 3: Configure PATH**
Add Go's bin directory to your PATH:

**For Zsh (macOS default):**
```bash
# Add to ~/.zshrc
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.zshrc
source ~/.zshrc
```

**For Bash:**
```bash
# Add to ~/.bashrc or ~/.bash_profile
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.bashrc
source ~/.bashrc
```

#### **Step 4: Verify Installation**
```bash
# Check Go installation
go version

# Check Graphviz installation
dot -V

# Check pprof installation
pprof -help
```

#### **Automated Installation (macOS)**
Use the npm script for automated installation:
```bash
npm run pprof:install
```

### Install pprof CLI (if not already installed):
```bash
go install github.com/google/pprof@latest
```

### View flame graph in browser:
```bash
pprof -http=:8080 path/to/profile.pb.gz
```
This opens an interactive web interface at `http://localhost:8080` with:
- Flame graphs for visualizing call stacks
- Top functions by CPU/memory usage
- Call graph analysis
- Source code view with annotations

### Generate SVG flame graph:
```bash
pprof -svg path/to/profile.pb.gz > flame.svg
```

### Other useful pprof commands:
```bash
# Text-based top report
pprof -top path/to/profile.pb.gz

# Generate PDF report
pprof -pdf path/to/profile.pb.gz > report.pdf

# Focus on specific functions
pprof -http=:8080 -focus="typeEvaluator|parseFile" path/to/profile.pb.gz
```

### Example Usage:
```bash
# Run memory tests to generate profiles
npm run test:memory

# Analyze generated profiles
cd packages/pyright-internal
pprof -http=:8080 memory-profiles/parser/large-file-parsing-0.pb.gz
pprof -http=:8080 memory-profiles/type-evaluator/complex-generics-analysis-0.pb.gz
```

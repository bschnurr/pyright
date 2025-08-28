# Memory Testing & Profiling Guide

This guide explains how to run memory tests and analyze performance profiles for the Pyright language server.

## Quick Start

```bash
# Run all memory tests
npm run test:memory

# Run specific test suite
npm run test:memory:parser

# View help for profiling
npm run pprof:help

# List generated profile files
npm run pprof:list
```

## Prerequisites

### 1. Install Go

The pprof CLI tool requires Go to be installed first.

#### **macOS**
```bash
# Using Homebrew (recommended)
brew install go

# Or download installer from https://golang.org/dl/
```

### 1.5. Install Graphviz

Graphviz is required for pprof to generate visual outputs like SVG flame graphs.

#### **macOS**
```bash
# Using Homebrew (recommended)
brew install graphviz
```

#### **Linux (Ubuntu/Debian)**
```bash
# Using package manager
sudo apt update
sudo apt install graphviz

# Or for other distributions
sudo yum install graphviz  # CentOS/RHEL
```

#### **Windows**
```bash
# Using Chocolatey
choco install graphviz

# Or download from https://graphviz.org/download/
```

#### **Linux (Ubuntu/Debian)**
```bash
# Using package manager
sudo apt update
sudo apt install golang-go graphviz

# Or download from https://golang.org/dl/
```

#### **Windows**
1. Download Go from https://golang.org/dl/
2. Run the installer
3. Install Graphviz: `choco install graphviz` or download from https://graphviz.org/download/
4. Or use Chocolatey for both: `choco install golang graphviz`

### 2. Install pprof CLI

```bash
# Install pprof CLI tool
go install github.com/google/pprof@latest
```

### 3. Configure PATH

Add Go's bin directory to your PATH:

#### **For Zsh (macOS default)**
```bash
# Add to ~/.zshrc
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.zshrc
source ~/.zshrc
```

#### **For Bash**
```bash
# Add to ~/.bashrc or ~/.bash_profile
echo 'export PATH=$PATH:$(go env GOPATH)/bin' >> ~/.bashrc
source ~/.bashrc
```

### 4. Verify Installation

```bash
# Check Go installation
go version
# Should output: go version go1.x.x...

# Check Graphviz installation
dot -V
# Should output: dot - graphviz version...

# Check pprof installation
pprof -help
# Should output: Usage of pprof...
```

## Automated Installation

For macOS users, you can use the automated installer:

```bash
npm run pprof:install
```

This will:
1. Install Go via Homebrew
2. Install Graphviz via Homebrew
3. Install pprof CLI
4. Configure PATH

## Running Memory Tests

### All Tests
```bash
npm run test:memory
```

### Specific Test Suites
```bash
# Parser memory tests
npm run test:memory:parser

# Type evaluator tests
npm run test:memory -- --testNamePattern="typeEvaluator"

# Cache tests
npm run test:memory -- --testNamePattern="cache"

# Analyzer tests
npm run test:memory -- --testNamePattern="analyzer"
```

### Individual Tests
```bash
# Specific test by name
npm run test:memory -- --testNamePattern="should not leak memory during type analysis"

# With verbose output
npm run test:memory -- --verbose --testNamePattern="complex generics"
```

## Analyzing Profile Files

Memory tests generate `.pb.gz` profile files that can be analyzed with pprof.

### List Available Profiles
```bash
npm run pprof:list
```

### View Interactive Flame Graphs
```bash
# Open specific profile in browser
pprof -http=:8080 cache/multiple-cache-managers-2.pb.gz

# Then open http://localhost:8080 in your browser
```

### Generate Static Reports
```bash
# SVG flame graph
pprof -svg cache/multiple-cache-managers-2.pb.gz > flame.svg

# PDF report
pprof -pdf cache/multiple-cache-managers-2.pb.gz > report.pdf

# Text-based top functions
pprof -top cache/multiple-cache-managers-2.pb.gz
```

### Focus on Specific Functions
```bash
# Focus on type evaluator functions
pprof -http=:8080 -focus="typeEvaluator|evaluateType" type-evaluator/complex-generics-analysis-0.pb.gz

# Focus on parser functions
pprof -http=:8080 -focus="parseFile|Parser" parser/large-file-parsing-0.pb.gz
```

## Profile File Organization

Profile files are organized by test suite:

```
memory-profiles/
├── parser/           # Parser memory tests
├── type-evaluator/   # Type analysis tests
├── cache/           # Cache management tests
└── analyzer/        # Analysis engine tests
```

## Alternative: Online Analysis

If you can't install the pprof CLI, you can upload `.pb.gz` files to:
- **https://pprof.me/** - Google's online pprof viewer
- No installation required, just upload the profile file

## Memory Test Results

Tests measure:
- **Memory Growth**: Heap memory increase during operations
- **Peak Memory**: Maximum memory usage
- **Memory Leaks**: Persistent memory after garbage collection
- **Performance Bottlenecks**: CPU-intensive operations

### Thresholds
- Parser tests: 15-50MB growth limit
- Type evaluator: 60-100MB growth limit  
- Cache tests: 35-60MB growth limit
- Analyzer tests: 80-200MB growth limit

## Troubleshooting

### "command not found: pprof"
1. Ensure Go is installed: `go version`
2. Install pprof: `go install github.com/google/pprof@latest`
3. Check PATH includes Go bin: `echo $PATH | grep go`
4. Reload shell: `source ~/.zshrc`

### "Could not execute dot; may need to install graphviz"
1. Install Graphviz: `brew install graphviz` (macOS) or `sudo apt install graphviz` (Linux)
2. Verify installation: `dot -V`
3. Restart terminal and try again

### "go: command not found"
1. Install Go using package manager or download from golang.org
2. Verify installation: `which go`
3. Add Go to PATH if needed

### Memory tests failing
1. Increase Node.js memory: Tests use `--max-old-space-size=4096`
2. Check for open handles: Tests use `--detectOpenHandles`
3. Run tests individually to isolate issues

### Large profile files
1. Focus on specific functions: Use `-focus` flag
2. Sample less frequently: Reduce profile duration
3. Filter out noise: Use `-ignore` flag

## Contributing

When adding new memory tests:
1. Use `MemoryTestRunner` for consistent measurement
2. Set appropriate memory growth thresholds
3. Enable profiling for performance analysis
4. Add descriptive test names and logging

## Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run test:memory` | Run all memory tests |
| `npm run test:memory:parser` | Run parser tests only |
| `npm run test:memory:report` | Run with detailed reporting |
| `npm run pprof:help` | Show pprof installation help |
| `npm run pprof:list` | List available profile files |
| `npm run pprof:install` | Auto-install Go and pprof (macOS) |

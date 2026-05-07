/*
 * parser.bench.ts
 *
 * Vitest benchmarks for the Python parser.
 * Measures parse performance across representative corpora.
 */

import * as fs from 'fs';
import * as path from 'path';
import { bench, describe } from 'vitest';

import { DiagnosticSink } from '../../common/diagnosticSink';
import { ParseOptions, Parser } from '../../parser/parser';

function loadCorpus(filename: string): string {
    const filePath = path.resolve(__dirname, '..', 'benchmarkData', filename);
    return fs.readFileSync(filePath, 'utf-8');
}

const corpora = [
    { name: 'large_stdlib', file: 'large_stdlib.py' },
    { name: 'fstring_heavy', file: 'fstring_heavy.py' },
    { name: 'comment_heavy', file: 'comment_heavy.py' },
    { name: 'large_class', file: 'large_class.py' },
    { name: 'import_heavy', file: 'import_heavy.py' },
    { name: 'union_heavy', file: 'union_heavy.py' },
];

describe('Parser', () => {
    const parseOptions = new ParseOptions();

    for (const { name, file } of corpora) {
        const code = loadCorpus(file);

        bench(`parse ${name}`, () => {
            const parser = new Parser();
            const diagSink = new DiagnosticSink();
            parser.parseSourceFile(code, parseOptions, diagSink);
        });
    }

    const scaledCode = Array(10).fill(loadCorpus('large_stdlib.py')).join('\n');

    bench('parse large_stdlib 10x', () => {
        const parser = new Parser();
        const diagSink = new DiagnosticSink();
        parser.parseSourceFile(scaledCode, parseOptions, diagSink);
    });
});

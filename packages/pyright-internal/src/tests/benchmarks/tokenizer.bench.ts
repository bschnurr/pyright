/*
 * tokenizer.bench.ts
 *
 * Vitest benchmarks for the Python tokenizer.
 * Measures tokenization performance across representative corpora.
 */

import * as fs from 'fs';
import * as path from 'path';
import { bench, describe } from 'vitest';

import { Tokenizer } from '../../parser/tokenizer';

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
    { name: 'repetitive_identifiers', file: 'repetitive_identifiers.py' },
];

describe('Tokenizer', () => {
    for (const { name, file } of corpora) {
        const code = loadCorpus(file);

        bench(`tokenize ${name}`, () => {
            const tokenizer = new Tokenizer();
            tokenizer.tokenize(code);
        });
    }

    const scaledCode = Array(10).fill(loadCorpus('large_stdlib.py')).join('\n');

    bench('tokenize large_stdlib 10x', () => {
        const tokenizer = new Tokenizer();
        tokenizer.tokenize(scaledCode);
    });
});

/*
 * stableDeclarationId.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 */

import assert from 'assert';

import {
    createStableDeclarationSummary,
    StableDeclarationIdentity,
    StableDeclarationIdInstabilityReason,
    StableDeclarationSummary,
} from '../analyzer/stableDeclarationId';
import { DiagnosticSink } from '../common/diagnosticSink';
import { ParseOptions, Parser } from '../parser/parser';

const testFileIdentity = 'file:///stableDeclarationId.py';

test('stable declaration ids survive comment edits', () => {
    const before = _getStableDeclaration(_createSummary('def f(x: int) -> int:\n    return x\n'), 'f');
    const after = _getStableDeclaration(
        _createSummary('def f(x: int) -> int:\n    # comment edit\n    return x\n'),
        'f'
    );

    assert.strictEqual(after.id, before.id);
    assert.strictEqual(after.declarationFingerprint, before.declarationFingerprint);
});

test('stable declaration ids survive unrelated declarations', () => {
    const before = _createSummary('def f() -> int:\n    return 1\n\ndef g() -> int:\n    return 2\n');
    const after = _createSummary(
        'def f() -> int:\n    return 1\n\ndef unrelated() -> None:\n    pass\n\ndef g() -> int:\n    return 2\n'
    );

    assert.strictEqual(_getStableDeclaration(after, 'f').id, _getStableDeclaration(before, 'f').id);
    assert.strictEqual(_getStableDeclaration(after, 'g').id, _getStableDeclaration(before, 'g').id);
    assert.strictEqual(after.stableDeclarationCount, 3);
});

test('stable declaration ids mark duplicate reorders unstable', () => {
    const before = _createSummary('def f(x: int) -> int:\n    return x\n\n' + 'def f(x: str) -> str:\n    return x\n');
    const after = _createSummary('def f(x: str) -> str:\n    return x\n\n' + 'def f(x: int) -> int:\n    return x\n');

    _assertDuplicateDeclarationsUnstable(before, 'f');
    _assertDuplicateDeclarationsUnstable(after, 'f');
});

function _createSummary(text: string): StableDeclarationSummary {
    const parser = new Parser();
    const parseResults = parser.parseSourceFile(text, new ParseOptions(), new DiagnosticSink());

    return createStableDeclarationSummary(parseResults.parserOutput.parseTree, text, testFileIdentity);
}

function _getStableDeclaration(summary: StableDeclarationSummary, symbolPath: string): StableDeclarationIdentity {
    const declaration = summary.declarations.find(
        (entry) => entry.symbolPath.join('.') === symbolPath && entry.isStable && entry.id !== undefined
    );
    assert.ok(declaration, `Expected stable declaration for ${symbolPath}`);

    return declaration;
}

function _assertDuplicateDeclarationsUnstable(summary: StableDeclarationSummary, symbolPath: string) {
    const declarations = summary.declarations.filter((entry) => entry.symbolPath.join('.') === symbolPath);
    assert.strictEqual(declarations.length, 2);

    for (const declaration of declarations) {
        assert.strictEqual(declaration.id, undefined);
        assert.strictEqual(declaration.isStable, false);
        assert.strictEqual(declaration.instabilityReason, StableDeclarationIdInstabilityReason.DuplicateSymbolInScope);
    }
}

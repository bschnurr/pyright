/*
 * editInvalidationClassifier.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 */

import * as assert from 'assert';

import { classifyEditInvalidation, InvalidationKind } from '../analyzer/editInvalidationClassifier';
import { TextRange } from '../common/textRange';

test('edit invalidation kind includes planned conservative categories', () => {
    assert.deepStrictEqual(Object.values(InvalidationKind), [
        'NoChange',
        'TriviaOnly',
        'TokenOnly',
        'SyntaxOnly',
        'LocalBodyOnly',
        'LocalDeclarationShape',
        'ModuleImportSurface',
        'ModuleExportSurface',
        'BuiltinsOrConfig',
    ]);
});

test('edit invalidation classifier returns no change for identical text', () => {
    assert.equal(
        classifyEditInvalidation({
            oldText: 'x = 1\n',
            newText: 'x = 1\n',
        }),
        InvalidationKind.NoChange
    );
});

test('edit invalidation classifier falls back for changed text', () => {
    assert.equal(
        classifyEditInvalidation({
            oldText: 'x = 1\n',
            newText: 'x = 2\n',
        }),
        InvalidationKind.ModuleExportSurface
    );
});

test('edit invalidation classifier accepts changed range without narrowing fallback', () => {
    assert.equal(
        classifyEditInvalidation({
            oldText: 'x = 1\n',
            newText: 'x = 2\n',
            changedRange: {
                range: TextRange.create(4, 1),
                delta: 0,
            },
        }),
        InvalidationKind.ModuleExportSurface
    );
});

test('edit invalidation classifier accepts no-change changed range', () => {
    assert.equal(
        classifyEditInvalidation({
            oldText: 'x = 1\n',
            newText: 'x = 1\n',
            changedRange: {
                range: TextRange.create(0, 0),
                delta: 0,
            },
        }),
        InvalidationKind.NoChange
    );
});

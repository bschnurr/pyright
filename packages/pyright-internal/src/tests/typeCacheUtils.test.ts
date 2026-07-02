/*
 * typeCacheUtils.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Tests for type cache utilities.
 */

import assert from 'assert';

import { Uri } from '../common/uri/uri';
import { ModuleNode } from '../parser/parseNodes';
import { SpeculativeTypeTracker } from '../analyzer/typeCacheUtils';
import { AnyType, ClassType, ClassTypeFlags, Type } from '../analyzer/types';

test('Speculative type cache is capped per node', () => {
    const tracker = new SpeculativeTypeTracker();
    const node = ModuleNode.create({ start: 0, length: 0 });
    const expectedTypes = Array.from({ length: 9 }, (_, index) => _createExpectedType(index));

    tracker.enterSpeculativeContext(node);

    expectedTypes.forEach((expectedType) => {
        tracker.addSpeculativeType(node, { type: AnyType.create() }, /* incompleteGenerationCount */ 0, expectedType);
    });

    assert.strictEqual(tracker.getCacheStats().speculativeTypeCacheEntries, 8);
    assert.strictEqual(tracker.getSpeculativeType(node, expectedTypes[0]), undefined);

    expectedTypes.slice(1).forEach((expectedType) => {
        assert.ok(tracker.getSpeculativeType(node, expectedType));
    });
});

test('Speculative mode disable clears and restores active dependent types', () => {
    const tracker = new SpeculativeTypeTracker();
    const node = ModuleNode.create({ start: 0, length: 0 });

    tracker.enterSpeculativeContext(node, { dependentType: _createExpectedType(1) });
    assert.deepStrictEqual(_getSpeculativeModeStats(tracker), {
        speculativeContextStack: 1,
        activeDependentTypes: 1,
    });

    const state = tracker.disableSpeculativeMode();
    assert.deepStrictEqual(_getSpeculativeModeStats(tracker), {
        speculativeContextStack: 0,
        activeDependentTypes: 0,
    });

    tracker.enableSpeculativeMode(state);
    assert.deepStrictEqual(_getSpeculativeModeStats(tracker), {
        speculativeContextStack: 1,
        activeDependentTypes: 1,
    });

    tracker.leaveSpeculativeContext();
    assert.deepStrictEqual(_getSpeculativeModeStats(tracker), {
        speculativeContextStack: 0,
        activeDependentTypes: 0,
    });
});

function _createExpectedType(index: number): Type {
    return ClassType.createInstantiable(
        `Expected${index}`,
        `test.Expected${index}`,
        'test',
        Uri.empty(),
        ClassTypeFlags.None,
        0,
        /* declaredMetaclass */ undefined,
        /* effectiveMetaclass */ undefined
    );
}

function _getSpeculativeModeStats(tracker: SpeculativeTypeTracker) {
    const { speculativeContextStack, activeDependentTypes } = tracker.getCacheStats();
    return { speculativeContextStack, activeDependentTypes };
}

/*
 * dependencyAwareEvaluatorCache.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 */

import assert from 'assert';

import {
    createDependencyAwareEvaluatorFingerprint,
    DependencyAwareEvaluatorCache,
    DependencyAwareEvaluatorCacheEntryKind,
    DependencyAwareEvaluatorCacheEpochs,
    DependencyAwareEvaluatorCacheValidationReason,
} from '../analyzer/dependencyAwareEvaluatorCache';
import { createModuleExportSummary, ModuleExportSummary } from '../analyzer/moduleExportSummary';
import { createStableDeclarationSummary, StableDeclarationIdentity } from '../analyzer/stableDeclarationId';
import { DiagnosticSink } from '../common/diagnosticSink';
import { ParseOptions, Parser } from '../parser/parser';

const testFileIdentity = 'file:///dependencyAwareEvaluatorCache.py';
const defaultEpochs: DependencyAwareEvaluatorCacheEpochs = {
    builtinsEpoch: 1,
    configEpoch: 1,
    importResolverEpoch: 1,
    typeshedEpoch: 1,
    librarySummaryConfigEpoch: 1,
    partialStubEpoch: 1,
};

test('dependency-aware evaluator cache validates unchanged declaration dependencies', () => {
    const before = _createDeclarationState('def f(x: int) -> int:\n    return x\n');
    const after = _createDeclarationState('def f(x: int) -> int:\n    # unrelated body edit\n    return x\n');
    const cache = new DependencyAwareEvaluatorCache();
    const entry = {
        key: _createKey(before.declaration),
        dependencyFingerprint: _createFingerprint(before.declaration, before.moduleExportSummary),
        evaluatorGeneration: 1,
    };

    assert.strictEqual(cache.set(entry), true);

    const result = cache.get(entry.key, _createFingerprint(after.declaration, after.moduleExportSummary));
    assert.strictEqual(result.isValid, true);
    assert.strictEqual(result.reason, DependencyAwareEvaluatorCacheValidationReason.Valid);
    assert.strictEqual(cache.getStats().validationHitCount, 1);
});

test('dependency-aware evaluator cache rejects unstable declaration entries', () => {
    const state = _createDeclarationState('def f(x: int) -> int:\n    return x\n');
    const cache = new DependencyAwareEvaluatorCache();

    assert.strictEqual(
        cache.set({
            key: _createKey(state.declaration),
            dependencyFingerprint: _createFingerprint(state.declaration, state.moduleExportSummary, {
                stableDeclarationId: undefined,
            }),
            evaluatorGeneration: 1,
        }),
        false
    );
    assert.strictEqual(cache.getStats().rejectedStoreCount, 1);
});

test('dependency-aware evaluator cache invalidates public signature, import, config, and builtins changes', () => {
    const before = _createDeclarationState('from dep import value\n\ndef f(x: int) -> int:\n    return value\n');
    const signatureChanged = _createDeclarationState(
        'from dep import value\n\ndef f(x: str) -> str:\n    return value\n'
    );
    const importChanged = _createDeclarationState(
        'from other import value\n\ndef f(x: int) -> int:\n    return value\n'
    );
    const entry = {
        key: _createKey(before.declaration),
        dependencyFingerprint: _createFingerprint(before.declaration, before.moduleExportSummary),
        evaluatorGeneration: 1,
    };
    const cache = new DependencyAwareEvaluatorCache();

    assert.strictEqual(cache.set(entry), true);
    assert.strictEqual(
        cache.validateEntry(
            entry,
            _createFingerprint(signatureChanged.declaration, signatureChanged.moduleExportSummary)
        ).reason,
        DependencyAwareEvaluatorCacheValidationReason.StableDeclarationIdChanged
    );
    assert.strictEqual(
        cache.validateEntry(entry, _createFingerprint(importChanged.declaration, importChanged.moduleExportSummary))
            .reason,
        DependencyAwareEvaluatorCacheValidationReason.ModuleImportFingerprintChanged
    );
    assert.strictEqual(
        cache.validateEntry(
            entry,
            _createFingerprint(before.declaration, before.moduleExportSummary, {
                epochs: { ...defaultEpochs, configEpoch: defaultEpochs.configEpoch + 1 },
            })
        ).reason,
        DependencyAwareEvaluatorCacheValidationReason.ConfigEpochChanged
    );
    assert.strictEqual(
        cache.validateEntry(
            entry,
            _createFingerprint(before.declaration, before.moduleExportSummary, {
                epochs: { ...defaultEpochs, builtinsEpoch: defaultEpochs.builtinsEpoch + 1 },
            })
        ).reason,
        DependencyAwareEvaluatorCacheValidationReason.BuiltinsEpochChanged
    );
});

function _createDeclarationState(text: string) {
    const parser = new Parser();
    const parseResults = parser.parseSourceFile(text, new ParseOptions(), new DiagnosticSink());
    const stableSummary = createStableDeclarationSummary(parseResults.parserOutput.parseTree, text, testFileIdentity);
    const moduleExportSummary = createModuleExportSummary(parseResults.parserOutput, text, testFileIdentity);
    const declaration = stableSummary.declarations.find(
        (entry) => entry.symbolPath.join('.') === 'f' && entry.isStable && entry.id !== undefined
    );

    assert.ok(declaration, 'Expected a stable declaration for f');
    return { declaration, moduleExportSummary };
}

function _createFingerprint(
    declaration: StableDeclarationIdentity,
    moduleExportSummary: ModuleExportSummary,
    overrides: {
        stableDeclarationId?: string | undefined;
        stableDeclarationFingerprint?: string | undefined;
        epochs?: DependencyAwareEvaluatorCacheEpochs;
    } = {}
) {
    return createDependencyAwareEvaluatorFingerprint({
        stableDeclarationId: 'stableDeclarationId' in overrides ? overrides.stableDeclarationId : declaration.id,
        stableDeclarationFingerprint:
            'stableDeclarationFingerprint' in overrides
                ? overrides.stableDeclarationFingerprint
                : declaration.declarationFingerprint,
        moduleExportSummary,
        epochs: overrides.epochs ?? defaultEpochs,
    });
}

function _createKey(declaration: StableDeclarationIdentity) {
    assert.ok(declaration.id);
    return {
        declarationId: declaration.id,
        entryKind: DependencyAwareEvaluatorCacheEntryKind.DeclarationEligibility,
        flags: undefined,
    };
}

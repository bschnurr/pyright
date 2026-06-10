/*
 * sparseResolver.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Unit tests for sparse resolver prototype scaffolding.
 */

import * as assert from 'assert';

import { Uri } from '../common/uri/uri';
import {
    SparseExportIndexCompleteness,
    SparseExportIndexSource,
    SparseFallbackReason,
    SparseResolver,
    SparseResolverMode,
} from '../analyzer/sparseResolver';

const testUri = Uri.file('/test/module.py');

describe('SparseResolver tests', () => {
    test('returns feature-disabled fallback when off', () => {
        const resolver = new SparseResolver({ mode: SparseResolverMode.Off, enableStarImports: true });

        const result = resolver.resolveExport({ moduleUri: testUri, name: 'A' });

        assert.equal(result.kind, 'fallback');
        assert.equal(result.kind === 'fallback' ? result.reason : undefined, SparseFallbackReason.FeatureDisabled);
    });

    test('returns negative result for absent name in complete export surface', () => {
        const resolver = new SparseResolver({ mode: SparseResolverMode.Enabled, enableStarImports: true });

        const result = resolver.resolveExport({
            moduleUri: testUri,
            name: 'Missing',
            exportIndex: {
                moduleUri: testUri,
                names: new Set(['Present']),
                completeness: SparseExportIndexCompleteness.Complete,
                source: SparseExportIndexSource.DunderAll,
                usesUnsupportedDunderAllForm: false,
            },
        });

        assert.equal(result.kind, 'notFound');
        assert.equal(resolver.getStats().missCount, 1);
    });

    test('falls back for absent name in partial export surface', () => {
        const resolver = new SparseResolver({ mode: SparseResolverMode.Enabled, enableStarImports: true });

        const result = resolver.resolveExport({
            moduleUri: testUri,
            name: 'Missing',
            exportIndex: {
                moduleUri: testUri,
                names: new Set(['Present']),
                completeness: SparseExportIndexCompleteness.Partial,
                source: SparseExportIndexSource.Binder,
                usesUnsupportedDunderAllForm: false,
            },
        });

        assert.equal(result.kind, 'fallback');
        assert.equal(result.kind === 'fallback' ? result.reason : undefined, SparseFallbackReason.IncompleteIndex);
    });

    test('falls back for dynamic dunder all', () => {
        const resolver = new SparseResolver({ mode: SparseResolverMode.Enabled, enableStarImports: true });

        const result = resolver.resolveExport({
            moduleUri: testUri,
            name: 'A',
            exportIndex: {
                moduleUri: testUri,
                names: new Set(['A']),
                completeness: SparseExportIndexCompleteness.Unknown,
                source: SparseExportIndexSource.Binder,
                usesUnsupportedDunderAllForm: true,
            },
        });

        assert.equal(result.kind, 'fallback');
        assert.equal(result.kind === 'fallback' ? result.reason : undefined, SparseFallbackReason.DynamicAll);
    });
});

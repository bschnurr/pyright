/*
 * sparseResolver.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Prototype-only sparse resolver scaffolding.
 *
 * The first target is wildcard import export-surface lookup. This file is
 * intentionally conservative: it can prove positive hits from existing binder
 * metadata and negative hits only when a static __all__ surface is complete.
 * All uncertain cases return fallback so callers can delegate to the existing
 * binder/evaluator paths.
 */

import { Uri } from '../common/uri/uri';
import { ImportLookupResult } from './analyzerFileInfo';
import { Symbol } from './symbol';

export const enum SparseResolverMode {
    Off = 'off',
    LoggingOnly = 'loggingOnly',
    Enabled = 'enabled',
}

export const enum SparseExportIndexCompleteness {
    Complete = 'complete',
    Partial = 'partial',
    Unknown = 'unknown',
}

export const enum SparseExportIndexSource {
    DunderAll = 'all',
    Binder = 'binder',
    Cache = 'cache',
}

export const enum SparseFallbackReason {
    FeatureDisabled = 'featureDisabled',
    UnknownExportSurface = 'unknownExportSurface',
    DynamicAll = 'dynamicAll',
    IncompleteIndex = 'incompleteIndex',
    CacheInvalidated = 'cacheInvalidated',
}

export interface SparseResolverOptions {
    mode: SparseResolverMode;
    enableStarImports: boolean;
}

export interface SparseExportIndex {
    moduleUri: Uri;
    names: ReadonlySet<string>;
    completeness: SparseExportIndexCompleteness;
    source: SparseExportIndexSource;
    usesUnsupportedDunderAllForm: boolean;
}

export interface SparseExportQuery {
    moduleUri: Uri;
    name: string;
    exportIndex?: SparseExportIndex | undefined;
}

export type SparseResolveResult<T> =
    | { kind: 'resolved'; value: T }
    | { kind: 'notFound' }
    | { kind: 'fallback'; reason: SparseFallbackReason };

export interface SparseResolverStats {
    hitCount: number;
    missCount: number;
    fallbackCount: number;
    positiveCacheHitCount: number;
    negativeCacheHitCount: number;
}

interface SparseResolutionKey {
    moduleUri: Uri;
    name: string;
    operation: 'export';
}

export class SparseResolverCache {
    private _positiveCache = new Map<string, Symbol>();
    private _negativeCache = new Set<string>();

    getPositive(key: SparseResolutionKey): Symbol | undefined {
        return this._positiveCache.get(this._formatKey(key));
    }

    setPositive(key: SparseResolutionKey, symbol: Symbol) {
        this._positiveCache.set(this._formatKey(key), symbol);
    }

    hasNegative(key: SparseResolutionKey) {
        return this._negativeCache.has(this._formatKey(key));
    }

    setNegative(key: SparseResolutionKey) {
        this._negativeCache.add(this._formatKey(key));
    }

    invalidateModule(moduleUri: Uri) {
        const prefix = `${moduleUri.key}:`;

        for (const key of this._positiveCache.keys()) {
            if (key.startsWith(prefix)) {
                this._positiveCache.delete(key);
            }
        }

        for (const key of this._negativeCache) {
            if (key.startsWith(prefix)) {
                this._negativeCache.delete(key);
            }
        }
    }

    private _formatKey(key: SparseResolutionKey) {
        return `${key.moduleUri.key}:${key.operation}:${key.name}`;
    }
}

export class SparseResolver {
    private _stats: SparseResolverStats = {
        hitCount: 0,
        missCount: 0,
        fallbackCount: 0,
        positiveCacheHitCount: 0,
        negativeCacheHitCount: 0,
    };

    constructor(private readonly _options: SparseResolverOptions, private readonly _cache = new SparseResolverCache()) {}

    getStats(): SparseResolverStats {
        return { ...this._stats };
    }

    resolveExport(query: SparseExportQuery): SparseResolveResult<Symbol> {
        if (this._options.mode === SparseResolverMode.Off || !this._options.enableStarImports) {
            return this._fallback(SparseFallbackReason.FeatureDisabled);
        }

        const key: SparseResolutionKey = {
            moduleUri: query.moduleUri,
            name: query.name,
            operation: 'export',
        };

        const positiveCacheHit = this._cache.getPositive(key);
        if (positiveCacheHit) {
            this._stats.positiveCacheHitCount++;
            return this._hit(positiveCacheHit);
        }

        if (this._cache.hasNegative(key)) {
            this._stats.negativeCacheHitCount++;
            return this._miss();
        }

        const index = query.exportIndex;
        if (!index) {
            return this._fallback(SparseFallbackReason.UnknownExportSurface);
        }

        if (index.usesUnsupportedDunderAllForm) {
            return this._fallback(SparseFallbackReason.DynamicAll);
        }

        if (index.names.has(query.name)) {
            // The prototype index stores names only. In the binder integration, the
            // caller should still use existing trusted alias creation logic to bind
            // the returned symbol into the importing scope.
            return this._fallback(SparseFallbackReason.IncompleteIndex);
        }

        if (index.completeness === SparseExportIndexCompleteness.Complete) {
            this._cache.setNegative(key);
            return this._miss();
        }

        return this._fallback(SparseFallbackReason.IncompleteIndex);
    }

    static createExportIndex(moduleUri: Uri, lookupInfo: ImportLookupResult): SparseExportIndex {
        if (lookupInfo.dunderAllNames && !lookupInfo.usesUnsupportedDunderAllForm) {
            return {
                moduleUri,
                names: new Set(lookupInfo.dunderAllNames),
                completeness: SparseExportIndexCompleteness.Complete,
                source: SparseExportIndexSource.DunderAll,
                usesUnsupportedDunderAllForm: false,
            };
        }

        return {
            moduleUri,
            names: new Set(lookupInfo.symbolTable.keys()),
            completeness: lookupInfo.usesUnsupportedDunderAllForm
                ? SparseExportIndexCompleteness.Unknown
                : SparseExportIndexCompleteness.Partial,
            source: SparseExportIndexSource.Binder,
            usesUnsupportedDunderAllForm: lookupInfo.usesUnsupportedDunderAllForm,
        };
    }

    private _hit(symbol: Symbol): SparseResolveResult<Symbol> {
        this._stats.hitCount++;
        return { kind: 'resolved', value: symbol };
    }

    private _miss(): SparseResolveResult<Symbol> {
        this._stats.missCount++;
        return { kind: 'notFound' };
    }

    private _fallback(reason: SparseFallbackReason): SparseResolveResult<Symbol> {
        this._stats.fallbackCount++;
        return { kind: 'fallback', reason };
    }
}

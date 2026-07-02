/*
 * dependencyAwareEvaluatorCache.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Conservative stable-keyed evaluator cache scaffolding.
 */

import * as StringUtils from '../common/stringUtils';
import { LibraryResourceKey, LibraryStubSummary } from './libraryResourceSummary';
import { ModuleExportSummary } from './moduleExportSummary';

export enum DependencyAwareEvaluatorCacheEntryKind {
    DeclarationEligibility = 'declarationEligibility',
}

export enum DependencyAwareEvaluatorCacheValidationReason {
    Valid = 'Valid',
    MissingEntry = 'MissingEntry',
    UnstableDeclaration = 'UnstableDeclaration',
    StableDeclarationIdChanged = 'StableDeclarationIdChanged',
    StableDeclarationFingerprintChanged = 'StableDeclarationFingerprintChanged',
    ModuleExportFingerprintChanged = 'ModuleExportFingerprintChanged',
    ModuleImportFingerprintChanged = 'ModuleImportFingerprintChanged',
    ModuleDeclarationFingerprintChanged = 'ModuleDeclarationFingerprintChanged',
    LocalFileContentsVersionChanged = 'LocalFileContentsVersionChanged',
    LocalSemanticVersionChanged = 'LocalSemanticVersionChanged',
    BuiltinsEpochChanged = 'BuiltinsEpochChanged',
    ConfigEpochChanged = 'ConfigEpochChanged',
    ImportResolverEpochChanged = 'ImportResolverEpochChanged',
    LibrarySummaryEpochChanged = 'LibrarySummaryEpochChanged',
    LibraryResourceKeyChanged = 'LibraryResourceKeyChanged',
    DependentModuleFingerprintChanged = 'DependentModuleFingerprintChanged',
}

export interface DependencyAwareEvaluatorCacheEpochs {
    readonly builtinsEpoch: number;
    readonly configEpoch: number;
    readonly importResolverEpoch: number;
    readonly typeshedEpoch: number;
    readonly librarySummaryConfigEpoch: number;
    readonly partialStubEpoch: number;
}

export interface DependencyAwareEvaluatorModuleDependency {
    readonly uri: string;
    readonly exportFingerprint: string | undefined;
    readonly importFingerprint: string | undefined;
    readonly declarationFingerprint: string | undefined;
    readonly libraryResourceKeyFingerprint?: string | undefined;
}

export interface DependencyAwareEvaluatorFingerprint {
    readonly stableDeclarationId: string | undefined;
    readonly stableDeclarationFingerprint: string | undefined;
    readonly moduleExportFingerprint: string | undefined;
    readonly moduleImportFingerprint: string | undefined;
    readonly moduleDeclarationFingerprint: string | undefined;
    readonly localFileContentsVersion: number | undefined;
    readonly localSemanticVersion: number | undefined;
    readonly builtinsEpoch: number;
    readonly configEpoch: number;
    readonly importResolverEpoch: number;
    readonly typeshedEpoch: number;
    readonly librarySummaryConfigEpoch: number;
    readonly partialStubEpoch: number;
    readonly libraryResourceKeyFingerprint: string | undefined;
    readonly dependentModuleFingerprints: readonly DependencyAwareEvaluatorModuleDependency[];
    readonly fingerprint: string;
}

export interface StableEvaluatorCacheKey {
    readonly declarationId: string;
    readonly entryKind: DependencyAwareEvaluatorCacheEntryKind;
    readonly flags: number | undefined;
}

export interface DependencyAwareEvaluatorCacheEntry<TPayload = never> {
    readonly key: StableEvaluatorCacheKey;
    readonly dependencyFingerprint: DependencyAwareEvaluatorFingerprint;
    readonly evaluatorGeneration: number;
    readonly payload?: TPayload | undefined;
}

export interface DependencyAwareEvaluatorCacheValidationResult<TPayload = never> {
    readonly isValid: boolean;
    readonly reason: DependencyAwareEvaluatorCacheValidationReason;
    readonly entry?: DependencyAwareEvaluatorCacheEntry<TPayload> | undefined;
}

export interface DependencyAwareEvaluatorCacheStats {
    readonly entryCount: number;
    readonly storeCount: number;
    readonly rejectedStoreCount: number;
    readonly validationCount: number;
    readonly validationHitCount: number;
    readonly validationMissCount: number;
    readonly evictionCount: number;
}

export function createDependencyAwareEvaluatorFingerprint(args: {
    readonly stableDeclarationId: string | undefined;
    readonly stableDeclarationFingerprint: string | undefined;
    readonly moduleExportSummary?: ModuleExportSummary | undefined;
    readonly localFileContentsVersion?: number | undefined;
    readonly localSemanticVersion?: number | undefined;
    readonly epochs: DependencyAwareEvaluatorCacheEpochs;
    readonly libraryStubSummary?: LibraryStubSummary | undefined;
    readonly dependentModules?: readonly DependencyAwareEvaluatorModuleDependency[] | undefined;
}): DependencyAwareEvaluatorFingerprint {
    const dependentModuleFingerprints = [...(args.dependentModules ?? [])].sort((left, right) =>
        left.uri.localeCompare(right.uri)
    );
    const libraryResourceKeyFingerprint = args.libraryStubSummary
        ? getLibraryResourceKeyFingerprint(args.libraryStubSummary.key)
        : undefined;

    const fingerprintParts = [
        args.stableDeclarationId ?? '',
        args.stableDeclarationFingerprint ?? '',
        args.moduleExportSummary?.fingerprint ?? '',
        args.moduleExportSummary?.importFingerprint ?? '',
        args.moduleExportSummary?.declarationFingerprint ?? '',
        args.localFileContentsVersion?.toString() ?? '',
        args.localSemanticVersion?.toString() ?? '',
        args.epochs.builtinsEpoch.toString(),
        args.epochs.configEpoch.toString(),
        args.epochs.importResolverEpoch.toString(),
        args.epochs.typeshedEpoch.toString(),
        args.epochs.librarySummaryConfigEpoch.toString(),
        args.epochs.partialStubEpoch.toString(),
        libraryResourceKeyFingerprint ?? '',
        _getDependentModuleFingerprint(dependentModuleFingerprints),
    ];

    return {
        stableDeclarationId: args.stableDeclarationId,
        stableDeclarationFingerprint: args.stableDeclarationFingerprint,
        moduleExportFingerprint: args.moduleExportSummary?.fingerprint,
        moduleImportFingerprint: args.moduleExportSummary?.importFingerprint,
        moduleDeclarationFingerprint: args.moduleExportSummary?.declarationFingerprint,
        localFileContentsVersion: args.localFileContentsVersion,
        localSemanticVersion: args.localSemanticVersion,
        builtinsEpoch: args.epochs.builtinsEpoch,
        configEpoch: args.epochs.configEpoch,
        importResolverEpoch: args.epochs.importResolverEpoch,
        typeshedEpoch: args.epochs.typeshedEpoch,
        librarySummaryConfigEpoch: args.epochs.librarySummaryConfigEpoch,
        partialStubEpoch: args.epochs.partialStubEpoch,
        libraryResourceKeyFingerprint,
        dependentModuleFingerprints,
        fingerprint: _hashParts(fingerprintParts),
    };
}

export function createStableEvaluatorCacheKeyString(key: StableEvaluatorCacheKey): string {
    return [key.entryKind, key.declarationId, key.flags?.toString() ?? ''].join('|');
}

export function validateDependencyAwareEvaluatorFingerprint(
    cached: DependencyAwareEvaluatorFingerprint,
    current: DependencyAwareEvaluatorFingerprint
): DependencyAwareEvaluatorCacheValidationReason {
    if (!cached.stableDeclarationId || !cached.stableDeclarationFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.UnstableDeclaration;
    }

    if (!current.stableDeclarationId || !current.stableDeclarationFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.UnstableDeclaration;
    }

    if (cached.stableDeclarationId !== current.stableDeclarationId) {
        return DependencyAwareEvaluatorCacheValidationReason.StableDeclarationIdChanged;
    }

    if (cached.stableDeclarationFingerprint !== current.stableDeclarationFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.StableDeclarationFingerprintChanged;
    }

    if (cached.moduleImportFingerprint !== current.moduleImportFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.ModuleImportFingerprintChanged;
    }

    if (cached.moduleDeclarationFingerprint !== current.moduleDeclarationFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.ModuleDeclarationFingerprintChanged;
    }

    if (cached.moduleExportFingerprint !== current.moduleExportFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.ModuleExportFingerprintChanged;
    }

    if (cached.localFileContentsVersion !== current.localFileContentsVersion) {
        return DependencyAwareEvaluatorCacheValidationReason.LocalFileContentsVersionChanged;
    }

    if (cached.localSemanticVersion !== current.localSemanticVersion) {
        return DependencyAwareEvaluatorCacheValidationReason.LocalSemanticVersionChanged;
    }

    if (cached.builtinsEpoch !== current.builtinsEpoch) {
        return DependencyAwareEvaluatorCacheValidationReason.BuiltinsEpochChanged;
    }

    if (cached.configEpoch !== current.configEpoch) {
        return DependencyAwareEvaluatorCacheValidationReason.ConfigEpochChanged;
    }

    if (cached.importResolverEpoch !== current.importResolverEpoch) {
        return DependencyAwareEvaluatorCacheValidationReason.ImportResolverEpochChanged;
    }

    if (
        cached.typeshedEpoch !== current.typeshedEpoch ||
        cached.librarySummaryConfigEpoch !== current.librarySummaryConfigEpoch ||
        cached.partialStubEpoch !== current.partialStubEpoch
    ) {
        return DependencyAwareEvaluatorCacheValidationReason.LibrarySummaryEpochChanged;
    }

    if (cached.libraryResourceKeyFingerprint !== current.libraryResourceKeyFingerprint) {
        return DependencyAwareEvaluatorCacheValidationReason.LibraryResourceKeyChanged;
    }

    if (
        _getDependentModuleFingerprint(cached.dependentModuleFingerprints) !==
        _getDependentModuleFingerprint(current.dependentModuleFingerprints)
    ) {
        return DependencyAwareEvaluatorCacheValidationReason.DependentModuleFingerprintChanged;
    }

    return DependencyAwareEvaluatorCacheValidationReason.Valid;
}

export function getLibraryResourceKeyFingerprint(key: LibraryResourceKey): string {
    return _hashParts([
        key.uri,
        key.contentHash,
        key.pythonVersion,
        key.pythonPlatform,
        key.pyTypedState,
        key.typeshedEpoch.toString(),
        key.configEpoch.toString(),
        key.partialStubEpoch.toString(),
        key.kind,
    ]);
}

export class DependencyAwareEvaluatorCache<TPayload = never> {
    private readonly _entries = new Map<string, DependencyAwareEvaluatorCacheEntry<TPayload>>();
    private _storeCount = 0;
    private _rejectedStoreCount = 0;
    private _validationCount = 0;
    private _validationHitCount = 0;
    private _validationMissCount = 0;
    private _evictionCount = 0;

    set(entry: DependencyAwareEvaluatorCacheEntry<TPayload>): boolean {
        const validationReason = validateDependencyAwareEvaluatorFingerprint(
            entry.dependencyFingerprint,
            entry.dependencyFingerprint
        );
        if (validationReason !== DependencyAwareEvaluatorCacheValidationReason.Valid) {
            this._rejectedStoreCount++;
            return false;
        }

        this._entries.set(createStableEvaluatorCacheKeyString(entry.key), entry);
        this._storeCount++;
        return true;
    }

    get(
        key: StableEvaluatorCacheKey,
        currentDependencyFingerprint: DependencyAwareEvaluatorFingerprint
    ): DependencyAwareEvaluatorCacheValidationResult<TPayload> {
        const entry = this._entries.get(createStableEvaluatorCacheKeyString(key));
        if (!entry) {
            this._validationMissCount++;
            return {
                isValid: false,
                reason: DependencyAwareEvaluatorCacheValidationReason.MissingEntry,
            };
        }

        return this.validateEntry(entry, currentDependencyFingerprint);
    }

    validateEntry(
        entry: DependencyAwareEvaluatorCacheEntry<TPayload>,
        currentDependencyFingerprint: DependencyAwareEvaluatorFingerprint
    ): DependencyAwareEvaluatorCacheValidationResult<TPayload> {
        this._validationCount++;
        const reason = validateDependencyAwareEvaluatorFingerprint(
            entry.dependencyFingerprint,
            currentDependencyFingerprint
        );

        if (reason === DependencyAwareEvaluatorCacheValidationReason.Valid) {
            this._validationHitCount++;
            return { isValid: true, reason, entry };
        }

        this._validationMissCount++;
        return { isValid: false, reason, entry };
    }

    clear() {
        this._evictionCount += this._entries.size;
        this._entries.clear();
    }

    getStats(): DependencyAwareEvaluatorCacheStats {
        return {
            entryCount: this._entries.size,
            storeCount: this._storeCount,
            rejectedStoreCount: this._rejectedStoreCount,
            validationCount: this._validationCount,
            validationHitCount: this._validationHitCount,
            validationMissCount: this._validationMissCount,
            evictionCount: this._evictionCount,
        };
    }
}

function _getDependentModuleFingerprint(dependencies: readonly DependencyAwareEvaluatorModuleDependency[]): string {
    return _hashParts(
        dependencies.map((dependency) =>
            [
                dependency.uri,
                dependency.exportFingerprint ?? '',
                dependency.importFingerprint ?? '',
                dependency.declarationFingerprint ?? '',
                dependency.libraryResourceKeyFingerprint ?? '',
            ].join('|')
        )
    );
}

function _hashParts(parts: readonly string[]): string {
    return StringUtils.hashString(parts.join('\n')).toString();
}

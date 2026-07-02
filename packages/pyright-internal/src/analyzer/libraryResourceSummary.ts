/*
 * libraryResourceSummary.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Conservative keys and compact summaries for long-lived library resources.
 */

import { PythonVersion } from '../common/pythonVersion';
import { Uri } from '../common/uri/uri';
import { ModuleExportSummary } from './moduleExportSummary';

export type LibraryPyTypedState = 'present' | 'absent' | 'notApplicable';

export enum LibraryResourceKind {
    Typeshed = 'typeshed',
    ThirdPartyPackage = 'thirdPartyPackage',
    Stub = 'stub',
}

export interface LibraryResourceKey {
    readonly uri: string;
    readonly contentHash: string;
    readonly pythonVersion: string;
    readonly pythonPlatform: string;
    readonly pyTypedState: LibraryPyTypedState;
    readonly typeshedEpoch: number;
    readonly configEpoch: number;
    readonly partialStubEpoch: number;
    readonly kind: LibraryResourceKind;
}

export interface LibraryStubSummary {
    readonly key: LibraryResourceKey;
    readonly moduleExportSummary: ModuleExportSummary;
}

export function createLibraryResourceKey(args: {
    uri: Uri;
    contentHash: number | undefined;
    pythonVersion: PythonVersion;
    pythonPlatform: string | undefined;
    pyTypedState: LibraryPyTypedState;
    typeshedEpoch: number;
    configEpoch: number;
    partialStubEpoch: number;
    kind: LibraryResourceKind;
}): LibraryResourceKey | undefined {
    if (args.contentHash === undefined) {
        return undefined;
    }

    return {
        uri: args.uri.toString(),
        contentHash: args.contentHash.toString(),
        pythonVersion: PythonVersion.toString(args.pythonVersion),
        pythonPlatform: args.pythonPlatform ?? '',
        pyTypedState: args.pyTypedState,
        typeshedEpoch: args.typeshedEpoch,
        configEpoch: args.configEpoch,
        partialStubEpoch: args.partialStubEpoch,
        kind: args.kind,
    };
}

export function createLibraryStubSummary(
    key: LibraryResourceKey,
    moduleExportSummary: ModuleExportSummary
): LibraryStubSummary {
    return { key, moduleExportSummary };
}

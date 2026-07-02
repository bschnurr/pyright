/*
 * editInvalidationClassifier.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Conservatively classifies source edits for future incremental invalidation.
 */

import { TextRange } from '../common/textRange';

export interface ChangedRange {
    range: TextRange;
    delta: number;
}

export enum InvalidationKind {
    NoChange = 'NoChange',
    TriviaOnly = 'TriviaOnly',
    TokenOnly = 'TokenOnly',
    SyntaxOnly = 'SyntaxOnly',
    LocalBodyOnly = 'LocalBodyOnly',
    LocalDeclarationShape = 'LocalDeclarationShape',
    ModuleImportSurface = 'ModuleImportSurface',
    ModuleExportSurface = 'ModuleExportSurface',
    BuiltinsOrConfig = 'BuiltinsOrConfig',
}

export interface EditInvalidationInput {
    oldText: string;
    newText: string;
    changedRange?: ChangedRange | undefined;
}

export function classifyEditInvalidation(input: EditInvalidationInput): InvalidationKind {
    if (input.oldText === input.newText) {
        return InvalidationKind.NoChange;
    }

    if (input.changedRange && !_isChangedRangePlausible(input)) {
        return InvalidationKind.ModuleExportSurface;
    }

    // Keep the initial scaffold conservative. Whitespace and comments can carry
    // pyright/type-ignore directives, so do not classify them as trivia-only yet.
    return InvalidationKind.ModuleExportSurface;
}

function _isChangedRangePlausible(input: EditInvalidationInput) {
    const changedRange = input.changedRange;
    if (!changedRange) {
        return true;
    }

    const oldEnd = changedRange.range.start + changedRange.range.length;
    const newEnd = oldEnd + changedRange.delta;

    return (
        changedRange.range.start <= input.oldText.length &&
        oldEnd <= input.oldText.length &&
        newEnd >= changedRange.range.start &&
        input.newText.length === input.oldText.length + changedRange.delta
    );
}

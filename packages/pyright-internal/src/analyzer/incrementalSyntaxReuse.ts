/*
 * incrementalSyntaxReuse.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Conservative syntax-reuse decision scaffolding.
 */

import { InvalidationKind, classifyEditInvalidation } from './editInvalidationClassifier';
import type { ChangedRange } from './editInvalidationClassifier';

export interface IncrementalSyntaxReuseInput {
    oldText?: string | undefined;
    newText: string;
    changedRange?: ChangedRange | undefined;
    contentsChangedByHash: boolean;
}

export interface IncrementalSyntaxReuseDecision {
    invalidationKind: InvalidationKind;
    preserveSyntax: boolean;
}

export function getIncrementalSyntaxReuseDecision(input: IncrementalSyntaxReuseInput): IncrementalSyntaxReuseDecision {
    let invalidationKind: InvalidationKind;
    if (input.oldText !== undefined) {
        invalidationKind = classifyEditInvalidation({
            oldText: input.oldText,
            newText: input.newText,
            changedRange: input.changedRange,
        });
    } else {
        invalidationKind = input.contentsChangedByHash
            ? InvalidationKind.ModuleExportSurface
            : InvalidationKind.NoChange;
    }

    // Comments and whitespace can carry pyright/type-ignore directives. Until the
    // classifier proves trivia-only edits preserve directive semantics, reuse only
    // exact no-change syntax.
    return {
        invalidationKind,
        preserveSyntax: invalidationKind === InvalidationKind.NoChange,
    };
}

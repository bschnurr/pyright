/*
 * diagnostics.ts
 *
 * This module contains TypeEvaluator-specific diagnostic plumbing that was
 * historically embedded in the massive `typeEvaluator.ts` closure.
 *
 * Important design notes:
 * - Diagnostics can be suppressed for a subtree (see `suppressDiagnostics`).
 *   This is used both for speculative evaluation and for "probe" evaluations
 *   where the caller wants to capture messages rather than emit them.
 * - The implementation intentionally avoids importing `typeEvaluator.ts` to
 *   prevent dependency cycles. It accepts a small context object instead.
 * - Reachability matters: in unreachable code, many diagnostics are skipped to
 *   reduce noise. The caller provides `isNodeReachable` so this module doesn't
 *   take a dependency on the code flow engine.
 */

import { DiagnosticLevel } from '../../common/configOptions';
import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { TextRange } from '../../common/textRange';
import { LocMessage } from '../../localization/localize';
import { ParseNode } from '../../parser/parseNodes';

import { AnalyzerFileInfo } from '../analyzerFileInfo';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { getFunctionInfoFromDecorators } from '../decorators';
import * as ParseTreeUtils from '../parseTreeUtils';
import { Reachability, TypeEvaluator } from '../typeEvaluatorTypes';
import { FunctionTypeFlags } from '../types';

export interface SuppressedNodeStackEntry {
    node: ParseNode;
    suppressedDiags: string[] | undefined;
}

export interface DiagnosticsContext {
    suppressedNodeStack: SuppressedNodeStackEntry[];

    // Speculative evaluation implicitly suppresses diagnostics. The concrete
    // implementation is `SpeculativeTypeTracker` in `typeCacheUtils.ts`.
    isSpeculative: (node: ParseNode, ignoreIfDiagnosticsAllowed: boolean) => boolean;

    // Used to suppress certain diagnostics for unreachable code.
    isNodeReachable: (node: ParseNode) => boolean;

    // Used by `addDiagnostic` to honor `@no_type_check` decorators.
    getEvaluatorInterface: () => TypeEvaluator;
}

export function addInformation(
    ctx: DiagnosticsContext,
    message: string,
    node: ParseNode,
    range?: TextRange
): Diagnostic | undefined {
    return addDiagnosticWithSuppressionCheck(ctx, 'information', message, node, range);
}

export function addUnreachableCode(
    ctx: DiagnosticsContext,
    node: ParseNode,
    reachability: Reachability,
    textRange: TextRange
) {
    if (reachability === Reachability.Reachable) {
        return;
    }

    if (!isDiagnosticSuppressedForNode(ctx, node)) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        const reportTypeReachability = fileInfo.diagnosticRuleSet.enableReachabilityAnalysis;

        if (
            reachability === Reachability.UnreachableStructural ||
            reachability === Reachability.UnreachableStaticCondition ||
            reportTypeReachability
        ) {
            fileInfo.diagnosticSink.addUnreachableCodeWithTextRange(
                reachability === Reachability.UnreachableStructural
                    ? LocMessage.unreachableCodeStructure()
                    : reachability === Reachability.UnreachableStaticCondition
                    ? LocMessage.unreachableCodeCondition()
                    : LocMessage.unreachableCodeType(),
                textRange
            );
        }
    }
}

export function addDeprecated(ctx: DiagnosticsContext, message: string, node: ParseNode) {
    if (!isDiagnosticSuppressedForNode(ctx, node)) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        fileInfo.diagnosticSink.addDeprecatedWithTextRange(message, node);
    }
}

export function addDiagnosticWithSuppressionCheck(
    ctx: DiagnosticsContext,
    diagLevel: DiagnosticLevel,
    message: string,
    node: ParseNode,
    range?: TextRange
): Diagnostic | undefined {
    if (isDiagnosticSuppressedForNode(ctx, node)) {
        // If the caller requested suppression *and* collection, record the message.
        //
        // Conceptually:
        // 1. Find the nearest suppressed region that contains the node.
        // 2. If that region is collecting, append the message.
        const suppressionEntry = ctx.suppressedNodeStack.find(
            (suppressedNode) =>
                ParseTreeUtils.isNodeContainedWithin(node, suppressedNode.node) && suppressedNode.suppressedDiags
        );
        suppressionEntry?.suppressedDiags?.push(message);

        return undefined;
    }

    // Skip diagnostics in unreachable code to avoid spurious cascades.
    if (ctx.isNodeReachable(node)) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        return fileInfo.diagnosticSink.addDiagnosticWithTextRange(diagLevel, message, range ?? node);
    }

    return undefined;
}

export function isDiagnosticSuppressedForNode(ctx: DiagnosticsContext, node: ParseNode) {
    // Speculative evaluation suppresses diagnostics unconditionally.
    if (ctx.isSpeculative(node, /* ignoreIfDiagnosticsAllowed */ true)) {
        return true;
    }

    // Otherwise, suppression is purely structural (node containment).
    return ctx.suppressedNodeStack.some((suppressedNode) =>
        ParseTreeUtils.isNodeContainedWithin(node, suppressedNode.node)
    );
}

// Similar to `isDiagnosticSuppressedForNode`, but returns false if the caller requested
// that diagnostics be generated anyway (i.e. suppression entries that *collect*).
export function canSkipDiagnosticForNode(ctx: DiagnosticsContext, node: ParseNode) {
    if (ctx.isSpeculative(node, /* ignoreIfDiagnosticsAllowed */ true)) {
        return true;
    }

    const suppressedEntries = ctx.suppressedNodeStack.filter((suppressedNode) =>
        ParseTreeUtils.isNodeContainedWithin(node, suppressedNode.node)
    );

    if (suppressedEntries.length === 0) {
        return false;
    }

    return suppressedEntries.every((entry) => !entry.suppressedDiags);
}

export function addDiagnostic(
    ctx: DiagnosticsContext,
    rule: DiagnosticRule,
    message: string,
    node: ParseNode,
    range?: TextRange
): Diagnostic | undefined {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    const diagLevel = fileInfo.diagnosticRuleSet[rule] as DiagnosticLevel;

    if (diagLevel === 'none') {
        return undefined;
    }

    const containingFunction = ParseTreeUtils.getEnclosingFunction(node);

    if (containingFunction) {
        // Suppress diagnostics within unannotated functions if configured.
        if (!fileInfo.diagnosticRuleSet.analyzeUnannotatedFunctions) {
            if (
                ParseTreeUtils.isUnannotatedFunction(containingFunction) &&
                ParseTreeUtils.isNodeContainedWithin(node, containingFunction.d.suite)
            ) {
                return undefined;
            }
        }

        // Suppress diagnostics within `@no_type_check` functions.
        const containingClassNode = ParseTreeUtils.getEnclosingClass(containingFunction, /* stopAtFunction */ true);
        const functionInfo = getFunctionInfoFromDecorators(
            ctx.getEvaluatorInterface(),
            containingFunction,
            !!containingClassNode
        );

        if ((functionInfo.flags & FunctionTypeFlags.NoTypeCheck) !== 0) {
            return undefined;
        }
    }

    const diagnostic = addDiagnosticWithSuppressionCheck(ctx, diagLevel, message, node, range);
    if (diagnostic) {
        diagnostic.setRule(rule);
    }

    return diagnostic;
}

export function addDiagnosticForTextRange(
    fileInfo: AnalyzerFileInfo,
    rule: DiagnosticRule,
    message: string,
    range: TextRange
): Diagnostic | undefined {
    const diagLevel = fileInfo.diagnosticRuleSet[rule] as DiagnosticLevel;

    if (diagLevel === 'none') {
        return undefined;
    }

    const diagnostic = fileInfo.diagnosticSink.addDiagnosticWithTextRange(diagLevel, message, range);
    if (rule) {
        diagnostic.setRule(rule);
    }

    return diagnostic;
}

// Disables recording of errors and warnings.
//
// In concept, suppression is stack-based:
// - A node suppression entry indicates a subtree for which diagnostics should be skipped.
// - Optionally, the caller can request collection; collected messages are returned
//   to the callback so it can decide what to do (e.g. display a single summary error).
export function suppressDiagnostics<T>(
    ctx: DiagnosticsContext,
    node: ParseNode,
    callback: () => T,
    diagCallback?: (suppressedDiags: string[]) => void
) {
    ctx.suppressedNodeStack.push({ node, suppressedDiags: diagCallback ? [] : undefined });

    try {
        const result = callback();
        const poppedNode = ctx.suppressedNodeStack.pop();
        if (diagCallback && poppedNode?.suppressedDiags) {
            diagCallback(poppedNode.suppressedDiags);
        }
        return result;
    } catch (e) {
        // We don't use finally here because the TypeScript debugger doesn't
        // handle finally well when single stepping.
        ctx.suppressedNodeStack.pop();
        throw e;
    }
}

// Convenience helper used by callers that want a standard addendum format.
export function formatTypeViolationMessage(message: string, addendum?: DiagnosticAddendum) {
    return addendum ? message + addendum.getString() : message;
}

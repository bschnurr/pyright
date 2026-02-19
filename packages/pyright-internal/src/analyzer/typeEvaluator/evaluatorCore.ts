/*
 * evaluatorCore.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Small extraction helpers for type evaluator core behavior.
 */

import { ExpressionNode, ImportFromAsNode, NameNode, ParseNode, ParseNodeType } from '../../parser/parseNodes';
import { KeywordType, OperatorType } from '../../parser/tokenizerTypes';
import { TextRange } from '../../common/textRange';
import { TextRangeCollection } from '../../common/textRangeCollection';
import { convertOffsetsToRange } from '../../common/positionUtils';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { Declaration, DeclarationType } from '../declaration';

export interface ReturnTypeInferenceContextFrame {
    functionNode: ParseNode;
    codeFlowAnalyzer?: unknown;
}

export interface SymbolResolutionStackEntryLike {
    symbolId: number;
    declaration: unknown;
}

export interface MutableSymbolResolutionStackEntryLike extends SymbolResolutionStackEntryLike {
    isResultValid: boolean;
    partialType?: unknown;
}

export function isNodeInReturnTypeInferenceContext(
    node: ParseNode,
    returnTypeInferenceContextStack: readonly ReturnTypeInferenceContextFrame[]
) {
    const stackSize = returnTypeInferenceContextStack.length;
    if (stackSize === 0) {
        return false;
    }

    const contextNode = returnTypeInferenceContextStack[stackSize - 1];

    let curNode: ParseNode | undefined = node;
    while (curNode) {
        if (curNode === contextNode.functionNode) {
            return true;
        }
        curNode = curNode.parent;
    }

    return false;
}

export function isFunctionNodeInReturnTypeInferenceContext(
    functionNode: ParseNode,
    returnTypeInferenceContextStack: readonly ReturnTypeInferenceContextFrame[]
) {
    return returnTypeInferenceContextStack.some((context) => context.functionNode === functionNode);
}

export function hasReachedReturnTypeInferenceStackLimit(
    returnTypeInferenceContextStack: readonly ReturnTypeInferenceContextFrame[],
    maxReturnTypeInferenceStackSize: number
) {
    return returnTypeInferenceContextStack.length >= maxReturnTypeInferenceStackSize;
}

export function getTopReturnTypeInferenceContextFrame<T extends ReturnTypeInferenceContextFrame>(
    returnTypeInferenceContextStack: readonly T[]
) {
    const stackSize = returnTypeInferenceContextStack.length;
    if (stackSize === 0) {
        return undefined;
    }

    return returnTypeInferenceContextStack[stackSize - 1];
}

export function pushReturnTypeInferenceContextFrame<T extends ReturnTypeInferenceContextFrame>(
    returnTypeInferenceContextStack: T[],
    frame: T
) {
    returnTypeInferenceContextStack.push(frame);
}

export function createReturnTypeInferenceContextFrame(
    functionNode: ParseNode,
    codeFlowAnalyzer: unknown
): ReturnTypeInferenceContextFrame {
    return {
        functionNode,
        codeFlowAnalyzer,
    };
}

export function popReturnTypeInferenceContextFrame<T extends ReturnTypeInferenceContextFrame>(
    returnTypeInferenceContextStack: T[]
) {
    return returnTypeInferenceContextStack.pop();
}

export function runWithReturnTypeInferenceContextFrame<T extends ReturnTypeInferenceContextFrame, TResult>(
    returnTypeInferenceContextStack: T[],
    frame: T,
    callback: () => TResult
) {
    pushReturnTypeInferenceContextFrame(returnTypeInferenceContextStack, frame);
    try {
        return callback();
    } finally {
        popReturnTypeInferenceContextFrame(returnTypeInferenceContextStack);
    }
}

export function getSymbolResolutionIndex(
    symbolResolutionStack: readonly SymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown
) {
    return symbolResolutionStack.findIndex((entry) => entry.symbolId === symbolId && entry.declaration === declaration);
}

export function tryPushSymbolResolutionEntry(
    symbolResolutionStack: MutableSymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown
) {
    const index = getSymbolResolutionIndex(symbolResolutionStack, symbolId, declaration);
    if (index >= 0) {
        for (let i = index + 1; i < symbolResolutionStack.length; i++) {
            symbolResolutionStack[i].isResultValid = false;
        }
        return false;
    }

    symbolResolutionStack.push({
        symbolId,
        declaration,
        isResultValid: true,
    });
    return true;
}

export function popSymbolResolutionEntry<T extends MutableSymbolResolutionStackEntryLike>(symbolResolutionStack: T[]) {
    return symbolResolutionStack.pop();
}

export function setSymbolResolutionPartialType(
    symbolResolutionStack: MutableSymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown,
    partialType: unknown
) {
    const index = getSymbolResolutionIndex(symbolResolutionStack, symbolId, declaration);
    if (index >= 0) {
        symbolResolutionStack[index].partialType = partialType;
    }
}

export function getSymbolResolutionPartialType(
    symbolResolutionStack: readonly MutableSymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown
): unknown | undefined {
    const index = getSymbolResolutionIndex(symbolResolutionStack, symbolId, declaration);
    if (index >= 0) {
        return symbolResolutionStack[index].partialType;
    }

    return undefined;
}

export function getLineNumForNode(node: ParseNode) {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    const range = convertOffsetsToRange(node.start, node.start + node.length, fileInfo.lines);
    return (range.start.line + 1).toString();
}

export function getAliasFromImportNode(node: NameNode): NameNode | undefined {
    if (
        node.parent &&
        node.parent.nodeType === ParseNodeType.ImportFromAs &&
        node.parent.d.alias &&
        node === node.parent.d.name
    ) {
        return node.parent.d.alias;
    }
    return undefined;
}

export function isTypeFormSupportedForNode(node: ParseNode) {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    return fileInfo.diagnosticRuleSet.enableExperimentalFeatures;
}

export function isFinalVariableDecl(decl: Declaration): boolean {
    return decl.type === DeclarationType.Variable && !!decl.isFinal;
}

export function includesVariableTypeDeclCheck(decls: Declaration[]): boolean {
    return decls.some((decl) => {
        if (decl.type === DeclarationType.Variable) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(decl.node);
            if (!fileInfo.isTypingStubFile && !fileInfo.isTypingExtensionsStubFile) {
                return true;
            }
        }

        if (decl.type === DeclarationType.Param) {
            return true;
        }

        return false;
    });
}

export function isLegalTypeAliasExprForm(node: ExpressionNode, allowStrLiteral: boolean): boolean {
    switch (node.nodeType) {
        case ParseNodeType.Error:
        case ParseNodeType.UnaryOperation:
        case ParseNodeType.AssignmentExpression:
        case ParseNodeType.TypeAnnotation:
        case ParseNodeType.Await:
        case ParseNodeType.Ternary:
        case ParseNodeType.Unpack:
        case ParseNodeType.Tuple:
        case ParseNodeType.Call:
        case ParseNodeType.Comprehension:
        case ParseNodeType.Slice:
        case ParseNodeType.Yield:
        case ParseNodeType.YieldFrom:
        case ParseNodeType.Lambda:
        case ParseNodeType.Number:
        case ParseNodeType.Dictionary:
        case ParseNodeType.List:
        case ParseNodeType.Set:
            return false;

        case ParseNodeType.StringList:
        case ParseNodeType.String:
            return allowStrLiteral;

        case ParseNodeType.Constant:
            return node.d.constType === KeywordType.None;

        case ParseNodeType.BinaryOperation:
            return (
                node.d.operator === OperatorType.BitwiseOr &&
                isLegalTypeAliasExprForm(node.d.leftExpr, /* allowStrLiteral */ true) &&
                isLegalTypeAliasExprForm(node.d.rightExpr, /* allowStrLiteral */ true)
            );

        case ParseNodeType.Index:
            return isLegalTypeAliasExprForm(node.d.leftExpr, allowStrLiteral);

        case ParseNodeType.MemberAccess:
            return isLegalTypeAliasExprForm(node.d.leftExpr, allowStrLiteral);
    }

    return true;
}

export function isPossibleTypeAliasDeclCheck(decl: Declaration): boolean {
    if (decl.type !== DeclarationType.Variable || !decl.typeAliasName || decl.typeAnnotationNode) {
        return false;
    }

    if (decl.node.parent?.nodeType !== ParseNodeType.Assignment) {
        return false;
    }

    return isLegalTypeAliasExprForm(decl.node.parent.d.rightExpr, /* allowStrLiteral */ false);
}

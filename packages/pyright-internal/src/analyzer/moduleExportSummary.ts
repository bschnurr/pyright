/*
 * moduleExportSummary.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Compact, conservative fingerprints for a module's import/export surface.
 */

import * as StringUtils from '../common/stringUtils';
import {
    AssignmentNode,
    AugmentedAssignmentNode,
    ClassNode,
    ExpressionNode,
    FunctionNode,
    ImportFromNode,
    ImportNode,
    ListNode,
    ParseNode,
    ParseNodeType,
    StatementListNode,
    StatementNode,
    TupleNode,
    TypeAnnotationNode,
} from '../parser/parseNodes';
import type { ParserOutput } from '../parser/parser';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { createStableDeclarationSummary } from './stableDeclarationId';

export interface ModuleExportSummary {
    readonly importFingerprint: string;
    readonly declarationFingerprint: string;
    readonly declarationIdentityFingerprint: string;
    readonly hasUnstableDeclarationIds: boolean;
    readonly exportFingerprint: string;
    readonly dunderAllFingerprint: string;
    readonly fingerprint: string;
    readonly isReliable: boolean;
}

export function createModuleExportSummary(
    parserOutput: ParserOutput,
    text: string,
    fileIdentity: string
): ModuleExportSummary {
    const importParts: string[] = [];
    const declarationParts: string[] = [];
    const exportParts: string[] = [];
    let isReliable = true;

    for (const statement of parserOutput.parseTree.d.statements) {
        if (!_appendStatementSurface(statement, text, importParts, declarationParts, exportParts)) {
            isReliable = false;
        }
    }

    const dunderAllInfo = AnalyzerNodeInfo.getDunderAllInfo(parserOutput.parseTree);
    if (dunderAllInfo?.usesUnsupportedDunderAllForm) {
        isReliable = false;
    }

    const dunderAllFingerprint = _hashParts(dunderAllInfo?.names ?? []);
    const importFingerprint = _hashParts(importParts);
    const declarationFingerprint = _hashParts(declarationParts);
    const declarationIdentitySummary = createStableDeclarationSummary(parserOutput.parseTree, text, fileIdentity);
    const exportFingerprint = _hashParts(exportParts);
    const reliability = isReliable ? 'reliable' : 'unreliable';
    const fingerprint = _hashParts([
        reliability,
        importFingerprint,
        declarationFingerprint,
        exportFingerprint,
        dunderAllFingerprint,
    ]);

    return {
        importFingerprint,
        declarationFingerprint,
        declarationIdentityFingerprint: declarationIdentitySummary.fingerprint,
        hasUnstableDeclarationIds: !declarationIdentitySummary.isReliable,
        exportFingerprint,
        dunderAllFingerprint,
        fingerprint,
        isReliable,
    };
}

export function areModuleExportSummariesEqual(left: ModuleExportSummary, right: ModuleExportSummary): boolean {
    return left.fingerprint === right.fingerprint;
}

export function areModuleDeclarationShapesEqual(left: ModuleExportSummary, right: ModuleExportSummary): boolean {
    return (
        left.declarationFingerprint === right.declarationFingerprint &&
        left.importFingerprint === right.importFingerprint
    );
}

function _appendStatementSurface(
    node: StatementNode,
    text: string,
    importParts: string[],
    declarationParts: string[],
    exportParts: string[]
): boolean {
    switch (node.nodeType) {
        case ParseNodeType.Function:
            return _appendFunctionSurface(node, text, declarationParts, exportParts);

        case ParseNodeType.Class:
            return _appendClassSurface(node, text, importParts, declarationParts, exportParts);

        case ParseNodeType.TypeAlias:
            _appendPart(declarationParts, exportParts, `type:${node.d.name.d.value}:${_getText(text, node)}`);
            return true;

        case ParseNodeType.StatementList:
            return _appendStatementListSurface(node, text, importParts, declarationParts, exportParts);

        case ParseNodeType.If:
        case ParseNodeType.Try:
        case ParseNodeType.For:
        case ParseNodeType.While:
        case ParseNodeType.With:
        case ParseNodeType.Match:
            return false;

        default:
            return false;
    }
}

function _appendStatementListSurface(
    node: StatementListNode,
    text: string,
    importParts: string[],
    declarationParts: string[],
    exportParts: string[]
): boolean {
    let isReliable = true;

    for (const statement of node.d.statements) {
        switch (statement.nodeType) {
            case ParseNodeType.Import:
                _appendImportSurface(statement, text, importParts, declarationParts, exportParts);
                break;

            case ParseNodeType.ImportFrom:
                _appendImportFromSurface(statement, text, importParts, declarationParts, exportParts);
                break;

            case ParseNodeType.Assignment:
                if (!_appendAssignmentSurface(statement, text, declarationParts, exportParts)) {
                    isReliable = false;
                }
                break;

            case ParseNodeType.TypeAnnotation:
                if (!_appendTypeAnnotationSurface(statement, text, declarationParts, exportParts)) {
                    isReliable = false;
                }
                break;

            case ParseNodeType.AugmentedAssignment:
                if (!_appendAugmentedAssignmentSurface(statement, text, declarationParts, exportParts)) {
                    isReliable = false;
                }
                break;

            case ParseNodeType.StringList:
            case ParseNodeType.Pass:
                break;

            default:
                isReliable = false;
        }
    }

    return isReliable;
}

function _appendFunctionSurface(
    node: FunctionNode,
    text: string,
    declarationParts: string[],
    exportParts: string[]
): boolean {
    _appendPart(
        declarationParts,
        exportParts,
        `func:${node.d.name.d.value}:${_getHeaderText(text, node, node.d.suite)}`
    );
    return node.d.returnAnnotation !== undefined || node.d.funcAnnotationComment !== undefined;
}

function _appendClassSurface(
    node: ClassNode,
    text: string,
    importParts: string[],
    declarationParts: string[],
    exportParts: string[]
): boolean {
    _appendPart(
        declarationParts,
        exportParts,
        `class:${node.d.name.d.value}:${_getHeaderText(text, node, node.d.suite)}`
    );

    let isReliable = true;
    for (const statement of node.d.suite.d.statements) {
        if (!_appendStatementSurface(statement, text, importParts, declarationParts, exportParts)) {
            isReliable = false;
        }
    }

    return isReliable;
}

function _appendImportSurface(
    node: ImportNode,
    text: string,
    importParts: string[],
    declarationParts: string[],
    exportParts: string[]
) {
    const statementText = _getText(text, node);
    importParts.push(`import:${statementText}`);
    _appendPart(declarationParts, exportParts, `import:${statementText}`);
}

function _appendImportFromSurface(
    node: ImportFromNode,
    text: string,
    importParts: string[],
    declarationParts: string[],
    exportParts: string[]
) {
    const statementText = _getText(text, node);
    importParts.push(`from:${statementText}`);
    _appendPart(declarationParts, exportParts, `from:${statementText}`);
}

function _appendAssignmentSurface(
    node: AssignmentNode,
    text: string,
    declarationParts: string[],
    exportParts: string[]
): boolean {
    const names = _getTargetNames(node.d.leftExpr);
    if (!names) {
        return false;
    }

    const statementText = _getText(text, node);
    for (const name of names) {
        declarationParts.push(`assign:${name}`);
        exportParts.push(`assign:${name}:${statementText}`);
    }

    return true;
}

function _appendTypeAnnotationSurface(
    node: TypeAnnotationNode,
    text: string,
    declarationParts: string[],
    exportParts: string[]
): boolean {
    const names = _getTargetNames(node.d.valueExpr);
    if (!names) {
        return false;
    }

    const statementText = _getText(text, node);
    for (const name of names) {
        declarationParts.push(`ann:${name}:${statementText}`);
        exportParts.push(`ann:${name}:${statementText}`);
    }

    return true;
}

function _appendAugmentedAssignmentSurface(
    node: AugmentedAssignmentNode,
    text: string,
    declarationParts: string[],
    exportParts: string[]
): boolean {
    const names = _getTargetNames(node.d.leftExpr);
    if (!names || names.some((name) => name === '__all__')) {
        return false;
    }

    const statementText = _getText(text, node);
    for (const name of names) {
        declarationParts.push(`augassign:${name}`);
        exportParts.push(`augassign:${name}:${statementText}`);
    }

    return true;
}

function _getTargetNames(node: ExpressionNode): string[] | undefined {
    switch (node.nodeType) {
        case ParseNodeType.Name:
            return [node.d.value];

        case ParseNodeType.TypeAnnotation:
            return _getTargetNames(node.d.valueExpr);

        case ParseNodeType.Tuple:
        case ParseNodeType.List:
            return _getSequenceTargetNames(node);

        case ParseNodeType.Unpack:
            return _getTargetNames(node.d.expr);

        default:
            return undefined;
    }
}

function _getSequenceTargetNames(node: TupleNode | ListNode): string[] | undefined {
    const names: string[] = [];

    for (const item of node.d.items) {
        const itemNames = _getTargetNames(item);
        if (!itemNames) {
            return undefined;
        }
        names.push(...itemNames);
    }

    return names;
}

function _getHeaderText(text: string, node: FunctionNode | ClassNode, suite: ParseNode): string {
    return text.substring(node.start, Math.max(node.start, suite.start));
}

function _getText(text: string, node: ParseNode): string {
    return text.substring(node.start, node.start + node.length);
}

function _appendPart(declarationParts: string[], exportParts: string[], part: string) {
    declarationParts.push(part);
    exportParts.push(part);
}

function _hashParts(parts: readonly string[]): string {
    return StringUtils.hashString(parts.join('\n')).toString(16);
}

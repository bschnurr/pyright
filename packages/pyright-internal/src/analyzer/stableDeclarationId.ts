/*
 * stableDeclarationId.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Stable declaration identity scaffolding for resource lifetime analysis.
 */

import * as StringUtils from '../common/stringUtils';
import { TextRange } from '../common/textRange';
import {
    AssignmentNode,
    ClassNode,
    ExpressionNode,
    FunctionNode,
    ImportFromNode,
    ImportNode,
    ModuleNameNode,
    ModuleNode,
    ParseNode,
    ParseNodeType,
    StatementListNode,
    StatementNode,
    TypeAliasNode,
    TypeAnnotationNode,
} from '../parser/parseNodes';

const _stableDeclarationIdVersion = 1;

export const enum StableDeclarationIdInstabilityReason {
    DuplicateSymbolInScope = 'DuplicateSymbolInScope',
    IdCollision = 'IdCollision',
}

export interface StableDeclarationIdentity {
    readonly id: string | undefined;
    readonly fileIdentity: string;
    readonly symbolPath: readonly string[];
    readonly nodeKind: ParseNodeType;
    readonly ordinal: number | undefined;
    readonly declarationFingerprint: string;
    readonly range: TextRange;
    readonly isStable: boolean;
    readonly instabilityReason: StableDeclarationIdInstabilityReason | undefined;
}

export interface StableDeclarationSummary {
    readonly declarations: readonly StableDeclarationIdentity[];
    readonly fingerprint: string;
    readonly stableDeclarationCount: number;
    readonly unstableDeclarationCount: number;
    readonly isReliable: boolean;
}

interface MutableDeclarationIdentity extends StableDeclarationIdentity {
    id: string | undefined;
    isStable: boolean;
    instabilityReason: StableDeclarationIdInstabilityReason | undefined;
}

interface CollectContext {
    readonly fileIdentity: string;
    readonly text: string;
    readonly declarations: MutableDeclarationIdentity[];
    readonly declarationOrdinalMap: Map<string, number>;
    readonly declarationScopeMap: Map<string, MutableDeclarationIdentity[]>;
}

export function createStableDeclarationSummary(
    parseTree: ModuleNode,
    text: string,
    fileIdentity: string
): StableDeclarationSummary {
    const context: CollectContext = {
        fileIdentity,
        text,
        declarations: [],
        declarationOrdinalMap: new Map<string, number>(),
        declarationScopeMap: new Map<string, MutableDeclarationIdentity[]>(),
    };

    _collectStatementDeclarations(parseTree.d.statements, [], context);
    _markAmbiguousDeclarations(context);

    const idMap = new Map<string, MutableDeclarationIdentity[]>();
    for (const declaration of context.declarations) {
        if (!declaration.isStable) {
            continue;
        }

        declaration.id = _createDeclarationId(declaration);
        const declarationsForId = idMap.get(declaration.id);
        if (declarationsForId) {
            declarationsForId.push(declaration);
        } else {
            idMap.set(declaration.id, [declaration]);
        }
    }

    for (const declarationsForId of idMap.values()) {
        if (declarationsForId.length <= 1) {
            continue;
        }

        for (const declaration of declarationsForId) {
            declaration.id = undefined;
            declaration.isStable = false;
            declaration.instabilityReason = StableDeclarationIdInstabilityReason.IdCollision;
        }
    }

    const stableDeclarationCount = context.declarations.filter((declaration) => declaration.isStable).length;
    const unstableDeclarationCount = context.declarations.length - stableDeclarationCount;
    const fingerprint = _hashParts(
        context.declarations.map(
            (declaration) =>
                declaration.id ??
                [
                    'unstable',
                    declaration.fileIdentity,
                    declaration.symbolPath.join('.'),
                    declaration.nodeKind.toString(),
                    declaration.ordinal?.toString() ?? '',
                    declaration.declarationFingerprint,
                    declaration.instabilityReason ?? '',
                ].join('|')
        )
    );

    return {
        declarations: context.declarations,
        fingerprint,
        stableDeclarationCount,
        unstableDeclarationCount,
        isReliable: unstableDeclarationCount === 0,
    };
}

function _collectStatementDeclarations(
    statements: readonly StatementNode[],
    scopePath: readonly string[],
    context: CollectContext
) {
    for (const statement of statements) {
        switch (statement.nodeType) {
            case ParseNodeType.Function:
                _addNamedDeclaration(statement, statement.d.name.d.value, scopePath, context);
                _collectStatementDeclarations(
                    statement.d.suite.d.statements,
                    [...scopePath, statement.d.name.d.value],
                    context
                );
                break;

            case ParseNodeType.Class:
                _addNamedDeclaration(statement, statement.d.name.d.value, scopePath, context);
                _collectStatementDeclarations(
                    statement.d.suite.d.statements,
                    [...scopePath, statement.d.name.d.value],
                    context
                );
                break;

            case ParseNodeType.TypeAlias:
                _addNamedDeclaration(statement, statement.d.name.d.value, scopePath, context);
                break;

            case ParseNodeType.StatementList:
                _collectSmallStatementDeclarations(statement, scopePath, context);
                break;
        }
    }
}

function _collectSmallStatementDeclarations(
    statementList: StatementListNode,
    scopePath: readonly string[],
    context: CollectContext
) {
    for (const statement of statementList.d.statements) {
        switch (statement.nodeType) {
            case ParseNodeType.Assignment:
                _addTargetDeclarations(statement, statement.d.leftExpr, scopePath, context);
                break;

            case ParseNodeType.TypeAnnotation:
                _addTargetDeclarations(statement, statement.d.valueExpr, scopePath, context);
                break;

            case ParseNodeType.Import:
                _addImportDeclarations(statement, scopePath, context);
                break;

            case ParseNodeType.ImportFrom:
                _addImportFromDeclarations(statement, scopePath, context);
                break;
        }
    }
}

function _addNamedDeclaration(
    node: FunctionNode | ClassNode | TypeAliasNode,
    symbolName: string,
    scopePath: readonly string[],
    context: CollectContext
) {
    _addDeclaration(node, symbolName, scopePath, _getDeclarationFingerprint(node, context.text), context);
}

function _addTargetDeclarations(
    node: AssignmentNode | TypeAnnotationNode,
    target: ExpressionNode,
    scopePath: readonly string[],
    context: CollectContext
) {
    const symbolNames = _getTargetNames(target);
    if (!symbolNames) {
        return;
    }

    const fingerprint = _getDeclarationFingerprint(node, context.text);
    for (const symbolName of symbolNames) {
        _addDeclaration(node, symbolName, scopePath, fingerprint, context);
    }
}

function _addImportDeclarations(node: ImportNode, scopePath: readonly string[], context: CollectContext) {
    const fingerprint = _getDeclarationFingerprint(node, context.text);
    for (const importAs of node.d.list) {
        const symbolName = importAs.d.alias?.d.value ?? importAs.d.module.d.nameParts[0]?.d.value;
        if (symbolName) {
            _addDeclaration(node, symbolName, scopePath, fingerprint, context);
        }
    }
}

function _addImportFromDeclarations(node: ImportFromNode, scopePath: readonly string[], context: CollectContext) {
    const fingerprint = _getDeclarationFingerprint(node, context.text);
    if (node.d.isWildcardImport) {
        _addDeclaration(node, `${_formatModuleName(node.d.module)}.*`, scopePath, fingerprint, context);
        return;
    }

    for (const importAs of node.d.imports) {
        const symbolName = importAs.d.alias?.d.value ?? importAs.d.name.d.value;
        _addDeclaration(node, symbolName, scopePath, fingerprint, context);
    }
}

function _addDeclaration(
    node: ParseNode,
    symbolName: string,
    scopePath: readonly string[],
    declarationFingerprint: string,
    context: CollectContext
) {
    const ordinalKey = _getScopeDeclarationKey(scopePath, symbolName, node.nodeType);
    const ordinal = context.declarationOrdinalMap.get(ordinalKey) ?? 0;
    context.declarationOrdinalMap.set(ordinalKey, ordinal + 1);

    const declaration: MutableDeclarationIdentity = {
        id: undefined,
        fileIdentity: context.fileIdentity,
        symbolPath: [...scopePath, symbolName],
        nodeKind: node.nodeType,
        ordinal,
        declarationFingerprint,
        range: TextRange.create(node.start, node.length),
        isStable: true,
        instabilityReason: undefined,
    };

    context.declarations.push(declaration);

    const declarationsForScope = context.declarationScopeMap.get(ordinalKey);
    if (declarationsForScope) {
        declarationsForScope.push(declaration);
    } else {
        context.declarationScopeMap.set(ordinalKey, [declaration]);
    }
}

function _markAmbiguousDeclarations(context: CollectContext) {
    for (const declarationsForScope of context.declarationScopeMap.values()) {
        if (declarationsForScope.length <= 1) {
            continue;
        }

        for (const declaration of declarationsForScope) {
            declaration.isStable = false;
            declaration.instabilityReason = StableDeclarationIdInstabilityReason.DuplicateSymbolInScope;
        }
    }
}

function _createDeclarationId(declaration: StableDeclarationIdentity): string {
    return `decl:v${_stableDeclarationIdVersion}:${_hashParts([
        declaration.fileIdentity,
        declaration.symbolPath.join('.'),
        declaration.nodeKind.toString(),
        declaration.ordinal?.toString() ?? '',
        declaration.declarationFingerprint,
    ])}`;
}

function _getDeclarationFingerprint(node: ParseNode, text: string): string {
    switch (node.nodeType) {
        case ParseNodeType.Function:
            return _hashParts(['function', _getNormalizedText(text, node.start, node.d.suite.start)]);

        case ParseNodeType.Class:
            return _hashParts(['class', _getNormalizedText(text, node.start, node.d.suite.start)]);

        default:
            return _hashParts([
                node.nodeType.toString(),
                _getNormalizedText(text, node.start, node.start + node.length),
            ]);
    }
}

function _getTargetNames(node: ExpressionNode): string[] | undefined {
    switch (node.nodeType) {
        case ParseNodeType.Name:
            return [node.d.value];

        case ParseNodeType.TypeAnnotation:
            return _getTargetNames(node.d.valueExpr);

        case ParseNodeType.Tuple:
        case ParseNodeType.List:
            return _getSequenceTargetNames(node.d.items);

        case ParseNodeType.Unpack:
            return _getTargetNames(node.d.expr);

        default:
            return undefined;
    }
}

function _getSequenceTargetNames(items: readonly ExpressionNode[]): string[] | undefined {
    const names: string[] = [];

    for (const item of items) {
        const itemNames = _getTargetNames(item);
        if (!itemNames) {
            return undefined;
        }

        names.push(...itemNames);
    }

    return names;
}

function _formatModuleName(node: ModuleNameNode): string {
    return `${'.'.repeat(node.d.leadingDots)}${node.d.nameParts.map((name) => name.d.value).join('.')}`;
}

function _getScopeDeclarationKey(scopePath: readonly string[], symbolName: string, nodeKind: ParseNodeType): string {
    return `${scopePath.join('.')}|${symbolName}|${nodeKind.toString()}`;
}

function _getNormalizedText(text: string, start: number, end: number): string {
    return text
        .slice(start, end)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

function _hashParts(parts: readonly string[]): string {
    return StringUtils.hashString(parts.join('\n')).toString(16);
}

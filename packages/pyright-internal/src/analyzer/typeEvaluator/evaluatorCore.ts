/*
 * evaluatorCore.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Small extraction helpers for type evaluator core behavior.
 */

import { ArgumentNode, ExpressionNode, ImportFromAsNode, NameNode, ParamCategory, ParseNode, ParseNodeType, StringListNode } from '../../parser/parseNodes';
import { KeywordType, OperatorType } from '../../parser/tokenizerTypes';
import { Parser, ParseOptions, ParseTextMode } from '../../parser/parser';
import { TextRange } from '../../common/textRange';
import { TextRangeCollection } from '../../common/textRangeCollection';
import { assert } from '../../common/debug';
import { convertOffsetsToRange } from '../../common/positionUtils';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { Declaration, DeclarationType } from '../declaration';
import { ArgWithExpression, AssignTypeFlags, EvalFlags, EvaluatorUsage, PrefetchedTypes } from '../typeEvaluatorTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { AnyType, ClassType, FunctionParam, FunctionParamFlags, FunctionType, isClass, isClassInstance, isFunction, isInstantiableClass, isModule, isNever, isParamSpec, isTypeVar, isTypeSame, isTypeVarTuple, isUnion, isUnknown, Type, TypeBase, TypeVarType, UnknownType } from '../types';
import { convertToInstance, doForEachSubtype, getTypeVarArgsRecursive, isEllipsisType, isNoneInstance, isSentinelLiteral, isTupleClass, isTypeAliasPlaceholder, lookUpClassMember } from '../typeUtils';
import { getParamListDetails } from '../parameterUtils';
import { ConstraintTracker } from '../constraintTracker';

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

export function getIndexAccessMagicMethodNameForUsage(usage: EvaluatorUsage): string {
    if (usage.method === 'get') {
        return '__getitem__';
    } else if (usage.method === 'set') {
        return '__setitem__';
    } else {
        assert(usage.method === 'del');
        return '__delitem__';
    }
}

export function convertArgumentNodeToArg(node: ArgumentNode): ArgWithExpression {
    return {
        argCategory: node.d.argCategory,
        name: node.d.name,
        valueExpression: node.d.valueExpr,
    };
}

export function getFunctionFullNameFromNode(functionNode: ParseNode, moduleName: string, functionName: string): string {
    const nameParts: string[] = [functionName];

    let curNode: ParseNode | undefined = functionNode;

    while (curNode) {
        curNode = ParseTreeUtils.getEnclosingClassOrFunction(curNode);
        if (curNode) {
            nameParts.push(curNode.d.name.d.value);
        }
    }

    nameParts.push(moduleName);

    return nameParts.reverse().join('.');
}

export function getPseudoGenericTypeVarNameForParam(paramName: string) {
    return `__type_of_${paramName}`;
}

export function getSpeculativeNodeForCallSite(errorNode: ExpressionNode): ParseNode {
    const argParent = ParseTreeUtils.getParentNodeOfType(errorNode, ParseNodeType.Argument);
    if (argParent?.parent) {
        return argParent.parent;
    }

    if (
        errorNode.nodeType === ParseNodeType.Name &&
        errorNode.parent?.nodeType === ParseNodeType.Class &&
        errorNode.parent.d.name === errorNode
    ) {
        return errorNode.parent;
    }

    return errorNode;
}

export function isSpecialFormClassCheck(classType: ClassType, flags: AssignTypeFlags): boolean {
    if ((flags & AssignTypeFlags.AllowIsinstanceSpecialForms) !== 0) {
        return false;
    }

    return ClassType.isSpecialFormClass(classType);
}

export function isSymbolValidTypeExpressionCheck(type: Type, includesVarDecl: boolean): boolean {
    if (!includesVarDecl || type.props?.typeAliasInfo) {
        return true;
    }

    if (isTypeAliasPlaceholder(type)) {
        return true;
    }

    if (isTypeVar(type)) {
        if (type.props?.specialForm || type.props?.typeAliasInfo) {
            return true;
        }
    }

    if (isClass(type) && !type.priv.includeSubclasses && ClassType.isValidTypeAliasClass(type)) {
        return true;
    }

    if (isSentinelLiteral(type)) {
        return true;
    }

    return false;
}

export function buildTypeParamsFromTypeArgsForClass(classType: ClassType): TypeVarType[] {
    const typeParams: TypeVarType[] = [];
    const typeArgs = classType.priv.typeArgs ?? [];

    typeArgs.forEach((typeArg, index) => {
        if (isTypeVar(typeArg)) {
            typeParams.push(typeArg);
            return;
        }

        const typeVar = TypeVarType.createInstance(`__P${index}`);
        typeVar.shared.isSynthesized = true;
        typeParams.push(typeVar);
    });

    return typeParams;
}

export function synthesizeTypeAliasPlaceholderForName(nameNode: NameNode, isTypeAliasType: boolean = false): TypeVarType {
    const placeholder = TypeVarType.createInstantiable(`__type_alias_${nameNode.d.value}`);
    placeholder.shared.isSynthesized = true;
    const typeVarScopeId = ParseTreeUtils.getScopeIdForNode(nameNode);
    const fileInfo = AnalyzerNodeInfo.getFileInfo(nameNode);

    placeholder.shared.recursiveAlias = {
        name: nameNode.d.value,
        fullName: ParseTreeUtils.getClassFullName(nameNode, fileInfo.moduleName, nameNode.d.value),
        moduleName: fileInfo.moduleName,
        fileUri: fileInfo.fileUri,
        typeVarScopeId,
        isTypeAliasType,
        typeParams: undefined,
        computedVariance: undefined,
    };
    placeholder.priv.scopeId = typeVarScopeId;

    return placeholder;
}

export function isFinalVariableCheck(symbol: { getDeclarations(): Declaration[] }): boolean {
    return symbol.getDeclarations().some((decl) => isFinalVariableDecl(decl));
}

export function isLegalImplicitTypeAliasTypeCheck(type: Type): boolean {
    if (isEllipsisType(type)) {
        return false;
    }

    if (isUnknown(type)) {
        if (type.props?.specialForm && ClassType.isBuiltIn(type.props.specialForm, 'UnionType')) {
            return true;
        }
        return false;
    }

    let isLegal = true;
    doForEachSubtype(type, (subtype) => {
        if (!TypeBase.isInstantiable(subtype) && !isNoneInstance(subtype)) {
            isLegal = false;
        }
    });

    return isLegal;
}

export function getUnknownExemptTypeVarsForReturnTypeCheck(functionType: FunctionType, returnType: Type): TypeVarType[] {
    if (isFunction(returnType) && !returnType.shared.name) {
        const returnTypeScopeId = returnType.shared.typeVarScopeId;

        if (returnTypeScopeId && functionType.shared.typeVarScopeId) {
            let typeVarsInReturnType = getTypeVarArgsRecursive(returnType);

            functionType.shared.parameters.forEach((param, index) => {
                if (FunctionParam.isTypeDeclared(param)) {
                    const typeVarsInInputParam = getTypeVarArgsRecursive(
                        FunctionType.getParamType(functionType, index)
                    );
                    typeVarsInReturnType = typeVarsInReturnType.filter(
                        (returnTypeVar) =>
                            !typeVarsInInputParam.some((inputTypeVar) => isTypeSame(returnTypeVar, inputTypeVar))
                    );
                }
            });

            return typeVarsInReturnType;
        }
    }

    return [];
}

export function applyUnpackToTupleLikeType(type: Type): Type | undefined {
    if (isTypeVarTuple(type)) {
        if (!type.priv.isUnpacked) {
            return TypeVarType.cloneForUnpacked(type);
        }

        return undefined;
    }

    if (isParamSpec(type)) {
        return undefined;
    }

    if (isTypeVar(type)) {
        const upperBound = type.shared.boundType;

        if (upperBound && isClassInstance(upperBound) && isTupleClass(upperBound)) {
            return TypeVarType.cloneForUnpacked(type);
        }

        return undefined;
    }

    if (isInstantiableClass(type) && !type.priv.includeSubclasses) {
        if (isTupleClass(type)) {
            return ClassType.cloneForUnpacked(type);
        }
    }

    return undefined;
}

export function getDeclarationFromKeywordParamForFunction(
    type: FunctionType,
    paramName: string
): Declaration | undefined {
    if (isFunction(type)) {
        if (type.shared.declaration) {
            const functionDecl = type.shared.declaration;
            if (functionDecl.type === DeclarationType.Function) {
                const functionNode = functionDecl.node;
                const functionScope = AnalyzerNodeInfo.getScope(functionNode);
                if (functionScope) {
                    const paramSymbol = functionScope.lookUpSymbol(paramName)!;
                    if (paramSymbol) {
                        return paramSymbol.getDeclarations().find((decl) => decl.type === DeclarationType.Param);
                    }

                    const parameterDetails = getParamListDetails(type);
                    if (parameterDetails.unpackedKwargsTypedDictType) {
                        const lookupResults = lookUpClassMember(
                            parameterDetails.unpackedKwargsTypedDictType,
                            paramName
                        );
                        if (lookupResults) {
                            return lookupResults.symbol
                                .getDeclarations()
                                .find((decl) => decl.type === DeclarationType.Variable);
                        }
                    }
                }
            }
        }
    }

    return undefined;
}

// --- Prefetched type accessors (Phase 3: context-injected) ---

export function getTypedDictClassTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): ClassType | undefined {
    return prefetched?.typedDictPrivateClass && isInstantiableClass(prefetched.typedDictPrivateClass)
        ? prefetched.typedDictPrivateClass
        : undefined;
}

export function getTupleClassTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): ClassType | undefined {
    return prefetched?.tupleClass && isInstantiableClass(prefetched.tupleClass) ? prefetched.tupleClass : undefined;
}

export function getDictClassTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): ClassType | undefined {
    return prefetched?.dictClass && isInstantiableClass(prefetched.dictClass) ? prefetched.dictClass : undefined;
}

export function getStrClassTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): ClassType | undefined {
    return prefetched?.strClass && isInstantiableClass(prefetched.strClass) ? prefetched.strClass : undefined;
}

export function getObjectTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): Type {
    return prefetched?.objectClass ? convertToInstance(prefetched.objectClass) : UnknownType.create();
}

export function getNoneTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): Type {
    return prefetched?.noneTypeClass ? convertToInstance(prefetched.noneTypeClass) : UnknownType.create();
}

export function getUnionClassTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): Type {
    return prefetched?.unionTypeClass ?? UnknownType.create();
}

export function getTypeClassTypeFromPrefetched(prefetched: Partial<PrefetchedTypes> | undefined): ClassType | undefined {
    if (prefetched?.typeClass && isInstantiableClass(prefetched.typeClass)) {
        return prefetched.typeClass;
    }
    return undefined;
}

export function parseStringAsTypeAnnotationNode(node: StringListNode, reportErrors: boolean): ExpressionNode | undefined {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    const parser = new Parser();
    const textValue = node.d.strings[0].d.value;

    let valueOffset = node.d.strings[0].start;
    if (node.d.strings[0].nodeType === ParseNodeType.String) {
        valueOffset += node.d.strings[0].d.token.prefixLength + node.d.strings[0].d.token.quoteMarkLength;
    }

    const dummyFileContents = ' '.repeat(valueOffset) + textValue;

    const parseOptions = new ParseOptions();
    parseOptions.isStubFile = fileInfo.isStubFile;
    parseOptions.pythonVersion = fileInfo.executionEnvironment.pythonVersion;
    parseOptions.reportErrorsForParsedStringContents = true;

    const parseResults = parser.parseTextExpression(
        dummyFileContents,
        valueOffset,
        textValue.length,
        parseOptions,
        ParseTextMode.Expression,
        /* initialParenDepth */ undefined,
        fileInfo.typingSymbolAliases
    );

    if (parseResults.parseTree) {
        if (!reportErrors && parseResults.diagnostics.length > 0) {
            return undefined;
        }

        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        parseResults.diagnostics.forEach((diag: { message: string; }) => {
            fileInfo.diagnosticSink.addDiagnosticWithTextRange('error', diag.message, node);
        });

        parseResults.parseTree.parent = node;

        if (reportErrors) {
            node.d.annotation = parseResults.parseTree;
        }

        return parseResults.parseTree;
    }

    return undefined;
}

export function convertSpecialFormToRuntimeValueWithPrefetched(
    type: Type,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined,
    convertModule = false
): Type {
    const exemptFlags = EvalFlags.TypeExpression | EvalFlags.InstantiableType | EvalFlags.NoConvertSpecialForm;

    if ((flags & exemptFlags) !== 0) {
        return type;
    }

    if (
        convertModule &&
        isModule(type) &&
        prefetched?.moduleTypeClass &&
        isInstantiableClass(prefetched.moduleTypeClass)
    ) {
        return ClassType.cloneAsInstance(prefetched.moduleTypeClass);
    }

    if ((flags & EvalFlags.IsinstanceArg) !== 0) {
        if (isUnion(type) && type.props?.typeAliasInfo && !type.props.typeAliasInfo.shared.isTypeAliasType) {
            return type;
        }
    }

    if (!type.props?.specialForm) {
        return type;
    }

    if ((flags & EvalFlags.NoSpecialize) !== 0 && type.props?.typeAliasInfo) {
        if (!ClassType.isBuiltIn(type.props.specialForm, 'TypeAliasType')) {
            return type;
        }
    }

    if (type.props?.typeForm) {
        return TypeBase.cloneWithTypeForm(type.props.specialForm, type.props.typeForm);
    }

    return type.props.specialForm;
}

export function expandTypedKwargsForFunction(functionType: FunctionType): FunctionType {
    const kwargsIndex = functionType.shared.parameters.findIndex(
        (param) => param.category === ParamCategory.KwargsDict
    );
    if (kwargsIndex < 0) {
        return functionType;
    }
    assert(kwargsIndex === functionType.shared.parameters.length - 1);

    const kwargsType = FunctionType.getParamType(functionType, kwargsIndex);
    if (!isClassInstance(kwargsType) || !ClassType.isTypedDictClass(kwargsType) || !kwargsType.priv.isUnpacked) {
        return functionType;
    }

    const tdEntries = kwargsType.priv.typedDictNarrowedEntries ?? kwargsType.shared.typedDictEntries?.knownItems;
    if (!tdEntries) {
        return functionType;
    }

    const newFunction = FunctionType.clone(functionType);
    newFunction.shared.parameters.splice(kwargsIndex);
    if (newFunction.priv.specializedTypes) {
        newFunction.priv.specializedTypes.parameterTypes.splice(kwargsIndex);
    }

    const kwSeparatorIndex = functionType.shared.parameters.findIndex(
        (param) => param.category === ParamCategory.ArgsList
    );

    if (kwSeparatorIndex < 0 && tdEntries.size > 0) {
        FunctionType.addKeywordOnlyParamSeparator(newFunction);
    }

    tdEntries.forEach((tdEntry, name) => {
        FunctionType.addParam(
            newFunction,
            FunctionParam.create(
                ParamCategory.Simple,
                tdEntry.valueType,
                FunctionParamFlags.TypeDeclared,
                name,
                tdEntry.isRequired ? undefined : tdEntry.valueType
            )
        );
    });

    const extraItemsType = kwargsType.shared.typedDictEntries?.extraItems?.valueType;

    if (extraItemsType && !isNever(extraItemsType)) {
        FunctionType.addParam(
            newFunction,
            FunctionParam.create(
                ParamCategory.KwargsDict,
                extraItemsType,
                FunctionParamFlags.TypeDeclared,
                'kwargs'
            )
        );
    }

    return newFunction;
}

export function setConstraintsForFreeTypeVarsInType(
    destType: Type,
    srcType: UnknownType | AnyType,
    constraints: ConstraintTracker
) {
    const typeVars = getTypeVarArgsRecursive(destType);
    typeVars.forEach((typeVar) => {
        if (!TypeVarType.isBound(typeVar) && !constraints.getMainConstraintSet().getTypeVar(typeVar)) {
            if (!isParamSpec(srcType) && !isTypeVarTuple(srcType)) {
                constraints.setBounds(typeVar, srcType);
            }
        }
    });
}

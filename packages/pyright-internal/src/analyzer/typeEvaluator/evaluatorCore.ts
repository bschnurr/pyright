/*
 * evaluatorCore.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Small extraction helpers for type evaluator core behavior.
 */

import { DiagnosticLevel } from '../../common/configOptions';
import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../../localization/localize';
import { ArgumentNode, ExpressionNode, ImportFromAsNode, NameNode, ParamCategory, ParseNode, ParseNodeType, SliceNode, StringListNode, TypeParameterNode } from '../../parser/parseNodes';
import { KeywordType, OperatorType } from '../../parser/tokenizerTypes';
import { Parser, ParseOptions, ParseTextMode } from '../../parser/parser';
import { TextRange } from '../../common/textRange';
import { TextRangeCollection } from '../../common/textRangeCollection';
import { assert } from '../../common/debug';
import { appendArray } from '../../common/collectionUtils';
import { convertOffsetsToRange } from '../../common/positionUtils';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { Declaration, DeclarationType } from '../declaration';
import { ArgWithExpression, AssignTypeFlags, EvalFlags, EvaluatorUsage, PrefetchedTypes, TypeEvaluator, TypeResult, TypeResultWithNode, ValidateTypeArgsOptions } from '../typeEvaluatorTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { AnyType, ClassType, ClassTypeFlags, combineTypes, findSubtype, FunctionParam, FunctionParamFlags, FunctionType, FunctionTypeFlags, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isNever, isParamSpec, isTypeVar, isTypeSame, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedClass, isUnpackedTypeVarTuple, NeverType, ParamSpecType, removeUnbound, TupleTypeArg, Type, TypeAliasInfo, TypeBase, TypeVarScopeId, TypeVarScopeType, TypeVarTupleType, TypeVarType, UnknownType, Variance } from '../types';
import { addConditionToType, computeMroLinearization, convertToInstance, derivesFromClassRecursive, doForEachSubtype, addTypeVarsToListIfUnique, getTypeCondition, getTypeVarArgsRecursive, isEffectivelyInstantiable, isEllipsisType, isIncompleteUnknown, isNoneInstance, isPartlyUnknown, isSentinelLiteral, isTupleClass, isTypeAliasPlaceholder, isUnboundedTupleClass, lookUpClassMember, lookUpObjectMember, MemberAccessFlags, requiresSpecialization, specializeTupleClass, validateTypeVarDefault } from '../typeUtils';
import { getParamListDetails, ParamKind, ParamListDetails } from '../parameterUtils';
import { ConstraintTracker } from '../constraintTracker';
import { makeTupleObject } from '../tuples';

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

export type AddDiagnosticFn = (rule: DiagnosticRule, message: string, node: ParseNode, range?: TextRange) => Diagnostic | undefined;

export function validateTypeVarTupleIsUnpackedCheck(
    type: TypeVarTupleType,
    node: ParseNode,
    addDiagnosticFn: AddDiagnosticFn
): boolean {
    if (!type.priv.isUnpacked) {
        addDiagnosticFn(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.unpackedTypeVarTupleExpected().format({
                name1: type.shared.name,
                name2: type.shared.name,
            }),
            node
        );
        return false;
    }

    return true;
}

export function getBooleanValueFromNode(
    node: ExpressionNode,
    addDiagnosticFn: AddDiagnosticFn
): boolean {
    if (node.nodeType === ParseNodeType.Constant) {
        if (node.d.constType === KeywordType.False) {
            return false;
        } else if (node.d.constType === KeywordType.True) {
            return true;
        }
    }

    addDiagnosticFn(DiagnosticRule.reportGeneralTypeIssues, LocMessage.expectedBoolLiteral(), node);
    return false;
}

export function reportUseOfTypeCheckOnlySymbol(
    type: Type,
    node: ExpressionNode,
    addDiagnosticFn: AddDiagnosticFn
) {
    let isTypeCheckingOnly = false;
    let name = '';

    if (isInstantiableClass(type) && !type.priv.includeSubclasses) {
        isTypeCheckingOnly = ClassType.isTypeCheckOnly(type);
        name = type.shared.name;
    } else if (isFunction(type)) {
        isTypeCheckingOnly = FunctionType.isTypeCheckOnly(type);
        name = type.shared.name;
    }

    if (isTypeCheckingOnly) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        if (!fileInfo.isStubFile) {
            addDiagnosticFn(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeCheckOnly().format({ name }),
                node
            );
        }
    }
}

export function enforceClassTypeVarScopeCheck(
    node: ExpressionNode,
    type: TypeVarType,
    addDiagnosticFn: AddDiagnosticFn
): boolean {
    const scopeId = type.priv.freeTypeVar?.priv.scopeId ?? type.priv.scopeId;
    if (!scopeId) {
        return true;
    }

    const enclosingClass = ParseTreeUtils.getEnclosingClass(node);
    if (enclosingClass) {
        const liveTypeVarScopeIds = ParseTreeUtils.getTypeVarScopesForNode(enclosingClass);
        if (!liveTypeVarScopeIds.includes(scopeId)) {
            addDiagnosticFn(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarInvalidForMemberVariable().format({
                    name: TypeVarType.getReadableName(type),
                }),
                node
            );

            return false;
        }
    }

    return true;
}

export function createClassVarTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (flags & EvalFlags.NoClassVar) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarNotAllowed(), errorNode);
        return AnyType.create();
    }

    if (!typeArgs) {
        return classType;
    } else if (typeArgs.length === 0) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarFirstArgMissing(), errorNode);
        return UnknownType.create();
    } else if (typeArgs.length > 1) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarTooManyArgs(), typeArgs[1].node);
        return UnknownType.create();
    }

    const type = typeArgs[0].type;

    if (requiresSpecialization(type, { ignorePseudoGeneric: true, ignoreSelf: true })) {
        addDiagnosticFn(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.classVarWithTypeVar(),
            typeArgs[0].node ?? errorNode
        );
    }

    return type;
}

export function createFinalTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (flags & EvalFlags.NoFinal) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.finalContext(), errorNode);
        }
        return classType;
    }

    if ((flags & EvalFlags.TypeExpression) === 0 || !typeArgs || typeArgs.length === 0) {
        return classType;
    }

    if (typeArgs.length > 1) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.finalTooManyArgs(), errorNode);
    }

    return TypeBase.cloneAsSpecialForm(typeArgs[0].type, classType);
}

export function verifyGenericTypeParamsCheck(
    errorNode: ExpressionNode,
    typeVars: TypeVarType[],
    genericTypeVars: TypeVarType[],
    addDiagnosticFn: AddDiagnosticFn
) {
    const missingFromGeneric = typeVars.filter((typeVar) => {
        return !genericTypeVars.some((genericTypeVar) => genericTypeVar.shared.name === typeVar.shared.name);
    });

    if (missingFromGeneric.length > 0) {
        const diag = new DiagnosticAddendum();
        diag.addMessage(
            LocAddendum.typeVarsMissing().format({
                names: missingFromGeneric.map((typeVar) => `"${typeVar.shared.name}"`).join(', '),
            })
        );
        addDiagnosticFn(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarsNotInGenericOrProtocol() + diag.getString(),
            errorNode
        );
    }
}

export function validateTypeParamDefaultCheck(
    errorNode: ExpressionNode,
    typeParam: TypeVarType,
    otherLiveTypeParams: TypeVarType[],
    scopeId: TypeVarScopeId,
    addDiagnosticFn: AddDiagnosticFn
) {
    if (!typeParam.shared.isDefaultExplicit && !typeParam.shared.isSynthesized && !TypeVarType.isSelf(typeParam)) {
        const typeVarWithDefault = otherLiveTypeParams.find(
            (param) => param.shared.isDefaultExplicit && param.priv.scopeId === scopeId
        );

        if (typeVarWithDefault) {
            addDiagnosticFn(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarWithoutDefault().format({
                    name: typeParam.shared.name,
                    other: typeVarWithDefault.shared.name,
                }),
                errorNode
            );
        }
        return;
    }

    const invalidTypeVars = new Set<string>();
    validateTypeVarDefault(typeParam, otherLiveTypeParams, invalidTypeVars);

    if (invalidTypeVars.size > 0) {
        const diag = new DiagnosticAddendum();
        invalidTypeVars.forEach((name) => {
            diag.addMessage(LocAddendum.typeVarDefaultOutOfScope().format({ name }));
        });

        addDiagnosticFn(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarDefaultInvalidTypeVar().format({
                name: typeParam.shared.name,
            }) + diag.getString(),
            errorNode
        );
    }
}

export function transformTypeArgsForParamSpecCheck(
    typeParams: TypeVarType[],
    typeArgs: TypeResultWithNode[] | undefined,
    errorNode: ExpressionNode,
    addDiagnosticFn: AddDiagnosticFn
): TypeResultWithNode[] | undefined {
    if (typeParams.length !== 1 || !isParamSpec(typeParams[0]) || !typeArgs) {
        return typeArgs;
    }

    if (typeArgs.length > 1) {
        for (const typeArg of typeArgs) {
            if (isParamSpec(typeArg.type)) {
                addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.paramSpecContext(), typeArg.node);
                return undefined;
            }

            if (isEllipsisType(typeArg.type)) {
                addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.ellipsisContext(), typeArg.node);
                return undefined;
            }

            if (isInstantiableClass(typeArg.type) && ClassType.isBuiltIn(typeArg.type, 'Concatenate')) {
                addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.concatenateContext(), typeArg.node);
                return undefined;
            }

            if (typeArg.typeList) {
                addDiagnosticFn(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.typeArgListNotAllowed(),
                    typeArg.node
                );
                return undefined;
            }
        }
    }

    if (typeArgs.length === 1) {
        if (typeArgs[0].typeList) {
            return typeArgs;
        }

        const typeArgType = typeArgs[0].type;

        if (isParamSpec(typeArgType) || isEllipsisType(typeArgType)) {
            return typeArgs;
        }

        if (isInstantiableClass(typeArgType) && ClassType.isBuiltIn(typeArgType, 'Concatenate')) {
            return typeArgs;
        }
    }

    return [
        {
            type: UnknownType.create(),
            node: typeArgs.length > 0 ? typeArgs[0].node : errorNode,
            typeList: typeArgs,
        },
    ];
}

export function validateTypeArgCheck(
    argResult: TypeResultWithNode,
    addDiagnosticFn: AddDiagnosticFn,
    options?: ValidateTypeArgsOptions
): boolean {
    if (argResult.typeList) {
        if (!options?.allowTypeArgList) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeArgListNotAllowed(), argResult.node);
            return false;
        } else {
            argResult.typeList.forEach((typeArg) => {
                validateTypeArgCheck(typeArg, addDiagnosticFn);
            });
        }
    }

    if (isEllipsisType(argResult.type)) {
        if (!options?.allowTypeArgList) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.ellipsisContext(), argResult.node);
            return false;
        }
    }

    if (isModule(argResult.type)) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.moduleAsType(), argResult.node);
        return false;
    }

    if (isParamSpec(argResult.type)) {
        if (!options?.allowParamSpec) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.paramSpecContext(), argResult.node);
            return false;
        }
    }

    if (isTypeVarTuple(argResult.type) && !argResult.type.priv.isInUnion) {
        if (!options?.allowTypeVarTuple) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeVarTupleContext(), argResult.node);
            return false;
        } else {
            validateTypeVarTupleIsUnpackedCheck(argResult.type, argResult.node, addDiagnosticFn);
        }
    }

    if (!options?.allowEmptyTuple && argResult.isEmptyTupleShorthand) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.zeroLengthTupleNotAllowed(), argResult.node);
        return false;
    }

    if (isUnpackedClass(argResult.type)) {
        if (!options?.allowUnpackedTuples) {
            addDiagnosticFn(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.unpackedArgInTypeArgument(),
                argResult.node
            );
            return false;
        }
    }

    return true;
}

export function createUnpackTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (!typeArgs || typeArgs.length !== 1) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.unpackArgCount(), errorNode);
        }
        return classType;
    }

    const typeArgType = typeArgs[0].type;

    if ((flags & EvalFlags.AllowUnpackedTuple) !== 0) {
        const unpackedType = applyUnpackToTupleLikeType(typeArgType);
        if (unpackedType) {
            return unpackedType;
        }

        if ((flags & EvalFlags.TypeExpression) === 0) {
            return classType;
        }
        addDiagnosticFn(DiagnosticRule.reportGeneralTypeIssues, LocMessage.unpackExpectedTypeVarTuple(), errorNode);
        return UnknownType.create();
    }

    if ((flags & EvalFlags.AllowUnpackedTypedDict) !== 0) {
        if (isInstantiableClass(typeArgType) && ClassType.isTypedDictClass(typeArgType)) {
            return ClassType.cloneForUnpacked(typeArgType);
        }

        if ((flags & EvalFlags.TypeExpression) === 0) {
            return classType;
        }
        addDiagnosticFn(DiagnosticRule.reportGeneralTypeIssues, LocMessage.unpackExpectedTypedDict(), errorNode);
        return UnknownType.create();
    }

    if ((flags & EvalFlags.TypeExpression) === 0) {
        return classType;
    }
    addDiagnosticFn(DiagnosticRule.reportGeneralTypeIssues, LocMessage.unpackNotAllowed(), errorNode);
    return UnknownType.create();
}

export function createSpecialTypeFromArgs(
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    addDiagnosticFn: AddDiagnosticFn,
    paramLimit?: number,
    allowParamSpec = false,
    isSpecialForm = true
): Type {
    const isTupleTypeParam = ClassType.isTupleClass(classType);

    if (typeArgs) {
        if (isTupleTypeParam && typeArgs.length === 1 && typeArgs[0].isEmptyTupleShorthand) {
            typeArgs = [];
        } else {
            let sawUnpacked = false;
            const noteSawUnpacked = (typeArg: TypeResultWithNode) => {
                if (sawUnpacked) {
                    if (!reportedUnpackedError) {
                        addDiagnosticFn(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.variadicTypeArgsTooMany(),
                            typeArg.node
                        );
                        reportedUnpackedError = true;
                    }
                }
                sawUnpacked = true;
            };
            let reportedUnpackedError = false;

            typeArgs.forEach((typeArg, index) => {
                assert(typeArgs !== undefined);
                if (isEllipsisType(typeArg.type)) {
                    if (!isTupleTypeParam) {
                        if (!allowParamSpec) {
                            addDiagnosticFn(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.ellipsisContext(),
                                typeArg.node
                            );
                        }
                    } else if (typeArgs!.length !== 2 || index !== 1) {
                        addDiagnosticFn(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.ellipsisSecondArg(),
                            typeArg.node
                        );
                    } else {
                        if (isTypeVarTuple(typeArgs![0].type) && !typeArgs![0].type.priv.isInUnion) {
                            addDiagnosticFn(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.typeVarTupleContext(),
                                typeArgs![0].node
                            );
                        } else if (isUnpackedClass(typeArgs![0].type)) {
                            addDiagnosticFn(
                                DiagnosticRule.reportInvalidTypeForm,
                                LocMessage.ellipsisAfterUnpacked(),
                                typeArg.node
                            );
                        }
                    }
                } else if (isParamSpec(typeArg.type) && allowParamSpec) {
                    // Nothing to do - this is allowed.
                } else if (paramLimit === undefined && isTypeVarTuple(typeArg.type)) {
                    if (!typeArg.type.priv.isInUnion) {
                        noteSawUnpacked(typeArg);
                    }
                    validateTypeVarTupleIsUnpackedCheck(typeArg.type, typeArg.node, addDiagnosticFn);
                } else if (paramLimit === undefined && isUnpackedClass(typeArg.type)) {
                    if (isUnboundedTupleClass(typeArg.type)) {
                        noteSawUnpacked(typeArg);
                    }
                    validateTypeArgCheck(typeArg, addDiagnosticFn, { allowUnpackedTuples: true });
                } else {
                    validateTypeArgCheck(typeArg, addDiagnosticFn);
                }
            });
        }
    }

    let typeArgTypes = typeArgs ? typeArgs.map((t) => convertToInstance(t.type)) : [];

    if (paramLimit !== undefined) {
        if (typeArgs && typeArgTypes.length > paramLimit) {
            addDiagnosticFn(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.typeArgsTooMany().format({
                    name: classType.priv.aliasName || classType.shared.name,
                    expected: paramLimit,
                    received: typeArgTypes.length,
                }),
                typeArgs[paramLimit].node
            );
            typeArgTypes = typeArgTypes.slice(0, paramLimit);
        } else if (typeArgTypes.length < paramLimit) {
            while (typeArgTypes.length < paramLimit) {
                typeArgTypes.push(UnknownType.create());
            }
        }
    }

    let returnType: Type;
    if (isTupleTypeParam) {
        const tupleTypeArgTypes: TupleTypeArg[] = [];

        if (!typeArgs) {
            tupleTypeArgTypes.push({ type: UnknownType.create(), isUnbounded: true });
        } else {
            typeArgs.forEach((typeArg, index) => {
                if (index === 1 && isEllipsisType(typeArgTypes[index])) {
                    if (tupleTypeArgTypes.length === 1 && !tupleTypeArgTypes[0].isUnbounded) {
                        tupleTypeArgTypes[0] = { type: tupleTypeArgTypes[0].type, isUnbounded: true };
                    }
                } else if (isUnpackedClass(typeArg.type) && typeArg.type.priv.tupleTypeArgs) {
                    appendArray(tupleTypeArgTypes, typeArg.type.priv.tupleTypeArgs);
                } else {
                    tupleTypeArgTypes.push({ type: typeArgTypes[index], isUnbounded: false });
                }
            });
        }

        returnType = specializeTupleClass(classType, tupleTypeArgTypes, typeArgs !== undefined);
    } else {
        returnType = ClassType.specialize(classType, typeArgTypes, typeArgs !== undefined);
    }

    if (isSpecialForm) {
        returnType = TypeBase.cloneAsSpecialForm(returnType, classType);
    }

    return returnType;
}

export function createConcatenateTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if ((flags & EvalFlags.AllowConcatenate) === 0) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.concatenateContext(), errorNode);
        }
        return classType;
    }

    if (!typeArgs || typeArgs.length === 0) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.concatenateTypeArgsMissing(), errorNode);
    } else {
        typeArgs.forEach((typeArg, index) => {
            if (index === typeArgs!.length - 1) {
                if (!isParamSpec(typeArg.type) && !isEllipsisType(typeArg.type)) {
                    addDiagnosticFn(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.concatenateParamSpecMissing(),
                        typeArg.node
                    );
                }
            } else {
                if (isParamSpec(typeArg.type)) {
                    addDiagnosticFn(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.paramSpecContext(),
                        typeArg.node
                    );
                } else if (isUnpackedTypeVarTuple(typeArg.type)) {
                    addDiagnosticFn(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeVarTupleContext(),
                        typeArg.node
                    );
                } else if (isUnpackedClass(typeArg.type)) {
                    addDiagnosticFn(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.unpackedArgInTypeArgument(),
                        typeArg.node
                    );
                }
            }
        });
    }

    return createSpecialTypeFromArgs(classType, typeArgs, addDiagnosticFn, undefined, true);
}

export function createGenericTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (!typeArgs) {
        if ((flags & (EvalFlags.TypeExpression | EvalFlags.NoNakedGeneric)) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.genericTypeArgMissing(), errorNode);
        }

        return classType;
    }

    const uniqueTypeVars: TypeVarType[] = [];
    if (typeArgs) {
        if (typeArgs.length === 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.genericTypeArgMissing(), errorNode);
        }

        typeArgs.forEach((typeArg) => {
            if (!isTypeVar(typeArg.type)) {
                addDiagnosticFn(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.genericTypeArgTypeVar(),
                    typeArg.node
                );
            } else {
                if (uniqueTypeVars.some((t) => isTypeSame(t, typeArg.type))) {
                    addDiagnosticFn(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.genericTypeArgUnique(),
                        typeArg.node
                    );
                }

                uniqueTypeVars.push(typeArg.type);
            }
        });
    }

    return createSpecialTypeFromArgs(classType, typeArgs, addDiagnosticFn, undefined, true);
}

export function validateAnnotatedMetadataCheck(
    errorNode: ExpressionNode,
    baseType: Type,
    metaArgs: TypeResultWithNode[]
): Type {
    // PEP 746 metadata validation is currently a no-op while the PEP is being revised.
    return baseType;
}

export function createAnnotatedTypeFromArgs(
    classType: ClassType,
    errorNode: ExpressionNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): TypeResult {
    let type: Type | undefined;

    const typeExprFlags = EvalFlags.TypeExpression | EvalFlags.NoConvertSpecialForm;
    if ((flags & typeExprFlags) === 0) {
        type = ClassType.cloneAsInstance(classType);

        if (typeArgs && typeArgs.length >= 1 && typeArgs[0].type.props?.typeForm) {
            type = TypeBase.cloneWithTypeForm(type, typeArgs[0].type.props.typeForm);
        }

        return { type };
    }

    if (typeArgs && typeArgs.length > 0) {
        type = typeArgs[0].type;

        if (typeArgs.length < 2) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.annotatedTypeArgMissing(), errorNode);
        } else {
            type = validateAnnotatedMetadataCheck(errorNode, typeArgs[0].type, typeArgs.slice(1));
        }
    }

    if (!type || !typeArgs || typeArgs.length === 0) {
        return { type: AnyType.create() };
    }

    if (typeArgs[0].typeList) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeArgListNotAllowed(), typeArgs[0].node);
    }

    return {
        type: TypeBase.cloneAsSpecialForm(type, ClassType.cloneAsInstance(classType)),
        isReadOnly: typeArgs[0].isReadOnly,
        isRequired: typeArgs[0].isRequired,
        isNotRequired: typeArgs[0].isNotRequired,
    };
}

export function createCallableTypeFromArgs(
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    errorNode: ParseNode,
    addDiagnosticFn: AddDiagnosticFn
): FunctionType {
    let functionType = FunctionType.createInstantiable(FunctionTypeFlags.None);
    let paramSpec: ParamSpecType | undefined;
    let isValidTypeForm = true;

    TypeBase.setSpecialForm(functionType, ClassType.cloneAsInstance(classType));
    functionType.shared.declaredReturnType = UnknownType.create();
    functionType.shared.typeVarScopeId = ParseTreeUtils.getScopeIdForNode(errorNode);

    if (typeArgs && typeArgs.length > 0) {
        functionType.priv.isCallableWithTypeArgs = true;

        if (typeArgs[0].typeList) {
            const typeList = typeArgs[0].typeList;
            let sawUnpacked = false;
            let reportedUnpackedError = false;
            const noteSawUnpacked = (entry: TypeResultWithNode) => {
                if (sawUnpacked) {
                    if (!reportedUnpackedError) {
                        addDiagnosticFn(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.variadicTypeArgsTooMany(),
                            entry.node
                        );
                        reportedUnpackedError = true;
                        isValidTypeForm = false;
                    }
                }
                sawUnpacked = true;
            };

            typeList.forEach((entry, index) => {
                let entryType = entry.type;
                let paramCategory: ParamCategory = ParamCategory.Simple;
                const paramName = `__p${index.toString()}`;

                if (isTypeVarTuple(entryType)) {
                    validateTypeVarTupleIsUnpackedCheck(entryType, entry.node, addDiagnosticFn);
                    paramCategory = ParamCategory.ArgsList;
                    noteSawUnpacked(entry);
                } else if (validateTypeArgCheck(entry, addDiagnosticFn, { allowUnpackedTuples: true })) {
                    if (isUnpackedClass(entryType)) {
                        paramCategory = ParamCategory.ArgsList;

                        if (
                            entryType.priv.tupleTypeArgs?.some(
                                (typeArg) => isTypeVarTuple(typeArg.type) || typeArg.isUnbounded
                            )
                        ) {
                            noteSawUnpacked(entry);
                        }
                    }
                } else {
                    entryType = UnknownType.create();
                }

                FunctionType.addParam(
                    functionType,
                    FunctionParam.create(
                        paramCategory,
                        convertToInstance(entryType),
                        FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                        paramName
                    )
                );
            });

            if (typeList.length > 0) {
                FunctionType.addPositionOnlyParamSeparator(functionType);
            }
        } else if (isEllipsisType(typeArgs[0].type)) {
            FunctionType.addDefaultParams(functionType);
            functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
        } else if (isParamSpec(typeArgs[0].type)) {
            paramSpec = typeArgs[0].type;
        } else {
            if (isInstantiableClass(typeArgs[0].type) && ClassType.isBuiltIn(typeArgs[0].type, 'Concatenate')) {
                const concatTypeArgs = typeArgs[0].type.priv.typeArgs;
                if (concatTypeArgs && concatTypeArgs.length > 0) {
                    concatTypeArgs.forEach((typeArg, index) => {
                        if (index === concatTypeArgs.length - 1) {
                            FunctionType.addPositionOnlyParamSeparator(functionType);

                            if (isParamSpec(typeArg)) {
                                paramSpec = typeArg;
                            } else if (isEllipsisType(typeArg)) {
                                FunctionType.addDefaultParams(functionType);
                                functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
                            }
                        } else {
                            FunctionType.addParam(
                                functionType,
                                FunctionParam.create(
                                    ParamCategory.Simple,
                                    typeArg,
                                    FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                                    `__p${index}`
                                )
                            );
                        }
                    });
                }
            } else {
                addDiagnosticFn(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.callableFirstArg(),
                    typeArgs[0].node
                );
                isValidTypeForm = false;
            }
        }

        if (typeArgs.length > 1) {
            let typeArg1Type = typeArgs[1].type;
            if (!validateTypeArgCheck(typeArgs[1], addDiagnosticFn)) {
                typeArg1Type = UnknownType.create();
            }
            functionType.shared.declaredReturnType = convertToInstance(typeArg1Type);
        } else {
            addDiagnosticFn(DiagnosticRule.reportMissingTypeArgument, LocMessage.callableSecondArg(), errorNode);

            functionType.shared.declaredReturnType = UnknownType.create();
            isValidTypeForm = false;
        }

        if (typeArgs.length > 2) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.callableExtraArgs(), typeArgs[2].node);
            isValidTypeForm = false;
        }
    } else {
        FunctionType.addDefaultParams(functionType, /* useUnknown */ true);
        functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;

        if (typeArgs && typeArgs.length === 0) {
            isValidTypeForm = false;
        }
    }

    if (paramSpec) {
        FunctionType.addParamSpecVariadics(functionType, convertToInstance(paramSpec));
    }

    if (isTypeFormSupportedForNode(errorNode) && isValidTypeForm) {
        functionType = TypeBase.cloneWithTypeForm(functionType, convertToInstance(functionType));
    }

    return functionType;
}

export function createOptionalTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (!typeArgs) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.optionalExtraArgs(), errorNode);
            return UnknownType.create();
        }

        return classType;
    }

    if (typeArgs.length !== 1) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.optionalExtraArgs(), errorNode);
        return UnknownType.create();
    }

    let typeArg0Type = typeArgs[0].type;
    if (!validateTypeArgCheck(typeArgs[0], addDiagnosticFn)) {
        typeArg0Type = UnknownType.create();
    }

    let optionalType = combineTypes([typeArg0Type, prefetched?.noneTypeClass ?? UnknownType.create()]);
    if (prefetched?.unionTypeClass && isInstantiableClass(prefetched.unionTypeClass)) {
        optionalType = TypeBase.cloneAsSpecialForm(
            optionalType,
            ClassType.cloneAsInstance(prefetched.unionTypeClass)
        );
    }

    if (typeArg0Type.props?.typeForm) {
        const typeFormType = combineTypes([
            typeArg0Type.props.typeForm,
            convertToInstance(prefetched?.noneTypeClass ?? UnknownType.create()),
        ]);
        optionalType = TypeBase.cloneWithTypeForm(optionalType, typeFormType);
    }

    return optionalType;
}

export function createTypeFormTypeFromArgs(
    classType: ClassType,
    errorNode: ExpressionNode,
    typeArgs: TypeResultWithNode[] | undefined,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (!typeArgs || typeArgs.length === 0) {
        return ClassType.specialize(classType, [UnknownType.create()]);
    }

    if (typeArgs.length > 1) {
        addDiagnosticFn(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.typeArgsTooMany().format({
                name: classType.priv.aliasName || classType.shared.name,
                expected: 1,
                received: typeArgs.length,
            }),
            typeArgs[1].node
        );
        return UnknownType.create();
    }

    const convertedTypeArgs = typeArgs.map((typeArg) => {
        return convertToInstance(validateTypeArgCheck(typeArg, addDiagnosticFn) ? typeArg.type : UnknownType.create());
    });
    let resultType = ClassType.specialize(classType, convertedTypeArgs);

    if (isTypeFormSupportedForNode(errorNode)) {
        resultType = TypeBase.cloneWithTypeForm(resultType, convertToInstance(resultType));
    }

    return resultType;
}

export function createTypeGuardTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    if (!typeArgs) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeGuardArgCount(), errorNode);
        }

        return classType;
    } else if (typeArgs.length !== 1) {
        addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeGuardArgCount(), errorNode);
        return UnknownType.create();
    }

    const convertedTypeArgs = typeArgs.map((typeArg) => {
        return convertToInstance(validateTypeArgCheck(typeArg, addDiagnosticFn) ? typeArg.type : UnknownType.create());
    });

    let resultType = ClassType.specialize(classType, convertedTypeArgs);

    if (isTypeFormSupportedForNode(errorNode)) {
        resultType = TypeBase.cloneWithTypeForm(resultType, convertToInstance(resultType));
    }

    return resultType;
}

// Phase 4: Functions receiving TypeEvaluator as context

export function adjustTypeArgsForTypeVarTupleWithEvaluator(
    evaluator: TypeEvaluator,
    typeArgs: TypeResultWithNode[],
    typeParams: TypeVarType[],
    errorNode: ExpressionNode
): TypeResultWithNode[] {
    const variadicIndex = typeParams.findIndex((param) => isTypeVarTuple(param));

    let srcUnboundedTupleType: Type | undefined;
    const findUnboundedTupleIndex = (startArgIndex: number) => {
        return typeArgs.findIndex((arg, index) => {
            if (index < startArgIndex) {
                return false;
            }
            if (
                isUnpackedClass(arg.type) &&
                arg.type.priv.tupleTypeArgs &&
                arg.type.priv.tupleTypeArgs.length === 1 &&
                arg.type.priv.tupleTypeArgs[0].isUnbounded
            ) {
                srcUnboundedTupleType = arg.type.priv.tupleTypeArgs[0].type;
                return true;
            }

            return false;
        });
    };
    let srcUnboundedTupleIndex = findUnboundedTupleIndex(0);

    if (srcUnboundedTupleIndex >= 0) {
        const secondUnboundedTupleIndex = findUnboundedTupleIndex(srcUnboundedTupleIndex + 1);
        if (secondUnboundedTupleIndex >= 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.variadicTypeArgsTooMany(),
                typeArgs[secondUnboundedTupleIndex].node
            );
        }
    }

    if (
        srcUnboundedTupleType &&
        srcUnboundedTupleIndex >= 0 &&
        variadicIndex >= 0 &&
        typeArgs.length < typeParams.length
    ) {
        while (variadicIndex > srcUnboundedTupleIndex) {
            typeArgs = [
                ...typeArgs.slice(0, srcUnboundedTupleIndex),
                { node: typeArgs[srcUnboundedTupleIndex].node, type: srcUnboundedTupleType },
                ...typeArgs.slice(srcUnboundedTupleIndex),
            ];
            srcUnboundedTupleIndex++;
        }

        while (typeArgs.length < typeParams.length) {
            typeArgs = [
                ...typeArgs.slice(0, srcUnboundedTupleIndex + 1),
                { node: typeArgs[srcUnboundedTupleIndex].node, type: srcUnboundedTupleType },
                ...typeArgs.slice(srcUnboundedTupleIndex + 1),
            ];
        }
    }

    if (variadicIndex >= 0) {
        const variadicTypeVar = typeParams[variadicIndex];

        let typeParamCount = typeParams.length;
        while (typeParamCount > 0) {
            const lastTypeParam = typeParams[typeParamCount - 1];
            if (!isParamSpec(lastTypeParam) || !lastTypeParam.shared.isDefaultExplicit) {
                break;
            }

            typeParamCount--;
        }

        if (variadicIndex < typeArgs.length) {
            let variadicEndIndex = variadicIndex + 1 + typeArgs.length - typeParamCount;
            while (variadicEndIndex > variadicIndex) {
                if (!typeArgs[variadicEndIndex - 1].typeList) {
                    break;
                }
                variadicEndIndex--;
            }
            const variadicTypeResults = typeArgs.slice(variadicIndex, variadicEndIndex);

            if (variadicTypeResults.length === 1 && isTypeVarTuple(variadicTypeResults[0].type)) {
                validateTypeVarTupleIsUnpackedCheck(variadicTypeResults[0].type, variadicTypeResults[0].node, evaluator.addDiagnostic);
            } else {
                variadicTypeResults.forEach((arg, index) => {
                    validateTypeArgCheck(arg, evaluator.addDiagnostic, {
                        allowEmptyTuple: index === 0,
                        allowTypeVarTuple: true,
                        allowUnpackedTuples: true,
                    });
                });

                const variadicTypes: TupleTypeArg[] = [];
                if (variadicTypeResults.length !== 1 || !variadicTypeResults[0].isEmptyTupleShorthand) {
                    variadicTypeResults.forEach((typeResult) => {
                        if (isUnpackedClass(typeResult.type) && typeResult.type.priv.tupleTypeArgs) {
                            appendArray(variadicTypes, typeResult.type.priv.tupleTypeArgs);
                        } else {
                            variadicTypes.push({
                                type: convertToInstance(typeResult.type),
                                isUnbounded: false,
                            });
                        }
                    });
                }

                const tupleObject = makeTupleObject(evaluator, variadicTypes, /* isUnpacked */ true);

                typeArgs = [
                    ...typeArgs.slice(0, variadicIndex),
                    { node: typeArgs[variadicIndex].node, type: tupleObject },
                    ...typeArgs.slice(variadicEndIndex, typeArgs.length),
                ];
            }
        } else if (!variadicTypeVar.shared.isDefaultExplicit) {
            typeArgs.push({
                node: errorNode,
                type: makeTupleObject(evaluator, [], /* isUnpacked */ true),
            });
        }
    }

    return typeArgs;
}

export function transformTypeForTypeAliasWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    errorNode: ExpressionNode,
    typeAliasPlaceholder: TypeVarType,
    isPep695TypeVarType: boolean,
    typeParamNodes?: TypeParameterNode[]
): Type {
    if (isTypeAliasPlaceholder(type)) {
        return type;
    }

    const sharedInfo = typeAliasPlaceholder.shared.recursiveAlias;
    assert(sharedInfo !== undefined);

    let typeParams: TypeVarType[] | undefined = sharedInfo.typeParams;
    if (!typeParams) {
        typeParams = [];
        addTypeVarsToListIfUnique(typeParams, getTypeVarArgsRecursive(type));
        typeParams = typeParams.filter((typeVar) => !typeVar.shared.isSynthesized);
    }

    typeParams = typeParams.map((typeVar) => {
        if (TypeBase.isInstance(typeVar)) {
            return typeVar;
        }
        return convertToInstance(typeVar);
    });

    const firstTypeVarTupleIndex = typeParams.findIndex((typeVar) => isTypeVarTuple(typeVar));
    if (firstTypeVarTupleIndex >= 0) {
        const typeVarWithDefaultIndex = typeParams.findIndex(
            (typeVar, index) =>
                index > firstTypeVarTupleIndex && !isParamSpec(typeVar) && typeVar.shared.isDefaultExplicit
        );

        if (typeVarWithDefaultIndex >= 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarWithDefaultFollowsVariadic().format({
                    typeVarName: typeParams[typeVarWithDefaultIndex].shared.name,
                    variadicName: typeParams[firstTypeVarTupleIndex].shared.name,
                }),
                typeParamNodes ? typeParamNodes[typeVarWithDefaultIndex].d.name : errorNode
            );
        }
    }

    typeParams.forEach((typeParam, index) => {
        assert(typeParams !== undefined);
        let bestErrorNode = errorNode;
        if (typeParamNodes && index < typeParamNodes.length) {
            bestErrorNode = typeParamNodes[index].d.defaultExpr ?? typeParamNodes[index].d.name;
        }
        validateTypeParamDefaultCheck(bestErrorNode, typeParam, typeParams.slice(0, index), sharedInfo.typeVarScopeId, evaluator.addDiagnostic);
    });

    const variadics = typeParams.filter((param) => isTypeVarTuple(param));
    if (variadics.length > 1) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.variadicTypeParamTooManyAlias().format({
                names: variadics.map((v) => `"${v.shared.name}"`).join(', '),
            }),
            errorNode
        );
    }

    if (!sharedInfo.isTypeAliasType && !isPep695TypeVarType) {
        const boundTypeVars = typeParams.filter(
            (typeVar) =>
                typeVar.priv.scopeId !== sharedInfo.typeVarScopeId &&
                typeVar.priv.scopeType === TypeVarScopeType.Class
        );

        if (boundTypeVars.length > 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                LocMessage.genericTypeAliasBoundTypeVar().format({
                    names: boundTypeVars.map((t) => `${t.shared.name}`).join(', '),
                }),
                errorNode
            );
        }
    }

    if (!TypeBase.isInstantiable(type)) {
        return type;
    }

    sharedInfo.typeParams = typeParams.length > 0 ? typeParams : undefined;

    let typeAlias = TypeBase.cloneForTypeAlias(type, {
        shared: sharedInfo,
        typeArgs: undefined,
    });

    if (sharedInfo.isTypeAliasType || isPep695TypeVarType) {
        const typeAliasTypeClass = evaluator.getTypingType(errorNode, 'TypeAliasType');
        if (typeAliasTypeClass && isInstantiableClass(typeAliasTypeClass)) {
            typeAlias = TypeBase.cloneAsSpecialForm(typeAlias, ClassType.cloneAsInstance(typeAliasTypeClass));
        }
    }

    if (typeAlias.props?.typeForm) {
        typeAlias = TypeBase.cloneWithTypeForm(typeAlias, undefined);
    }

    return typeAlias;
}

export function adjustSourceParamDetailsForDestVariadicWithEvaluator(
    evaluator: TypeEvaluator,
    srcDetails: ParamListDetails,
    destDetails: ParamListDetails
) {
    if (destDetails.argsIndex === undefined) {
        return;
    }

    if (!isUnpacked(destDetails.params[destDetails.argsIndex].type)) {
        return;
    }

    if (srcDetails.params.length < destDetails.argsIndex) {
        return;
    }

    let srcLastToPackIndex = srcDetails.params.findIndex((p, i) => {
        assert(destDetails.argsIndex !== undefined);
        return i >= destDetails.argsIndex && p.kind === ParamKind.Keyword;
    });
    if (srcLastToPackIndex < 0) {
        srcLastToPackIndex = srcDetails.params.length;
    }

    if (srcDetails.argsIndex !== undefined && destDetails.argsIndex > srcDetails.argsIndex) {
        return;
    }

    const destFirstNonPositional = destDetails.firstKeywordOnlyIndex ?? destDetails.params.length;
    const suffixLength = destFirstNonPositional - destDetails.argsIndex - 1;
    const srcPositionalsToPack = srcDetails.params.slice(destDetails.argsIndex, srcLastToPackIndex - suffixLength);
    const srcTupleTypes: TupleTypeArg[] = [];
    srcPositionalsToPack.forEach((entry) => {
        if (entry.param.category === ParamCategory.ArgsList) {
            if (isUnpackedTypeVarTuple(entry.type)) {
                srcTupleTypes.push({ type: entry.type, isUnbounded: false });
            } else if (isUnpackedClass(entry.type) && entry.type.priv.tupleTypeArgs) {
                appendArray(srcTupleTypes, entry.type.priv.tupleTypeArgs);
            } else {
                srcTupleTypes.push({ type: entry.type, isUnbounded: true });
            }
        } else {
            srcTupleTypes.push({ type: entry.type, isUnbounded: false, isOptional: !!entry.defaultType });
        }
    });

    if (srcTupleTypes.length !== 1 || !isTypeVarTuple(srcTupleTypes[0].type)) {
        const srcPositionalsType = makeTupleObject(evaluator, srcTupleTypes, /* isUnpacked */ true);

        srcDetails.params = [
            ...srcDetails.params.slice(0, destDetails.argsIndex),
            {
                param: FunctionParam.create(
                    ParamCategory.ArgsList,
                    srcPositionalsType,
                    FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                    '_arg_combined'
                ),
                type: srcPositionalsType,
                declaredType: srcPositionalsType,
                index: -1,
                kind: ParamKind.Positional,
            },
            ...srcDetails.params.slice(
                destDetails.argsIndex + srcPositionalsToPack.length,
                srcDetails.params.length
            ),
        ];

        const argsIndex = srcDetails.params.findIndex((param) => param.param.category === ParamCategory.ArgsList);
        srcDetails.argsIndex = argsIndex >= 0 ? argsIndex : undefined;

        const kwargsIndex = srcDetails.params.findIndex(
            (param) => param.param.category === ParamCategory.KwargsDict
        );
        srcDetails.kwargsIndex = kwargsIndex >= 0 ? kwargsIndex : undefined;

        const firstKeywordOnlyIndex = srcDetails.params.findIndex((param) => param.kind === ParamKind.Keyword);
        srcDetails.firstKeywordOnlyIndex = firstKeywordOnlyIndex >= 0 ? firstKeywordOnlyIndex : undefined;

        srcDetails.positionOnlyParamCount = Math.max(
            0,
            srcDetails.params.findIndex(
                (p) =>
                    p.kind !== ParamKind.Positional || p.param.category !== ParamCategory.Simple || !!p.defaultType
            )
        );
    }
}

export function createRequiredOrReadOnlyTypeFromArgs(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
): TypeResult {
    if (!typeArgs && (flags & EvalFlags.TypeExpression) === 0) {
        return { type: classType };
    }

    if (!typeArgs || typeArgs.length !== 1) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                classType.shared.name === 'ReadOnly'
                    ? LocMessage.readOnlyArgCount()
                    : classType.shared.name === 'Required'
                    ? LocMessage.requiredArgCount()
                    : LocMessage.notRequiredArgCount(),
                errorNode
            );
        }

        return { type: classType };
    }

    const typeArgType = typeArgs[0].type;

    const containingClassNode = ParseTreeUtils.getEnclosingClass(errorNode, /* stopAtFunction */ true);
    const classTypeInfo = containingClassNode ? evaluator.getTypeOfClass(containingClassNode) : undefined;

    let isUsageLegal = false;

    if (
        classTypeInfo &&
        isInstantiableClass(classTypeInfo.classType) &&
        ClassType.isTypedDictClass(classTypeInfo.classType)
    ) {
        if (ParseTreeUtils.isNodeContainedWithinNodeType(errorNode, ParseNodeType.TypeAnnotation)) {
            isUsageLegal = true;
        }
    }

    let isReadOnly = typeArgs[0].isReadOnly;
    let isRequired = typeArgs[0].isRequired;
    let isNotRequired = typeArgs[0].isNotRequired;

    if (classType.shared.name === 'ReadOnly') {
        if ((flags & EvalFlags.AllowReadOnly) !== 0) {
            isUsageLegal = true;
        }

        if (typeArgs[0].isReadOnly) {
            isUsageLegal = false;
        }

        isReadOnly = true;
    } else {
        if ((flags & EvalFlags.AllowRequired) !== 0) {
            isUsageLegal = true;
        }

        if (typeArgs[0].isRequired || typeArgs[0].isNotRequired) {
            isUsageLegal = false;
        }

        isRequired = classType.shared.name === 'Required';
        isNotRequired = classType.shared.name === 'NotRequired';
    }

    if (!isUsageLegal) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeForm,
                classType.shared.name === 'ReadOnly'
                    ? LocMessage.readOnlyNotInTypedDict()
                    : classType.shared.name === 'Required'
                    ? LocMessage.requiredNotInTypedDict()
                    : LocMessage.notRequiredNotInTypedDict(),
                errorNode
            );
        }

        return { type: classType };
    }

    return { type: typeArgType, isReadOnly, isRequired, isNotRequired };
}

export function createUnionTypeFromArgs(
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined,
    addDiagnosticFn: AddDiagnosticFn
): Type {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    const types: Type[] = [];
    let allowSingleTypeArg = false;
    let isValidTypeForm = true;

    if (!typeArgs) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeForm, LocMessage.unionTypeArgCount(), errorNode);
            return NeverType.createNever();
        }

        return classType;
    }

    for (const typeArg of typeArgs) {
        let typeArgType = typeArg.type;

        if (
            !validateTypeArgCheck(typeArg, addDiagnosticFn, {
                allowTypeVarTuple: fileInfo.diagnosticRuleSet.enableExperimentalFeatures,
            })
        ) {
            typeArgType = UnknownType.create();
        }

        if (isTypeVar(typeArgType) && isUnpackedTypeVarTuple(typeArgType)) {
            if (fileInfo.diagnosticRuleSet.enableExperimentalFeatures) {
                typeArgType = TypeVarType.cloneForUnpacked(typeArgType, /* isInUnion */ true);
                allowSingleTypeArg = true;
            } else {
                addDiagnosticFn(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.unionUnpackedTypeVarTuple(),
                    errorNode
                );

                typeArgType = UnknownType.create();
                isValidTypeForm = false;
            }
        }

        types.push(typeArgType);
    }

    if (types.length === 1 && !allowSingleTypeArg && !isNoneInstance(types[0])) {
        if ((flags & EvalFlags.TypeExpression) !== 0) {
            addDiagnosticFn(DiagnosticRule.reportInvalidTypeArguments, LocMessage.unionTypeArgCount(), errorNode);
        }
        isValidTypeForm = false;
    }

    let unionType = combineTypes(types, { skipElideRedundantLiterals: true });
    if (prefetched?.unionTypeClass && isInstantiableClass(prefetched.unionTypeClass)) {
        unionType = TypeBase.cloneAsSpecialForm(unionType, ClassType.cloneAsInstance(prefetched.unionTypeClass));
    }

    if (!isValidTypeForm || types.some((t) => !t.props?.typeForm)) {
        if (unionType.props?.typeForm) {
            unionType = TypeBase.cloneWithTypeForm(unionType, undefined);
        }
    } else if (isTypeFormSupportedForNode(errorNode)) {
        const typeFormType = combineTypes(types.map((t) => t.props!.typeForm!));
        unionType = TypeBase.cloneWithTypeForm(unionType, typeFormType);
    }

    return unionType;
}

export function validateTypeIsInstantiableWithEvaluator(
    evaluator: TypeEvaluator,
    typeResult: TypeResult,
    flags: EvalFlags,
    node: ExpressionNode
) {
    if (typeResult.isIncomplete) {
        return;
    }

    if ((flags & EvalFlags.NoTypeVarTuple) !== 0) {
        if (isTypeVarTuple(typeResult.type) && !typeResult.type.priv.isInUnion) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeVarTupleContext(), node);
            typeResult.type = UnknownType.create();
        }
    }

    if (isEffectivelyInstantiable(typeResult.type, { honorTypeVarBounds: true })) {
        return;
    }

    if (isClassInstance(typeResult.type) && ClassType.isBuiltIn(typeResult.type, ['EllipsisType', 'ellipsis'])) {
        return;
    }

    if ((flags & EvalFlags.TypeExpression) !== 0) {
        const diag = new DiagnosticAddendum();
        if (isUnion(typeResult.type)) {
            doForEachSubtype(typeResult.type, (subtype) => {
                if (!isEffectivelyInstantiable(subtype, { honorTypeVarBounds: true })) {
                    diag.addMessage(LocAddendum.typeNotClass().format({ type: evaluator.printType(subtype) }));
                }
            });
        }

        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeExpectedClass().format({ type: evaluator.printType(typeResult.type) }) + diag.getString(),
            node
        );

        typeResult.type = UnknownType.create();
    }

    typeResult.typeErrors = true;
}

export function reportPossibleUnknownAssignmentWithEvaluator(
    evaluator: TypeEvaluator,
    diagLevel: DiagnosticLevel,
    rule: DiagnosticRule,
    target: NameNode,
    type: Type,
    errorNode: ExpressionNode,
    ignoreEmptyContainers: boolean
) {
    if (diagLevel === 'none') {
        return;
    }

    const nameValue = target.d.value;
    const simplifiedType = removeUnbound(type);

    if (isUnknown(simplifiedType)) {
        evaluator.addDiagnostic(rule, LocMessage.typeUnknown().format({ name: nameValue }), errorNode);
    } else if (isPartlyUnknown(simplifiedType)) {
        if (!ignoreEmptyContainers || !isClassInstance(type) || !type.priv.isEmptyContainer) {
            const diagAddendum = new DiagnosticAddendum();
            diagAddendum.addMessage(
                LocAddendum.typeOfSymbol().format({
                    name: nameValue,
                    type: evaluator.printType(simplifiedType, { expandTypeAlias: true }),
                })
            );
            evaluator.addDiagnostic(
                rule,
                LocMessage.typePartiallyUnknown().format({ name: nameValue }) + diagAddendum.getString(),
                errorNode
            );
        }
    }
}

export function isProperSubtypeWithEvaluator(
    evaluator: TypeEvaluator,
    destType: Type,
    srcType: Type,
    recursionCount: number
) {
    // If the destType has a condition, don't consider the srcType a proper subtype.
    if (destType.props?.condition) {
        return false;
    }

    // Shortcut the check if either type is Any or Unknown.
    if (isAnyOrUnknown(destType) || isAnyOrUnknown(srcType)) {
        return true;
    }

    // Shortcut the check if either type is a class whose hierarchy contains an unknown type.
    if (isClass(destType) && destType.shared.mro.some((mro) => isAnyOrUnknown(mro))) {
        return true;
    }

    if (isClass(srcType) && srcType.shared.mro.some((mro) => isAnyOrUnknown(mro))) {
        return true;
    }

    return (
        evaluator.assignType(
            destType,
            srcType,
            /* diag */ undefined,
            /* constraints */ undefined,
            AssignTypeFlags.Default,
            recursionCount
        ) &&
        !evaluator.assignType(
            srcType,
            destType,
            /* diag */ undefined,
            /* constraints */ undefined,
            AssignTypeFlags.Default,
            recursionCount
        )
    );
}

export function isOverrideMethodApplicableWithEvaluator(
    evaluator: TypeEvaluator,
    baseMethod: FunctionType,
    childClass: ClassType
): boolean {
    if (
        !FunctionType.isInstanceMethod(baseMethod) &&
        !FunctionType.isClassMethod(baseMethod) &&
        !FunctionType.isConstructorMethod(baseMethod)
    ) {
        return true;
    }

    const baseParamDetails = getParamListDetails(baseMethod);
    if (baseParamDetails.params.length === 0) {
        return true;
    }

    const baseParamType = baseParamDetails.params[0].param;

    if (baseParamType.category !== ParamCategory.Simple || !FunctionParam.isTypeDeclared(baseParamType)) {
        return true;
    }

    // If this is a self or cls parameter, determine whether the override
    // class can be assigned to the base parameter type. If not, then this
    // override doesn't apply.
    const childSelfOrClsType = FunctionType.isInstanceMethod(baseMethod)
        ? ClassType.cloneAsInstance(childClass)
        : childClass;

    return evaluator.assignType(
        baseParamDetails.params[0].type,
        childSelfOrClsType,
        /* diag */ undefined,
        /* constraints */ undefined,
        AssignTypeFlags.Default
    );
}

export function assignRecursiveTypeAliasToSelfWithEvaluator(
    evaluator: TypeEvaluator,
    destAliasInfo: TypeAliasInfo,
    srcAliasInfo: TypeAliasInfo,
    diag?: DiagnosticAddendum,
    constraints?: ConstraintTracker,
    flags = AssignTypeFlags.Default,
    recursionCount = 0
) {
    assert(destAliasInfo.typeArgs !== undefined);
    assert(srcAliasInfo.typeArgs !== undefined);

    let isAssignable = true;
    const srcTypeArgs = srcAliasInfo.typeArgs;
    const variances = destAliasInfo.shared.computedVariance;

    destAliasInfo.typeArgs.forEach((destTypeArg, index) => {
        const srcTypeArg = index < srcTypeArgs.length ? srcTypeArgs[index] : UnknownType.create();

        let adjFlags = flags;
        const variance = variances && index < variances.length ? variances[index] : Variance.Covariant;

        if (variance === Variance.Invariant) {
            adjFlags |= AssignTypeFlags.Invariant;
        } else if (variance === Variance.Contravariant) {
            adjFlags ^= AssignTypeFlags.Contravariant;
        }

        if (!evaluator.assignType(destTypeArg, srcTypeArg, diag, constraints, adjFlags, recursionCount)) {
            isAssignable = false;
        }
    });

    return isAssignable;
}

export function convertToTypeFormTypeWithEvaluator(
    evaluator: TypeEvaluator,
    expectedType: Type,
    srcType: Type
): Type {
    // Is the source is a TypeForm type?
    if (!srcType.props?.typeForm) {
        return srcType;
    }

    let srcTypeFormType: Type | undefined;

    // Is the source is a TypeForm type?
    if (srcType.props?.typeForm) {
        srcTypeFormType = srcType.props.typeForm;
    } else if (isClass(srcType)) {
        if (TypeBase.isInstantiable(srcType)) {
            if (!ClassType.isSpecialBuiltIn(srcType)) {
                srcTypeFormType = ClassType.cloneAsInstance(srcType);
            }
        } else if (ClassType.isBuiltIn(srcType, 'type')) {
            srcTypeFormType =
                srcType.priv.typeArgs?.length && srcType.priv.typeArgs.length > 0
                    ? srcType.priv.typeArgs[0]
                    : UnknownType.create();
        }
    } else if (isTypeVar(srcType) && TypeBase.isInstantiable(srcType)) {
        if (!isTypeVarTuple(srcType) || !srcType.priv.isInUnion) {
            srcTypeFormType = convertToInstance(srcType);
        }
    }

    if (!srcTypeFormType) {
        return srcType;
    }

    let resultType: Type | undefined;

    doForEachSubtype(expectedType, (subtype) => {
        if (resultType || !isClassInstance(subtype) || !ClassType.isBuiltIn(subtype, 'TypeForm')) {
            return;
        }

        const destTypeFormType =
            subtype.priv.typeArgs && subtype.priv.typeArgs.length > 0
                ? subtype.priv.typeArgs[0]
                : UnknownType.create();

        if (evaluator.assignType(destTypeFormType, srcTypeFormType)) {
            resultType = ClassType.specialize(subtype, [srcTypeFormType]);
        }
    });

    return resultType ?? srcType;
}

export function assignConditionalTypeToTypeVarWithEvaluator(
    evaluator: TypeEvaluator,
    destType: TypeVarType,
    srcType: Type,
    recursionCount: number
): boolean {
    // The srcType is assignable only if all of its subtypes are assignable.
    return !findSubtype(srcType, (srcSubtype) => {
        if (isTypeSame(destType, srcSubtype, { ignorePseudoGeneric: true }, recursionCount)) {
            return false;
        }

        if (isIncompleteUnknown(srcSubtype)) {
            return false;
        }

        const destTypeVarName = TypeVarType.getNameWithScope(destType);

        // Determine which conditions on this type apply to this type variable.
        const applicableConditions = (getTypeCondition(srcSubtype) ?? []).filter(
            (constraint) => constraint.typeVar.priv.nameWithScope === destTypeVarName
        );

        // If there are no applicable conditions, it's not assignable.
        if (applicableConditions.length === 0) {
            return true;
        }

        return !applicableConditions.some((condition) => {
            if (condition.typeVar.priv.nameWithScope === TypeVarType.getNameWithScope(destType)) {
                if (destType.shared.boundType) {
                    assert(
                        condition.constraintIndex === 0,
                        'Expected constraint for bound TypeVar to have index of 0'
                    );

                    return evaluator.assignType(
                        destType.shared.boundType,
                        srcSubtype,
                        /* diag */ undefined,
                        /* constraints */ undefined,
                        AssignTypeFlags.Default,
                        recursionCount
                    );
                }

                if (TypeVarType.hasConstraints(destType)) {
                    assert(
                        condition.constraintIndex < destType.shared.constraints.length,
                        'Constraint for constrained TypeVar is out of bounds'
                    );

                    return evaluator.assignType(
                        destType.shared.constraints[condition.constraintIndex],
                        srcSubtype,
                        /* diag */ undefined,
                        /* constraints */ undefined,
                        AssignTypeFlags.Default,
                        recursionCount
                    );
                }

                // This is a non-bound and non-constrained type variable with a matching condition.
                return true;
            }

            return false;
        });
    });
}

export function isTypeHashableWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type
): boolean {
    let isHashable = true;

    doForEachSubtype(evaluator.makeTopLevelTypeVarsConcrete(type), (subtype) => {
        if (isClassInstance(subtype)) {
            // Assume the class is hashable.
            let isObjectHashable = true;

            // Have we already computed and cached the hashability?
            if (subtype.shared.isInstanceHashable !== undefined) {
                isObjectHashable = subtype.shared.isInstanceHashable;
            } else {
                const hashMember = lookUpObjectMember(subtype, '__hash__', MemberAccessFlags.SkipObjectBaseClass);

                if (hashMember && hashMember.isTypeDeclared) {
                    const decls = hashMember.symbol.getTypedDeclarations();
                    const synthesizedType = hashMember.symbol.getSynthesizedType();

                    // Handle the case where the type is synthesized (used for
                    // dataclasses).
                    if (synthesizedType) {
                        isObjectHashable = !isNoneInstance(synthesizedType.type);
                    } else {
                        // Assume that if '__hash__' is declared as a variable, it is
                        // not hashable. If it's declared as a function, it is.
                        if (decls.every((decl) => decl.type === DeclarationType.Variable)) {
                            isObjectHashable = false;
                        }
                    }
                }

                // Cache the hashability for next time.
                subtype.shared.isInstanceHashable = isObjectHashable;
            }

            if (!isObjectHashable) {
                isHashable = false;
            }
        }
    });

    return isHashable;
}

export function isTypeComparableWithEvaluator(
    evaluator: TypeEvaluator,
    leftType: Type,
    rightType: Type,
    assumeIsOperator = false
) {
    if (isAnyOrUnknown(leftType) || isAnyOrUnknown(rightType)) {
        return true;
    }

    if (isNever(leftType) || isNever(rightType)) {
        return false;
    }

    if (isModule(leftType) || isModule(rightType)) {
        return isTypeSame(leftType, rightType, { ignoreConditions: true });
    }

    const isLeftCallable = isFunctionOrOverloaded(leftType);
    const isRightCallable = isFunctionOrOverloaded(rightType);

    if (isLeftCallable || isRightCallable) {
        return true;
    }

    if (isInstantiableClass(leftType) || (isClassInstance(leftType) && ClassType.isBuiltIn(leftType, 'type'))) {
        if (
            isInstantiableClass(rightType) ||
            (isClassInstance(rightType) && ClassType.isBuiltIn(rightType, 'type'))
        ) {
            const genericLeftType = ClassType.specialize(leftType, /* typeArgs */ undefined);
            const genericRightType = ClassType.specialize(rightType, /* typeArgs */ undefined);

            if (
                evaluator.assignType(genericLeftType, genericRightType) ||
                evaluator.assignType(genericRightType, genericLeftType)
            ) {
                return true;
            }
        }

        // Does the class have an operator overload for eq?
        const metaclass = leftType.shared.effectiveMetaclass;
        if (metaclass && isClass(metaclass)) {
            if (lookUpClassMember(metaclass, '__eq__', MemberAccessFlags.SkipObjectBaseClass)) {
                return true;
            }
        }

        return false;
    }

    if (isClassInstance(leftType)) {
        if (isClass(rightType)) {
            const genericLeftType = ClassType.specialize(leftType, /* typeArgs */ undefined);
            const genericRightType = ClassType.specialize(rightType, /* typeArgs */ undefined);

            if (
                evaluator.assignType(genericLeftType, genericRightType) ||
                evaluator.assignType(genericRightType, genericLeftType)
            ) {
                return true;
            }

            // Check for the "is None" or "is not None" case.
            if (assumeIsOperator && isNoneInstance(rightType)) {
                if (isNoneInstance(leftType)) {
                    return true;
                }

                return evaluator.assignType(leftType, rightType);
            }

            // Assume that if the types are disjoint and built-in classes that they
            // will never be comparable.
            if (ClassType.isBuiltIn(leftType) && ClassType.isBuiltIn(rightType) && TypeBase.isInstance(rightType)) {
                let boolType: ClassType | undefined;
                let intType: ClassType | undefined;
                if (ClassType.isBuiltIn(leftType, 'bool') && ClassType.isBuiltIn(rightType, 'int')) {
                    boolType = leftType;
                    intType = rightType;
                } else if (ClassType.isBuiltIn(rightType, 'bool') && ClassType.isBuiltIn(leftType, 'int')) {
                    boolType = rightType;
                    intType = leftType;
                }

                if (boolType && intType) {
                    const intVal = intType.priv?.literalValue as number | BigInt | undefined;
                    if (intVal === undefined) {
                        return true;
                    }
                    if (intVal !== 0 && intVal !== 1) {
                        return false;
                    }

                    const boolVal = boolType.priv?.literalValue as boolean | undefined;
                    if (boolVal === undefined) {
                        return true;
                    }

                    return boolVal === (intVal === 1);
                }

                return false;
            }
        }

        // Does the class have an operator overload for eq?
        const eqMethod = lookUpClassMember(
            ClassType.cloneAsInstantiable(leftType),
            '__eq__',
            MemberAccessFlags.SkipObjectBaseClass
        );

        if (eqMethod) {
            if (ClassType.isDataClass(leftType) && eqMethod.symbol.getSynthesizedType()) {
                return false;
            }

            return true;
        }

        return false;
    }

    return true;
}

export function createSubclassWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    type1: ClassType,
    type2: ClassType
): ClassType {
    assert(isInstantiableClass(type1) && isInstantiableClass(type2));

    let createClassObject = false;
    if (TypeBase.getInstantiableDepth(type1) > 0 && TypeBase.getInstantiableDepth(type2) > 0) {
        type1 = ClassType.cloneAsInstance(type1);
        type2 = ClassType.cloneAsInstance(type2);
        createClassObject = true;
    }

    const className = `<subclass of ${evaluator.printType(convertToInstance(type1), {
        omitTypeArgsIfUnknown: true,
    })} and ${evaluator.printType(convertToInstance(type2), { omitTypeArgsIfUnknown: true })}>`;
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);

    // The effective metaclass of the intersection is the narrower of the two metaclasses.
    let effectiveMetaclass = type1.shared.effectiveMetaclass;
    if (type2.shared.effectiveMetaclass) {
        if (!effectiveMetaclass || evaluator.assignType(effectiveMetaclass, type2.shared.effectiveMetaclass)) {
            effectiveMetaclass = type2.shared.effectiveMetaclass;
        }
    }

    let newClassType = ClassType.createInstantiable(
        className,
        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.None,
        ParseTreeUtils.getTypeSourceId(errorNode),
        /* declaredMetaclass */ undefined,
        effectiveMetaclass,
        type1.shared.docString
    );

    newClassType.shared.baseClasses = [type1, type2];
    computeMroLinearization(newClassType);

    newClassType = addConditionToType(newClassType, type1.props?.condition);
    newClassType = addConditionToType(newClassType, type2.props?.condition);

    if (createClassObject) {
        newClassType = ClassType.cloneAsInstantiable(newClassType);
    }

    return newClassType;
}

export function getTypeOfSliceWithEvaluator(
    evaluator: TypeEvaluator,
    node: SliceNode
): TypeResult {
    const noneType = evaluator.getNoneType();
    let startType = noneType;
    let endType = noneType;
    let stepType = noneType;
    let isIncomplete = false;

    if (node.d.startValue) {
        const startTypeResult = evaluator.getTypeOfExpression(node.d.startValue);
        startType = startTypeResult.type;
        if (startTypeResult.isIncomplete) {
            isIncomplete = true;
        }
    }

    if (node.d.endValue) {
        const endTypeResult = evaluator.getTypeOfExpression(node.d.endValue);
        endType = endTypeResult.type;
        if (endTypeResult.isIncomplete) {
            isIncomplete = true;
        }
    }

    if (node.d.stepValue) {
        const stepTypeResult = evaluator.getTypeOfExpression(node.d.stepValue);
        stepType = stepTypeResult.type;
        if (stepTypeResult.isIncomplete) {
            isIncomplete = true;
        }
    }

    const sliceType = evaluator.getBuiltInObject(node, 'slice');

    if (!isClassInstance(sliceType)) {
        return { type: sliceType };
    }

    return { type: ClassType.specialize(sliceType, [startType, endType, stepType]), isIncomplete };
}

export function transformVariadicParamTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: ParseNode,
    paramCategory: ParamCategory,
    type: Type
): Type {
    switch (paramCategory) {
        case ParamCategory.Simple: {
            return type;
        }

        case ParamCategory.ArgsList: {
            if (isParamSpec(type) && type.priv.paramSpecAccess) {
                return type;
            }

            if (isUnpackedClass(type)) {
                return ClassType.cloneForPacked(type);
            }

            return makeTupleObject(evaluator, [{ type, isUnbounded: !isTypeVarTuple(type) }]);
        }

        case ParamCategory.KwargsDict: {
            if (isParamSpec(type) && type.priv.paramSpecAccess) {
                return type;
            }

            if (isClassInstance(type) && ClassType.isTypedDictClass(type) && type.priv.isUnpacked) {
                return ClassType.cloneForPacked(type);
            }

            const dictType = evaluator.getBuiltInType(node, 'dict');
            const strType = evaluator.getBuiltInObject(node, 'str');

            if (isInstantiableClass(dictType) && isClassInstance(strType)) {
                return ClassType.cloneAsInstance(ClassType.specialize(dictType, [strType, type]));
            }

            return UnknownType.create();
        }
    }
}

export function computeEffectiveMetaclassWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    prefetched: Partial<PrefetchedTypes> | undefined
) {
    let effectiveMetaclass = classType.shared.declaredMetaclass;
    let reportedMetaclassConflict = false;

    if (!effectiveMetaclass || isInstantiableClass(effectiveMetaclass)) {
        for (const baseClass of classType.shared.baseClasses) {
            if (isInstantiableClass(baseClass)) {
                const baseClassMeta = baseClass.shared.effectiveMetaclass ?? prefetched?.typeClass;
                if (baseClassMeta && isInstantiableClass(baseClassMeta)) {
                    if (!effectiveMetaclass) {
                        effectiveMetaclass = baseClassMeta;
                    } else if (
                        derivesFromClassRecursive(baseClassMeta, effectiveMetaclass, /* ignoreUnknown */ false)
                    ) {
                        effectiveMetaclass = baseClassMeta;
                    } else if (
                        !derivesFromClassRecursive(effectiveMetaclass, baseClassMeta, /* ignoreUnknown */ false)
                    ) {
                        if (!reportedMetaclassConflict) {
                            const diag = new DiagnosticAddendum();

                            diag.addMessage(
                                LocAddendum.metaclassConflict().format({
                                    metaclass1: evaluator.printType(convertToInstance(effectiveMetaclass)),
                                    metaclass2: evaluator.printType(convertToInstance(baseClassMeta)),
                                })
                            );
                            evaluator.addDiagnostic(
                                DiagnosticRule.reportGeneralTypeIssues,
                                LocMessage.metaclassConflict() + diag.getString(),
                                errorNode
                            );

                            reportedMetaclassConflict = true;
                        }
                    }
                } else {
                    effectiveMetaclass = baseClassMeta ? UnknownType.create() : undefined;
                    break;
                }
            } else {
                effectiveMetaclass = UnknownType.create();
                break;
            }
        }
    }

    if (!effectiveMetaclass) {
        const typeMetaclass = evaluator.getBuiltInType(errorNode, 'type');
        effectiveMetaclass =
            typeMetaclass && isInstantiableClass(typeMetaclass) ? typeMetaclass : UnknownType.create();
    }

    classType.shared.effectiveMetaclass = effectiveMetaclass;

    return effectiveMetaclass;
}
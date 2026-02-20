/*
 * evaluatorCore.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Small extraction helpers for type evaluator core behavior.
 */

import { DiagnosticLevel } from '../../common/configOptions';
import { PythonVersion, pythonVersion3_9, pythonVersion3_13 } from '../../common/pythonVersion';
import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../../localization/localize';
import { ArgCategory, ArgumentNode, AssignmentNode, CallNode, ComprehensionForIfNode, ComprehensionNode, ConstantNode, DictionaryNode, ErrorExpressionCategory, ExpressionNode, FormatStringNode, FunctionNode, ImportAsNode, ImportFromAsNode, ImportFromNode, IndexNode, isExpressionNode, LambdaNode, ListNode, NameNode, ParamCategory, ParameterNode, ParseNode, ParseNodeType, SetNode, SliceNode, StringListNode, StringNode, TypeParameterNode, UnpackNode, YieldFromNode, YieldNode } from '../../parser/parseNodes';
import { KeywordType, OperatorType, StringTokenFlags } from '../../parser/tokenizerTypes';
import { Parser, ParseOptions, ParseTextMode } from '../../parser/parser';
import { TextRange } from '../../common/textRange';
import { TextRangeCollection } from '../../common/textRangeCollection';
import { Uri } from '../../common/uri/uri';
import { assert } from '../../common/debug';
import { appendArray } from '../../common/collectionUtils';
import { convertOffsetsToRange } from '../../common/positionUtils';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { isAnnotationEvaluationPostponed } from '../analyzerFileInfo';
import { Declaration, DeclarationType, FunctionDeclaration } from '../declaration';
import { AbstractSymbol, Arg, ArgWithExpression, AssignTypeFlags, CallResult, EvalFlags, EvaluatorUsage, ExpectedTypeOptions, MagicMethodDeprecationInfo, maxInferredContainerDepth, maxSubtypesForInferredType, MemberAccessDeprecationInfo, MemberAccessTypeResult, PrefetchedTypes, PrintTypeOptions, Reachability, SolveConstraintsOptions, SymbolDeclInfo, TypeEvaluator, TypeResult, TypeResultWithNode, ValidateTypeArgsOptions } from '../typeEvaluatorTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { AnyType, ClassType, ClassTypeFlags, combineTypes, findSubtype, FunctionParam, FunctionParamFlags, FunctionType, FunctionTypeFlags, InheritanceChain, isAny, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isNever, isOverloaded, isParamSpec, isPositionOnlySeparator, isTypeVar, isTypeSame, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedClass, isUnpackedTypeVarTuple, LiteralValue, maxTypeRecursionCount, ModuleType, NeverType, OverloadedType, ParamSpecType, removeUnbound, TupleTypeArg, Type, TypeAliasInfo, TypeBase, TypeCategory, TypeCondition, TypedDictEntries, TypeVarKind, TypeVarScopeId, TypeVarScopeType, TypeVarTupleType, TypeVarType, UnionType, UnknownType, Variance } from '../types';
import { addConditionToType, applySolvedTypeVars, ApplyTypeVarOptions, areTypesSame, ClassMember, combineSameSizedTuples, combineVariances, computeMroLinearization, containsLiteralType, convertToInstance, convertToInstantiable, derivesFromAnyOrUnknown, derivesFromClassRecursive, derivesFromStdlibClass, doForEachSubtype, addTypeVarsToListIfUnique, explodeGenericClass, getContainerDepth, getDeclaredGeneratorReturnType, getGeneratorTypeArgs, getGeneratorYieldType, getSpecializedTupleType, getTypeCondition, getTypeVarArgsRecursive, getTypeVarScopeId, getTypeVarScopeIds, getUnknownTypeForCallable, InferenceContext, invertVariance, isEffectivelyInstantiable, isEllipsisType, isIncompleteUnknown, isInstantiableMetaclass, isLiteralLikeType, isLiteralType, isMetaclassInstance, isNoneInstance, isNoneTypeClass, isOptionalType, isPartlyUnknown, isSentinelLiteral, isTupleClass, isTupleIndexUnambiguous, isTypeAliasPlaceholder, isUnboundedTupleClass, isVarianceOfTypeArgCompatible, lookUpClassMember, lookUpObjectMember, makeFunctionTypeVarsBound, makeInferenceContext, makeTypeVarsBound, MapSubtypesOptions, mapSignatures, mapSubtypes, MemberAccessFlags, partiallySpecializeType, removeNoneFromUnion, requiresSpecialization, requiresTypeArgs, selfSpecializeClass, simplifyFunctionToParamSpec, sortTypes, specializeForBaseClass, specializeWithDefaultTypeArgs, specializeTupleClass, stripTypeForm, synthesizeTypeVarForSelfCls, transformExpectedType, transformPossibleRecursiveTypeAlias, validateTypeVarDefault } from '../typeUtils';
import { getParamListDetails, ParamKind, ParamListDetails, VirtualParamDetails } from '../parameterUtils';
import { ConstraintTracker } from '../constraintTracker';
import { ConstraintSolution } from '../constraintSolution';
import { addConstraintsForExpectedType, solveConstraints } from '../constraintSolver';
import { assignTupleTypeArgs, expandTuple, getSlicedTupleType, makeTupleObject } from '../tuples';
import { assignClassToProtocol } from '../protocols';
import { enumerateLiteralsForType } from '../typeGuards';
import { Scope, ScopeType, SymbolWithScope } from '../scope';
import { CodeFlowEngine } from '../codeFlowEngine';
import { Symbol, SymbolFlags, SynthesizedTypeInfo } from '../symbol';
import { getDeclarationsWithUsesLocalNameRemoved, synthesizeAliasDeclaration } from '../declarationUtils';
import { getBoundInitMethod, validateConstructorArgs } from '../constructors';
import { isPrivateOrProtectedName } from '../symbolNameUtils';
import { getLastTypedDeclarationForSymbol } from '../symbolUtils';
import * as TypeEvaluatorNarrowing from './narrowing';
import * as ScopeUtils from '../scopeUtils';
import { FunctionDecoratorInfo, getFunctionInfoFromDecorators } from '../decorators';
import { createTypedDictTypeInlined, getTypeOfIndexedTypedDict, assignTypedDictToTypedDict, getTypedDictMappingEquivalent, getTypedDictDictEquivalent, getTypedDictMembersForClass, assignToTypedDict } from '../typedDicts';
import { isTypeFormSupportedForNode, applyUnpackToTupleLikeType } from './pureHelpers';
import { createSpecialTypeFromArgs, createCallableTypeFromArgs, createOptionalTypeFromArgs, createClassVarTypeFromArgs, createUnionTypeFromArgs, createGenericTypeFromArgs, createFinalTypeFromArgs, createAnnotatedTypeFromArgs, createConcatenateTypeFromArgs, createTypeGuardTypeFromArgs, createTypeFormTypeFromArgs, createUnpackTypeFromArgs, createRequiredOrReadOnlyTypeFromArgs, adjustSourceParamDetailsForDestVariadicWithEvaluator, adjustTypeArgsForTypeVarTupleWithEvaluator, transformTypeForTypeAliasWithEvaluator, validateTypeVarTupleIsUnpackedCheck, validateTypeArgCheck, transformTypeArgsForParamSpecCheck, getBooleanValueFromNode } from './specialFormCreation';

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


function getEffectiveReturnTypeForAssign(type: FunctionType, evaluator: TypeEvaluator): Type {
    const specializedReturnType = FunctionType.getEffectiveReturnType(type, /* includeInferred */ false);
    if (specializedReturnType && !isUnknown(specializedReturnType)) {
        return specializedReturnType;
    }
    return evaluator.getInferredReturnType(type);
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

// Re-exported from pureHelpers.ts
export { isTypeFormSupportedForNode, applyUnpackToTupleLikeType } from './pureHelpers';

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

// applyUnpackToTupleLikeType moved to pureHelpers.ts

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

export function makeTopLevelTypeVarsConcreteWithPrefetched(
    type: Type,
    prefetched: Partial<PrefetchedTypes> | undefined,
    evaluator: TypeEvaluator,
    makeParamSpecsConcrete = false,
    conditionFilter?: TypeCondition[]
): Type {
    type = transformPossibleRecursiveTypeAlias(type);

    return mapSubtypes(type, (subtype) => {
        if (isParamSpec(subtype)) {
            if (subtype.priv.paramSpecAccess === 'args') {
                return makeTupleObject(evaluator, [{ type: getObjectTypeFromPrefetched(prefetched), isUnbounded: true }]);
            } else if (subtype.priv.paramSpecAccess === 'kwargs') {
                if (
                    prefetched?.dictClass &&
                    isInstantiableClass(prefetched.dictClass) &&
                    prefetched?.strClass &&
                    isInstantiableClass(prefetched.strClass)
                ) {
                    return ClassType.cloneAsInstance(
                        ClassType.specialize(prefetched.dictClass, [
                            convertToInstance(prefetched.strClass),
                            getObjectTypeFromPrefetched(prefetched),
                        ])
                    );
                }

                return UnknownType.create();
            }
        }

        // If this is a function that contains only a ParamSpec (no additional
        // parameters), convert it to a concrete type of (*args: Unknown, **kwargs: Unknown).
        if (makeParamSpecsConcrete && isFunction(subtype)) {
            const convertedType = simplifyFunctionToParamSpec(subtype);
            if (isParamSpec(convertedType)) {
                return ParamSpecType.getUnknown();
            }
        }

        if (isTypeVarTuple(subtype)) {
            // If it's in a union, convert to type or object.
            if (subtype.priv.isInUnion) {
                if (TypeBase.isInstantiable(subtype)) {
                    if (prefetched?.typeClass && isInstantiableClass(prefetched.typeClass)) {
                        return prefetched.typeClass;
                    }
                } else {
                    return getObjectTypeFromPrefetched(prefetched);
                }

                return AnyType.create();
            }

            // Fall back to "*tuple[object, ...]".
            return makeTupleObject(
                evaluator,
                [{ type: getObjectTypeFromPrefetched(prefetched), isUnbounded: true }],
                /* isUnpacked */ true
            );
        }

        if (isTypeVar(subtype)) {
            // If this is a recursive type alias placeholder
            // that hasn't yet been resolved, return it as is.
            if (subtype.shared.recursiveAlias) {
                return subtype;
            }

            if (TypeVarType.hasConstraints(subtype)) {
                const typesToCombine: Type[] = [];

                // Expand the list of constrained subtypes, filtering out any that are
                // disallowed by the conditionFilter.
                subtype.shared.constraints.forEach((constraintType, constraintIndex) => {
                    if (conditionFilter) {
                        const typeVarName = TypeVarType.getNameWithScope(subtype);
                        const applicableConstraint = conditionFilter.find(
                            (filter) => filter.typeVar.priv.nameWithScope === typeVarName
                        );

                        // If this type variable is being constrained to a single index,
                        // don't include the other indices.
                        if (applicableConstraint && applicableConstraint.constraintIndex !== constraintIndex) {
                            return;
                        }
                    }

                    if (TypeBase.isInstantiable(subtype)) {
                        constraintType = convertToInstantiable(constraintType);
                    }

                    typesToCombine.push(
                        addConditionToType(constraintType, [{ typeVar: subtype, constraintIndex }])
                    );
                });

                return combineTypes(typesToCombine);
            }

            if (subtype.shared.isExemptFromBoundCheck) {
                return AnyType.create();
            }

            // Fall back to a bound of "object" if no bound is provided.
            let boundType = subtype.shared.boundType ?? getObjectTypeFromPrefetched(prefetched);

            // If this is a synthesized self/cls type var, self-specialize its type arguments.
            if (TypeVarType.isSelf(subtype) && isClass(boundType) && !ClassType.isPseudoGenericClass(boundType)) {
                boundType = selfSpecializeClass(boundType, {
                    useBoundTypeVars: TypeVarType.isBound(subtype),
                });
            }

            if (subtype.priv.isUnpacked && isClass(boundType)) {
                boundType = ClassType.cloneForUnpacked(boundType);
            }

            boundType = TypeBase.isInstantiable(subtype) ? convertToInstantiable(boundType) : boundType;

            return addConditionToType(boundType, [{ typeVar: subtype, constraintIndex: 0 }]);
        }

        return subtype;
    });
}

export function inferVarianceForTypeAliasWithEvaluator(
    type: Type,
    evaluator: TypeEvaluator
): Variance[] | undefined {
    const aliasInfo = type.props?.typeAliasInfo;

    // If this isn't a generic type alias, there's nothing to do.
    if (!aliasInfo || !aliasInfo.shared.typeParams) {
        return undefined;
    }

    // Is the computed variance info already cached?
    if (aliasInfo.shared.computedVariance) {
        return aliasInfo.shared.computedVariance;
    }

    const typeParams = aliasInfo.shared.typeParams;

    // Start with all of the usage variances unknown.
    const usageVariances: Variance[] = typeParams.map(() => Variance.Unknown);

    // Prepopulate the cached value for the type alias to handle
    // recursive type aliases.
    aliasInfo.shared.computedVariance = usageVariances;

    // Traverse the type alias type definition and adjust the usage
    // variances accordingly.
    updateUsageVariancesRecursiveWithEvaluator(type, typeParams, usageVariances, Variance.Covariant, evaluator);

    return usageVariances;
}

function updateUsageVariancesRecursiveWithEvaluator(
    type: Type,
    typeAliasTypeParams: TypeVarType[],
    usageVariances: Variance[],
    varianceContext: Variance,
    evaluator: TypeEvaluator,
    pendingTypes: Type[] = [],
    recursionCount = 0
) {
    if (recursionCount > maxTypeRecursionCount) {
        return;
    }

    const transformedType = transformPossibleRecursiveTypeAlias(type);
    const isRecursiveTypeAlias = transformedType !== type;

    // If this is a recursive type alias, see if we've already recursed
    // seen it once before in the recursion stack. If so, don't recurse
    // further.
    if (isRecursiveTypeAlias) {
        const pendingOverlaps = pendingTypes.filter((pendingType) => isTypeSame(pendingType, type));
        if (pendingOverlaps.length > 1) {
            return;
        }

        pendingTypes.push(type);
    }

    recursionCount++;

    // Define a helper function that performs the actual usage variant update.
    function updateUsageVarianceForType(type: Type, variance: Variance) {
        doForEachSubtype(type, (subtype) => {
            const typeParamIndex = typeAliasTypeParams.findIndex((param) => isTypeSame(param, subtype));
            if (typeParamIndex >= 0) {
                usageVariances[typeParamIndex] = combineVariances(usageVariances[typeParamIndex], variance);
            } else {
                updateUsageVariancesRecursiveWithEvaluator(
                    subtype,
                    typeAliasTypeParams,
                    usageVariances,
                    variance,
                    evaluator,
                    pendingTypes,
                    recursionCount
                );
            }
        });
    }

    doForEachSubtype(transformedType, (subtype) => {
        if (subtype.category === TypeCategory.Function) {
            subtype.shared.parameters.forEach((param, index) => {
                const paramType = FunctionType.getParamType(subtype, index);
                updateUsageVarianceForType(paramType, invertVariance(varianceContext));
            });

            const returnType = FunctionType.getEffectiveReturnType(subtype);
            if (returnType) {
                updateUsageVarianceForType(returnType, varianceContext);
            }
        } else if (subtype.category === TypeCategory.Class) {
            if (subtype.priv.typeArgs) {
                // If the class includes type parameters that uses auto variance,
                // compute the calculated variance.
                evaluator.inferVarianceForClass(subtype);

                // Is the class specialized using any type arguments that correspond to
                // the type alias' type parameters?
                subtype.priv.typeArgs.forEach((typeArg, classParamIndex) => {
                    if (isTupleClass(subtype)) {
                        updateUsageVarianceForType(typeArg, varianceContext);
                    } else if (classParamIndex < subtype.shared.typeParams.length) {
                        const classTypeParam = subtype.shared.typeParams[classParamIndex];
                        if (isUnpackedClass(typeArg) && typeArg.priv.tupleTypeArgs) {
                            typeArg.priv.tupleTypeArgs.forEach((tupleTypeArg) => {
                                updateUsageVarianceForType(tupleTypeArg.type, Variance.Invariant);
                            });
                        } else {
                            const effectiveVariance =
                                classTypeParam.priv.computedVariance ?? classTypeParam.shared.declaredVariance;
                            updateUsageVarianceForType(
                                typeArg,
                                varianceContext === Variance.Contravariant
                                    ? invertVariance(effectiveVariance)
                                    : effectiveVariance
                            );
                        }
                    }
                });
            }
        }
    });

    if (isRecursiveTypeAlias) {
        pendingTypes.pop();
    }
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


// Re-export special form creation functions from dedicated module
export { AddDiagnosticFn, validateTypeVarTupleIsUnpackedCheck, getBooleanValueFromNode, reportUseOfTypeCheckOnlySymbol, enforceClassTypeVarScopeCheck, createClassVarTypeFromArgs, createFinalTypeFromArgs, verifyGenericTypeParamsCheck, validateTypeParamDefaultCheck, transformTypeArgsForParamSpecCheck, validateTypeArgCheck, createUnpackTypeFromArgs, createSpecialTypeFromArgs, createConcatenateTypeFromArgs, createGenericTypeFromArgs, validateAnnotatedMetadataCheck, createAnnotatedTypeFromArgs, createCallableTypeFromArgs, createOptionalTypeFromArgs, createTypeFormTypeFromArgs, createTypeGuardTypeFromArgs, adjustTypeArgsForTypeVarTupleWithEvaluator, transformTypeForTypeAliasWithEvaluator, adjustSourceParamDetailsForDestVariadicWithEvaluator, createRequiredOrReadOnlyTypeFromArgs, createUnionTypeFromArgs } from './specialFormCreation';


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

export const typePromotions: Map<string, string[]> = new Map([
    ['builtins.float', ['builtins.int']],
    ['builtins.complex', ['builtins.float', 'builtins.int']],
    ['builtins.bytes', ['builtins.bytearray', 'builtins.memoryview']],
]);

export function expandPromotionTypesWithEvaluator(
    evaluator: TypeEvaluator,
    node: ParseNode,
    type: Type,
    excludeBytes = false
): Type {
    return mapSubtypes(type, (subtype) => {
        if (!isClass(subtype) || !subtype.priv.includePromotions || subtype.priv.literalValue !== undefined) {
            return subtype;
        }

        if (excludeBytes && ClassType.isBuiltIn(subtype, 'bytes')) {
            return subtype;
        }

        const typesToCombine: Type[] = [ClassType.cloneRemoveTypePromotions(subtype)];

        const promotionTypeNames = typePromotions.get(subtype.shared.fullName);
        if (promotionTypeNames) {
            for (const promotionTypeName of promotionTypeNames) {
                const nameSplit = promotionTypeName.split('.');
                let promotionSubtype = evaluator.getBuiltInType(node, nameSplit[nameSplit.length - 1]);

                if (promotionSubtype && isInstantiableClass(promotionSubtype)) {
                    promotionSubtype = ClassType.cloneRemoveTypePromotions(promotionSubtype);

                    if (isClassInstance(subtype)) {
                        promotionSubtype = ClassType.cloneAsInstance(promotionSubtype);
                    }

                    promotionSubtype = addConditionToType(promotionSubtype, subtype.props?.condition);
                    typesToCombine.push(promotionSubtype);
                }
            }
        }

        return combineTypes(typesToCombine);
    });
}

export function isPossibleTypeDictFactoryCallWithEvaluator(
    evaluator: TypeEvaluator,
    decl: Declaration
) {
    if (
        decl.type !== DeclarationType.Variable ||
        !decl.node.parent ||
        decl.node.parent.nodeType !== ParseNodeType.Assignment
    ) {
        return false;
    }

    const assignNode = decl.node.parent as AssignmentNode;
    if (assignNode.d.rightExpr?.nodeType !== ParseNodeType.Call) {
        return false;
    }

    const callLeftNode = assignNode.d.rightExpr.d.leftExpr;

    if (
        (callLeftNode.nodeType === ParseNodeType.Name && callLeftNode.d.value) === 'TypedDict' ||
        (callLeftNode.nodeType === ParseNodeType.MemberAccess &&
            callLeftNode.d.member.d.value === 'TypedDict' &&
            callLeftNode.d.leftExpr.nodeType === ParseNodeType.Name)
    ) {
        const callType = evaluator.getTypeOfExpression(callLeftNode, EvalFlags.CallBaseDefaults).type;

        if (isInstantiableClass(callType) && ClassType.isBuiltIn(callType, 'TypedDict')) {
            return true;
        }
    }

    return false;
}

export function isUnambiguousInferenceWithEvaluator(
    evaluator: TypeEvaluator,
    symbol: { getDeclarations(): Declaration[] },
    decl: Declaration,
    inferredType: Type
): boolean {
    const nonSlotsDecls = symbol.getDeclarations().filter((decl) => {
        return decl.type !== DeclarationType.Variable || !decl.isInferenceAllowedInPyTyped;
    });

    if (nonSlotsDecls.length > 1) {
        return false;
    }

    if (decl.type !== DeclarationType.Variable) {
        return false;
    }

    if (nonSlotsDecls.length === 0) {
        return true;
    }

    if (isTypeVar(inferredType)) {
        return true;
    }

    let assignmentNode: AssignmentNode | undefined;

    const parentNode = decl.node.parent;
    if (parentNode) {
        if (parentNode.nodeType === ParseNodeType.Assignment) {
            assignmentNode = parentNode as AssignmentNode;
        } else if (
            parentNode.nodeType === ParseNodeType.MemberAccess &&
            parentNode.parent?.nodeType === ParseNodeType.Assignment
        ) {
            assignmentNode = parentNode.parent as AssignmentNode;
        }
    }

    if (!assignmentNode) {
        return false;
    }

    const assignedType = evaluator.getTypeOfExpression(assignmentNode.d.rightExpr).type;

    if (isClassInstance(assignedType) && isLiteralType(assignedType)) {
        return true;
    }

    if (assignmentNode.d.rightExpr.nodeType === ParseNodeType.Name && !TypeBase.isAmbiguous(assignedType)) {
        return true;
    }

    return false;
}

// Phase 5: Symbol scope extraction — functions with codeFlowEngine dependency

export function lookUpSymbolRecursiveWithFlowContext(
    node: ParseNode,
    name: string,
    honorCodeFlow: boolean,
    codeFlowEngine: CodeFlowEngine,
    isFlowPathBetweenNodesFn: (sourceNode: ParseNode, sinkNode: ParseNode) => boolean,
    preferGlobalScope = false
): SymbolWithScope | undefined {
    const scopeNodeInfo = ParseTreeUtils.getEvaluationScopeNode(node);
    const scope = AnalyzerNodeInfo.getScope(scopeNodeInfo.node);

    let symbolWithScope = scope?.lookUpSymbolRecursive(name, { useProxyScope: !!scopeNodeInfo.useProxyScope });
    const scopeType = scope?.type ?? ScopeType.Module;

    // Functions and list comprehensions don't allow access to implicitly
    // aliased symbols in outer scopes if they haven't yet been assigned
    // within the local scope.
    let scopeTypeHonorsCodeFlow = scopeType !== ScopeType.Function && scopeType !== ScopeType.Comprehension;

    // Type parameter scopes don't honor code flow.
    if (symbolWithScope?.scope.type === ScopeType.TypeParameter) {
        scopeTypeHonorsCodeFlow = false;
    }

    if (symbolWithScope && honorCodeFlow && scopeTypeHonorsCodeFlow) {
        // Filter the declarations based on flow reachability.
        const reachableDecl = symbolWithScope.symbol.getDeclarations().find((decl) => {
            if (decl.type !== DeclarationType.Alias && decl.type !== DeclarationType.Intrinsic) {
                // Determine if the declaration is in the same execution scope as the "usageNode" node.
                let usageScopeNode = ParseTreeUtils.getExecutionScopeNode(node);
                const declNode: ParseNode =
                    decl.type === DeclarationType.Class ||
                    decl.type === DeclarationType.Function ||
                    decl.type === DeclarationType.TypeAlias
                        ? decl.node.d.name
                        : decl.node;
                const declScopeNode = ParseTreeUtils.getExecutionScopeNode(declNode);

                // If this is a type parameter scope, it will be a proxy for its
                // containing scope, so we need to use that instead.
                const usageScope = AnalyzerNodeInfo.getScope(usageScopeNode);
                if (usageScope?.proxy) {
                    const typeParamScope = AnalyzerNodeInfo.getScope(usageScopeNode);
                    if (!typeParamScope?.symbolTable.has(name) && usageScopeNode.parent) {
                        usageScopeNode = ParseTreeUtils.getExecutionScopeNode(usageScopeNode.parent);
                    }
                }

                if (usageScopeNode === declScopeNode) {
                    if (!isFlowPathBetweenNodesFn(declNode, node)) {
                        // If there was no control flow path from the usage back
                        // to the source, see if the usage node is reachable by
                        // any path.
                        const flowNode = AnalyzerNodeInfo.getFlowNode(node);
                        const isReachable =
                            flowNode &&
                            codeFlowEngine.getFlowNodeReachability(
                                flowNode,
                                /* sourceFlowNode */ undefined,
                                /* ignoreNoReturn */ true
                            ) === Reachability.Reachable;
                        return !isReachable;
                    }
                }
            }
            return true;
        });

        // If none of the declarations are reachable from the current node,
        // search for the symbol in outer scopes.
        if (!reachableDecl) {
            if (symbolWithScope.scope.type !== ScopeType.Function) {
                let nextScopeToSearch = symbolWithScope.scope.parent;
                const isOutsideCallerModule =
                    symbolWithScope.isOutsideCallerModule || symbolWithScope.scope.type === ScopeType.Module;
                let isBeyondExecutionScope =
                    symbolWithScope.isBeyondExecutionScope || symbolWithScope.scope.isIndependentlyExecutable();

                if (symbolWithScope.scope.type === ScopeType.Class) {
                    // There is an odd documented behavior for classes in that
                    // symbol resolution skips to the global scope rather than
                    // the next scope in the chain.
                    const globalScopeResult = symbolWithScope.scope.getGlobalScope();
                    nextScopeToSearch = globalScopeResult.scope;
                    if (globalScopeResult.isBeyondExecutionScope) {
                        isBeyondExecutionScope = true;
                    }
                }

                if (nextScopeToSearch) {
                    symbolWithScope = nextScopeToSearch.lookUpSymbolRecursive(name, {
                        isOutsideCallerModule,
                        isBeyondExecutionScope,
                    });
                } else {
                    symbolWithScope = undefined;
                }
            } else {
                symbolWithScope = undefined;
            }
        }
    }

    // PEP 563 indicates that if a forward reference can be resolved in the module
    // scope (or, by implication, in the builtins scope), it should prefer that
    // resolution over local resolutions.
    if (symbolWithScope && preferGlobalScope) {
        let curSymbolWithScope: SymbolWithScope | undefined = symbolWithScope;
        while (
            curSymbolWithScope.scope.type !== ScopeType.Module &&
            curSymbolWithScope.scope.type !== ScopeType.Builtin &&
            curSymbolWithScope.scope.type !== ScopeType.TypeParameter &&
            curSymbolWithScope.scope.parent
        ) {
            curSymbolWithScope = curSymbolWithScope.scope.parent.lookUpSymbolRecursive(name, {
                isOutsideCallerModule: curSymbolWithScope.isOutsideCallerModule,
                isBeyondExecutionScope:
                    curSymbolWithScope.isBeyondExecutionScope ||
                    curSymbolWithScope.scope.isIndependentlyExecutable(),
            });
            if (!curSymbolWithScope) {
                break;
            }
        }

        if (
            curSymbolWithScope?.scope.type === ScopeType.Module ||
            curSymbolWithScope?.scope.type === ScopeType.Builtin
        ) {
            symbolWithScope = curSymbolWithScope;
        }
    }

    return symbolWithScope;
}

export function getDeclInfoForStringNodeWithEvaluator(
    node: StringNode,
    evaluator: TypeEvaluator
): SymbolDeclInfo | undefined {
    const decls: Declaration[] = [];
    const synthesizedTypes: SynthesizedTypeInfo[] = [];
    const expectedType = evaluator.getExpectedType(node)?.type;

    if (expectedType) {
        doForEachSubtype(expectedType, (subtype) => {
            // If the expected type is a TypedDict then the node is either a key expression
            // or a single entry in a set. We then need to check that the value of the node
            // is a valid entry in the TypedDict to avoid resolving declarations for
            // synthesized symbols such as 'get'.
            if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
                const entry = subtype.shared.typedDictEntries?.knownItems.get(node.d.value);
                if (entry) {
                    const symbol = lookUpObjectMember(subtype, node.d.value)?.symbol;

                    if (symbol) {
                        appendArray(decls, symbol.getDeclarations());

                        const synthTypeInfo = symbol.getSynthesizedType();
                        if (synthTypeInfo) {
                            synthesizedTypes.push(synthTypeInfo);
                        }
                    }
                }
            }
        });
    }

    return decls.length === 0 ? undefined : { decls, synthesizedTypes };
}

export function getDeclInfoForNameNodeWithEvaluator(
    node: NameNode,
    evaluator: TypeEvaluator,
    skipUnreachableCode = true
): SymbolDeclInfo | undefined {
    if (skipUnreachableCode && AnalyzerNodeInfo.isCodeUnreachable(node)) {
        return undefined;
    }

    const decls: Declaration[] = [];
    const synthesizedTypes: SynthesizedTypeInfo[] = [];

    // If the node is part of a "from X import Y as Z" statement and the node
    // is the "Y" (non-aliased) name, we need to look up the alias symbol
    // since the non-aliased name is not in the symbol table.
    const alias = getAliasFromImportNode(node);
    if (alias) {
        const scope = ScopeUtils.getScopeForNode(node);
        if (scope) {
            // Look up the alias symbol.
            const symbolInScope = scope.lookUpSymbolRecursive(alias.d.value);
            if (symbolInScope) {
                // The alias could have more decls that don't refer to this import. Filter
                // out the one(s) that specifically associated with this import statement.
                const declsForThisImport = symbolInScope.symbol.getDeclarations().filter((decl) => {
                    return decl.type === DeclarationType.Alias && decl.node === node.parent;
                });

                appendArray(decls, getDeclarationsWithUsesLocalNameRemoved(declsForThisImport));
            }
        }
    } else if (
        node.parent &&
        node.parent.nodeType === ParseNodeType.MemberAccess &&
        node === node.parent.d.member
    ) {
        let baseType = evaluator.getType(node.parent.d.leftExpr);
        if (baseType) {
            baseType = evaluator.makeTopLevelTypeVarsConcrete(baseType);
            const memberName = node.parent.d.member.d.value;
            doForEachSubtype(baseType, (subtype) => {
                let symbol: Symbol | undefined;

                subtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

                if (isInstantiableClass(subtype)) {
                    // Try to find a member that has a declared type. If so, that
                    // overrides any inferred types.
                    let member = lookUpClassMember(subtype, memberName, MemberAccessFlags.DeclaredTypesOnly);
                    if (!member) {
                        member = lookUpClassMember(subtype, memberName);
                    }

                    if (!member) {
                        const metaclass = subtype.shared.effectiveMetaclass;
                        if (metaclass && isInstantiableClass(metaclass)) {
                            member = lookUpClassMember(metaclass, memberName);
                        }
                    }

                    if (member) {
                        symbol = member.symbol;
                    }
                } else if (isClassInstance(subtype)) {
                    // Try to find a member that has a declared type. If so, that
                    // overrides any inferred types.
                    let member = lookUpObjectMember(subtype, memberName, MemberAccessFlags.DeclaredTypesOnly);
                    if (!member) {
                        member = lookUpObjectMember(subtype, memberName);
                    }
                    if (member) {
                        symbol = member.symbol;
                    }
                } else if (isModule(subtype)) {
                    symbol = ModuleType.getField(subtype, memberName);
                }

                if (symbol) {
                    // By default, report only the declarations that have type annotations.
                    // If there are none, then report all of the unannotated declarations,
                    // which includes every assignment of that symbol.
                    const typedDecls = symbol.getTypedDeclarations();
                    if (typedDecls.length > 0) {
                        appendArray(decls, typedDecls);
                    } else {
                        appendArray(decls, symbol.getDeclarations());
                    }

                    const synthTypeInfo = symbol.getSynthesizedType();
                    if (synthTypeInfo) {
                        synthesizedTypes.push(synthTypeInfo);
                    }
                }
            });
        }
    } else if (node.parent && node.parent.nodeType === ParseNodeType.ModuleName) {
        const namePartIndex = node.parent.d.nameParts.findIndex((part) => part === node);
        const importInfo = AnalyzerNodeInfo.getImportInfo(node.parent);
        if (
            namePartIndex >= 0 &&
            importInfo &&
            !importInfo.isNativeLib &&
            namePartIndex < importInfo.resolvedUris.length
        ) {
            if (importInfo.resolvedUris[namePartIndex]) {
                evaluator.evaluateTypesForStatement(node);

                // Synthesize an alias declaration for this name part. The only
                // time this case is used is for IDE services such as
                // the find all references, hover provider and etc.
                decls.push(synthesizeAliasDeclaration(importInfo.resolvedUris[namePartIndex]));
            }
        }
    } else if (node.parent && node.parent.nodeType === ParseNodeType.Argument && node === node.parent.d.name) {
        // The target node is the name in a keyword argument. We need to determine whether
        // the corresponding keyword parameter can be determined from the context.
        const argNode = node.parent;
        const paramName = node.d.value;
        if (argNode.parent?.nodeType === ParseNodeType.Call) {
            const baseType = evaluator.getType(argNode.parent.d.leftExpr);

            if (baseType) {
                if (isFunction(baseType) && baseType.shared.declaration) {
                    const paramDecl = getDeclarationFromKeywordParamForFunction(baseType, paramName);
                    if (paramDecl) {
                        decls.push(paramDecl);
                    }
                } else if (isOverloaded(baseType)) {
                    OverloadedType.getOverloads(baseType).forEach((f) => {
                        const paramDecl = getDeclarationFromKeywordParamForFunction(f, paramName);
                        if (paramDecl) {
                            decls.push(paramDecl);
                        }
                    });
                } else if (isInstantiableClass(baseType)) {
                    const initMethodType = getBoundInitMethod(
                        evaluator,
                        argNode.parent.d.leftExpr,
                        ClassType.cloneAsInstance(baseType)
                    )?.type;

                    if (initMethodType && isFunction(initMethodType)) {
                        const paramDecl = getDeclarationFromKeywordParamForFunction(initMethodType, paramName);
                        if (paramDecl) {
                            decls.push(paramDecl);
                        } else if (
                            ClassType.isDataClass(baseType) ||
                            ClassType.isTypedDictClass(baseType) ||
                            ClassType.hasNamedTupleEntry(baseType, paramName)
                        ) {
                            const lookupResults = lookUpClassMember(baseType, paramName);

                            if (lookupResults) {
                                appendArray(decls, lookupResults.symbol.getDeclarations());

                                const synthTypeInfo = lookupResults.symbol.getSynthesizedType();
                                if (synthTypeInfo) {
                                    synthesizedTypes.push(synthTypeInfo);
                                }
                            }
                        }
                    } else if (
                        ClassType.isDataClass(baseType) ||
                        ClassType.isTypedDictClass(baseType) ||
                        ClassType.hasNamedTupleEntry(baseType, paramName)
                    ) {
                        // Some synthesized callables (notably TypedDict "constructors") don't have a
                        // meaningful __init__ signature we can map keyword arguments to. In these cases,
                        // treat the keyword as referring to the class entry so IDE features like
                        // go-to-definition and rename can bind to the field declaration.
                        const lookupResults = lookUpClassMember(baseType, paramName);

                        if (lookupResults) {
                            appendArray(decls, lookupResults.symbol.getDeclarations());

                            const synthTypeInfo = lookupResults.symbol.getSynthesizedType();
                            if (synthTypeInfo) {
                                synthesizedTypes.push(synthTypeInfo);
                            }
                        }
                    }
                }
            }
        } else if (argNode.parent?.nodeType === ParseNodeType.Class) {
            const classTypeResult = evaluator.getTypeOfClass(argNode.parent);

            // Validate the init subclass args for this class so we can properly
            // evaluate its custom keyword parameters.
            if (classTypeResult) {
                evaluator.validateInitSubclassArgs(argNode.parent, classTypeResult.classType);
            }
        }
    } else {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // Determine if this node is within a quoted type annotation.
        const isWithinTypeAnnotation = ParseTreeUtils.isWithinTypeAnnotation(
            node,
            !isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(node))
        );

        // Determine if this is part of a "type" statement.
        const isWithinTypeAliasStatement = !!ParseTreeUtils.getParentNodeOfType(node, ParseNodeType.TypeAlias);
        const allowForwardReferences = isWithinTypeAnnotation || isWithinTypeAliasStatement || fileInfo.isStubFile;

        const symbolWithScope = evaluator.lookUpSymbolRecursive(
            node,
            node.d.value,
            !allowForwardReferences,
            isWithinTypeAnnotation
        );

        if (symbolWithScope) {
            appendArray(decls, symbolWithScope.symbol.getDeclarations());

            const synthTypeInfo = symbolWithScope.symbol.getSynthesizedType();
            if (synthTypeInfo) {
                synthesizedTypes.push(synthTypeInfo);
            }
        }
    }

    return { decls, synthesizedTypes };
}

export function getCallbackProtocolTypeWithEvaluator(
    objType: ClassType,
    prefetched: Partial<PrefetchedTypes> | undefined,
    evaluator: TypeEvaluator,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    if (!isClassInstance(objType) || !ClassType.isProtocolClass(objType)) {
        return undefined;
    }

    // Make sure that the protocol class doesn't define any fields that
    // a normal function wouldn't be compatible with.
    for (const mroClass of objType.shared.mro) {
        if (isClass(mroClass) && ClassType.isProtocolClass(mroClass)) {
            for (const field of ClassType.getSymbolTable(mroClass)) {
                const fieldName = field[0];
                const fieldSymbol = field[1];

                // We're expecting a __call__ method. We will also ignore a
                // __slots__ definition, which is (by convention) ignored for
                // protocol matching.
                if (fieldName === '__call__' || fieldName === '__slots__') {
                    continue;
                }

                if (fieldSymbol.isIgnoredForProtocolMatch()) {
                    continue;
                }

                let fieldIsPartOfFunction = false;

                if (prefetched?.functionClass && isClass(prefetched.functionClass)) {
                    if (ClassType.getSymbolTable(prefetched.functionClass).has(field[0])) {
                        fieldIsPartOfFunction = true;
                    }
                }

                if (!fieldIsPartOfFunction) {
                    return undefined;
                }
            }
        }
    }

    const callType = evaluator.getBoundMagicMethod(
        objType,
        '__call__',
        /* selfType */ undefined,
        /* errorNode */ undefined,
        /* diag */ undefined,
        recursionCount
    );

    if (!callType) {
        return undefined;
    }

    return makeFunctionTypeVarsBound(callType);
}

export function bindFunctionToClassOrObjectWithEvaluator(
    baseType: ClassType | undefined,
    memberType: FunctionType | OverloadedType,
    evaluator: TypeEvaluator,
    memberClass?: ClassType,
    treatConstructorAsClassMethod = false,
    selfType?: ClassType | TypeVarType,
    diag?: DiagnosticAddendum,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    return mapSignatures(memberType, (functionType) => {
        // If the caller specified no base type, always strip the
        // first parameter. This is used in cases like constructors.
        if (!baseType) {
            return FunctionType.clone(functionType, /* stripFirstParam */ true);
        }

        // If the first parameter was already stripped, it has already been
        // bound. Don't attempt to rebind.
        if (functionType.priv.strippedFirstParamType) {
            return functionType;
        }

        if (FunctionType.isInstanceMethod(functionType)) {
            // If the baseType is a metaclass, don't specialize the function.
            if (isInstantiableMetaclass(baseType)) {
                return functionType;
            }

            const baseObj: ClassType = isClassInstance(baseType)
                ? baseType
                : ClassType.cloneAsInstance(specializeWithDefaultTypeArgs(baseType));

            let stripFirstParam = false;
            if (isClassInstance(baseType)) {
                stripFirstParam = true;
            } else if (memberClass && isInstantiableMetaclass(memberClass)) {
                stripFirstParam = true;
            }

            return partiallySpecializeBoundMethodWithEvaluator(
                baseType,
                functionType,
                diag,
                recursionCount,
                selfType ?? baseObj,
                evaluator,
                stripFirstParam
            );
        }

        if (
            FunctionType.isClassMethod(functionType) ||
            (treatConstructorAsClassMethod && FunctionType.isConstructorMethod(functionType))
        ) {
            const baseClass = isInstantiableClass(baseType) ? baseType : ClassType.cloneAsInstantiable(baseType);
            const clsType = selfType ? (convertToInstantiable(selfType) as ClassType | TypeVarType) : undefined;

            return partiallySpecializeBoundMethodWithEvaluator(
                baseClass,
                functionType,
                diag,
                recursionCount,
                clsType ?? baseClass,
                evaluator,
                /* stripFirstParam */ true
            );
        }

        if (FunctionType.isStaticMethod(functionType)) {
            const baseClass = isInstantiableClass(baseType) ? baseType : ClassType.cloneAsInstantiable(baseType);

            return partiallySpecializeBoundMethodWithEvaluator(
                baseClass,
                functionType,
                diag,
                recursionCount,
                /* firstParamType */ undefined,
                evaluator,
                /* stripFirstParam */ false
            );
        }

        return functionType;
    });
}

export function partiallySpecializeBoundMethodWithEvaluator(
    baseType: ClassType,
    memberType: FunctionType,
    diag: DiagnosticAddendum | undefined,
    recursionCount: number,
    firstParamType: ClassType | TypeVarType | undefined,
    evaluator: TypeEvaluator,
    stripFirstParam = true
): FunctionType | undefined {
    const constraints = new ConstraintTracker();

    if (firstParamType) {
        if (memberType.shared.parameters.length > 0) {
            const memberTypeFirstParam = memberType.shared.parameters[0];
            const memberTypeFirstParamType = FunctionType.getParamType(memberType, 0);

            if (
                isTypeVar(memberTypeFirstParamType) &&
                memberTypeFirstParamType.shared.boundType &&
                isClassInstance(memberTypeFirstParamType.shared.boundType) &&
                ClassType.isProtocolClass(memberTypeFirstParamType.shared.boundType)
            ) {
                // Handle the protocol class specially. Some protocol classes
                // contain references to themselves or their subclasses, so if
                // we attempt to call assignType, we'll risk infinite recursion.
                // Instead, we'll assume it's assignable.
                constraints.setBounds(
                    memberTypeFirstParamType,
                    TypeBase.isInstantiable(memberTypeFirstParamType)
                        ? convertToInstance(firstParamType)
                        : firstParamType
                );
            } else {
                const subDiag = diag?.createAddendum();

                // Protect against the case where a callback protocol is being
                // bound to its own __call__ method but the first parameter
                // is annotated with its own callable type. This can lead to
                // infinite recursion.
                if (isFunctionOrOverloaded(memberTypeFirstParamType)) {
                    if (isClassInstance(firstParamType) && ClassType.isProtocolClass(firstParamType)) {
                        if (subDiag) {
                            subDiag.addMessage(
                                LocMessage.bindTypeMismatch().format({
                                    type: evaluator.printType(firstParamType),
                                    methodName: memberType.shared.name || '<anonymous>',
                                    paramName: memberTypeFirstParam.name || '__p0',
                                })
                            );
                        }
                        return undefined;
                    }
                }

                if (
                    !evaluator.assignType(
                        memberTypeFirstParamType,
                        firstParamType,
                        subDiag?.createAddendum(),
                        constraints,
                        AssignTypeFlags.AllowUnspecifiedTypeArgs,
                        recursionCount
                    )
                ) {
                    if (
                        memberTypeFirstParam.name &&
                        !FunctionParam.isNameSynthesized(memberTypeFirstParam) &&
                        FunctionParam.isTypeDeclared(memberTypeFirstParam)
                    ) {
                        if (subDiag) {
                            subDiag.addMessage(
                                LocMessage.bindTypeMismatch().format({
                                    type: evaluator.printType(firstParamType),
                                    methodName: memberType.shared.name || '<anonymous>',
                                    paramName: memberTypeFirstParam.name,
                                })
                            );
                        }
                        return undefined;
                    }
                }
            }
        } else {
            const subDiag = diag?.createAddendum();
            if (subDiag) {
                subDiag.addMessage(
                    LocMessage.bindParamMissing().format({
                        methodName: memberType.shared.name || '<anonymous>',
                    })
                );
            }
            return undefined;
        }
    }

    // Get the effective return type, which will have the side effect of lazily
    // evaluating (and caching) the inferred return type if there is no defined return type.
    getEffectiveReturnTypeForAssign(memberType, evaluator);

    const specializedFunction = evaluator.solveAndApplyConstraints(memberType, constraints);
    if (isFunction(specializedFunction)) {
        return FunctionType.clone(specializedFunction, stripFirstParam, baseType);
    }

    if (isOverloaded(specializedFunction)) {
        // For overloaded functions, use the first overload. This isn't
        // strictly correct, but this is an extreme edge case.
        return FunctionType.clone(OverloadedType.getOverloads(specializedFunction)[0], stripFirstParam, baseType);
    }

    return undefined;
}

export function printSrcDestTypesWithEvaluator(
    srcType: Type,
    destType: Type,
    evaluator: TypeEvaluator,
    options?: PrintTypeOptions
): { sourceType: string; destType: string } {
    const simpleSrcType = evaluator.printType(srcType, options);
    const simpleDestType = evaluator.printType(destType, options);

    if (simpleSrcType !== simpleDestType) {
        return { sourceType: simpleSrcType, destType: simpleDestType };
    }

    const fullSrcType = evaluator.printType(srcType, { ...(options ?? {}), useFullyQualifiedNames: true });
    const fullDestType = evaluator.printType(destType, { ...(options ?? {}), useFullyQualifiedNames: true });

    if (fullSrcType !== fullDestType) {
        return { sourceType: fullSrcType, destType: fullDestType };
    }

    return { sourceType: simpleSrcType, destType: simpleDestType };
}

export function expandArgListWithEvaluator(
    evaluator: TypeEvaluator,
    argList: Arg[],
    prefetched: Partial<PrefetchedTypes> | undefined
): Arg[] {
    const expandedArgList: Arg[] = [];

    for (const arg of argList) {
        if (arg.argCategory === ArgCategory.UnpackedList) {
            const argType = evaluator.getTypeOfArg(arg, /* inferenceContext */ undefined).type;

            // If this is a tuple with specified element types, use those
            // specified types rather than using the more generic iterator
            // type which will be a union of all element types.
            const combinedArgType = combineSameSizedTuples(
                evaluator.makeTopLevelTypeVarsConcrete(argType),
                prefetched?.tupleClass
            );

            if (isClassInstance(combinedArgType) && isTupleClass(combinedArgType)) {
                const tupleTypeArgs = combinedArgType.priv.tupleTypeArgs ?? [];

                if (tupleTypeArgs.length !== 1 || !tupleTypeArgs[0].isUnbounded) {
                    for (const tupleTypeArg of tupleTypeArgs) {
                        if (tupleTypeArg.isUnbounded) {
                            expandedArgList.push({
                                ...arg,
                                argCategory: ArgCategory.UnpackedList,
                                valueExpression: undefined,
                                typeResult: {
                                    type: makeTupleObject(evaluator, [tupleTypeArg]),
                                },
                            });
                        } else {
                            expandedArgList.push({
                                ...arg,
                                argCategory: ArgCategory.Simple,
                                valueExpression: undefined,
                                typeResult: {
                                    type: tupleTypeArg.type,
                                },
                            });
                        }
                    }
                    continue;
                }
            }
        }

        expandedArgList.push(arg);
    }

    return expandedArgList;
}

export function specializeTypeAliasWithDefaultsWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    errorNode: ExpressionNode | undefined,
    prefetched: Partial<PrefetchedTypes> | undefined
) {
    // Is this a type alias?
    const aliasInfo = type.props?.typeAliasInfo;
    if (!aliasInfo) {
        return type;
    }

    // Is this a generic type alias that needs specializing?
    if (!aliasInfo.shared.typeParams || aliasInfo.shared.typeParams.length === 0 || aliasInfo.typeArgs) {
        return type;
    }

    let reportDiag = false;
    const defaultTypeArgs: Type[] = [];
    const constraints = new ConstraintTracker();

    aliasInfo.shared.typeParams.forEach((param) => {
        if (!param.shared.isDefaultExplicit) {
            reportDiag = true;
        }

        let defaultType: Type;
        if (param.shared.isDefaultExplicit || isParamSpec(param)) {
            defaultType = evaluator.solveAndApplyConstraints(param, constraints, {
                replaceUnsolved: {
                    scopeIds: [aliasInfo.shared.typeVarScopeId],
                    tupleClassType: evaluator.getTupleClassType(),
                },
            });
        } else if (isTypeVarTuple(param) && prefetched?.tupleClass && isInstantiableClass(prefetched.tupleClass)) {
            defaultType = makeTupleObject(
                evaluator,
                [{ type: UnknownType.create(), isUnbounded: true }],
                /* isUnpacked */ true
            );
        } else {
            defaultType = UnknownType.create();
        }

        defaultTypeArgs.push(defaultType);
        constraints.setBounds(param, defaultType);
    });

    if (reportDiag && errorNode) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportMissingTypeArgument,
            LocMessage.typeArgsMissingForAlias().format({
                name: aliasInfo.shared.name,
            }),
            errorNode
        );
    }

    type = TypeBase.cloneForTypeAlias(
        evaluator.solveAndApplyConstraints(type, constraints, {
            replaceUnsolved: {
                scopeIds: [aliasInfo.shared.typeVarScopeId],
                tupleClassType: evaluator.getTupleClassType(),
            },
        }),
        { ...aliasInfo, typeArgs: defaultTypeArgs }
    );

    return type;
}

export function inferVarianceForClassWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType
): void {
    if (!classType.shared.requiresVarianceInference) {
        return;
    }

    // Presumptively mark the variance inference as complete. This
    // prevents potential recursion.
    classType.shared.requiresVarianceInference = false;

    // Presumptively mark the computed variance to "unknown". We'll
    // replace this below once the variance has been inferred.
    classType.shared.typeParams.forEach((param) => {
        if (param.shared.declaredVariance === Variance.Auto) {
            param.priv.computedVariance = Variance.Unknown;
        }
    });

    const dummyTypeObject = ClassType.createInstantiable(
        '__varianceDummy',
        '',
        '',
        Uri.empty(),
        0,
        0,
        undefined,
        undefined
    );

    classType.shared.typeParams.forEach((param, paramIndex) => {
        // Skip TypeVarTuples and ParamSpecs.
        if (isTypeVarTuple(param) || isParamSpec(param)) {
            return;
        }

        // Skip type variables without auto-variance.
        if (param.shared.declaredVariance !== Variance.Auto) {
            return;
        }

        // Replace all type arguments with a dummy type except for the
        // TypeVar of interest, which is replaced with an object instance.
        const srcTypeArgs = classType.shared.typeParams.map((p, i) => {
            if (isTypeVarTuple(p)) {
                return p;
            }
            return i === paramIndex ? evaluator.getObjectType() : dummyTypeObject;
        });

        // Replace all type arguments with a dummy type except for the
        // TypeVar of interest, which is replaced with itself.
        const destTypeArgs = classType.shared.typeParams.map((p, i) => {
            return i === paramIndex || isTypeVarTuple(p) ? p : dummyTypeObject;
        });

        const srcType = ClassType.specialize(classType, srcTypeArgs);
        const destType = ClassType.specialize(classType, destTypeArgs);

        const isDestSubtypeOfSrc = evaluator.assignClassToSelf(
            srcType,
            destType,
            Variance.Covariant,
            /* ignoreBaseClassVariance */ false
        );

        let inferredVariance: Variance;
        if (isDestSubtypeOfSrc) {
            inferredVariance = Variance.Covariant;
        } else {
            const isSrcSubtypeOfDest = evaluator.assignClassToSelf(
                destType,
                srcType,
                Variance.Contravariant,
                /* ignoreBaseClassVariance */ false
            );
            if (isSrcSubtypeOfDest) {
                inferredVariance = Variance.Contravariant;
            } else {
                inferredVariance = Variance.Invariant;
            }
        }

        // We assume here that we don't need to clone the type var object
        // because it was already cloned when it was associated with this
        // class scope.
        classType.shared.typeParams[paramIndex].priv.computedVariance = inferredVariance;
    });
}

export function getTypeOfAwaitableWithEvaluator(
    evaluator: TypeEvaluator,
    typeResult: TypeResult,
    prefetched: Partial<PrefetchedTypes> | undefined,
    errorNode?: ExpressionNode
): TypeResult {
    if (
        !prefetched?.awaitableClass ||
        !isInstantiableClass(prefetched.awaitableClass) ||
        prefetched.awaitableClass.shared.typeParams.length !== 1
    ) {
        return { type: UnknownType.create(), isIncomplete: typeResult.isIncomplete };
    }

    const awaitableProtocolObj = ClassType.cloneAsInstance(prefetched.awaitableClass);
    const isIncomplete = !!typeResult.isIncomplete;

    const type = mapSubtypes(typeResult.type, (subtype) => {
        subtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

        if (isAnyOrUnknown(subtype)) {
            return subtype;
        }

        const diag = errorNode ? new DiagnosticAddendum() : undefined;

        if (isClassInstance(subtype)) {
            const constraints = new ConstraintTracker();

            if (evaluator.assignType(awaitableProtocolObj, subtype, diag, constraints)) {
                const specializedType = evaluator.solveAndApplyConstraints(awaitableProtocolObj, constraints);

                if (
                    isClass(specializedType) &&
                    specializedType.priv.typeArgs &&
                    specializedType.priv.typeArgs.length > 0
                ) {
                    return specializedType.priv.typeArgs[0];
                }

                return UnknownType.create();
            }
        }

        if (errorNode && !typeResult.isIncomplete) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeNotAwaitable().format({ type: evaluator.printType(subtype) }) + diag?.getString(),
                errorNode
            );
        }

        return UnknownType.create();
    });

    return { type, isIncomplete };
}

export function createSelfTypeWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType,
    errorNode: ParseNode,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags
) {
    // Self doesn't support any type arguments.
    if (typeArgs && typeArgs.length > 0) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeArguments,
            LocMessage.typeArgsExpectingNone().format({
                name: classType.shared.name,
            }),
            typeArgs[0].node ?? errorNode
        );
    }

    let enclosingClass = ParseTreeUtils.getEnclosingClass(errorNode);

    // If `Self` appears anywhere outside of the class body (e.g. a decorator,
    // base class list, metaclass argument, type parameter list), it is
    // considered illegal.
    if (enclosingClass && !ParseTreeUtils.isNodeContainedWithin(errorNode, enclosingClass.d.suite)) {
        enclosingClass = undefined;
    }

    const enclosingClassTypeResult = enclosingClass ? evaluator.getTypeOfClass(enclosingClass) : undefined;
    if (!enclosingClassTypeResult) {
        if ((flags & (EvalFlags.TypeExpression | EvalFlags.InstantiableType)) !== 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.selfTypeContext(), errorNode);
        }

        return UnknownType.create();
    } else if (isInstantiableMetaclass(enclosingClassTypeResult.classType)) {
        // If `Self` appears within a metaclass, it is considered illegal.
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.selfTypeMetaclass(), errorNode);

        return UnknownType.create();
    }

    const enclosingFunction = ParseTreeUtils.getEnclosingFunction(errorNode);
    if (enclosingFunction) {
        const functionInfo = getFunctionInfoFromDecorators(
            evaluator,
            enclosingFunction,
            /* isInClass */ true
        );

        const isInnerFunction = !!ParseTreeUtils.getEnclosingFunction(enclosingFunction);
        if (!isInnerFunction) {
            // Check for static methods.
            if (functionInfo.flags & FunctionTypeFlags.StaticMethod) {
                evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.selfTypeContext(), errorNode);

                return UnknownType.create();
            }

            if (enclosingFunction.d.params.length > 0) {
                const firstParamTypeAnnotation = ParseTreeUtils.getTypeAnnotationForParam(enclosingFunction, 0);
                if (
                    firstParamTypeAnnotation &&
                    !ParseTreeUtils.isNodeContainedWithin(errorNode, firstParamTypeAnnotation)
                ) {
                    const annotationType = evaluator.getTypeOfAnnotation(firstParamTypeAnnotation, {
                        typeVarGetsCurScope: true,
                    });
                    if (!isTypeVar(annotationType) || !TypeVarType.isSelf(annotationType)) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.selfTypeWithTypedSelfOrCls(),
                            errorNode
                        );
                    }
                }
            }
        }
    }

    let result = synthesizeTypeVarForSelfCls(enclosingClassTypeResult.classType, /* isClsParam */ true);

    if (enclosingClass) {
        // If "Self" is used as a type expression within a function suite, it needs
        // to be marked as bound.
        const enclosingSuite = ParseTreeUtils.getEnclosingClassOrFunctionSuite(errorNode);

        if (enclosingSuite && ParseTreeUtils.isNodeContainedWithin(enclosingSuite, enclosingClass)) {
            if (enclosingClass.d.suite !== enclosingSuite) {
                result = TypeVarType.cloneAsBound(result);
            }
        }
    }

    return result;
}

export function applyTypeArgToTypeVarWithEvaluator(
    destType: TypeVarType,
    srcType: Type,
    diag: DiagnosticAddendum,
    evaluator: TypeEvaluator
): Type | undefined {
    if (isAnyOrUnknown(srcType)) {
        return srcType;
    }

    let effectiveSrcType: Type = transformPossibleRecursiveTypeAlias(srcType);

    if (isTypeVar(srcType)) {
        if (isTypeSame(srcType, destType)) {
            return srcType;
        }

        effectiveSrcType = evaluator.makeTopLevelTypeVarsConcrete(srcType);
    }

    // If this is a partially-evaluated class, don't perform any further
    // checks. Assume in this case that the type is compatible with the
    // bound or constraint.
    if (isClass(effectiveSrcType) && ClassType.isPartiallyEvaluated(effectiveSrcType)) {
        return srcType;
    }

    // If there's a bound type, make sure the source is derived from it.
    if (destType.shared.boundType && !isTypeAliasPlaceholder(effectiveSrcType)) {
        if (
            !evaluator.assignType(
                destType.shared.boundType,
                effectiveSrcType,
                diag.createAddendum(),
                /* constraints */ undefined
            )
        ) {
            // Avoid adding a message that will confuse users if the TypeVar was
            // synthesized for internal purposes.
            if (!destType.shared.isSynthesized) {
                diag.addMessage(
                    LocAddendum.typeBound().format({
                        sourceType: evaluator.printType(effectiveSrcType),
                        destType: evaluator.printType(destType.shared.boundType),
                        name: TypeVarType.getReadableName(destType),
                    })
                );
            }
            return undefined;
        }
    }

    if (isParamSpec(destType)) {
        if (isParamSpec(srcType)) {
            return srcType;
        }

        if (isFunction(srcType) && FunctionType.isParamSpecValue(srcType)) {
            return srcType;
        }

        if (isClassInstance(srcType) && ClassType.isBuiltIn(srcType, 'Concatenate')) {
            return srcType;
        }

        diag.addMessage(
            LocAddendum.typeParamSpec().format({
                type: evaluator.printType(srcType),
                name: TypeVarType.getReadableName(destType),
            })
        );

        return undefined;
    }

    if (isParamSpec(srcType)) {
        diag.addMessage(LocMessage.paramSpecContext());
        return undefined;
    }

    // If there are no constraints, we're done.
    const constraints = destType.shared.constraints;
    if (constraints.length === 0) {
        return srcType;
    }

    if (isTypeAliasPlaceholder(srcType)) {
        return srcType;
    }

    if (isTypeVar(srcType) && TypeVarType.hasConstraints(srcType)) {
        // Make sure all the source constraint types map to constraint types in the dest.
        if (
            srcType.shared.constraints.every((sourceConstraint) => {
                return constraints.some((destConstraint) => evaluator.assignType(destConstraint, sourceConstraint));
            })
        ) {
            return srcType;
        }
    } else {
        let bestConstraintSoFar: Type | undefined;

        // Try to find the best (narrowest) match among the constraints.
        for (const constraint of constraints) {
            if (evaluator.assignType(constraint, effectiveSrcType)) {
                // Don't allow Never to match unless the constraint is also explicitly Never.
                if (!isNever(effectiveSrcType) || isNever(constraint)) {
                    if (!bestConstraintSoFar || evaluator.assignType(bestConstraintSoFar, constraint)) {
                        bestConstraintSoFar = constraint;
                    }
                }
            }
        }

        if (bestConstraintSoFar) {
            return bestConstraintSoFar;
        }
    }

    diag.addMessage(
        LocAddendum.typeConstrainedTypeVar().format({
            type: evaluator.printType(srcType),
            name: TypeVarType.getReadableName(destType),
        })
    );

    return undefined;
}


export function verifyRaiseExceptionTypeWithEvaluator(node: ExpressionNode, allowNone: boolean, evaluator: TypeEvaluator) {
    const baseExceptionType = evaluator.getBuiltInType(node, 'BaseException');
    const exceptionType = evaluator.getTypeOfExpression(node).type;

    // Validate that the argument of "raise" is an exception object or class.
    // If it is a class, validate that the class's constructor accepts zero
    // arguments.
    if (exceptionType && baseExceptionType && isInstantiableClass(baseExceptionType)) {
        const diag = new DiagnosticAddendum();

        doForEachSubtype(exceptionType, (subtype) => {
            const concreteSubtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

            if (isAnyOrUnknown(concreteSubtype) || isNever(concreteSubtype)) {
                return;
            }

            if (allowNone && isNoneInstance(concreteSubtype)) {
                return;
            }

            if (isInstantiableClass(concreteSubtype) && concreteSubtype.priv.literalValue === undefined) {
                if (!derivesFromClassRecursive(concreteSubtype, baseExceptionType, /* ignoreUnknown */ false)) {
                    diag.addMessage(
                        LocMessage.exceptionTypeIncorrect().format({
                            type: evaluator.printType(subtype),
                        })
                    );
                } else {
                    let callResult: CallResult | undefined;
                    evaluator.suppressDiagnostics(node, () => {
                        callResult = validateConstructorArgs(
                            evaluator,
                            node,
                            [],
                            concreteSubtype,
                            /* skipUnknownArgCheck */ false,
                            /* inferenceContext */ undefined
                        );
                    });

                    if (callResult && callResult.argumentErrors) {
                        diag.addMessage(
                            LocMessage.exceptionTypeNotInstantiable().format({
                                type: evaluator.printType(subtype),
                            })
                        );
                    }
                }
            } else if (isClassInstance(concreteSubtype)) {
                if (
                    !derivesFromClassRecursive(
                        ClassType.cloneAsInstantiable(concreteSubtype),
                        baseExceptionType,
                        /* ignoreUnknown */ false
                    )
                ) {
                    diag.addMessage(
                        LocMessage.exceptionTypeIncorrect().format({
                            type: evaluator.printType(subtype),
                        })
                    );
                }
            } else {
                diag.addMessage(
                    LocMessage.exceptionTypeIncorrect().format({
                        type: evaluator.printType(subtype),
                    })
                );
            }
        });

        if (!diag.isEmpty()) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.expectedExceptionClass() + diag.getString(),
                node
            );
        }
    }
}

export function getAliasedSymbolTypeForNameWithEvaluator(
    evaluator: TypeEvaluator,
    node: ImportAsNode | ImportFromAsNode | ImportFromNode,
    name: string,
    evaluateUnknownImportsAsAny: boolean
): Type | undefined {
    const symbolWithScope = evaluator.lookUpSymbolRecursive(node, name, /* honorCodeFlow */ true);
    if (!symbolWithScope) {
        return undefined;
    }

    // Normally there will be at most one decl associated with the import node, but
    // there can be multiple in the case of the "from .X import X" statement. In such
    // case, we want to choose the last declaration.
    const filteredDecls = symbolWithScope.symbol
        .getDeclarations()
        .filter(
            (decl) => ParseTreeUtils.isNodeContainedWithin(node, decl.node) && decl.type === DeclarationType.Alias
        );
    let aliasDecl = filteredDecls.length > 0 ? filteredDecls[filteredDecls.length - 1] : undefined;

    // If we didn't find an exact match, look for any alias associated with
    // this symbol. In cases where we have multiple ImportAs nodes that share
    // the same first-part name (e.g. "import asyncio" and "import asyncio.tasks"),
    // we may not find the declaration associated with this node.
    if (!aliasDecl) {
        aliasDecl = symbolWithScope.symbol.getDeclarations().find((decl) => decl.type === DeclarationType.Alias);
    }

    if (!aliasDecl) {
        return undefined;
    }

    assert(aliasDecl.type === DeclarationType.Alias);

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

    // Try to resolve the alias while honoring external visibility.
    const resolvedAliasInfo = evaluator.resolveAliasDeclarationWithInfo(aliasDecl, /* resolveLocalNames */ true, {
        allowExternallyHiddenAccess: fileInfo.isStubFile,
    });

    if (!resolvedAliasInfo) {
        return undefined;
    }

    if (!resolvedAliasInfo.declaration) {
        return evaluateUnknownImportsAsAny ? AnyType.create() : UnknownType.create();
    }

    if (node.nodeType === ParseNodeType.ImportFromAs) {
        if (resolvedAliasInfo.isPrivate) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportPrivateUsage,
                LocMessage.privateUsedOutsideOfModule().format({
                    name: node.d.name.d.value,
                }),
                node.d.name
            );
        }

        if (resolvedAliasInfo.privatePyTypedImporter) {
            const diag = new DiagnosticAddendum();
            if (resolvedAliasInfo.privatePyTypedImported) {
                diag.addMessage(
                    LocAddendum.privateImportFromPyTypedSource().format({
                        module: resolvedAliasInfo.privatePyTypedImported,
                    })
                );
            }
            evaluator.addDiagnostic(
                DiagnosticRule.reportPrivateImportUsage,
                LocMessage.privateImportFromPyTypedModule().format({
                    name: node.d.name.d.value,
                    module: resolvedAliasInfo.privatePyTypedImporter,
                }) + diag.getString(),
                node.d.name
            );
        }
    }

    return evaluator.getInferredTypeOfDeclaration(symbolWithScope.symbol, aliasDecl);
}

export function createSpecializedClassTypeWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType,
    typeArgs: TypeResultWithNode[] | undefined,
    flags: EvalFlags,
    errorNode: ExpressionNode,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResult {
    let isValidTypeForm = true;

    // Handle the special-case classes that are not defined
    // in the type stubs.
    if (ClassType.isSpecialBuiltIn(classType)) {
        const aliasedName = classType.priv.aliasName || classType.shared.name;
        switch (aliasedName) {
            case 'Callable': {
                return { type: createCallableTypeFromArgs(classType, typeArgs, errorNode, evaluator.addDiagnostic) };
            }

            case 'Never':
            case 'NoReturn': {
                if (typeArgs && typeArgs.length > 0) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeArgsExpectingNone().format({ name: aliasedName }),
                        typeArgs[0].node
                    );
                }

                let resultType = aliasedName === 'Never' ? NeverType.createNever() : NeverType.createNoReturn();
                resultType = TypeBase.cloneAsSpecialForm(resultType, classType);
                if (isTypeFormSupportedForNode(errorNode)) {
                    resultType = TypeBase.cloneWithTypeForm(resultType, convertToInstance(resultType));
                }

                return { type: resultType };
            }

            case 'Optional': {
                return { type: createOptionalTypeFromArgs(classType, errorNode, typeArgs, flags, prefetched, evaluator.addDiagnostic) };
            }

            case 'Type': {
                let typeType = createSpecialTypeFromArgs(
                    classType,
                    typeArgs,
                    evaluator.addDiagnostic,
                    1,
                    /* allowParamSpec */ undefined,
                    /* isSpecialForm */ false
                );

                if (isInstantiableClass(typeType)) {
                    typeType = explodeGenericClass(typeType);
                }

                if (isTypeFormSupportedForNode(errorNode)) {
                    typeType = TypeBase.cloneWithTypeForm(typeType, convertToInstance(typeType));
                }

                return { type: typeType };
            }

            case 'ClassVar': {
                return { type: createClassVarTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic) };
            }

            case 'Protocol': {
                if ((flags & (EvalFlags.NoNonTypeSpecialForms | EvalFlags.TypeExpression)) !== 0) {
                    evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.protocolNotAllowed(), errorNode);
                }

                typeArgs?.forEach((typeArg) => {
                    if (typeArg.typeList || !isTypeVar(typeArg.type)) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.protocolTypeArgMustBeTypeParam(),
                            typeArg.node
                        );
                    }
                });

                return {
                    type: createSpecialTypeFromArgs(
                        classType,
                        typeArgs,
                        evaluator.addDiagnostic,
                        /* paramLimit */ undefined,
                        /* allowParamSpec */ true
                    ),
                };
            }

            case 'TypedDict': {
                if ((flags & (EvalFlags.NoNonTypeSpecialForms | EvalFlags.TypeExpression)) !== 0) {
                    const isInlinedTypedDict =
                        AnalyzerNodeInfo.getFileInfo(errorNode).diagnosticRuleSet.enableExperimentalFeatures &&
                        !!typeArgs;

                    if (!isInlinedTypedDict) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.typedDictNotAllowed(),
                            errorNode
                        );
                    }
                }
                isValidTypeForm = false;
                break;
            }

            case 'Literal': {
                if ((flags & (EvalFlags.NoNonTypeSpecialForms | EvalFlags.TypeExpression)) !== 0) {
                    evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.literalNotAllowed(), errorNode);
                }
                isValidTypeForm = false;
                break;
            }

            case 'Tuple': {
                return {
                    type: createSpecialTypeFromArgs(
                        classType,
                        typeArgs,
                        evaluator.addDiagnostic,
                        /* paramLimit */ undefined,
                        /* allowParamSpec */ false,
                        /* isSpecialForm */ false
                    ),
                };
            }

            case 'Union': {
                return { type: createUnionTypeFromArgs(classType, errorNode, typeArgs, flags, prefetched, evaluator.addDiagnostic) };
            }

            case 'Generic': {
                return { type: createGenericTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic) };
            }

            case 'Final': {
                return { type: createFinalTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic) };
            }

            case 'Annotated': {
                return createAnnotatedTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic);
            }

            case 'Concatenate': {
                return { type: createConcatenateTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic) };
            }

            case 'TypeGuard':
            case 'TypeIs': {
                return { type: createTypeGuardTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic) };
            }

            case 'Unpack': {
                return { type: createUnpackTypeFromArgs(classType, errorNode, typeArgs, flags, evaluator.addDiagnostic) };
            }

            case 'Required':
            case 'NotRequired': {
                return createRequiredOrReadOnlyTypeFromArgs(evaluator, classType, errorNode, typeArgs, flags);
            }

            case 'ReadOnly': {
                return createRequiredOrReadOnlyTypeFromArgs(evaluator, classType, errorNode, typeArgs, flags);
            }

            case 'Self': {
                return { type: createSelfTypeWithEvaluator(evaluator, classType, errorNode, typeArgs, flags) };
            }

            case 'LiteralString': {
                return { type: createSpecialTypeFromArgs(classType, typeArgs, evaluator.addDiagnostic, 0) };
            }

            case 'TypeForm': {
                return { type: createTypeFormTypeFromArgs(classType, errorNode, typeArgs, evaluator.addDiagnostic) };
            }
        }
    }

    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    if (
        fileInfo.isStubFile ||
        PythonVersion.isGreaterOrEqualTo(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_9) ||
        isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(errorNode)) ||
        (flags & EvalFlags.ForwardRefs) !== 0
    ) {
        // Handle "type" specially, since it needs to act like "Type"
        // in Python 3.9 and newer.
        if (ClassType.isBuiltIn(classType, 'type') && typeArgs) {
            if (typeArgs.length >= 1) {
                // Treat type[function] as illegal.
                if (isFunctionOrOverloaded(typeArgs[0].type)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeForm,
                        LocMessage.typeAnnotationWithCallable(),
                        typeArgs[0].node
                    );

                    return { type: UnknownType.create() };
                }
            }

            if (prefetched?.typeClass && isInstantiableClass(prefetched.typeClass)) {
                let typeType = createSpecialTypeFromArgs(
                    prefetched.typeClass,
                    typeArgs,
                    evaluator.addDiagnostic,
                    1,
                    /* allowParamSpec */ undefined,
                    /* isSpecialForm */ false
                );

                if (isInstantiableClass(typeType)) {
                    typeType = explodeGenericClass(typeType);
                }

                if (isTypeFormSupportedForNode(errorNode)) {
                    typeType = TypeBase.cloneWithTypeForm(typeType, convertToInstance(typeType));
                }

                return { type: typeType };
            }
        }

        // Handle "tuple" specially, since it needs to act like "Tuple"
        // in Python 3.9 and newer.
        if (isTupleClass(classType)) {
            let specializedClass = createSpecialTypeFromArgs(
                classType,
                typeArgs,
                evaluator.addDiagnostic,
                /* paramLimit */ undefined,
                /* allowParamSpec */ undefined,
                /* isSpecialForm */ false
            );

            if (isTypeFormSupportedForNode(errorNode)) {
                specializedClass = TypeBase.cloneWithTypeForm(
                    specializedClass,
                    convertToInstance(specializedClass)
                );
            }

            return { type: specializedClass };
        }
    }

    let typeArgCount = typeArgs ? typeArgs.length : 0;

    // Make sure the argument list count is correct.
    const typeParams = ClassType.isPseudoGenericClass(classType) ? [] : ClassType.getTypeParams(classType);

    // If there are no type parameters or args, the class is already specialized.
    // No need to do any more work.
    if (typeParams.length === 0 && typeArgCount === 0) {
        return { type: classType };
    }

    const variadicTypeParamIndex = typeParams.findIndex((param) => isTypeVarTuple(param));

    if (typeArgs) {
        let minTypeArgCount = typeParams.length;
        const firstDefaultParamIndex = typeParams.findIndex((param) => !!param.shared.isDefaultExplicit);

        if (firstDefaultParamIndex >= 0) {
            minTypeArgCount = firstDefaultParamIndex;
        }

        // Classes that accept inlined type dict type args allow only one.
        if (typeArgs.length > 0 && typeArgs[0].inlinedTypeDict) {
            if (typeArgs.length > 1) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeArguments,
                    LocMessage.typeArgsTooMany().format({
                        name: classType.priv.aliasName || classType.shared.name,
                        expected: 1,
                        received: typeArgCount,
                    }),
                    typeArgs[1].node
                );
            }

            return { type: typeArgs[0].inlinedTypeDict };
        } else if (typeArgCount > typeParams.length) {
            if (!ClassType.isPartiallyEvaluated(classType) && !ClassType.isTupleClass(classType)) {
                if (typeParams.length === 0) {
                    isValidTypeForm = false;
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeArguments,
                        LocMessage.typeArgsExpectingNone().format({
                            name: classType.priv.aliasName || classType.shared.name,
                        }),
                        typeArgs[typeParams.length].node
                    );
                } else if (typeParams.length !== 1 || !isParamSpec(typeParams[0])) {
                    isValidTypeForm = false;
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeArguments,
                        LocMessage.typeArgsTooMany().format({
                            name: classType.priv.aliasName || classType.shared.name,
                            expected: typeParams.length,
                            received: typeArgCount,
                        }),
                        typeArgs[typeParams.length].node
                    );
                }

                typeArgCount = typeParams.length;
            }
        } else if (typeArgCount < minTypeArgCount) {
            isValidTypeForm = false;
            evaluator.addDiagnostic(
                DiagnosticRule.reportInvalidTypeArguments,
                LocMessage.typeArgsTooFew().format({
                    name: classType.priv.aliasName || classType.shared.name,
                    expected: minTypeArgCount,
                    received: typeArgCount,
                }),
                typeArgs.length > 0 ? typeArgs[0].node.parent! : errorNode
            );
        }

        typeArgs.forEach((typeArg, index) => {
            if (!typeArg.type.props?.typeForm) {
                isValidTypeForm = false;
            }

            if (index === variadicTypeParamIndex) {
                // The types that make up the tuple that maps to the
                // TypeVarTuple have already been validated when the tuple
                // object was created in adjustTypeArgsForTypeVarTuple.
                if (isClassInstance(typeArg.type) && isTupleClass(typeArg.type)) {
                    return;
                }

                if (isTypeVarTuple(typeArg.type)) {
                    if (!validateTypeVarTupleIsUnpackedCheck(typeArg.type, typeArg.node, evaluator.addDiagnostic)) {
                        isValidTypeForm = false;
                    }
                    return;
                }
            }

            const typeParam = index < typeParams.length ? typeParams[index] : undefined;
            const isParamSpecTarget = typeParam && isParamSpec(typeParam);

            if (
                !validateTypeArgCheck(typeArg, evaluator.addDiagnostic, {
                    allowParamSpec: true,
                    allowTypeArgList: isParamSpecTarget,
                })
            ) {
                isValidTypeForm = false;
            }
        });
    }

    // Handle ParamSpec arguments and fill in any missing type arguments with Unknown.
    let typeArgTypes: Type[] = [];
    const fullTypeParams = ClassType.getTypeParams(classType);

    typeArgs = transformTypeArgsForParamSpecCheck(fullTypeParams, typeArgs, errorNode, evaluator.addDiagnostic);
    if (!typeArgs) {
        isValidTypeForm = false;
    }

    const constraints = new ConstraintTracker();

    fullTypeParams.forEach((typeParam, index) => {
        if (typeArgs && index < typeArgs.length) {
            if (isParamSpec(typeParam)) {
                const typeArg = typeArgs[index];
                const functionType = FunctionType.createSynthesizedInstance('', FunctionTypeFlags.ParamSpecValue);

                if (isEllipsisType(typeArg.type)) {
                    FunctionType.addDefaultParams(functionType);
                    functionType.shared.flags |= FunctionTypeFlags.GradualCallableForm;
                    typeArgTypes.push(functionType);
                    constraints.setBounds(typeParam, functionType);
                    return;
                }

                if (typeArg.typeList) {
                    typeArg.typeList!.forEach((paramType, paramIndex) => {
                        FunctionType.addParam(
                            functionType,
                            FunctionParam.create(
                                ParamCategory.Simple,
                                convertToInstance(paramType.type),
                                FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                                `__p${paramIndex}`
                            )
                        );
                    });

                    if (typeArg.typeList.length > 0) {
                        FunctionType.addPositionOnlyParamSeparator(functionType);
                    }

                    typeArgTypes.push(functionType);
                    constraints.setBounds(typeParam, functionType);
                    return;
                }

                if (isInstantiableClass(typeArg.type) && ClassType.isBuiltIn(typeArg.type, 'Concatenate')) {
                    const concatTypeArgs = typeArg.type.priv.typeArgs;
                    if (concatTypeArgs && concatTypeArgs.length > 0) {
                        concatTypeArgs.forEach((typeArg, index) => {
                            if (index === concatTypeArgs.length - 1) {
                                if (isParamSpec(typeArg)) {
                                    FunctionType.addParamSpecVariadics(functionType, typeArg);
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

                    typeArgTypes.push(functionType);
                    return;
                }
            }

            const typeArgType = convertToInstance(typeArgs[index].type);
            typeArgTypes.push(typeArgType);
            constraints.setBounds(typeParam, typeArgType);
            return;
        }

        const solvedDefaultType = evaluator.solveAndApplyConstraints(typeParam, constraints, {
            replaceUnsolved: {
                scopeIds: getTypeVarScopeIds(classType),
                tupleClassType: getTupleClassTypeFromPrefetched(prefetched),
            },
        });
        typeArgTypes.push(solvedDefaultType);
        constraints.setBounds(typeParam, solvedDefaultType);
    });

    typeArgTypes = typeArgTypes.map((typeArgType, index) => {
        if (index < typeArgCount) {
            const diag = new DiagnosticAddendum();
            let adjustedTypeArgType = applyTypeArgToTypeVarWithEvaluator(typeParams[index], typeArgType, diag, evaluator);

            // Determine if the variance must match.
            if (adjustedTypeArgType && (flags & EvalFlags.EnforceVarianceConsistency) !== 0) {
                const destType = typeParams[index];
                const declaredVariance = destType.shared.declaredVariance;

                if (!isVarianceOfTypeArgCompatible(adjustedTypeArgType, declaredVariance)) {
                    diag.addMessage(
                        LocAddendum.varianceMismatchForClass().format({
                            typeVarName: evaluator.printType(adjustedTypeArgType),
                            className: classType.shared.name,
                        })
                    );
                    adjustedTypeArgType = undefined;
                }
            }

            if (adjustedTypeArgType) {
                typeArgType = adjustedTypeArgType;
            } else {
                // Avoid emitting this error for a partially-constructed class.
                if (!isClassInstance(typeArgType) || !ClassType.isPartiallyEvaluated(typeArgType)) {
                    assert(typeArgs !== undefined);
                    isValidTypeForm = false;
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportInvalidTypeArguments,
                        LocMessage.typeVarAssignmentMismatch().format({
                            type: evaluator.printType(typeArgType),
                            name: TypeVarType.getReadableName(typeParams[index]),
                        }) + diag.getString(),
                        typeArgs[index].node
                    );
                }
            }
        }

        return typeArgType;
    });

    // If the class is partially constructed and doesn't yet have
    // type parameters, assume that the number and types of supplied type
    // arguments are correct.
    if (typeArgs && classType.shared.typeParams.length === 0 && ClassType.isPartiallyEvaluated(classType)) {
        typeArgTypes = typeArgs.map((t) => convertToInstance(t.type));
    }

    let specializedClass = ClassType.specialize(classType, typeArgTypes, typeArgs !== undefined);

    if (isTypeFormSupportedForNode(errorNode)) {
        specializedClass = TypeBase.cloneWithTypeForm(
            specializedClass,
            isValidTypeForm ? convertToInstance(specializedClass) : undefined
        );
    }

    return { type: specializedClass };
}

export function getBoundMagicMethodWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType,
    memberName: string,
    selfType?: ClassType | TypeVarType | undefined,
    errorNode?: ExpressionNode | undefined,
    diag?: DiagnosticAddendum,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    const boundMethodResult = evaluator.getTypeOfBoundMember(
        errorNode as unknown as ExpressionNode,
        classType,
        memberName,
        /* usage */ undefined,
        diag,
        MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride,
        selfType,
        recursionCount
    );

    if (!boundMethodResult || boundMethodResult.typeErrors) {
        return undefined;
    }

    if (isFunctionOrOverloaded(boundMethodResult.type)) {
        return boundMethodResult.type;
    }

    if (isClassInstance(boundMethodResult.type)) {
        if (recursionCount > maxTypeRecursionCount) {
            return undefined;
        }
        recursionCount++;

        return getBoundMagicMethodWithEvaluator(
            evaluator,
            boundMethodResult.type,
            '__call__',
            /* selfType */ undefined,
            errorNode,
            diag,
            recursionCount
        );
    }

    if (isAnyOrUnknown(boundMethodResult.type)) {
        return getUnknownTypeForCallable();
    }

    return undefined;
}

export function applyConditionFilterToTypeWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    conditionFilter: TypeCondition[],
    recursionCount: number
): Type | undefined {
    if (recursionCount > maxTypeRecursionCount) {
        return type;
    }
    recursionCount++;

    // If the type has a condition associated with it, make sure it's compatible.
    if (!TypeCondition.isCompatible(getTypeCondition(type), conditionFilter)) {
        return undefined;
    }

    // If the type is generic, see if any of its type arguments should be filtered.
    // This is possible only in cases where the type parameter is covariant.

    // TODO - handle functions and tuples
    if (isClass(type) && type.priv.typeArgs && !type.priv.tupleTypeArgs) {
        evaluator.inferVarianceForClass(type);

        let typeWasTransformed = false;

        const filteredTypeArgs = type.priv.typeArgs.map((typeArg, index) => {
            if (index >= type.shared.typeParams.length) {
                return typeArg;
            }

            const variance = TypeVarType.getVariance(type.shared.typeParams[index]);
            if (variance !== Variance.Covariant) {
                return typeArg;
            }

            // Don't expand recursive type aliases because they can
            // cause infinite recursion.
            if (isTypeVar(typeArg) && typeArg.shared.recursiveAlias) {
                return typeArg;
            }

            const filteredTypeArg = evaluator.mapSubtypesExpandTypeVars(
                typeArg,
                { conditionFilter },
                (expandedSubtype) => {
                    return expandedSubtype;
                }
            );

            if (filteredTypeArg !== typeArg) {
                typeWasTransformed = true;
            }

            return filteredTypeArg;
        });

        if (typeWasTransformed) {
            return ClassType.specialize(type, filteredTypeArgs);
        }
    }

    return type;
}

export function buildTupleTypesListWithEvaluator(
    evaluator: TypeEvaluator,
    entryTypeResults: TypeResult[],
    stripLiterals: boolean,
    convertModule: boolean,
    prefetched: Partial<PrefetchedTypes> | undefined
): TupleTypeArg[] {
    const entryTypes: TupleTypeArg[] = [];

    for (const typeResult of entryTypeResults) {
        let possibleUnpackedTuple: Type | undefined;
        if (typeResult.unpackedType) {
            possibleUnpackedTuple = typeResult.unpackedType;
        } else if (isUnpacked(typeResult.type)) {
            possibleUnpackedTuple = typeResult.type;
        }

        // Is this an unpacked tuple? If so, we can append the individual
        // unpacked entries onto the new tuple. If it's not an upacked tuple
        // but some other iterator (e.g. a List), we won't know the number of
        // items, so we'll need to leave the Tuple open-ended.
        if (
            possibleUnpackedTuple &&
            isClassInstance(possibleUnpackedTuple) &&
            possibleUnpackedTuple.priv.tupleTypeArgs
        ) {
            const typeArgs = possibleUnpackedTuple.priv.tupleTypeArgs;

            if (!typeArgs) {
                entryTypes.push({ type: UnknownType.create(), isUnbounded: true });
            } else {
                appendArray(entryTypes, typeArgs);
            }
        } else if (isNever(typeResult.type) && typeResult.isIncomplete && !typeResult.unpackedType) {
            entryTypes.push({ type: UnknownType.create(/* isIncomplete */ true), isUnbounded: false });
        } else {
            let entryType = convertSpecialFormToRuntimeValueWithPrefetched(typeResult.type, EvalFlags.None, prefetched, convertModule);
            entryType = stripLiterals ? stripTypeForm(evaluator.stripLiteralValue(entryType)) : entryType;
            entryTypes.push({ type: entryType, isUnbounded: !!typeResult.unpackedType });
        }
    }

    // If there are multiple unbounded entries, combine all of them into a single
    // unbounded entry to avoid violating the invariant that there can be at most
    // one unbounded entry in a tuple.
    if (entryTypes.filter((t) => t.isUnbounded).length > 1) {
        const firstUnboundedEntryIndex = entryTypes.findIndex((t) => t.isUnbounded);
        const removedEntries = entryTypes.splice(firstUnboundedEntryIndex);
        entryTypes.push({ type: combineTypes(removedEntries.map((t) => t.type)), isUnbounded: true });
    }

    return entryTypes;
}

export function validateCallForClassInstanceWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    expandedCallType: ClassType,
    unexpandedCallType: Type,
    constraints: ConstraintTracker | undefined,
    skipUnknownArgCheck: boolean | undefined,
    inferenceContext: InferenceContext | undefined,
    recursionCount: number
): CallResult {
    const callDiag = new DiagnosticAddendum();
    const callMethodResult = evaluator.getTypeOfBoundMember(
        errorNode,
        expandedCallType,
        '__call__',
        /* usage */ undefined,
        callDiag,
        MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.SkipAttributeAccessOverride,
        /* selfType */ undefined,
        recursionCount
    );
    const callMethodType = callMethodResult?.type;

    if (!callMethodType || callMethodResult.typeErrors) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportCallIssue,
            LocMessage.objectNotCallable().format({
                type: evaluator.printType(expandedCallType),
            }) + callDiag.getString(),
            errorNode
        );

        return { returnType: UnknownType.create(), argumentErrors: true };
    }

    const callResult = evaluator.validateCallArgs(
        errorNode,
        argList,
        { type: callMethodType },
        constraints,
        skipUnknownArgCheck,
        inferenceContext
    );

    let returnType = callResult.returnType ?? UnknownType.create();
    if (
        isTypeVar(unexpandedCallType) &&
        TypeBase.isInstantiable(unexpandedCallType) &&
        isClass(expandedCallType) &&
        ClassType.isBuiltIn(expandedCallType, 'type')
    ) {
        // Handle the case where a type[T] is being called. We presume this
        // will instantiate an object of type T.
        returnType = convertToInstance(unexpandedCallType);
    }

    return {
        returnType,
        argumentErrors: callResult.argumentErrors,
        overloadsUsedForCall: callResult.overloadsUsedForCall,
    };
}

export function isAsymmetricDescriptorClassWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType
): boolean {
    // If the value has already been cached in this type, return the cached value.
    if (classType.priv.isAsymmetricDescriptor !== undefined) {
        return classType.priv.isAsymmetricDescriptor;
    }

    let isAsymmetric = false;

    const getterSymbolResult = lookUpClassMember(classType, '__get__', MemberAccessFlags.SkipBaseClasses);
    const setterSymbolResult = lookUpClassMember(classType, '__set__', MemberAccessFlags.SkipBaseClasses);

    if (!getterSymbolResult || !setterSymbolResult) {
        isAsymmetric = false;
    } else {
        let getterType = evaluator.getTypeOfMember(getterSymbolResult);
        const setterType = evaluator.getTypeOfMember(setterSymbolResult);

        // If this is an overload, find the appropriate overload.
        if (isOverloaded(getterType)) {
            const getOverloads = OverloadedType.getOverloads(getterType).filter((overload) => {
                if (overload.shared.parameters.length < 2) {
                    return false;
                }
                const param1Type = FunctionType.getParamType(overload, 1);
                return !isNoneInstance(param1Type);
            });

            if (getOverloads.length === 1) {
                getterType = getOverloads[0];
            } else {
                isAsymmetric = true;
            }
        }

        // If this is an overload, find the appropriate overload.
        if (isOverloaded(setterType)) {
            isAsymmetric = true;
        }

        // If either the setter or getter is an overload (or some other non-function type),
        // conservatively assume that it's not asymmetric.
        if (isFunction(getterType) && isFunction(setterType)) {
            // If there's no declared return type on the getter, assume it's symmetric.
            if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                const setterValueType = FunctionType.getParamType(setterType, 2);
                const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                if (!isTypeSame(setterValueType, getterReturnType)) {
                    isAsymmetric = true;
                }
            }
        }
    }

    // Cache the value for next time.
    classType.priv.isAsymmetricDescriptor = isAsymmetric;
    return isAsymmetric;
}

export function isClassWithAsymmetricAttributeAccessorWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType
): boolean {
    // If the value has already been cached in this type, return the cached value.
    if (classType.priv.isAsymmetricAttributeAccessor !== undefined) {
        return classType.priv.isAsymmetricAttributeAccessor;
    }

    let isAsymmetric = false;

    const getterSymbolResult = lookUpClassMember(classType, '__getattr__', MemberAccessFlags.SkipBaseClasses);
    const setterSymbolResult = lookUpClassMember(classType, '__setattr__', MemberAccessFlags.SkipBaseClasses);

    if (!getterSymbolResult || !setterSymbolResult) {
        isAsymmetric = false;
    } else {
        const getterType = evaluator.getEffectiveTypeOfSymbol(getterSymbolResult.symbol);
        const setterType = evaluator.getEffectiveTypeOfSymbol(setterSymbolResult.symbol);

        // If either the setter or getter is an overload (or some other non-function type),
        // conservatively assume that it's not asymmetric.
        if (isFunction(getterType) && isFunction(setterType)) {
            // If there's no declared return type on the getter, assume it's symmetric.
            if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                const setterValueType = FunctionType.getParamType(setterType, 2);
                const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                if (!isTypeSame(setterValueType, getterReturnType)) {
                    isAsymmetric = true;
                }
            }
        }
    }

    // Cache the value for next time.
    classType.priv.isAsymmetricAttributeAccessor = isAsymmetric;
    return isAsymmetric;
}

export function verifyTypeVarDefaultIsCompatibleWithEvaluator(
    evaluator: TypeEvaluator,
    typeVar: TypeVarType,
    defaultValueNode: ExpressionNode
) {
    assert(typeVar.shared.isDefaultExplicit);

    const constraints = new ConstraintTracker();
    const concreteDefaultType = evaluator.makeTopLevelTypeVarsConcrete(
        evaluator.solveAndApplyConstraints(typeVar.shared.defaultType, constraints, {
            replaceUnsolved: {
                scopeIds: getTypeVarScopeIds(typeVar),
                tupleClassType: evaluator.getTupleClassType(),
            },
        })
    );

    if (typeVar.shared.boundType) {
        if (!evaluator.assignType(typeVar.shared.boundType, concreteDefaultType)) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarDefaultBoundMismatch(),
                defaultValueNode
            );
        }
    } else if (TypeVarType.hasConstraints(typeVar)) {
        let isConstraintCompatible = true;

        // If the default type is a constrained TypeVar, make sure all of its constraints
        // are also constraints in typeVar. If the default type is not a constrained TypeVar,
        // use its concrete type to compare against the constraints.
        if (isTypeVar(typeVar.shared.defaultType) && TypeVarType.hasConstraints(typeVar.shared.defaultType)) {
            for (const constraint of typeVar.shared.defaultType.shared.constraints) {
                if (!typeVar.shared.constraints.some((c) => isTypeSame(c, constraint))) {
                    isConstraintCompatible = false;
                }
            }
        } else if (
            !typeVar.shared.constraints.some((constraint) =>
                isTypeSame(constraint, concreteDefaultType, { ignoreConditions: true })
            )
        ) {
            isConstraintCompatible = false;
        }

        if (!isConstraintCompatible) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarDefaultConstraintMismatch(),
                defaultValueNode
            );
        }
    }
}

export function methodAlwaysRaisesNotImplementedWithEvaluator(
    evaluator: TypeEvaluator,
    functionDecl?: FunctionDeclaration
): boolean {
    if (
        !functionDecl ||
        !functionDecl.isMethod ||
        functionDecl.returnStatements ||
        functionDecl.yieldStatements ||
        !functionDecl.raiseStatements
    ) {
        return false;
    }

    const statements = functionDecl.node.d.suite.d.statements;
    if (statements.some((statement) => statement.nodeType !== ParseNodeType.StatementList)) {
        return false;
    }

    for (const raiseStatement of functionDecl.raiseStatements) {
        if (!raiseStatement.d.expr || raiseStatement.d.fromExpr) {
            return false;
        }
        const raiseType = evaluator.getTypeOfExpression(raiseStatement.d.expr).type;
        const classType = isInstantiableClass(raiseType)
            ? raiseType
            : isClassInstance(raiseType)
            ? raiseType
            : undefined;
        if (!classType || !derivesFromStdlibClass(classType, 'NotImplementedError')) {
            return false;
        }
    }

    return true;
}

export function evaluateComprehensionForIfWithEvaluator(
    evaluator: TypeEvaluator,
    node: ComprehensionForIfNode
) {
    let isIncomplete = false;

    if (node.nodeType === ParseNodeType.ComprehensionFor) {
        const iterableTypeResult = evaluator.getTypeOfExpression(node.d.iterableExpr);
        if (iterableTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        const iterableType = evaluator.stripLiteralValue(iterableTypeResult.type);
        const itemTypeResult = evaluator.getTypeOfIterator(
            { type: iterableType, isIncomplete: iterableTypeResult.isIncomplete },
            !!node.d.isAsync,
            node.d.iterableExpr
        ) ?? { type: UnknownType.create(), isIncomplete: iterableTypeResult.isIncomplete };

        const targetExpr = node.d.targetExpr;
        evaluator.assignTypeToExpression(targetExpr, itemTypeResult, node.d.iterableExpr);
    } else {
        assert(node.nodeType === ParseNodeType.ComprehensionIf);

        // Evaluate the test expression to validate it and mark symbols
        // as referenced. This doesn't affect the type of the evaluated
        // comprehension, but it is important for evaluating intermediate
        // expressions such as assignment expressions that can affect other
        // subexpressions.
        evaluator.getTypeOfExpression(node.d.testExpr);
    }

    return isIncomplete;
}

export function getTypeVarTupleDefaultTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    isPep695Syntax: boolean
): Type | undefined {
    const argType = evaluator.getTypeOfExpressionExpectingType(node, {
        allowUnpackedTuple: true,
        allowTypeVarsWithoutScopeId: true,
        forwardRefs: isPep695Syntax,
        typeExpression: true,
    }).type;
    const isUnpackedTuple = isClass(argType) && isTupleClass(argType) && argType.priv.isUnpacked;
    const isUnpackedTypeVar = isUnpackedTypeVarTuple(argType);

    if (!isUnpackedTuple && !isUnpackedTypeVar) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.typeVarTupleDefaultNotUnpacked(), node);
        return undefined;
    }

    return convertToInstance(argType);
}

export function adjustParamAnnotatedTypeWithEvaluator(
    evaluator: TypeEvaluator,
    param: ParameterNode,
    type: Type
): Type {
    // PEP 484 indicates that if a parameter has a default value of 'None'
    // the type checker should assume that the type is optional (i.e. a union
    // of the specified type and 'None'). Skip this step if the type is already
    // optional to avoid losing alias names when combining the types.
    if (
        param.d.defaultValue?.nodeType === ParseNodeType.Constant &&
        param.d.defaultValue.d.constType === KeywordType.None &&
        !isOptionalType(type) &&
        !AnalyzerNodeInfo.getFileInfo(param).diagnosticRuleSet.strictParameterNoneValue
    ) {
        return combineTypes([type, evaluator.getNoneType()]);
    }

    return type;
}

export function isExplicitTypeAliasDeclarationWithEvaluator(
    evaluator: TypeEvaluator,
    decl: Declaration
): boolean {
    if (decl.type !== DeclarationType.Variable || !decl.typeAnnotationNode) {
        return false;
    }

    if (
        decl.typeAnnotationNode.nodeType !== ParseNodeType.Name &&
        decl.typeAnnotationNode.nodeType !== ParseNodeType.MemberAccess &&
        decl.typeAnnotationNode.nodeType !== ParseNodeType.StringList
    ) {
        return false;
    }

    const type = evaluator.getTypeOfAnnotation(decl.typeAnnotationNode, { varTypeAnnotation: true, allowClassVar: true });
    return isClassInstance(type) && ClassType.isBuiltIn(type, 'TypeAlias');
}

export function getDeclaredReturnTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: FunctionNode
): Type | undefined {
    const functionTypeInfo = evaluator.getTypeOfFunction(node);
    const returnType = functionTypeInfo?.functionType.shared.declaredReturnType;

    if (!returnType) {
        return undefined;
    }

    if (FunctionType.isGenerator(functionTypeInfo.functionType)) {
        return getDeclaredGeneratorReturnType(functionTypeInfo.functionType);
    }

    return returnType;
}

export function getBuiltInTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: ParseNode,
    name: string
): Type {
    const scope = ScopeUtils.getScopeForNode(node);
    if (scope) {
        const builtInScope = ScopeUtils.getBuiltInScope(scope);
        const nameType = builtInScope.lookUpSymbol(name);
        if (nameType) {
            return evaluator.getEffectiveTypeOfSymbol(nameType);
        }
    }

    return UnknownType.create();
}

export function getBuiltInObjectWithEvaluator(
    evaluator: TypeEvaluator,
    node: ParseNode,
    name: string,
    typeArgs?: Type[]
) {
    const nameType = evaluator.getBuiltInType(node, name);
    if (isInstantiableClass(nameType)) {
        let classType = nameType;
        if (typeArgs) {
            classType = ClassType.specialize(classType, typeArgs);
        }

        return ClassType.cloneAsInstance(classType);
    }

    return nameType;
}

export function createTypeVarTypeWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    argList: Arg[]
): Type | undefined {
    let typeVarName = '';
    let firstConstraintArg: Arg | undefined;
    let defaultValueNode: ExpressionNode | undefined;

    if (argList.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.typeVarFirstArg(), errorNode);
        return undefined;
    }

    const firstArg = argList[0];
    if (firstArg.valueExpression && firstArg.valueExpression.nodeType === ParseNodeType.StringList) {
        typeVarName = firstArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    } else {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarFirstArg(),
            firstArg.valueExpression || errorNode
        );
    }

    const typeVar = TypeBase.cloneAsSpecialForm(
        TypeVarType.createInstantiable(typeVarName),
        ClassType.cloneAsInstance(classType)
    );

    // Parse the remaining parameters.
    const paramNameMap = new Map<string, string>();
    for (let i = 1; i < argList.length; i++) {
        const paramNameNode = argList[i].name;
        const paramName = paramNameNode ? paramNameNode.d.value : undefined;

        if (paramName) {
            if (paramNameMap.get(paramName)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.duplicateParam().format({ name: paramName }),
                    argList[i].valueExpression || errorNode
                );
            }

            if (paramName === 'bound') {
                if (TypeVarType.hasConstraints(typeVar)) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarBoundAndConstrained(),
                        argList[i].valueExpression || errorNode
                    );
                } else {
                    const argType =
                        argList[i].typeResult?.type ??
                        evaluator.getTypeOfExpressionExpectingType(argList[i].valueExpression!, {
                            noNonTypeSpecialForms: true,
                            typeExpression: true,
                            parsesStringLiteral: true,
                        }).type;
                    if (
                        requiresSpecialization(argType, { ignorePseudoGeneric: true, ignoreImplicitTypeArgs: true })
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarBoundGeneric(),
                            argList[i].valueExpression || errorNode
                        );
                    }
                    typeVar.shared.boundType = convertToInstance(argType);
                }
            } else if (paramName === 'covariant') {
                if (argList[i].valueExpression && getBooleanValueFromNode(argList[i].valueExpression!, evaluator.addDiagnostic)) {
                    if (
                        typeVar.shared.declaredVariance === Variance.Contravariant ||
                        typeVar.shared.declaredVariance === Variance.Auto
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarVariance(),
                            argList[i].valueExpression!
                        );
                    } else {
                        typeVar.shared.declaredVariance = Variance.Covariant;
                    }
                }
            } else if (paramName === 'contravariant') {
                if (argList[i].valueExpression && getBooleanValueFromNode(argList[i].valueExpression!, evaluator.addDiagnostic)) {
                    if (
                        typeVar.shared.declaredVariance === Variance.Covariant ||
                        typeVar.shared.declaredVariance === Variance.Auto
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarVariance(),
                            argList[i].valueExpression!
                        );
                    } else {
                        typeVar.shared.declaredVariance = Variance.Contravariant;
                    }
                }
            } else if (paramName === 'infer_variance') {
                if (argList[i].valueExpression && getBooleanValueFromNode(argList[i].valueExpression!, evaluator.addDiagnostic)) {
                    if (
                        typeVar.shared.declaredVariance === Variance.Covariant ||
                        typeVar.shared.declaredVariance === Variance.Contravariant
                    ) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportGeneralTypeIssues,
                            LocMessage.typeVarVariance(),
                            argList[i].valueExpression!
                        );
                    } else {
                        typeVar.shared.declaredVariance = Variance.Auto;
                    }
                }
            } else if (paramName === 'default') {
                defaultValueNode = argList[i].valueExpression;
                const argType =
                    argList[i].typeResult?.type ??
                    evaluator.getTypeOfExpressionExpectingType(defaultValueNode!, {
                        allowTypeVarsWithoutScopeId: true,
                        typeExpression: true,
                    }).type;
                typeVar.shared.defaultType = convertToInstance(argType);
                typeVar.shared.isDefaultExplicit = true;

                const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
                if (
                    !fileInfo.isStubFile &&
                    PythonVersion.isLessThan(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_13) &&
                    classType.shared.moduleName !== 'typing_extensions'
                ) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarDefaultIllegal(),
                        defaultValueNode!
                    );
                }
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportCallIssue,
                    LocMessage.typeVarUnknownParam().format({ name: paramName }),
                    argList[i].node?.d.name || argList[i].valueExpression || errorNode
                );
            }

            paramNameMap.set(paramName, paramName);
        } else {
            if (TypeVarType.hasBound(typeVar)) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeVarBoundAndConstrained(),
                    argList[i].valueExpression || errorNode
                );
            } else {
                const argType =
                    argList[i].typeResult?.type ??
                    evaluator.getTypeOfExpressionExpectingType(argList[i].valueExpression!, {
                        typeExpression: true,
                    }).type;

                if (requiresSpecialization(argType, { ignorePseudoGeneric: true })) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarConstraintGeneric(),
                        argList[i].valueExpression || errorNode
                    );
                }
                TypeVarType.addConstraint(typeVar, convertToInstance(argType));
                if (firstConstraintArg === undefined) {
                    firstConstraintArg = argList[i];
                }
            }
        }
    }

    if (typeVar.shared.constraints.length === 1 && firstConstraintArg) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarSingleConstraint(),
            firstConstraintArg.valueExpression || errorNode
        );
    }

    // If a default is provided, make sure it is compatible with the bound
    // or constraint.
    if (typeVar.shared.isDefaultExplicit && defaultValueNode) {
        verifyTypeVarDefaultIsCompatibleWithEvaluator(evaluator, typeVar, defaultValueNode);
    }

    return typeVar;
}

export function getAbstractSymbolInfoWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType,
    symbolName: string
): AbstractSymbol | undefined {
    const isProtocolClass = ClassType.isProtocolClass(classType);

    const symbol = ClassType.getSymbolTable(classType).get(symbolName);
    if (!symbol) {
        return undefined;
    }

    if (!symbol.isClassMember() && !symbol.isNamedTupleMemberMember()) {
        return undefined;
    }

    const lastDecl = getLastTypedDeclarationForSymbol(symbol);
    if (!lastDecl) {
        return undefined;
    }

    if (isProtocolClass && lastDecl.type === DeclarationType.Variable) {
        const allDecls = symbol.getDeclarations();
        if (!allDecls.some((decl) => decl.type === DeclarationType.Variable && !!decl.inferredTypeSource)) {
            return { symbol, symbolName, classType, hasImplementation: false };
        }
    }

    if (lastDecl.type !== DeclarationType.Function) {
        return undefined;
    }

    let isAbstract = false;
    const lastFunctionInfo = getFunctionInfoFromDecorators(evaluator, lastDecl.node, /* isInClass */ true);
    if ((lastFunctionInfo.flags & FunctionTypeFlags.AbstractMethod) !== 0) {
        isAbstract = true;
    }

    const isStubFile = AnalyzerNodeInfo.getFileInfo(lastDecl.node).isStubFile;

    const firstDecl = symbol.getDeclarations()[0];
    let firstFunctionInfo: FunctionDecoratorInfo | undefined;

    if (firstDecl !== lastDecl && firstDecl.type === DeclarationType.Function) {
        firstFunctionInfo = getFunctionInfoFromDecorators(evaluator, firstDecl.node, /* isInClass */ true);
        if ((firstFunctionInfo.flags & FunctionTypeFlags.AbstractMethod) !== 0) {
            isAbstract = true;
        }

        if (isProtocolClass && (lastFunctionInfo.flags & FunctionTypeFlags.Overloaded) !== 0) {
            if (isProtocolClass && !isAbstract && isStubFile) {
                return undefined;
            }

            return { symbol, symbolName, classType, hasImplementation: false };
        }
    }

    if (!isProtocolClass && !isAbstract) {
        return undefined;
    }

    const hasImplementation =
        !ParseTreeUtils.isSuiteEmpty(lastDecl.node.d.suite) && !methodAlwaysRaisesNotImplementedWithEvaluator(evaluator, lastDecl);

    if (isProtocolClass && !isAbstract) {
        if (hasImplementation || isStubFile) {
            return undefined;
        }
    }

    return { symbol, symbolName, classType, hasImplementation };
}

export function inferParamTypeFromDefaultValueWithEvaluator(
    evaluator: TypeEvaluator,
    paramValueExpr: ExpressionNode,
    prefetched: Partial<PrefetchedTypes> | undefined
) {
    const defaultValueType = evaluator.getTypeOfExpression(paramValueExpr, EvalFlags.ConvertEllipsisToAny).type;

    let inferredParamType: Type | undefined;

    if (
        isNoneInstance(defaultValueType) ||
        isSentinelLiteral(defaultValueType) ||
        (isClassInstance(defaultValueType) && isPrivateOrProtectedName(defaultValueType.shared.name))
    ) {
        inferredParamType = combineTypes([defaultValueType, UnknownType.create()]);
    } else {
        let skipInference = false;

        if (isFunctionOrOverloaded(defaultValueType)) {
            skipInference = true;
        } else if (
            isClassInstance(defaultValueType) &&
            ClassType.isBuiltIn(defaultValueType, ['tuple', 'list', 'set', 'dict'])
        ) {
            skipInference = true;
        }

        if (!skipInference) {
            inferredParamType = convertSpecialFormToRuntimeValueWithPrefetched(
                defaultValueType,
                EvalFlags.None,
                prefetched,
                /* convertModule */ true
            );
            inferredParamType = stripTypeForm(inferredParamType);
            inferredParamType = evaluator.stripLiteralValue(inferredParamType);
        }
    }

    if (inferredParamType) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(paramValueExpr);
        if (fileInfo.isInPyTypedPackage && !fileInfo.isStubFile) {
            inferredParamType = TypeBase.cloneForAmbiguousType(inferredParamType);
        }
    }

    return inferredParamType;
}

export function addTypeFormForSymbolWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    type: Type,
    flags: EvalFlags,
    includesVarDecl: boolean
): Type {
    if (!isTypeFormSupportedForNode(node)) {
        return type;
    }

    const isValid = isSymbolValidTypeExpressionCheck(type, includesVarDecl);

    if (type.props?.typeForm) {
        if ((flags & EvalFlags.NoConvertSpecialForm) !== 0 && !isValid) {
            type = TypeBase.cloneWithTypeForm(type, undefined);
        }
        return type;
    }

    if (!isValid) {
        return type;
    }

    if (isTypeVar(type) && type.priv.scopeId && !type.shared.isSynthesized) {
        if (!isTypeVarTuple(type) || !type.priv.isInUnion) {
            const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
            type = TypeBase.cloneWithTypeForm(type, convertToInstance(makeTypeVarsBound(type, liveScopeIds)));
        }
    } else if (isInstantiableClass(type) && !type.priv.includeSubclasses && !ClassType.isSpecialBuiltIn(type)) {
        if (ClassType.isBuiltIn(type, 'Any')) {
            type = TypeBase.cloneWithTypeForm(type, AnyType.create());
        } else {
            type = TypeBase.cloneWithTypeForm(type, ClassType.cloneAsInstance(specializeWithDefaultTypeArgs(type)));
        }
    }

    if (type.props?.typeAliasInfo && TypeBase.isInstantiable(type)) {
        let typeFormType = type;
        if ((flags & EvalFlags.NoSpecialize) === 0) {
            typeFormType = specializeTypeAliasWithDefaultsWithEvaluator(evaluator, typeFormType, /* errorNode */ undefined, /* prefetched */ undefined);
        }

        type = TypeBase.cloneWithTypeForm(type, convertToInstance(typeFormType));
    }

    return type;
}

export function createTypeVarTupleTypeWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    argList: Arg[],
    prefetched: Partial<PrefetchedTypes> | undefined
): Type | undefined {
    let typeVarName = '';

    if (argList.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.typeVarFirstArg(), errorNode);
        return undefined;
    }

    const firstArg = argList[0];
    if (firstArg.valueExpression && firstArg.valueExpression.nodeType === ParseNodeType.StringList) {
        typeVarName = firstArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    } else {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.typeVarFirstArg(),
            firstArg.valueExpression || errorNode
        );
    }

    const typeVar = TypeBase.cloneAsSpecialForm(
        TypeVarType.createInstantiable(typeVarName, TypeVarKind.TypeVarTuple),
        ClassType.cloneAsInstance(classType)
    );
    typeVar.shared.defaultType = makeTupleObject(evaluator, [
        { type: UnknownType.create(), isUnbounded: true },
    ]);

    for (let i = 1; i < argList.length; i++) {
        const paramNameNode = argList[i].name;
        const paramName = paramNameNode ? paramNameNode.d.value : undefined;

        if (paramName) {
            if (paramName === 'default') {
                const expr = argList[i].valueExpression;
                if (expr) {
                    const defaultType = getTypeVarTupleDefaultTypeWithEvaluator(evaluator, expr, /* isPep695Syntax */ false);
                    if (defaultType) {
                        typeVar.shared.defaultType = defaultType;
                        typeVar.shared.isDefaultExplicit = true;
                    }
                }

                const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
                if (
                    !fileInfo.isStubFile &&
                    PythonVersion.isLessThan(fileInfo.executionEnvironment.pythonVersion, pythonVersion3_13) &&
                    classType.shared.moduleName !== 'typing_extensions'
                ) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.typeVarDefaultIllegal(),
                        expr!
                    );
                }
            } else {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportGeneralTypeIssues,
                    LocMessage.typeVarTupleUnknownParam().format({ name: argList[i].name?.d.value || '?' }),
                    argList[i].node?.d.name || argList[i].valueExpression || errorNode
                );
            }
        } else {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeVarTupleConstraints(),
                argList[i].valueExpression || errorNode
            );
        }
    }

    return typeVar;
}

export function reportMissingTypeArgsWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    type: Type,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined
): Type {
    if ((flags & EvalFlags.NoSpecialize) !== 0) {
        return type;
    }

    if (isInstantiableClass(type)) {
        if ((flags & EvalFlags.InstantiableType) !== 0 && (flags & EvalFlags.AllowMissingTypeArgs) === 0) {
            if (!type.props?.typeAliasInfo && requiresTypeArgs(type)) {
                if (!type.priv.typeArgs || !type.priv.isTypeArgExplicit) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportMissingTypeArgument,
                        LocMessage.typeArgsMissingForClass().format({
                            name: type.priv.aliasName || type.shared.name,
                        }),
                        node
                    );
                }
            }
        }

        if (!type.priv.typeArgs) {
            type = createSpecializedClassTypeWithEvaluator(evaluator, type, /* typeArgs */ undefined, flags, node, prefetched)?.type;
        }
    }

    if ((flags & EvalFlags.InstantiableType) !== 0) {
        type = specializeTypeAliasWithDefaultsWithEvaluator(evaluator, type, node, prefetched);
    }

    return type;
}

export function getAbstractSymbolsWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType
): AbstractSymbol[] {
    const symbolTable = new Map<string, AbstractSymbol>();

    ClassType.getReverseMro(classType).forEach((mroClass) => {
        if (isInstantiableClass(mroClass)) {
            ClassType.getSymbolTable(mroClass).forEach((symbol, symbolName) => {
                const abstractSymbolInfo = getAbstractSymbolInfoWithEvaluator(evaluator, mroClass, symbolName);

                if (abstractSymbolInfo) {
                    symbolTable.set(symbolName, abstractSymbolInfo);
                } else {
                    symbolTable.delete(symbolName);
                }
            });
        }
    });

    const symbolList: AbstractSymbol[] = [];
    symbolTable.forEach((method) => {
        symbolList.push(method);
    });

    return symbolList;
}

export function isTypeSubsumedByOtherTypeWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    otherType: Type,
    allowAnyToSubsume: boolean,
    recursionCount = 0
) {
    const concreteType = evaluator.makeTopLevelTypeVarsConcrete(type);
    const otherSubtypes = isUnion(otherType) ? otherType.priv.subtypes : [otherType];

    for (const otherSubtype of otherSubtypes) {
        if (isTypeSame(otherSubtype, type)) {
            continue;
        }

        if (isAnyOrUnknown(otherSubtype)) {
            if (allowAnyToSubsume) {
                return true;
            }
        } else if (isProperSubtypeWithEvaluator(evaluator, otherSubtype, concreteType, recursionCount)) {
            return true;
        }
    }

    return false;
}

export function isDeclaredTypeAliasWithEvaluator(
    evaluator: TypeEvaluator,
    expression: ExpressionNode
): boolean {
    if (expression.nodeType === ParseNodeType.TypeAnnotation) {
        if (expression.d.valueExpr.nodeType === ParseNodeType.Name) {
            const symbolWithScope = evaluator.lookUpSymbolRecursive(
                expression,
                expression.d.valueExpr.d.value,
                /* honorCodeFlow */ false
            );
            if (symbolWithScope) {
                const symbol = symbolWithScope.symbol;
                return symbol.getDeclarations().find((decl) => evaluator.isExplicitTypeAliasDeclaration(decl)) !== undefined;
            }
        }
    }

    return false;
}

export function validateSymbolIsTypeExpressionWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    type: Type,
    includesVarDecl: boolean
): Type {
    if (isSymbolValidTypeExpressionCheck(type, includesVarDecl)) {
        return type;
    }

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    if (fileInfo.isTypingStubFile) {
        return type;
    }

    evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeAnnotationVariable(), node);
    return UnknownType.create();
}

export function verifySetEntryOrDictKeyIsHashableWithEvaluator(
    evaluator: TypeEvaluator,
    entry: ExpressionNode,
    type: Type,
    isDictKey: boolean
) {
    if (!isTypeHashableWithEvaluator(evaluator, type)) {
        const diag = new DiagnosticAddendum();
        diag.addMessage(LocAddendum.unhashableType().format({ type: evaluator.printType(type) }));

        const message = isDictKey ? LocMessage.unhashableDictKey() : LocMessage.unhashableSetEntry();

        evaluator.addDiagnostic(DiagnosticRule.reportUnhashable, message + diag.getString(), entry);
    }
}

export interface MapSubtypesExpandOptions extends MapSubtypesOptions {
    expandCallback?: (type: Type) => Type;
    conditionFilter?: TypeCondition[];
}

export function mapSubtypesExpandTypeVarsWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    options: MapSubtypesExpandOptions | undefined,
    callback: (expandedSubtype: Type, unexpandedSubtype: Type, isLastIteration: boolean) => Type | undefined,
    recursionCount = 0
): Type {
    const newSubtypes: Type[] = [];
    let typeChanged = false;

    function expandSubtype(unexpandedType: Type, isLastSubtype: boolean) {
        let expandedType = isUnion(unexpandedType) ? unexpandedType : evaluator.makeTopLevelTypeVarsConcrete(unexpandedType);

        expandedType = transformPossibleRecursiveTypeAlias(expandedType);
        if (options?.expandCallback) {
            expandedType = options.expandCallback(expandedType);
        }

        doForEachSubtype(
            expandedType,
            (subtype, index, allSubtypes) => {
                if (options?.conditionFilter) {
                    const filteredType = applyConditionFilterToTypeWithEvaluator(
                        evaluator,
                        subtype,
                        options.conditionFilter,
                        recursionCount
                    );
                    if (!filteredType) {
                        return undefined;
                    }

                    subtype = filteredType;
                }

                let transformedType = callback(
                    subtype,
                    unexpandedType,
                    isLastSubtype && index === allSubtypes.length - 1
                );

                if (transformedType !== unexpandedType) {
                    typeChanged = true;
                }

                if (transformedType) {
                    const typeCondition = getTypeCondition(subtype)?.filter((condition) =>
                        TypeVarType.hasConstraints(condition.typeVar)
                    );

                    if (typeCondition && typeCondition.length > 0) {
                        transformedType = addConditionToType(transformedType, typeCondition);
                    }

                    if (
                        newSubtypes.length === 0 ||
                        !isTypeSame(transformedType, newSubtypes[newSubtypes.length - 1])
                    ) {
                        newSubtypes.push(transformedType);
                    }
                }
                return undefined;
            },
            options?.sortSubtypes
        );
    }

    if (isUnion(type)) {
        const subtypes = options?.sortSubtypes ? sortTypes(type.priv.subtypes) : type.priv.subtypes;
        subtypes.forEach((subtype, index) => {
            expandSubtype(subtype, index === type.priv.subtypes.length - 1);
        });
    } else {
        expandSubtype(type, /* isLastSubtype */ true);
    }

    if (!typeChanged) {
        return type;
    }

    const newType = combineTypes(newSubtypes);

    if (newType.category === TypeCategory.Union) {
        UnionType.addTypeAliasSource(newType, type);
    }
    return newType;
}

export function bindMethodForMemberAccessWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    concreteType: FunctionType | OverloadedType,
    memberInfo: ClassMember | undefined,
    classType: ClassType,
    selfType: ClassType | TypeVarType | undefined,
    flags: MemberAccessFlags,
    memberName: string,
    usage: EvaluatorUsage,
    diag: DiagnosticAddendum | undefined,
    recursionCount = 0
): TypeResult {
    if (usage.method === 'set') {
        const impl = isFunction(concreteType) ? concreteType : OverloadedType.getImplementation(concreteType);

        if (impl && isFunction(impl) && FunctionType.isFinal(impl) && memberInfo && isClass(memberInfo.classType)) {
            diag?.addMessage(
                LocMessage.finalMethodOverride().format({
                    name: memberName,
                    className: memberInfo.classType.shared.name,
                })
            );

            return { type: UnknownType.create(), typeErrors: true };
        }
    }

    if (TypeBase.isInstance(classType)) {
        if (!memberInfo || memberInfo.isInstanceMember) {
            return { type: type };
        }
    }

    const boundType = evaluator.bindFunctionToClassOrObject(
        classType,
        concreteType,
        memberInfo && isInstantiableClass(memberInfo.classType) ? memberInfo.classType : undefined,
        (flags & MemberAccessFlags.TreatConstructorAsClassMethod) !== 0,
        selfType && isClass(selfType) ? ClassType.cloneIncludeSubclasses(selfType) : selfType,
        diag,
        recursionCount
    );

    return { type: boundType ?? UnknownType.create(), typeErrors: !boundType };
}

export function cloneBuiltinClassWithLiteralWithEvaluator(
    evaluator: TypeEvaluator,
    node: ParseNode,
    literalClassType: ClassType,
    builtInName: string,
    value: LiteralValue
): Type {
    const type = evaluator.getBuiltInType(node, builtInName);
    if (isInstantiableClass(type)) {
        const literalType = ClassType.cloneWithLiteral(type, value);
        TypeBase.setSpecialForm(literalType, literalClassType);
        return literalType;
    }

    return UnknownType.create();
}

export function cloneBuiltinObjectWithLiteralWithEvaluator(
    evaluator: TypeEvaluator,
    node: ParseNode,
    builtInName: string,
    value: LiteralValue
): Type {
    const type = evaluator.getBuiltInObject(node, builtInName);
    if (isClassInstance(type)) {
        return ClassType.cloneWithLiteral(ClassType.cloneRemoveTypePromotions(type), value);
    }

    return UnknownType.create();
}

export function getTypeOfArgExpectingTypeWithEvaluator(
    evaluator: TypeEvaluator,
    arg: Arg,
    options?: ExpectedTypeOptions
): TypeResult {
    if (arg.typeResult) {
        return { type: arg.typeResult.type, isIncomplete: arg.typeResult.isIncomplete };
    }

    assert(arg.valueExpression !== undefined);
    return evaluator.getTypeOfExpressionExpectingType(arg.valueExpression, options);
}

export function solveAndApplyConstraintsWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    constraints: ConstraintTracker,
    applyOptions?: ApplyTypeVarOptions,
    solveOptions?: SolveConstraintsOptions
): Type {
    const solution = solveConstraints(evaluator, constraints, solveOptions);
    return applySolvedTypeVars(type, solution, applyOptions);
}

export function stripLiteralValueWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    prefetched: Partial<PrefetchedTypes> | undefined
): Type {
    return TypeEvaluatorNarrowing.stripLiteralValue(
        {
            getStrInstanceTypeForLiteralString: () =>
                prefetched?.strClass && isInstantiableClass(prefetched.strClass)
                    ? ClassType.cloneAsInstance(prefetched.strClass)
                    : undefined,
        },
        type
    );
}

export function inferTypeArgFromExpectedEntryTypeWithEvaluator(
    evaluator: TypeEvaluator,
    inferenceContext: InferenceContext,
    entryTypes: Type[],
    isNarrowable: boolean
): Type | undefined {
    if (isAny(inferenceContext.expectedType)) {
        return inferenceContext.expectedType;
    }

    const constraints = new ConstraintTracker();
    const expectedType = inferenceContext.expectedType;
    let isCompatible = true;

    entryTypes.forEach((entryType) => {
        if (isCompatible && !evaluator.assignType(expectedType, entryType, /* diag */ undefined, constraints)) {
            isCompatible = false;
        }
    });

    if (!isCompatible) {
        return undefined;
    }

    if (isNarrowable && entryTypes.length > 0) {
        const combinedTypes = combineTypes(entryTypes);
        return containsLiteralType(inferenceContext.expectedType)
            ? combinedTypes
            : evaluator.stripLiteralValue(combinedTypes);
    }

    return mapSubtypes(
        solveAndApplyConstraintsWithEvaluator(evaluator, inferenceContext.expectedType, constraints, {
            replaceUnsolved: {
                scopeIds: [],
                tupleClassType: evaluator.getTupleClassType(),
            },
        }),
        (subtype) => {
            if (entryTypes.length !== 1) {
                return subtype;
            }
            const entryType = entryTypes[0];

            if (
                isTypeSame(subtype, entryType, { ignoreTypedDictNarrowEntries: true }) &&
                isClass(subtype) &&
                isClass(entryType) &&
                ClassType.isTypedDictClass(entryType)
            ) {
                return ClassType.cloneForNarrowedTypedDictEntries(subtype, entryType.priv.typedDictNarrowedEntries);
            }

            return subtype;
        }
    );
}

export function adjustCallableReturnTypeWithEvaluator(
    evaluator: TypeEvaluator,
    callNode: ExpressionNode,
    returnType: Type,
    liveTypeVarScopes: TypeVarScopeId[]
): Type {
    if (!isFunction(returnType)) {
        return returnType;
    }

    const typeParams = getTypeVarArgsRecursive(returnType).filter(
        (t) => !liveTypeVarScopes.some((scopeId) => t.priv.scopeId === scopeId)
    );

    if (typeParams.length === 0) {
        return returnType;
    }

    evaluator.inferReturnTypeIfNecessary(returnType);

    const newScopeId = ParseTreeUtils.getScopeIdForNode(callNode);
    const solution = new ConstraintSolution();

    const newTypeParams = typeParams.map((typeVar) => {
        const newTypeParam = TypeVarType.cloneForScopeId(
            typeVar,
            newScopeId,
            typeVar.priv.scopeName,
            TypeVarScopeType.Function
        );
        solution.setType(typeVar, newTypeParam);
        return newTypeParam;
    });

    return applySolvedTypeVars(
        FunctionType.cloneWithNewTypeVarScopeId(
            returnType,
            newScopeId,
            /* constructorTypeVarScopeId */ undefined,
            newTypeParams
        ),
        solution
    );
}

export function createNewTypeWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    prefetched: Partial<PrefetchedTypes> | undefined
): ClassType | undefined {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    let className = '';

    if (argList.length !== 2) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.newTypeParamCount(), errorNode);
        return undefined;
    }

    const nameArg = argList[0];
    if (
        nameArg.argCategory === ArgCategory.Simple &&
        nameArg.valueExpression &&
        nameArg.valueExpression.nodeType === ParseNodeType.StringList
    ) {
        className = nameArg.valueExpression.d.strings.map((s) => s.d.value).join('');
    }

    if (!className) {
        evaluator.addDiagnostic(DiagnosticRule.reportArgumentType, LocMessage.newTypeBadName(), argList[0].node ?? errorNode);
        return undefined;
    }

    if (
        errorNode.parent?.nodeType === ParseNodeType.Assignment &&
        errorNode.parent.d.leftExpr.nodeType === ParseNodeType.Name &&
        errorNode.parent.d.leftExpr.d.value !== className
    ) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeNameMismatch(),
            errorNode.parent.d.leftExpr
        );
        return undefined;
    }

    let baseClass = getTypeOfArgExpectingTypeWithEvaluator(evaluator, argList[1]).type;
    let isBaseClassAny = false;

    if (isAnyOrUnknown(baseClass)) {
        baseClass = prefetched?.objectClass ?? UnknownType.create();

        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeAnyOrUnknown(),
            argList[1].node ?? errorNode
        );

        isBaseClassAny = true;
    }

    if (
        baseClass.props?.specialForm &&
        isClassInstance(baseClass.props.specialForm) &&
        ClassType.isBuiltIn(baseClass.props.specialForm, 'Annotated')
    ) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeNotAClass(),
            argList[1].node || errorNode
        );
        return undefined;
    }

    if (!isInstantiableClass(baseClass)) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeNotAClass(),
            argList[1].node || errorNode
        );
        return undefined;
    }

    if (ClassType.isProtocolClass(baseClass) || ClassType.isTypedDictClass(baseClass)) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeProtocolClass(),
            argList[1].node || errorNode
        );
    } else if (baseClass.priv.literalValue !== undefined) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.newTypeLiteral(),
            argList[1].node || errorNode
        );
    }

    const classType = ClassType.createInstantiable(
        className,
        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.Final | ClassTypeFlags.NewTypeClass | ClassTypeFlags.ValidTypeAliasClass,
        ParseTreeUtils.getTypeSourceId(errorNode),
        /* declaredMetaclass */ undefined,
        baseClass.shared.effectiveMetaclass
    );
    classType.shared.baseClasses.push(isBaseClassAny ? AnyType.create() : baseClass);
    computeMroLinearization(classType);

    if (!isBaseClassAny) {
        const initType = FunctionType.createSynthesizedInstance('__init__');
        FunctionType.addParam(
            initType,
            FunctionParam.create(ParamCategory.Simple, AnyType.create(), FunctionParamFlags.TypeDeclared, 'self')
        );
        FunctionType.addParam(
            initType,
            FunctionParam.create(
                ParamCategory.Simple,
                ClassType.cloneAsInstance(baseClass),
                FunctionParamFlags.TypeDeclared,
                '_x'
            )
        );
        initType.shared.declaredReturnType = evaluator.getNoneType();
        ClassType.getSymbolTable(classType).set(
            '__init__',
            Symbol.createWithType(SymbolFlags.ClassMember, initType)
        );

        const newType = FunctionType.createSynthesizedInstance('__new__', FunctionTypeFlags.ConstructorMethod);
        FunctionType.addParam(
            newType,
            FunctionParam.create(ParamCategory.Simple, AnyType.create(), FunctionParamFlags.TypeDeclared, 'cls')
        );
        FunctionType.addDefaultParams(newType);
        newType.shared.declaredReturnType = ClassType.cloneAsInstance(classType);
        newType.priv.constructorTypeVarScopeId = getTypeVarScopeId(classType);
        ClassType.getSymbolTable(classType).set('__new__', Symbol.createWithType(SymbolFlags.ClassMember, newType));
    }

    return classType;
}

export function applyAttributeAccessOverrideWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    usage: EvaluatorUsage,
    memberName: string,
    prefetched: Partial<PrefetchedTypes> | undefined,
    selfType?: ClassType | TypeVarType
): MemberAccessTypeResult | undefined {
    const getAttributeAccessMember = (name: string) => {
        return evaluator.getTypeOfBoundMember(
            errorNode,
            classType,
            name,
            /* usage */ undefined,
            /* diag */ undefined,
            MemberAccessFlags.SkipInstanceMembers |
                MemberAccessFlags.SkipObjectBaseClass |
                MemberAccessFlags.SkipTypeBaseClass |
                MemberAccessFlags.SkipAttributeAccessOverride,
            selfType
        )?.type;
    };

    let accessMemberType: Type | undefined;
    if (usage.method === 'get') {
        accessMemberType = getAttributeAccessMember('__getattribute__') ?? getAttributeAccessMember('__getattr__');
    } else if (usage.method === 'set') {
        accessMemberType = getAttributeAccessMember('__setattr__');
    } else {
        assert(usage.method === 'del');
        accessMemberType = getAttributeAccessMember('__delattr__');
    }

    if (!accessMemberType) {
        return undefined;
    }

    const argList: Arg[] = [];

    argList.push({
        argCategory: ArgCategory.Simple,
        typeResult: {
            type:
                prefetched?.strClass && isInstantiableClass(prefetched.strClass)
                    ? ClassType.cloneWithLiteral(ClassType.cloneAsInstance(prefetched.strClass), memberName)
                    : AnyType.create(),
        },
    });

    if (usage.method === 'set') {
        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: {
                type: usage.setType?.type ?? UnknownType.create(),
                isIncomplete: !!usage.setType?.isIncomplete,
            },
        });
    }

    if (!isFunctionOrOverloaded(accessMemberType)) {
        if (isAnyOrUnknown(accessMemberType)) {
            return { type: accessMemberType };
        }

        return undefined;
    }

    const callResult = evaluator.validateCallArgs(
        errorNode,
        argList,
        { type: accessMemberType },
        /* constraints */ undefined,
        /* skipUnknownArgCheck */ true,
        /* inferenceContext */ undefined
    );

    let isAsymmetricAccessor = false;
    if (usage.method === 'set') {
        isAsymmetricAccessor = isClassWithAsymmetricAttributeAccessorWithEvaluator(evaluator, classType);
    }

    return {
        type: callResult.returnType ?? UnknownType.create(),
        typeErrors: callResult.argumentErrors,
        isAsymmetricAccessor,
    };
}



const maxSingleOverloadArgTypeExpansionCount = 64;

const maxEntriesToUseForInference = 64;

export function expandArgTypeWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type
): Type[] | undefined {
    const expandedTypes: Type[] = [];

    type = evaluator.makeTopLevelTypeVarsConcrete(type);

    doForEachSubtype(type, (subtype) => {
        if (isClassInstance(subtype)) {
            const expandedLiteralTypes = enumerateLiteralsForType(evaluator, subtype);
            if (expandedLiteralTypes && expandedLiteralTypes.length <= maxSingleOverloadArgTypeExpansionCount) {
                appendArray(expandedTypes, expandedLiteralTypes);
                return;
            }

            const expandedTuples = expandTuple(subtype, maxSingleOverloadArgTypeExpansionCount);
            if (expandedTuples) {
                appendArray(expandedTypes, expandedTuples);
                return;
            }
        }

        expandedTypes.push(subtype);
    });

    return expandedTypes.length > 1 ? expandedTypes : undefined;
}

export function createClassFromMetaclassWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    argList: Arg[],
    metaclass: ClassType
): ClassType | undefined {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(errorNode);
    const arg0Type = evaluator.getTypeOfArg(argList[0], /* inferenceContext */ undefined).type;
    if (!isClassInstance(arg0Type) || !ClassType.isBuiltIn(arg0Type, 'str')) {
        return undefined;
    }
    const className = (arg0Type.priv.literalValue as string) || '_';

    const arg1Type = evaluator.getTypeOfArg(argList[1], /* inferenceContext */ undefined).type;

    if (!isClassInstance(arg1Type) || !isTupleClass(arg1Type) || arg1Type.priv.tupleTypeArgs === undefined) {
        return undefined;
    }

    const classType = ClassType.createInstantiable(
        className,
        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
        fileInfo.moduleName,
        fileInfo.fileUri,
        ClassTypeFlags.ValidTypeAliasClass,
        ParseTreeUtils.getTypeSourceId(errorNode),
        metaclass,
        arg1Type.shared.effectiveMetaclass
    );
    arg1Type.priv.tupleTypeArgs.forEach((typeArg) => {
        const specializedType = evaluator.makeTopLevelTypeVarsConcrete(typeArg.type);

        if (isEffectivelyInstantiable(specializedType)) {
            classType.shared.baseClasses.push(specializedType);
        } else {
            classType.shared.baseClasses.push(UnknownType.create());
        }
    });

    if (!computeMroLinearization(classType)) {
        evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.methodOrdering(), errorNode);
    }

    return classType;
}

export function expandArgTypesWithEvaluator(
    evaluator: TypeEvaluator,
    contextFreeArgTypes: Type[],
    expandedArgTypes: (Type | undefined)[][]
): (Type | undefined)[][] | undefined {
    let indexToExpand = contextFreeArgTypes.length - 1;
    while (indexToExpand >= 0 && !expandedArgTypes[0][indexToExpand]) {
        indexToExpand--;
    }

    indexToExpand++;

    if (indexToExpand >= contextFreeArgTypes.length) {
        return undefined;
    }

    let expandedTypes: Type[] | undefined;
    while (indexToExpand < contextFreeArgTypes.length) {
        const argType = contextFreeArgTypes[indexToExpand];

        expandedTypes = expandArgTypeWithEvaluator(evaluator, argType);
        if (expandedTypes) {
            break;
        }
        indexToExpand++;
    }

    if (!expandedTypes) {
        return undefined;
    }

    const newExpandedArgTypes: (Type | undefined)[][] = [];

    expandedArgTypes.forEach((preExpandedTypes) => {
        expandedTypes.forEach((subtype) => {
            const expandedTypes = [...preExpandedTypes];
            expandedTypes[indexToExpand] = subtype;
            newExpandedArgTypes.push(expandedTypes);
        });
    });

    return newExpandedArgTypes;
}
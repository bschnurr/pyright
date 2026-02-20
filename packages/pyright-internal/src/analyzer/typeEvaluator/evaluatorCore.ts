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
import { ArgCategory, ArgumentNode, AssignmentNode, CallNode, ComprehensionForIfNode, ComprehensionNode, ConstantNode, ExpressionNode, FunctionNode, ImportAsNode, ImportFromAsNode, ImportFromNode, IndexNode, isExpressionNode, LambdaNode, ListNode, NameNode, ParamCategory, ParameterNode, ParseNode, ParseNodeType, SetNode, SliceNode, StringListNode, StringNode, TypeParameterNode, UnpackNode, YieldFromNode, YieldNode } from '../../parser/parseNodes';
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
import { AbstractSymbol, Arg, ArgWithExpression, AssignTypeFlags, CallResult, EvalFlags, EvaluatorUsage, ExpectedTypeOptions, MagicMethodDeprecationInfo, MemberAccessDeprecationInfo, MemberAccessTypeResult, PrefetchedTypes, PrintTypeOptions, Reachability, SolveConstraintsOptions, SymbolDeclInfo, TypeEvaluator, TypeResult, TypeResultWithNode, ValidateTypeArgsOptions } from '../typeEvaluatorTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { AnyType, ClassType, ClassTypeFlags, combineTypes, findSubtype, FunctionParam, FunctionParamFlags, FunctionType, FunctionTypeFlags, InheritanceChain, isAny, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isNever, isOverloaded, isParamSpec, isPositionOnlySeparator, isTypeVar, isTypeSame, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedClass, isUnpackedTypeVarTuple, LiteralValue, maxTypeRecursionCount, ModuleType, NeverType, OverloadedType, ParamSpecType, removeUnbound, TupleTypeArg, Type, TypeAliasInfo, TypeBase, TypeCategory, TypeCondition, TypeVarKind, TypeVarScopeId, TypeVarScopeType, TypeVarTupleType, TypeVarType, UnionType, UnknownType, Variance } from '../types';
import { addConditionToType, applySolvedTypeVars, ApplyTypeVarOptions, areTypesSame, ClassMember, combineSameSizedTuples, combineVariances, computeMroLinearization, containsLiteralType, convertToInstance, convertToInstantiable, derivesFromAnyOrUnknown, derivesFromClassRecursive, derivesFromStdlibClass, doForEachSubtype, addTypeVarsToListIfUnique, explodeGenericClass, getDeclaredGeneratorReturnType, getGeneratorTypeArgs, getGeneratorYieldType, getSpecializedTupleType, getTypeCondition, getTypeVarArgsRecursive, getTypeVarScopeId, getTypeVarScopeIds, getUnknownTypeForCallable, InferenceContext, invertVariance, isEffectivelyInstantiable, isEllipsisType, isIncompleteUnknown, isInstantiableMetaclass, isLiteralLikeType, isLiteralType, isMetaclassInstance, isNoneInstance, isNoneTypeClass, isOptionalType, isPartlyUnknown, isSentinelLiteral, isTupleClass, isTupleIndexUnambiguous, isTypeAliasPlaceholder, isUnboundedTupleClass, isVarianceOfTypeArgCompatible, lookUpClassMember, lookUpObjectMember, makeFunctionTypeVarsBound, makeInferenceContext, makeTypeVarsBound, MapSubtypesOptions, mapSignatures, mapSubtypes, MemberAccessFlags, partiallySpecializeType, removeNoneFromUnion, requiresSpecialization, requiresTypeArgs, selfSpecializeClass, simplifyFunctionToParamSpec, sortTypes, specializeForBaseClass, specializeWithDefaultTypeArgs, specializeTupleClass, stripTypeForm, synthesizeTypeVarForSelfCls, transformPossibleRecursiveTypeAlias, validateTypeVarDefault } from '../typeUtils';
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
import { createTypedDictTypeInlined, getTypeOfIndexedTypedDict, assignTypedDictToTypedDict, getTypedDictMappingEquivalent, getTypedDictDictEquivalent } from '../typedDicts';

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

export function getTypeOfExpressionExpectingTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    options?: ExpectedTypeOptions
): TypeResult {
    let flags = EvalFlags.InstantiableType | EvalFlags.StrLiteralAsType;

    if (options?.allowTypeVarsWithoutScopeId) {
        flags |= EvalFlags.AllowTypeVarWithoutScopeId;
    }

    if (options?.typeVarGetsCurScope) {
        flags |= EvalFlags.TypeVarGetsCurScope;
    }

    if (options?.enforceClassTypeVarScope) {
        flags |= EvalFlags.EnforceClassTypeVarScope;
    }

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    if ((isAnnotationEvaluationPostponed(fileInfo) || options?.forwardRefs) && !options?.runtimeTypeExpression) {
        flags |= EvalFlags.ForwardRefs;
    } else if (options?.parsesStringLiteral) {
        flags |= EvalFlags.ParsesStringLiteral;
    }

    if (!options?.allowFinal) {
        flags |= EvalFlags.NoFinal;
    }

    if (options?.allowRequired) {
        flags |= EvalFlags.AllowRequired | EvalFlags.TypeExpression;
    }

    if (options?.allowReadOnly) {
        flags |= EvalFlags.AllowReadOnly | EvalFlags.TypeExpression;
    }

    if (options?.allowUnpackedTuple) {
        flags |= EvalFlags.AllowUnpackedTuple;
    } else {
        flags |= EvalFlags.NoTypeVarTuple;
    }

    if (options?.allowUnpackedTypedDict) {
        flags |= EvalFlags.AllowUnpackedTypedDict;
    }

    if (!options?.allowParamSpec) {
        flags |= EvalFlags.NoParamSpec;
    }

    if (options?.typeExpression) {
        flags |= EvalFlags.TypeExpression;
    }

    if (options?.convertEllipsisToAny) {
        flags |= EvalFlags.ConvertEllipsisToAny;
    }

    if (options?.allowEllipsis) {
        flags |= EvalFlags.AllowEllipsis;
    }

    if (options?.noNonTypeSpecialForms) {
        flags |= EvalFlags.NoNonTypeSpecialForms;
    }

    if (!options?.allowClassVar) {
        flags |= EvalFlags.NoClassVar;
    }

    if (options?.varTypeAnnotation) {
        flags |= EvalFlags.VarTypeAnnotation;
    }

    if (options?.notParsed) {
        flags |= EvalFlags.NotParsed;
    }

    if (options?.typeFormArg) {
        flags |= EvalFlags.TypeFormArg;
    }

    return evaluator.getTypeOfExpression(node, flags);
}

export function getTypeOfYieldFromWithEvaluator(
    evaluator: TypeEvaluator,
    node: YieldFromNode
): TypeResult {
    const yieldFromTypeResult = evaluator.getTypeOfExpression(node.d.expr);
    const yieldFromType = yieldFromTypeResult.type;

    const returnedType = mapSubtypes(yieldFromType, (yieldFromSubtype) => {
        // Is the expression a Generator type?
        let generatorTypeArgs = getGeneratorTypeArgs(yieldFromSubtype);
        if (generatorTypeArgs) {
            return generatorTypeArgs.length >= 2 ? generatorTypeArgs[2] : UnknownType.create();
        }

        // Handle old-style (pre-await) Coroutines as a special case.
        if (
            isClassInstance(yieldFromSubtype) &&
            ClassType.isBuiltIn(yieldFromSubtype, ['Coroutine', 'CoroutineType'])
        ) {
            return UnknownType.create();
        }

        // Handle simple iterables.
        const iterableType =
            evaluator.getTypeOfIterable(yieldFromTypeResult, /* isAsync */ false, node)?.type ?? UnknownType.create();

        // Does the iterable return a Generator?
        generatorTypeArgs = getGeneratorTypeArgs(iterableType);
        return generatorTypeArgs && generatorTypeArgs.length >= 2 ? generatorTypeArgs[2] : UnknownType.create();
    });

    return { type: returnedType };
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

export function assignFromUnionTypeWithEvaluator(
    destType: Type,
    srcType: UnionType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number,
    evaluator: TypeEvaluator
): boolean {
    // Start by checking for an exact match. This is needed to handle unions
    // that contain recursive type aliases.
    if (isTypeSame(srcType, destType, {}, recursionCount)) {
        return true;
    }

    if (
        (flags & AssignTypeFlags.OverloadOverlap) !== 0 &&
        srcType.priv.subtypes.some((subtype) => isAnyOrUnknown(subtype))
    ) {
        return false;
    }

    // Sort the subtypes so we have a deterministic order for unions.
    let sortedSrcTypes: Type[] = sortTypes(srcType.priv.subtypes);
    let matchedSomeSubtypes = false;

    // Handle the case where the source and dest are both unions. Try
    // to eliminate as many exact type matches between the src and dest.
    if (isUnion(destType)) {
        // Handle the special case where the dest is a union of Any and
        // a type variable. This occurs, for example, with the return type of
        // the getattr function.
        const nonAnySubtypes = destType.priv.subtypes.filter((t) => !isAnyOrUnknown(t));
        if (nonAnySubtypes.length === 1 && isTypeVar(nonAnySubtypes[0])) {
            evaluator.assignType(nonAnySubtypes[0], srcType, /* diag */ undefined, constraints, flags, recursionCount);

            // This always succeeds because the destination contains Any.
            return true;
        }

        const remainingDestSubtypes: Type[] = [];
        let remainingSrcSubtypes: Type[] = sortedSrcTypes;
        let canUseFastPath = true;

        // First attempt to match all of the non-generic types in the dest
        // to non-generic types in the source.
        sortTypes(destType.priv.subtypes).forEach((destSubtype) => {
            if (requiresSpecialization(destSubtype)) {
                remainingDestSubtypes.push(destSubtype);
            } else {
                const srcTypeIndex = remainingSrcSubtypes.findIndex((srcSubtype) =>
                    isTypeSame(srcSubtype, destSubtype, {}, recursionCount)
                );

                if (srcTypeIndex >= 0) {
                    remainingSrcSubtypes.splice(srcTypeIndex, 1);
                    matchedSomeSubtypes = true;
                } else {
                    remainingDestSubtypes.push(destSubtype);
                }
            }
        });

        // For all remaining source subtypes, attempt to find a dest subtype
        // whose primary type matches.
        remainingSrcSubtypes.forEach((srcSubtype) => {
            const destTypeIndex = remainingDestSubtypes.findIndex((destSubtype) => {
                if (isTypeSame(destSubtype, srcSubtype)) {
                    return true;
                }

                if (
                    isClass(srcSubtype) &&
                    isClass(destSubtype) &&
                    TypeBase.isInstance(srcSubtype) === TypeBase.isInstance(destSubtype)
                ) {
                    if (ClassType.isSameGenericClass(srcSubtype, destSubtype)) {
                        return true;
                    }

                    // Are they equivalent TypedDicts?
                    if (ClassType.isTypedDictClass(srcSubtype) && ClassType.isTypedDictClass(destSubtype)) {
                        if (
                            evaluator.assignType(
                                srcSubtype,
                                destSubtype,
                                /* diag */ undefined,
                                /* constraints */ undefined,
                                flags,
                                recursionCount
                            )
                        ) {
                            return true;
                        }
                    }
                }

                if (isFunctionOrOverloaded(srcSubtype) && isFunctionOrOverloaded(destSubtype)) {
                    return true;
                }

                return false;
            });

            if (destTypeIndex >= 0) {
                if (
                    evaluator.assignType(
                        remainingDestSubtypes[destTypeIndex],
                        srcSubtype,
                        /* diag */ undefined,
                        constraints,
                        flags,
                        recursionCount
                    )
                ) {
                    // Note that we have matched at least one subtype indicating
                    // there is at least some overlap.
                    matchedSomeSubtypes = true;
                } else {
                    canUseFastPath = false;
                }

                remainingDestSubtypes.splice(destTypeIndex, 1);
                remainingSrcSubtypes = remainingSrcSubtypes.filter((t) => t !== srcSubtype);
            }
        });

        // If there is are remaining dest subtypes and they're all type variables,
        // attempt to assign the remaining source subtypes to them.
        if (canUseFastPath && (remainingDestSubtypes.length !== 0 || remainingSrcSubtypes.length !== 0)) {
            if ((flags & AssignTypeFlags.Invariant) !== 0) {
                // If we have no src subtypes remaining but not all dest types have been subsumed
                // by other dest types, then the types are not compatible if we're enforcing invariance.
                if (remainingSrcSubtypes.length === 0) {
                    return remainingDestSubtypes.every((destSubtype) =>
                        evaluator.isTypeSubsumedByOtherType(
                            destSubtype,
                            destType,
                            /* allowAnyToSubsume */ true,
                            recursionCount
                        )
                    );
                }
            }

            const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;
            const effectiveDestSubtypes = isContra ? remainingSrcSubtypes : remainingDestSubtypes;

            if (effectiveDestSubtypes.length === 0 || effectiveDestSubtypes.some((t) => !isTypeVar(t))) {
                canUseFastPath = false;

                // We can avoid checking the source subtypes that have already been checked.
                sortedSrcTypes = remainingSrcSubtypes;
            } else if (remainingDestSubtypes.length === remainingSrcSubtypes.length) {
                // If the number of remaining source subtypes is the same as the number
                // of dest TypeVars, try to assign each source subtype to its own dest TypeVar.
                const reorderedDestSubtypes = [...remainingDestSubtypes];

                for (let srcIndex = 0; srcIndex < remainingSrcSubtypes.length; srcIndex++) {
                    let foundMatchForSrc = false;

                    for (let destIndex = 0; destIndex < reorderedDestSubtypes.length; destIndex++) {
                        if (
                            evaluator.assignType(
                                reorderedDestSubtypes[destIndex],
                                remainingSrcSubtypes[srcIndex],
                                diag?.createAddendum(),
                                constraints,
                                flags,
                                recursionCount
                            )
                        ) {
                            foundMatchForSrc = true;
                            // Move the matched dest TypeVar to the end of the list so the other
                            // dest TypeVars have a better chance of being assigned to.
                            reorderedDestSubtypes.push(...reorderedDestSubtypes.splice(destIndex, 1));
                            break;
                        }
                    }

                    if (!foundMatchForSrc) {
                        canUseFastPath = false;
                        break;
                    }
                }

                // We can avoid checking the source subtypes that have already been checked.
                sortedSrcTypes = remainingSrcSubtypes;
            } else if (remainingSrcSubtypes.length === 0) {
                if ((flags & AssignTypeFlags.PopulateExpectedType) !== 0) {
                    // If we're populating an expected type, try not to leave
                    // any TypeVars unsolved. Assign the full type to the remaining
                    // dest TypeVars.
                    remainingDestSubtypes.forEach((destSubtype) => {
                        evaluator.assignType(destSubtype, srcType, /* diag */ undefined, constraints, flags, recursionCount);
                    });
                }

                // If we've assigned all of the source subtypes but one or more dest
                // TypeVars have gone unmatched, treat this as success.
            } else {
                // Try to assign a union of the remaining source types to
                // the first destination TypeVar. If this is a contravariant
                // context, use the full dest type rather than the remaining
                // dest subtypes to keep the lower bound as wide as possible.
                if (
                    !evaluator.assignType(
                        isContra ? destType : remainingDestSubtypes[0],
                        isContra ? remainingSrcSubtypes[0] : combineTypes(remainingSrcSubtypes),
                        diag?.createAddendum(),
                        constraints,
                        flags,
                        recursionCount
                    )
                ) {
                    canUseFastPath = false;
                }
            }
        }

        if (canUseFastPath) {
            return true;
        }

        // If we're looking for type overlaps and at least one type was matched,
        // consider it as assignable.
        if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0 && matchedSomeSubtypes) {
            return true;
        }
    }

    let isIncompatible = false;

    sortedSrcTypes.forEach((subtype) => {
        if (isIncompatible) {
            return;
        }

        if (!evaluator.assignType(destType, subtype, /* diag */ undefined, constraints, flags, recursionCount)) {
            // Determine if the current subtype is subsumed by another subtype
            // in the same union. If so, we can ignore this.
            const isSubtypeSubsumed = evaluator.isTypeSubsumedByOtherType(
                subtype,
                srcType,
                /* allowAnyToSubsume */ false,
                recursionCount
            );

            // Try again with a concrete version of the subtype.
            if (
                !isSubtypeSubsumed &&
                !evaluator.assignType(destType, subtype, diag?.createAddendum(), constraints, flags, recursionCount)
            ) {
                isIncompatible = true;
            }
        } else {
            matchedSomeSubtypes = true;
        }
    }, /* sortSubtypes */ true);

    if (isIncompatible) {
        // If we're looking for type overlaps and at least one type was matched,
        // consider it as assignable.
        if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0 && matchedSomeSubtypes) {
            return true;
        }

        diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
        return false;
    }

    return true;
}

export function assignToUnionTypeWithEvaluator(
    destType: UnionType,
    srcType: Type,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number,
    evaluator: TypeEvaluator
): boolean {
    // If we need to enforce invariance, the source needs to be compatible
    // with all subtypes in the dest, unless those subtypes are subclasses
    // of other subtypes.
    if (flags & AssignTypeFlags.Invariant) {
        let isIncompatible = false;

        doForEachSubtype(destType, (subtype, index) => {
            if (
                !isIncompatible &&
                !evaluator.assignType(subtype, srcType, diag?.createAddendum(), constraints, flags, recursionCount)
            ) {
                // Determine whether this subtype is subsumed by some other
                // subtype in the union. If so, we can ignore the incompatibility.
                let skipSubtype = false;
                if (!isAnyOrUnknown(subtype)) {
                    const adjSubtype = makeTypeVarsBound(subtype, /* scopeIds */ undefined);

                    doForEachSubtype(destType, (otherSubtype, otherIndex) => {
                        if (index !== otherIndex && !skipSubtype) {
                            const adjOtherSubtype = makeTypeVarsBound(otherSubtype, /* scopeIds */ undefined);

                            if (
                                evaluator.assignType(
                                    adjOtherSubtype,
                                    adjSubtype,
                                    /* diag */ undefined,
                                    /* constraints */ undefined,
                                    AssignTypeFlags.Default,
                                    recursionCount
                                )
                            ) {
                                skipSubtype = true;
                            }
                        }
                    });
                }
                if (!skipSubtype) {
                    isIncompatible = true;
                }
            }
        });

        if (isIncompatible) {
            diag?.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            return false;
        }

        return true;
    }

    // For union destinations, we just need to match one of the types.
    const diagAddendum = diag ? new DiagnosticAddendum() : undefined;

    let foundMatch = false;

    // Does the union contain any type variables that need to be solved?
    // If so, we need to use a slower path.
    if (!requiresSpecialization(destType)) {
        for (const subtype of destType.priv.subtypes) {
            if (evaluator.assignType(subtype, srcType, diagAddendum?.createAddendum(), constraints, flags, recursionCount)) {
                foundMatch = true;
                break;
            }
        }
    } else {
        // Run through all subtypes in the union. Don't stop at the first
        // match we find because we may need to match TypeVars in other
        // subtypes. We special-case "None" so we can handle Optional[T]
        // without matching the None to the type var.
        if (isNoneInstance(srcType) && isOptionalType(destType)) {
            foundMatch = true;
        } else {
            let bestConstraints: ConstraintTracker | undefined;
            let bestConstraintsScore: number | undefined;
            let nakedTypeVarMatches = 0;

            // If the srcType is a literal, try to use the fast-path lookup
            // in case the destType is a union with hundreds of literals.
            if (
                isClassInstance(srcType) &&
                isLiteralType(srcType) &&
                UnionType.containsType(
                    destType,
                    srcType,
                    /* options */ undefined,
                    /* exclusionSet */ undefined,
                    recursionCount
                )
            ) {
                return true;
            }

            doForEachSubtype(
                destType,
                (subtype) => {
                    // Make a temporary clone of the constraints. We don't want to modify
                    // the original constraints until we find the "optimal" typeVar mapping.
                    const constraintsClone = constraints?.clone();
                    if (
                        evaluator.assignType(
                            subtype,
                            srcType,
                            diagAddendum?.createAddendum(),
                            constraintsClone,
                            flags,
                            recursionCount
                        )
                    ) {
                        foundMatch = true;
                        if (constraintsClone) {
                            // Ask the constraints to compute a "score" for the current
                            // contents of the table.
                            let constraintsScore = constraintsClone.getScore();

                            if (isTypeVar(subtype)) {
                                if (!constraints?.getMainConstraintSet().getTypeVar(subtype)) {
                                    nakedTypeVarMatches++;

                                    // Handicap the solution slightly so another type var with
                                    // existing constraints will be preferred.
                                    constraintsScore += 0.001;
                                }
                            }

                            // If the type matches exactly, prefer it over other types.
                            if (isTypeSame(subtype, evaluator.stripLiteralValue(srcType))) {
                                constraintsScore = Number.POSITIVE_INFINITY;
                            }

                            if (bestConstraintsScore === undefined || bestConstraintsScore <= constraintsScore) {
                                // We found a typeVar mapping with a higher score than before.
                                bestConstraintsScore = constraintsScore;
                                bestConstraints = constraintsClone;
                            }
                        }
                    }
                },
                /* sortSubtypes */ true
            );

            // If we saw more than one "naked" type vars that have no
            // previous constraints recorded, it's dangerous for us to
            // assign a value to any of these type vars at this time.
            // Typically, they will receive some constraints via some
            // later argument assignment.
            if (nakedTypeVarMatches > 1 && (flags & AssignTypeFlags.ArgAssignmentFirstPass) !== 0) {
                bestConstraints = undefined;
            }

            // If we found a winning type var mapping, copy it back to constraints.
            if (constraints && bestConstraints) {
                constraints.copyFromClone(bestConstraints);
            }
        }
    }

    // If the source is a constrained TypeVar, see if we can assign all of the
    // constraints to the union.
    if (!foundMatch) {
        if (isTypeVar(srcType) && TypeVarType.hasConstraints(srcType)) {
            foundMatch = evaluator.assignType(
                destType,
                evaluator.makeTopLevelTypeVarsConcrete(srcType),
                diagAddendum?.createAddendum(),
                constraints,
                flags,
                recursionCount
            );
        }
    }

    if (!foundMatch) {
        if (diag && diagAddendum) {
            diag.addMessage(LocAddendum.typeAssignmentMismatch().format(evaluator.printSrcDestTypes(srcType, destType)));
            diag.addAddendum(diagAddendum);
        }
        return false;
    }

    return true;
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

export function getTypeOfMagicMethodCallWithEvaluator(
    evaluator: TypeEvaluator,
    objType: Type,
    methodName: string,
    argList: TypeResult[],
    errorNode: ExpressionNode,
    prefetched: Partial<PrefetchedTypes> | undefined,
    inferenceContext?: InferenceContext,
    diag?: DiagnosticAddendum
): TypeResult | undefined {
    let magicMethodSupported = true;
    let isIncomplete = false;
    let deprecationInfo: MagicMethodDeprecationInfo | undefined;
    const overloadsUsedForCall: FunctionType[] = [];

    // Create a helper lambda for object subtypes.
    const handleSubtype = (subtype: ClassType | TypeVarType) => {
        let magicMethodType: Type | undefined;
        const concreteSubtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

        if (isClass(concreteSubtype)) {
            magicMethodType = evaluator.getBoundMagicMethod(concreteSubtype, methodName, subtype, errorNode, diag);
        }

        if (magicMethodType) {
            const functionArgs: Arg[] = argList.map((arg) => {
                return {
                    argCategory: ArgCategory.Simple,
                    typeResult: arg,
                };
            });

            let callResult: CallResult | undefined;

            callResult = evaluator.useSpeculativeMode(errorNode, () => {
                assert(magicMethodType !== undefined);
                return evaluator.validateCallArgs(
                    errorNode,
                    functionArgs,
                    { type: magicMethodType },
                    /* constraints */ undefined,
                    /* skipUnknownArgCheck */ true,
                    inferenceContext
                );
            });

            // If there were errors with the expected type, try
            // to evaluate without the expected type.
            if (callResult.argumentErrors && inferenceContext) {
                callResult = evaluator.useSpeculativeMode(errorNode, () => {
                    assert(magicMethodType !== undefined);
                    return evaluator.validateCallArgs(
                        errorNode,
                        functionArgs,
                        { type: magicMethodType },
                        /* constraints */ undefined,
                        /* skipUnknownArgCheck */ true,
                        /* inferenceContext */ undefined
                    );
                });
            }

            if (callResult.argumentErrors) {
                magicMethodSupported = false;
            } else if (callResult.overloadsUsedForCall) {
                callResult.overloadsUsedForCall.forEach((overload) => {
                    overloadsUsedForCall.push(overload);

                    // If one of the overloads is deprecated, note the message.
                    if (overload.shared.deprecatedMessage && isClass(concreteSubtype)) {
                        deprecationInfo = {
                            deprecatedMessage: overload.shared.deprecatedMessage,
                            className: concreteSubtype.shared.name,
                            methodName,
                        };
                    }
                });
            }

            if (callResult.isTypeIncomplete) {
                isIncomplete = true;
            }

            return callResult.returnType;
        }

        magicMethodSupported = false;
        return undefined;
    };

    const returnType = mapSubtypes(objType, (subtype) => {
        if (isAnyOrUnknown(subtype)) {
            return subtype;
        }

        if (isClassInstance(subtype) || isInstantiableClass(subtype) || isTypeVar(subtype)) {
            return handleSubtype(subtype);
        }

        if (isNoneInstance(subtype)) {
            if (prefetched?.objectClass && isInstantiableClass(prefetched.objectClass)) {
                // Use 'object' for 'None'.
                return handleSubtype(ClassType.cloneAsInstance(prefetched.objectClass));
            }
        }

        if (isNoneTypeClass(subtype)) {
            if (prefetched?.typeClass && isInstantiableClass(prefetched.typeClass)) {
                // Use 'type' for 'type[None]'.
                return handleSubtype(ClassType.cloneAsInstance(prefetched.typeClass));
            }
        }

        magicMethodSupported = false;
        return undefined;
    });

    if (!magicMethodSupported) {
        return undefined;
    }

    return { type: returnType, isIncomplete, magicMethodDeprecationInfo: deprecationInfo, overloadsUsedForCall };
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

export function validateOverrideMethodWithEvaluator(
    baseMethod: Type,
    overrideMethod: FunctionType | OverloadedType,
    baseClass: ClassType | undefined,
    diag: DiagnosticAddendum,
    evaluator: TypeEvaluator,
    enforceParamNames = true
): boolean {
    // If we're overriding a non-method with a method, report it as an error.
    // This occurs when a non-property overrides a property.
    if (!isFunctionOrOverloaded(baseMethod)) {
        diag.addMessage(LocAddendum.overrideType().format({ type: evaluator.printType(baseMethod) }));
        return false;
    }

    if (isFunction(baseMethod)) {
        // Handle the easy case - a simple function overriding another simple function.
        if (isFunction(overrideMethod)) {
            return validateOverrideMethodInternalWithEvaluator(baseMethod, overrideMethod, diag, enforceParamNames, evaluator);
        }

        const overloadsAndImpl = [...OverloadedType.getOverloads(overrideMethod)];
        const impl = OverloadedType.getImplementation(overrideMethod);
        if (impl && isFunction(impl)) {
            overloadsAndImpl.push(impl);
        }

        // For an overload overriding a base method, at least one overload
        // or the implementation must be compatible with the base method.
        if (
            overloadsAndImpl.some((overrideOverload) => {
                return validateOverrideMethodInternalWithEvaluator(
                    baseMethod,
                    overrideOverload,
                    /* diag */ undefined,
                    enforceParamNames,
                    evaluator
                );
            })
        ) {
            return true;
        }

        diag.addMessage(LocAddendum.overrideNoOverloadMatches());
        return false;
    }

    // For a non-overloaded method overriding an overloaded method, the
    // override must match all of the overloads.
    if (isFunction(overrideMethod)) {
        return OverloadedType.getOverloads(baseMethod).every((overload) => {
            // If the override isn't applicable for this base class, skip the check.
            if (baseClass && !isOverrideMethodApplicableWithEvaluator(evaluator, overload, baseClass)) {
                return true;
            }

            return validateOverrideMethodInternalWithEvaluator(
                overload,
                overrideMethod,
                diag?.createAddendum(),
                enforceParamNames,
                evaluator
            );
        });
    }

    // For an overloaded method overriding an overloaded method, the overrides
    // must all match and be in the correct order. It is OK if the base method
    // has additional overloads that are not present in the override.

    let previousMatchIndex = -1;
    const baseOverloads = OverloadedType.getOverloads(baseMethod);

    for (const overrideOverload of OverloadedType.getOverloads(overrideMethod)) {
        let possibleMatchIndex: number | undefined;

        let matchIndex = baseOverloads.findIndex((baseOverload, index) => {
            // If the override isn't applicable for this base class, skip the check.
            if (baseClass && !isOverrideMethodApplicableWithEvaluator(evaluator, baseOverload, baseClass)) {
                return false;
            }

            const isCompatible = validateOverrideMethodInternalWithEvaluator(
                baseOverload,
                overrideOverload,
                /* diag */ undefined,
                enforceParamNames,
                evaluator
            );

            // If the override is compatible but the match is one that is below the previous
            // matched index, keep looking for additional matches. Record the fact that
            // we found at least one match.
            if (isCompatible && index <= previousMatchIndex && possibleMatchIndex === undefined) {
                possibleMatchIndex = index;
                return false;
            }

            return isCompatible;
        });

        if (matchIndex < 0 && possibleMatchIndex !== undefined) {
            matchIndex = possibleMatchIndex;
        }

        if (matchIndex < 0) {
            break;
        }

        if (matchIndex < previousMatchIndex) {
            diag.addMessage(LocAddendum.overrideOverloadOrder());
            return false;
        }

        previousMatchIndex = matchIndex;
    }

    if (previousMatchIndex < baseOverloads.length - 1) {
        const unmatchedOverloads = baseOverloads.slice(previousMatchIndex + 1);

        // See if all of the remaining overrides are nonapplicable.
        if (
            !baseClass ||
            unmatchedOverloads.some((overload) => {
                return isOverrideMethodApplicableWithEvaluator(evaluator, overload, baseClass);
            })
        ) {
            // We didn't find matches for all of the base overloads.
            diag.addMessage(LocAddendum.overrideOverloadNoMatch());
            return false;
        }
    }

    return true;
}

export function validateOverrideMethodInternalWithEvaluator(
    baseMethod: FunctionType,
    overrideMethod: FunctionType,
    diag: DiagnosticAddendum | undefined,
    enforceParamNames: boolean,
    evaluator: TypeEvaluator
): boolean {
    const baseParamDetails = getParamListDetails(baseMethod);
    const overrideParamDetails = getParamListDetails(overrideMethod);
    const constraints = new ConstraintTracker();

    let canOverride = true;

    if (!FunctionType.isGradualCallableForm(baseMethod) && !FunctionType.isGradualCallableForm(overrideMethod)) {
        // Verify that we're not overriding a static, class or instance method with
        // an incompatible type.
        if (FunctionType.isStaticMethod(baseMethod)) {
            if (!FunctionType.isStaticMethod(overrideMethod)) {
                diag?.addMessage(LocAddendum.overrideNotStaticMethod());
                canOverride = false;
            }
        } else if (FunctionType.isClassMethod(baseMethod)) {
            if (!FunctionType.isClassMethod(overrideMethod)) {
                diag?.addMessage(LocAddendum.overrideNotClassMethod());
                canOverride = false;
            }
        } else if (FunctionType.isInstanceMethod(baseMethod)) {
            if (!FunctionType.isInstanceMethod(overrideMethod)) {
                diag?.addMessage(LocAddendum.overrideNotInstanceMethod());
                canOverride = false;
            }
        }

        // Verify that the positional param count matches exactly or that the override
        // adds only params that preserve the original signature.
        let foundParamCountMismatch = false;
        if (overrideParamDetails.positionParamCount < baseParamDetails.positionParamCount) {
            if (overrideParamDetails.argsIndex === undefined) {
                foundParamCountMismatch = true;
            } else {
                const overrideArgsType = overrideParamDetails.params[overrideParamDetails.argsIndex].type;
                for (
                    let i = overrideParamDetails.positionParamCount;
                    i < baseParamDetails.positionParamCount;
                    i++
                ) {
                    if (
                        !evaluator.assignType(
                            overrideArgsType,
                            baseParamDetails.params[i].type,
                            diag?.createAddendum(),
                            constraints,
                            AssignTypeFlags.Default
                        )
                    ) {
                        LocAddendum.overrideParamType().format({
                            index: i + 1,
                            baseType: evaluator.printType(baseParamDetails.params[i].type),
                            overrideType: evaluator.printType(overrideArgsType),
                        });
                        canOverride = false;
                    }
                }
            }
        } else if (overrideParamDetails.positionParamCount > baseParamDetails.positionParamCount) {
            // Verify that all of the override parameters that extend the
            // signature are either *args, **kwargs or parameters with
            // default values.

            for (let i = baseParamDetails.positionParamCount; i < overrideParamDetails.positionParamCount; i++) {
                const overrideParam = overrideParamDetails.params[i].param;

                if (
                    overrideParam.category === ParamCategory.Simple &&
                    overrideParam.name &&
                    !overrideParamDetails.params[i].defaultType
                ) {
                    foundParamCountMismatch = true;
                }
            }
        }

        if (foundParamCountMismatch) {
            diag?.addMessage(
                LocAddendum.overridePositionalParamCount().format({
                    baseCount: baseParamDetails.params.length,
                    overrideCount: overrideParamDetails.params.length,
                })
            );
            canOverride = false;
        }

        const positionalParamCount = Math.min(
            baseParamDetails.positionParamCount,
            overrideParamDetails.positionParamCount
        );

        for (let i = 0; i < positionalParamCount; i++) {
            // If the first parameter is a "self" or "cls" parameter, skip the
            // test because these are allowed to violate the Liskov substitution
            // principle.
            if (i === 0) {
                if (
                    FunctionType.isInstanceMethod(overrideMethod) ||
                    FunctionType.isClassMethod(overrideMethod) ||
                    FunctionType.isConstructorMethod(overrideMethod)
                ) {
                    continue;
                }
            }

            const baseParam = baseParamDetails.params[i].param;
            const overrideParam = overrideParamDetails.params[i].param;

            if (
                i >= baseParamDetails.positionOnlyParamCount &&
                !isPrivateOrProtectedName(baseParam.name || '') &&
                baseParamDetails.params[i].kind !== ParamKind.Positional &&
                baseParam.category === ParamCategory.Simple &&
                enforceParamNames &&
                baseParam.name !== overrideParam.name
            ) {
                if (overrideParam.category === ParamCategory.Simple) {
                    if (!FunctionParam.isNameSynthesized(baseParam)) {
                        if (overrideParamDetails.params[i].kind === ParamKind.Positional) {
                            diag?.addMessage(
                                LocAddendum.overrideParamNamePositionOnly().format({
                                    index: i + 1,
                                    baseName: baseParam.name || '*',
                                })
                            );
                        } else {
                            diag?.addMessage(
                                LocAddendum.overrideParamName().format({
                                    index: i + 1,
                                    baseName: baseParam.name || '*',
                                    overrideName: overrideParam.name || '*',
                                })
                            );
                        }
                        canOverride = false;
                    }
                }
            } else if (
                i < overrideParamDetails.positionOnlyParamCount &&
                i >= baseParamDetails.positionOnlyParamCount
            ) {
                if (
                    !FunctionParam.isNameSynthesized(baseParam) &&
                    baseParamDetails.params[i].kind !== ParamKind.Positional &&
                    baseParamDetails.params[i].kind !== ParamKind.ExpandedArgs
                ) {
                    diag?.addMessage(
                        LocAddendum.overrideParamNamePositionOnly().format({
                            index: i + 1,
                            baseName: baseParam.name || '*',
                        })
                    );
                    canOverride = false;
                }
            } else {
                const baseParamType = baseParamDetails.params[i].type;
                const overrideParamType = overrideParamDetails.params[i].type;

                const baseIsSynthesizedTypeVar = isTypeVar(baseParamType) && baseParamType.shared.isSynthesized;
                const overrideIsSynthesizedTypeVar =
                    isTypeVar(overrideParamType) && overrideParamType.shared.isSynthesized;

                if (!baseIsSynthesizedTypeVar && !overrideIsSynthesizedTypeVar) {
                    if (
                        baseParam.category !== overrideParam.category ||
                        !evaluator.assignType(
                            overrideParamType,
                            baseParamType,
                            diag?.createAddendum(),
                            constraints,
                            AssignTypeFlags.Default
                        )
                    ) {
                        diag?.addMessage(
                            LocAddendum.overrideParamType().format({
                                index: i + 1,
                                baseType: evaluator.printType(baseParamType),
                                overrideType: evaluator.printType(overrideParamType),
                            })
                        );
                        canOverride = false;
                    }
                }

                if (baseParamDetails.params[i].defaultType && !overrideParamDetails.params[i].defaultType) {
                    diag?.addMessage(
                        LocAddendum.overrideParamNoDefault().format({
                            index: i + 1,
                        })
                    );
                    canOverride = false;
                }
            }
        }

        // Check for positional (named) parameters in the base method that
        // do not exist in the override.
        if (enforceParamNames && overrideParamDetails.kwargsIndex === undefined) {
            for (let i = positionalParamCount; i < baseParamDetails.positionParamCount; i++) {
                const baseParam = baseParamDetails.params[i];

                if (baseParam.kind === ParamKind.Standard && baseParam.param.category === ParamCategory.Simple) {
                    diag?.addMessage(
                        LocAddendum.overrideParamNamePositionOnly().format({
                            index: i + 1,
                            baseName: baseParam.param.name || '*',
                        })
                    );
                    canOverride = false;
                }
            }
        }

        // Check for a *args match.
        if (baseParamDetails.argsIndex !== undefined) {
            if (overrideParamDetails.argsIndex === undefined) {
                diag?.addMessage(
                    LocAddendum.overrideParamNameMissing().format({
                        name: baseParamDetails.params[baseParamDetails.argsIndex].param.name ?? '?',
                    })
                );
                canOverride = false;
            } else {
                const overrideParamType = overrideParamDetails.params[overrideParamDetails.argsIndex].type;
                const baseParamType = baseParamDetails.params[baseParamDetails.argsIndex].type;

                if (
                    !evaluator.assignType(
                        overrideParamType,
                        baseParamType,
                        diag?.createAddendum(),
                        constraints,
                        AssignTypeFlags.Default
                    )
                ) {
                    diag?.addMessage(
                        LocAddendum.overrideParamKeywordType().format({
                            name: overrideParamDetails.params[overrideParamDetails.argsIndex].param.name ?? '?',
                            baseType: evaluator.printType(baseParamType),
                            overrideType: evaluator.printType(overrideParamType),
                        })
                    );
                    canOverride = false;
                }
            }
        }

        // Now check any keyword-only parameters.
        const baseKwOnlyParams = baseParamDetails.params.filter(
            (paramInfo) => paramInfo.kind === ParamKind.Keyword && paramInfo.param.category === ParamCategory.Simple
        );
        const overrideKwOnlyParams = overrideParamDetails.params.filter(
            (paramInfo) => paramInfo.kind === ParamKind.Keyword && paramInfo.param.category === ParamCategory.Simple
        );

        baseKwOnlyParams.forEach((paramInfo) => {
            const overrideParamInfo = overrideKwOnlyParams.find((pi) => paramInfo.param.name === pi.param.name);

            if (!overrideParamInfo && overrideParamDetails.kwargsIndex === undefined) {
                diag?.addMessage(
                    LocAddendum.overrideParamNameMissing().format({
                        name: paramInfo.param.name ?? '?',
                    })
                );
                canOverride = false;
            } else {
                let targetParamType = overrideParamInfo?.type;
                if (!targetParamType) {
                    targetParamType = overrideParamDetails.params[overrideParamDetails.kwargsIndex!].type;
                }

                if (
                    !evaluator.assignType(
                        targetParamType,
                        paramInfo.type,
                        diag?.createAddendum(),
                        constraints,
                        AssignTypeFlags.Default
                    )
                ) {
                    diag?.addMessage(
                        LocAddendum.overrideParamKeywordType().format({
                            name: paramInfo.param.name ?? '?',
                            baseType: evaluator.printType(paramInfo.type),
                            overrideType: evaluator.printType(targetParamType),
                        })
                    );
                    canOverride = false;
                }

                if (overrideParamInfo) {
                    if (paramInfo.defaultType && !overrideParamInfo.defaultType) {
                        diag?.addMessage(
                            LocAddendum.overrideParamKeywordNoDefault().format({
                                name: overrideParamInfo.param.name ?? '?',
                            })
                        );
                        canOverride = false;
                    }
                }
            }
        });

        // Verify that any keyword-only parameters added by the overload are compatible
        // with the **kwargs in the base.
        overrideKwOnlyParams.forEach((paramInfo) => {
            const baseParamInfo = baseKwOnlyParams.find((pi) => paramInfo.param.name === pi.param.name);

            if (!baseParamInfo) {
                if (baseParamDetails.kwargsIndex === undefined) {
                    if (!paramInfo.defaultType) {
                        diag?.addMessage(
                            LocAddendum.overrideParamNameExtra().format({
                                name: paramInfo.param.name ?? '?',
                            })
                        );
                        canOverride = false;
                    }
                } else {
                    // Base has a **kwargs; ensure the added keyword-only parameter's
                    // type is compatible with the base's **kwargs value type.
                    const baseKwargsType = baseParamDetails.params[baseParamDetails.kwargsIndex].type;
                    if (
                        !evaluator.assignType(
                            paramInfo.type,
                            baseKwargsType,
                            diag?.createAddendum(),
                            constraints,
                            AssignTypeFlags.Default
                        )
                    ) {
                        diag?.addMessage(
                            LocAddendum.overrideParamKeywordType().format({
                                name: paramInfo.param.name ?? '?',
                                baseType: evaluator.printType(baseKwargsType),
                                overrideType: evaluator.printType(paramInfo.type),
                            })
                        );
                        canOverride = false;
                    }
                }
            }
        });

        // Verify that if the base method has a **kwargs parameter, the override does too.
        if (baseParamDetails.kwargsIndex !== undefined && overrideParamDetails.kwargsIndex === undefined) {
            diag?.addMessage(
                LocAddendum.kwargsParamMissing().format({
                    paramName: baseParamDetails.params[baseParamDetails.kwargsIndex].param.name!,
                })
            );
            canOverride = false;
        }
    }

    // Verify that one or the other method doesn't contain a ParamSpec.
    if (baseParamDetails.paramSpec && !overrideParamDetails.paramSpec) {
        // If the override uses an `*args: Any, **kwargs: Any` signature, we
        // will allow this as an acceptable overload for a `*args: P.args, **kwargs: P.kwargs`.
        const overrideHasArgsKwargs =
            overrideParamDetails.argsIndex !== undefined &&
            isAnyOrUnknown(overrideParamDetails.params[overrideParamDetails.argsIndex].type) &&
            overrideParamDetails.kwargsIndex !== undefined &&
            isAnyOrUnknown(overrideParamDetails.params[overrideParamDetails.kwargsIndex].type);

        if (!overrideHasArgsKwargs) {
            diag?.addMessage(LocAddendum.paramSpecMissingInOverride());
            canOverride = false;
        }
    }

    // Now check the return type.
    const baseReturnType = getEffectiveReturnTypeForAssign(baseMethod, evaluator);
    const overrideReturnType = evaluator.solveAndApplyConstraints(getEffectiveReturnTypeForAssign(overrideMethod, evaluator), constraints);

    if (
        !evaluator.assignType(
            baseReturnType,
            overrideReturnType,
            diag?.createAddendum(),
            constraints,
            AssignTypeFlags.Default
        )
    ) {
        diag?.addMessage(
            LocAddendum.overrideReturnType().format({
                baseType: evaluator.printType(baseReturnType),
                overrideType: evaluator.printType(overrideReturnType),
            })
        );

        canOverride = false;
    }

    return canOverride;
}

// Helper to replicate the closure getEffectiveReturnType using the interface.
function getEffectiveReturnTypeForAssign(type: FunctionType, evaluator: TypeEvaluator): Type {
    const specializedReturnType = FunctionType.getEffectiveReturnType(type, /* includeInferred */ false);
    if (specializedReturnType && !isUnknown(specializedReturnType)) {
        return specializedReturnType;
    }
    return evaluator.getInferredReturnType(type);
}

export function assignFunctionWithEvaluator(
    destType: FunctionType,
    srcType: FunctionType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker,
    flags: AssignTypeFlags,
    recursionCount: number,
    prefetched: Partial<PrefetchedTypes> | undefined,
    evaluator: TypeEvaluator
): boolean {
    let canAssign = true;
    const checkReturnType = (flags & AssignTypeFlags.SkipReturnTypeCheck) === 0;
    const isContra = (flags & AssignTypeFlags.Contravariant) !== 0;
    flags &= ~AssignTypeFlags.SkipReturnTypeCheck;

    const destParamSpec = FunctionType.getParamSpecFromArgsKwargs(destType);
    if (destParamSpec) {
        destType = FunctionType.cloneRemoveParamSpecArgsKwargs(destType);
    }

    const srcParamSpec = FunctionType.getParamSpecFromArgsKwargs(srcType);
    if (srcParamSpec) {
        srcType = FunctionType.cloneRemoveParamSpecArgsKwargs(srcType);
    }

    const destParamDetails = getParamListDetails(destType, {
        disallowExtraKwargsForTd: (flags & AssignTypeFlags.DisallowExtraKwargsForTd) !== 0,
    });
    const srcParamDetails = getParamListDetails(srcType, {
        disallowExtraKwargsForTd: (flags & AssignTypeFlags.DisallowExtraKwargsForTd) !== 0,
    });

    adjustSourceParamDetailsForDestVariadicWithEvaluator(
        evaluator,
        isContra ? destParamDetails : srcParamDetails,
        isContra ? srcParamDetails : destParamDetails
    );

    const targetIncludesParamSpec = isContra ? !!srcParamSpec : !!destParamSpec;

    const destPositionalCount = destParamDetails.firstKeywordOnlyIndex ?? destParamDetails.params.length;
    const srcPositionalCount = srcParamDetails.firstKeywordOnlyIndex ?? srcParamDetails.params.length;
    const positionalsToMatch = Math.min(destPositionalCount, srcPositionalCount);
    const skippedPosParamIndices: number[] = [];

    // Match positional parameters.
    for (let paramIndex = 0; paramIndex < positionalsToMatch; paramIndex++) {
        if (
            paramIndex === 0 &&
            destType.shared.methodClass &&
            (flags & AssignTypeFlags.SkipSelfClsParamCheck) !== 0
        ) {
            if (FunctionType.isInstanceMethod(destType) || FunctionType.isClassMethod(destType)) {
                continue;
            }
        }

        // Skip over the *args parameter since it's handled separately below.
        if (paramIndex === destParamDetails.argsIndex) {
            if (!isUnpackedTypeVarTuple(destParamDetails.params[destParamDetails.argsIndex].type)) {
                skippedPosParamIndices.push(paramIndex);
            }
            continue;
        }

        const destParam = destParamDetails.params[paramIndex];
        const srcParam = srcParamDetails.params[paramIndex];

        // Find the original index of this source param. If we synthesized it above (for
        // a variadic parameter), it may not be found.
        const srcParamType = srcParam.type;
        const destParamType = destParam.type;

        const destParamName = destParam.param.name ?? '';
        const srcParamName = srcParam.param.name ?? '';
        if (destParamName) {
            const isDestPositionalOnly =
                destParam.kind === ParamKind.Positional || destParam.kind === ParamKind.ExpandedArgs;
            if (
                !isDestPositionalOnly &&
                destParam.param.category !== ParamCategory.ArgsList &&
                srcParam.param.category !== ParamCategory.ArgsList
            ) {
                if (srcParam.kind === ParamKind.Positional || srcParam.kind === ParamKind.ExpandedArgs) {
                    diag?.createAddendum().addMessage(
                        LocAddendum.functionParamPositionOnly().format({
                            name: destParamName,
                        })
                    );
                    canAssign = false;
                } else if (destParamName !== srcParamName) {
                    diag?.createAddendum().addMessage(
                        LocAddendum.functionParamName().format({
                            srcName: srcParamName,
                            destName: destParamName,
                        })
                    );
                    canAssign = false;
                }
            }
        }

        if (destParam.defaultType) {
            if (!srcParam.defaultType && paramIndex !== srcParamDetails.argsIndex) {
                diag?.createAddendum().addMessage(
                    LocAddendum.functionParamDefaultMissing().format({
                        name: srcParamName,
                    })
                );
                canAssign = false;
            }

            // If we're performing a partial overload match and both the source
            // and dest parameters provide defaults, assume that there could
            // be a match.
            if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0) {
                if (srcParam.defaultType) {
                    continue;
                }
            }
        }

        // Handle the special case of an overloaded __init__ method whose self
        // parameter is annotated.
        if (
            paramIndex === 0 &&
            srcType.shared.name === '__init__' &&
            FunctionType.isInstanceMethod(srcType) &&
            destType.shared.name === '__init__' &&
            FunctionType.isInstanceMethod(destType) &&
            FunctionType.isOverloaded(destType) &&
            FunctionParam.isTypeDeclared(destParam.param)
        ) {
            continue;
        }

        if (isUnpacked(srcParamType)) {
            canAssign = false;
        } else if (
            !assignParamWithEvaluator(
                destParamType,
                srcParamType,
                paramIndex,
                diag?.createAddendum(),
                constraints,
                flags,
                recursionCount,
                evaluator
            )
        ) {
            // Handle the special case where the source parameter is a synthesized
            // TypeVar for "self" or "cls".
            if (
                (flags & AssignTypeFlags.SkipSelfClsTypeCheck) === 0 ||
                !isTypeVar(srcParamType) ||
                !srcParamType.shared.isSynthesized
            ) {
                canAssign = false;
            }
        } else if (
            destParam.kind !== ParamKind.Positional &&
            destParam.kind !== ParamKind.ExpandedArgs &&
            srcParam.kind === ParamKind.Positional &&
            srcParamDetails.kwargsIndex === undefined &&
            !srcParamDetails.params.some(
                (p) =>
                    p.kind === ParamKind.Keyword &&
                    p.param.category === ParamCategory.Simple &&
                    p.param.name === destParam.param.name
            )
        ) {
            diag?.addMessage(
                LocAddendum.namedParamMissingInSource().format({
                    name: destParam.param.name ?? '',
                })
            );
            canAssign = false;
        }
    }

    if (
        !FunctionType.isGradualCallableForm(destType) &&
        destParamDetails.firstPositionOrKeywordIndex < srcParamDetails.positionOnlyParamCount &&
        !targetIncludesParamSpec
    ) {
        diag?.createAddendum().addMessage(
            LocAddendum.argsPositionOnly().format({
                expected: srcParamDetails.positionOnlyParamCount,
                received: destParamDetails.firstPositionOrKeywordIndex,
            })
        );
        canAssign = false;
    }

    if (destPositionalCount < srcPositionalCount && !targetIncludesParamSpec) {
        // Add any remaining positional parameter indices to the list that
        // need to be validated.
        for (let i = destPositionalCount; i < srcPositionalCount; i++) {
            skippedPosParamIndices.push(i);
        }

        for (const i of skippedPosParamIndices) {
            // If the dest has an *args parameter, make sure it can accept the remaining
            // positional arguments in the source.
            if (destParamDetails.argsIndex !== undefined) {
                const destArgsType = destParamDetails.params[destParamDetails.argsIndex].type;
                const srcParamType = srcParamDetails.params[i].type;
                if (
                    !assignParamWithEvaluator(
                        destArgsType,
                        srcParamType,
                        i,
                        diag?.createAddendum(),
                        constraints,
                        flags,
                        recursionCount,
                        evaluator
                    )
                ) {
                    canAssign = false;
                }

                continue;
            }

            // If The source parameter has a default value, it is OK for the
            // corresponding dest parameter to be missing.
            const srcParam = srcParamDetails.params[i];

            if (srcParam.defaultType) {
                // Assign default arg value in case it is needed for
                // populating TypeVar constraints.
                const paramInfo = srcParamDetails.params[i];
                const defaultArgType = paramInfo.defaultType ?? paramInfo.defaultType;

                // Enforce invariance below because the default arg value
                // is constructed prior to the call, so its type is already
                // fixed.
                if (
                    defaultArgType &&
                    !evaluator.assignType(
                        paramInfo.type,
                        defaultArgType,
                        diag?.createAddendum(),
                        constraints,
                        flags,
                        recursionCount
                    )
                ) {
                    if ((flags & AssignTypeFlags.PartialOverloadOverlap) === 0) {
                        canAssign = false;
                    }
                }

                continue;
            }

            // If the source parameter is also addressable by keyword, it is OK
            // that there is no matching positional parameter in the dest.
            if (srcParam.kind === ParamKind.Standard) {
                continue;
            }

            // If the source parameter is a variadic, it is OK that there is no
            // matching positional parameter in the dest.
            if (srcParam.param.category === ParamCategory.ArgsList) {
                continue;
            }

            const nonDefaultSrcParamCount = srcParamDetails.params.filter(
                (p) => !!p.param.name && !p.defaultType && p.param.category === ParamCategory.Simple
            ).length;

            diag?.createAddendum().addMessage(
                LocAddendum.functionTooFewParams().format({
                    expected: nonDefaultSrcParamCount,
                    received: destPositionalCount,
                })
            );
            canAssign = false;
            break;
        }
    } else if (srcPositionalCount < destPositionalCount) {
        if (srcParamDetails.argsIndex !== undefined) {
            // Make sure the remaining dest parameters can be assigned to the source
            // *args parameter type.
            const srcArgsType = srcParamDetails.params[srcParamDetails.argsIndex].type;
            for (let paramIndex = srcPositionalCount; paramIndex < destPositionalCount; paramIndex++) {
                if (paramIndex === srcParamDetails.argsIndex) {
                    continue;
                }

                const destParamType = destParamDetails.params[paramIndex].type;
                if (isTypeVarTuple(destParamType) && !isTypeVarTuple(srcArgsType)) {
                    diag?.addMessage(LocAddendum.typeVarTupleRequiresKnownLength());
                    canAssign = false;
                } else {
                    if (
                        !assignParamWithEvaluator(
                            destParamType,
                            srcArgsType,
                            paramIndex,
                            diag?.createAddendum(),
                            constraints,
                            flags,
                            recursionCount,
                            evaluator
                        )
                    ) {
                        canAssign = false;
                    }

                    const destParamKind = destParamDetails.params[paramIndex].kind;
                    if (
                        destParamKind !== ParamKind.Positional &&
                        destParamKind !== ParamKind.ExpandedArgs &&
                        srcParamDetails.kwargsIndex === undefined
                    ) {
                        diag?.addMessage(
                            LocAddendum.namedParamMissingInSource().format({
                                name: destParamDetails.params[paramIndex].param.name ?? '',
                            })
                        );
                        canAssign = false;
                    }
                }
            }
        } else if (!srcParamDetails.paramSpec) {
            // If the dest contains a *args, remove it from the positional count
            // because it's OK for zero source args to match it.
            let adjDestPositionalCount = destPositionalCount;
            if (destParamDetails.argsIndex !== undefined && destParamDetails.argsIndex < destPositionalCount) {
                adjDestPositionalCount--;
            }

            // If we're doing a partial overload overlap check, ignore dest positional
            // params with default values.
            if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0) {
                while (
                    adjDestPositionalCount > 0 &&
                    destParamDetails.params[adjDestPositionalCount - 1].defaultType
                ) {
                    adjDestPositionalCount--;
                }
            }

            if (srcPositionalCount < adjDestPositionalCount) {
                diag?.addMessage(
                    LocAddendum.functionTooManyParams().format({
                        expected: srcPositionalCount,
                        received: destPositionalCount,
                    })
                );
                canAssign = false;
            }
        }
    }

    // If both src and dest have an "*args" parameter, make sure
    // their types are compatible.
    if (
        srcParamDetails.argsIndex !== undefined &&
        destParamDetails.argsIndex !== undefined &&
        !FunctionType.isGradualCallableForm(destType)
    ) {
        let destArgsType = destParamDetails.params[destParamDetails.argsIndex].type;
        let srcArgsType = srcParamDetails.params[srcParamDetails.argsIndex].type;

        if (!isUnpacked(destArgsType)) {
            destArgsType = makeTupleObject(
                evaluator,
                [{ type: destArgsType, isUnbounded: true }],
                /* isUnpacked */ true
            );
        }

        if (!isUnpacked(srcArgsType)) {
            srcArgsType = makeTupleObject(
                evaluator,
                [{ type: srcArgsType, isUnbounded: true }],
                /* isUnpacked */ true
            );
        }

        if (
            !assignParamWithEvaluator(
                destArgsType,
                srcArgsType,
                destParamDetails.params[destParamDetails.argsIndex].index,
                diag?.createAddendum(),
                constraints,
                flags,
                recursionCount,
                evaluator
            )
        ) {
            canAssign = false;
        }
    }

    // If the dest has an "*args" but the source doesn't, report the incompatibility.
    // The converse situation is OK.
    if (
        !FunctionType.isGradualCallableForm(destType) &&
        srcParamDetails.argsIndex === undefined &&
        srcParamSpec === undefined &&
        destParamDetails.argsIndex !== undefined &&
        !destParamDetails.hasUnpackedTypeVarTuple
    ) {
        diag?.createAddendum().addMessage(
            LocAddendum.argsParamMissing().format({
                paramName: destParamDetails.params[destParamDetails.argsIndex].param.name ?? '',
            })
        );
        canAssign = false;
    }

    // Handle matching of named (keyword) parameters.
    if (!targetIncludesParamSpec) {
        // Build a dictionary of named parameters in the dest.
        const destParamMap = new Map<string, VirtualParamDetails>();

        if (destParamDetails.firstKeywordOnlyIndex !== undefined) {
            destParamDetails.params.forEach((param, index) => {
                if (index >= destParamDetails.firstKeywordOnlyIndex!) {
                    if (
                        param.param.name &&
                        param.param.category === ParamCategory.Simple &&
                        param.kind !== ParamKind.Positional &&
                        param.kind !== ParamKind.ExpandedArgs
                    ) {
                        destParamMap.set(param.param.name, param);
                    }
                }
            });
        }

        // If the dest has fewer positional arguments than the source, the remaining
        // positional arguments in the source can be treated as named arguments.
        let srcStartOfNamed =
            srcParamDetails.firstKeywordOnlyIndex !== undefined
                ? srcParamDetails.firstKeywordOnlyIndex
                : srcParamDetails.params.length;
        if (destPositionalCount < srcPositionalCount && destParamDetails.argsIndex === undefined) {
            srcStartOfNamed = destPositionalCount;
        }

        if (srcStartOfNamed >= 0) {
            srcParamDetails.params.forEach((srcParamInfo, index) => {
                if (index < srcStartOfNamed) {
                    return;
                }

                if (
                    !srcParamInfo.param.name ||
                    srcParamInfo.param.category !== ParamCategory.Simple ||
                    srcParamInfo.kind === ParamKind.Positional
                ) {
                    return;
                }

                const destParamInfo = destParamMap.get(srcParamInfo.param.name);
                const paramDiag = diag?.createAddendum();
                const srcParamType = srcParamInfo.type;

                if (!destParamInfo) {
                    if (destParamDetails.kwargsIndex === undefined && !srcParamInfo.defaultType) {
                        if (paramDiag) {
                            paramDiag.addMessage(
                                LocAddendum.namedParamMissingInDest().format({
                                    name: srcParamInfo.param.name,
                                })
                            );
                        }
                        canAssign = false;
                    } else if (destParamDetails.kwargsIndex !== undefined) {
                        // Make sure we can assign the type to the Kwargs.
                        if (
                            !assignParamWithEvaluator(
                                destParamDetails.params[destParamDetails.kwargsIndex].type,
                                srcParamType,
                                destParamDetails.params[destParamDetails.kwargsIndex].index,
                                diag?.createAddendum(),
                                constraints,
                                flags,
                                recursionCount,
                                evaluator
                            )
                        ) {
                            canAssign = false;
                        }
                    } else if (srcParamInfo.defaultType) {
                        // Assign default arg values in case they are needed for
                        // populating TypeVar constraints.
                        const defaultArgType = srcParamInfo.defaultType ?? srcParamInfo.defaultType;

                        if (
                            defaultArgType &&
                            !evaluator.assignType(
                                srcParamInfo.type,
                                defaultArgType,
                                diag?.createAddendum(),
                                constraints,
                                flags,
                                recursionCount
                            )
                        ) {
                            if ((flags & AssignTypeFlags.PartialOverloadOverlap) === 0) {
                                canAssign = false;
                            }
                        }
                    }
                    return;
                }

                // If we're performing a partial overload match and both the source
                // and dest parameters provide defaults, assume that there could
                // be a match.
                if (srcParamInfo.defaultType && destParamInfo.defaultType) {
                    if ((flags & AssignTypeFlags.PartialOverloadOverlap) !== 0) {
                        destParamMap.delete(srcParamInfo.param.name);
                        return;
                    }
                }

                const destParamType = destParamInfo.type;
                const specializedDestParamType = constraints
                    ? evaluator.solveAndApplyConstraints(destParamType, constraints)
                    : destParamType;

                if (
                    !assignParamWithEvaluator(
                        destParamInfo.type,
                        srcParamType,
                        /* paramIndex */ undefined,
                        paramDiag?.createAddendum(),
                        constraints,
                        flags,
                        recursionCount,
                        evaluator
                    )
                ) {
                    if (paramDiag) {
                        paramDiag.addMessage(
                            LocAddendum.namedParamTypeMismatch().format({
                                name: srcParamInfo.param.name,
                                sourceType: evaluator.printType(specializedDestParamType),
                                destType: evaluator.printType(srcParamType),
                            })
                        );
                    }
                    canAssign = false;
                }

                if (destParamInfo.defaultType && !srcParamInfo.defaultType) {
                    diag?.createAddendum().addMessage(
                        LocAddendum.functionParamDefaultMissing().format({
                            name: srcParamInfo.param.name,
                        })
                    );
                    canAssign = false;
                }

                destParamMap.delete(srcParamInfo.param.name);
            });
        }

        // See if there are any unmatched named parameters.
        destParamMap.forEach((destParamInfo, paramName) => {
            if (srcParamDetails.kwargsIndex !== undefined && destParamInfo.param.name) {
                // Make sure the src kwargs type is compatible.
                if (
                    !assignParamWithEvaluator(
                        destParamInfo.type,
                        srcParamDetails.params[srcParamDetails.kwargsIndex].type,
                        destParamInfo.index,
                        diag?.createAddendum(),
                        constraints,
                        flags,
                        recursionCount,
                        evaluator
                    )
                ) {
                    canAssign = false;
                }
                destParamMap.delete(paramName);
            } else {
                diag?.createAddendum().addMessage(
                    LocAddendum.namedParamMissingInSource().format({ name: paramName })
                );
                canAssign = false;
            }
        });

        // If both src and dest have a "**kwargs" parameter, make sure their types are compatible.
        if (srcParamDetails.kwargsIndex !== undefined && destParamDetails.kwargsIndex !== undefined) {
            if (
                !assignParamWithEvaluator(
                    destParamDetails.params[destParamDetails.kwargsIndex].type,
                    srcParamDetails.params[srcParamDetails.kwargsIndex].type,
                    destParamDetails.params[destParamDetails.kwargsIndex].index,
                    diag?.createAddendum(),
                    constraints,
                    flags,
                    recursionCount,
                    evaluator
                )
            ) {
                canAssign = false;
            }
        }

        // If the dest has a "**kwargs" but the source doesn't, report the incompatibility.
        // The converse situation is OK.
        if (
            !FunctionType.isGradualCallableForm(destType) &&
            srcParamDetails.kwargsIndex === undefined &&
            srcParamSpec === undefined &&
            destParamDetails.kwargsIndex !== undefined
        ) {
            diag?.createAddendum().addMessage(
                LocAddendum.kwargsParamMissing().format({
                    paramName: destParamDetails.params[destParamDetails.kwargsIndex].param.name!,
                })
            );
            canAssign = false;
        }
    }

    if ((flags & AssignTypeFlags.OverloadOverlap) !== 0) {
        // If we're checking for full overlapping overloads and the source is
        // a gradual form, the dest must also be a gradual form.
        if (FunctionType.isGradualCallableForm(srcType) && !FunctionType.isGradualCallableForm(destType)) {
            canAssign = false;
        }

        // If the src contains a ParamSpec the dest must also.
        if (srcParamSpec && !destParamSpec) {
            canAssign = false;
        }
    }

    // If the source and the dest are using the same ParamSpec, any additional
    // concatenated parameters must match.
    if (targetIncludesParamSpec && srcParamSpec?.priv.nameWithScope === destParamSpec?.priv.nameWithScope) {
        if (srcParamDetails.params.length !== destParamDetails.params.length) {
            canAssign = false;
        }
    }

    // Are we assigning to a function with a ParamSpec?
    if (targetIncludesParamSpec) {
        const effectiveSrcType = isContra ? destType : srcType;
        const effectiveDestType = isContra ? srcType : destType;

        const effectiveSrcParamSpec = isContra ? destParamSpec : srcParamSpec;
        const effectiveDestParamSpec = isContra ? srcParamSpec : destParamSpec;

        if (effectiveDestParamSpec) {
            const requiredMatchParamCount = effectiveDestType.shared.parameters.filter((p, i) => {
                if (!p.name) {
                    return false;
                }

                const paramType = FunctionType.getParamType(effectiveDestType, i);
                if (p.category === ParamCategory.Simple && isParamSpec(paramType)) {
                    return false;
                }
                return true;
            }).length;
            let matchedParamCount = 0;
            const remainingParams: FunctionParam[] = [];

            // If there are parameters in the source that are not matched
            // to parameters in the dest, assume these are concatenated on
            // to the ParamSpec.
            effectiveSrcType.shared.parameters.forEach((p, index) => {
                if (matchedParamCount < requiredMatchParamCount) {
                    if (p.name) {
                        matchedParamCount++;
                    }

                    // If this is a *args parameter, assume that it provides
                    // the remaining positional parameters, but also assume
                    // that it is not exhausted and can provide additional
                    // parameters.
                    if (p.category !== ParamCategory.ArgsList) {
                        return;
                    }
                }

                if (isPositionOnlySeparator(p) && remainingParams.length === 0) {
                    // Don't bother pushing a position-only separator if it
                    // is the first remaining param.
                    return;
                }

                remainingParams.push(
                    FunctionParam.create(
                        p.category,
                        FunctionType.getParamType(effectiveSrcType, index),
                        p.flags,
                        p.name,
                        FunctionType.getParamDefaultType(effectiveSrcType, index),
                        p.defaultExpr
                    )
                );
            });

            // If there are remaining parameters and the source and dest do not contain
            // the same ParamSpec, synthesize a function for the remaining parameters.
            if (
                remainingParams.length > 0 ||
                !effectiveSrcParamSpec ||
                !isTypeSame(effectiveSrcParamSpec, effectiveDestParamSpec, { ignoreTypeFlags: true })
            ) {
                const effectiveSrcPosCount = isContra ? destPositionalCount : srcPositionalCount;
                const effectiveDestPosCount = isContra ? srcPositionalCount : destPositionalCount;

                // If the src and dest both have ParamSpecs but the src has additional positional
                // parameters that have not been matched to dest positional parameters (probably due
                // to a Concatenate), don't attempt to assign the remaining parameters to the ParamSpec.
                if (!effectiveSrcParamSpec || effectiveSrcPosCount >= effectiveDestPosCount) {
                    const remainingFunction = FunctionType.createInstance(
                        '',
                        '',
                        '',
                        effectiveSrcType.shared.flags | FunctionTypeFlags.SynthesizedMethod,
                        effectiveSrcType.shared.docString
                    );
                    remainingFunction.shared.deprecatedMessage = effectiveSrcType.shared.deprecatedMessage;
                    remainingFunction.shared.typeVarScopeId = effectiveSrcType.shared.typeVarScopeId;
                    remainingFunction.priv.constructorTypeVarScopeId =
                        effectiveSrcType.priv.constructorTypeVarScopeId;
                    remainingFunction.shared.methodClass = effectiveSrcType.shared.methodClass;
                    remainingParams.forEach((param) => {
                        FunctionType.addParam(remainingFunction, param);
                    });
                    if (effectiveSrcParamSpec) {
                        FunctionType.addParamSpecVariadics(
                            remainingFunction,
                            convertToInstance(effectiveSrcParamSpec)
                        );
                    }

                    if (
                        !evaluator.assignType(
                            effectiveDestParamSpec,
                            remainingFunction,
                            /* diag */ undefined,
                            constraints,
                            flags
                        )
                    ) {
                        // If we couldn't assign the function to the ParamSpec, see if we can
                        // assign only the ParamSpec. This is possible if there were no
                        // remaining parameters.
                        if (
                            remainingParams.length > 0 ||
                            !effectiveSrcParamSpec ||
                            !evaluator.assignType(
                                convertToInstance(effectiveDestParamSpec),
                                convertToInstance(effectiveSrcParamSpec),
                                /* diag */ undefined,
                                constraints,
                                flags
                            )
                        ) {
                            canAssign = false;
                        }
                    }
                }
            }
        }
    }

    // Match the return parameter.
    if (checkReturnType) {
        const destReturnType = getEffectiveReturnTypeForAssign(destType, evaluator);
        if (!isAnyOrUnknown(destReturnType)) {
            const srcReturnType = evaluator.solveAndApplyConstraints(getEffectiveReturnTypeForAssign(srcType, evaluator), constraints);
            const returnDiag = diag?.createAddendum();

            let isReturnTypeCompatible = false;

            let effectiveFlags = flags;

            // If the source has a declared return type that includes a literal
            // in its annotation, assume that we will want the constraint
            // solver to retain literals.
            if (
                srcType.shared.declaredReturnType &&
                containsLiteralType(srcType.shared.declaredReturnType, /* includeTypeArgs */ true)
            ) {
                effectiveFlags |= AssignTypeFlags.RetainLiteralsForTypeVar;
            }

            if (
                evaluator.assignType(
                    destReturnType,
                    srcReturnType,
                    returnDiag?.createAddendum(),
                    constraints,
                    effectiveFlags,
                    recursionCount
                )
            ) {
                isReturnTypeCompatible = true;
            } else {
                // Handle the special case where the return type is a TypeGuard[T]
                // or TypeIs[T]. This should also act as a bool, since that's its
                // type at runtime.
                if (
                    isClassInstance(srcReturnType) &&
                    ClassType.isBuiltIn(srcReturnType, ['TypeGuard', 'TypeIs']) &&
                    prefetched?.boolClass &&
                    isInstantiableClass(prefetched.boolClass)
                ) {
                    if (
                        evaluator.assignType(
                            destReturnType,
                            ClassType.cloneAsInstance(prefetched.boolClass),
                            returnDiag?.createAddendum(),
                            constraints,
                            flags,
                            recursionCount
                        )
                    ) {
                        isReturnTypeCompatible = true;
                    }
                }
            }

            if (!isReturnTypeCompatible) {
                if (returnDiag) {
                    returnDiag.addMessage(
                        LocAddendum.functionReturnTypeMismatch().format({
                            sourceType: evaluator.printType(srcReturnType),
                            destType: evaluator.printType(destReturnType),
                        })
                    );
                }
                canAssign = false;
            }
        }
    }

    return canAssign;
}

export function assignParamWithEvaluator(
    destType: Type,
    srcType: Type,
    paramIndex: number | undefined,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker,
    flags: AssignTypeFlags,
    recursionCount: number,
    evaluator: TypeEvaluator
) {
    if (isTypeVarTuple(destType) && !isUnpacked(srcType)) {
        return false;
    }

    let specializedSrcType = srcType;
    let specializedDestType = destType;
    let doSpecializationStep = false;

    if ((flags & AssignTypeFlags.OverloadOverlap) === 0) {
        const isFirstPass = (flags & AssignTypeFlags.ArgAssignmentFirstPass) !== 0;

        if ((flags & AssignTypeFlags.Contravariant) === 0) {
            if (!isFirstPass) {
                specializedDestType = evaluator.solveAndApplyConstraints(
                    destType,
                    constraints,
                    /* applyOptions */ undefined,
                    { useLowerBoundOnly: true }
                );
            }
            doSpecializationStep = requiresSpecialization(specializedDestType);
        } else {
            if (!isFirstPass) {
                specializedSrcType = evaluator.solveAndApplyConstraints(srcType, constraints, /* applyOptions */ undefined, {
                    useLowerBoundOnly: true,
                });
            }
            doSpecializationStep = requiresSpecialization(specializedSrcType);
        }
    }

    // Is an additional specialization step required?
    if (doSpecializationStep) {
        if (
            evaluator.assignType(
                specializedSrcType,
                specializedDestType,
                /* diag */ undefined,
                constraints,
                (flags ^ AssignTypeFlags.Contravariant) | AssignTypeFlags.RetainLiteralsForTypeVar,
                recursionCount
            )
        ) {
            specializedDestType = evaluator.solveAndApplyConstraints(destType, constraints);
        }
    }

    if (
        !evaluator.assignType(
            specializedSrcType,
            specializedDestType,
            diag?.createAddendum(),
            constraints,
            flags,
            recursionCount
        )
    ) {
        if (diag && paramIndex !== undefined) {
            diag.addMessage(
                LocAddendum.paramAssignment().format({
                    index: paramIndex + 1,
                    sourceType: evaluator.printType(destType),
                    destType: evaluator.printType(srcType),
                })
            );
        }

        return false;
    }

    return true;
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

export function getTypeOfSuperCallWithEvaluator(
    evaluator: TypeEvaluator,
    prefetched: Partial<PrefetchedTypes> | undefined,
    node: CallNode
): TypeResult {
    if (node.d.args.length > 2) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.superCallArgCount(), node.d.args[2]);
    }

    const enclosingFunction = ParseTreeUtils.getEnclosingFunctionEvaluationScope(node);
    const enclosingClass = enclosingFunction ? ParseTreeUtils.getEnclosingClass(enclosingFunction) : undefined;
    const enclosingClassType = enclosingClass ? evaluator.getTypeOfClass(enclosingClass)?.classType : undefined;

    // Determine which class the "super" call is applied to. If
    // there is no first argument, then the class is implicit.
    let targetClassType: Type;
    if (node.d.args.length > 0) {
        targetClassType = evaluator.getTypeOfExpression(node.d.args[0].d.valueExpr).type;
        const concreteTargetClassType = evaluator.makeTopLevelTypeVarsConcrete(targetClassType);

        if (
            !isAnyOrUnknown(concreteTargetClassType) &&
            !isInstantiableClass(concreteTargetClassType) &&
            !isMetaclassInstance(concreteTargetClassType)
        ) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportArgumentType,
                LocMessage.superCallFirstArg().format({ type: evaluator.printType(targetClassType) }),
                node.d.args[0].d.valueExpr
            );
        }
    } else {
        if (enclosingClassType) {
            targetClassType = enclosingClassType ?? UnknownType.create();

            // Zero-argument forms of super are not allowed within static methods.
            // This results in a runtime exception.
            if (enclosingFunction) {
                const functionInfo = getFunctionInfoFromDecorators(
                    evaluator,
                    enclosingFunction,
                    /* isInClass */ true
                );

                if ((functionInfo?.flags & FunctionTypeFlags.StaticMethod) !== 0) {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.superCallZeroArgFormStaticMethod(),
                        node.d.leftExpr
                    );
                }
            }
        } else {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.superCallZeroArgForm(),
                node.d.leftExpr
            );
            targetClassType = UnknownType.create();
        }
    }

    const concreteTargetClassType = evaluator.makeTopLevelTypeVarsConcrete(targetClassType);

    // Determine whether to further narrow the type.
    let secondArgType: Type | undefined;
    let bindToType: ClassType | undefined;

    if (node.d.args.length > 1) {
        secondArgType = evaluator.getTypeOfExpression(node.d.args[1].d.valueExpr).type;
        const secondArgConcreteType = evaluator.makeTopLevelTypeVarsConcrete(secondArgType);

        let reportError = false;

        doForEachSubtype(secondArgConcreteType, (secondArgSubtype) => {
            if (isAnyOrUnknown(secondArgSubtype)) {
                // Ignore unknown or any types.
            } else if (isClassInstance(secondArgSubtype)) {
                if (isInstantiableClass(concreteTargetClassType)) {
                    if (
                        !derivesFromClassRecursive(
                            ClassType.cloneAsInstantiable(secondArgSubtype),
                            concreteTargetClassType,
                            /* ignoreUnknown */ true
                        )
                    ) {
                        reportError = true;
                    }
                }
                bindToType = secondArgSubtype;
            } else if (isInstantiableClass(secondArgSubtype)) {
                if (isInstantiableClass(concreteTargetClassType)) {
                    if (
                        !ClassType.isBuiltIn(concreteTargetClassType, 'type') &&
                        !derivesFromClassRecursive(
                            secondArgSubtype,
                            concreteTargetClassType,
                            /* ignoreUnknown */ true
                        )
                    ) {
                        reportError = true;
                    }
                }
                bindToType = secondArgSubtype;
            } else {
                reportError = true;
            }
        });

        if (reportError) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportArgumentType,
                LocMessage.superCallSecondArg().format({ type: evaluator.printType(targetClassType) }),
                node.d.args[1].d.valueExpr
            );

            return { type: UnknownType.create() };
        }
    } else if (enclosingClassType) {
        bindToType = ClassType.cloneAsInstance(enclosingClassType);

        // Get the type from the self or cls parameter if it is explicitly annotated.
        // If it's a TypeVar, change the bindToType into a conditional type.
        const enclosingMethod = ParseTreeUtils.getEnclosingFunction(node);
        let implicitBindToType: Type | undefined;

        if (enclosingMethod) {
            const methodTypeInfo = evaluator.getTypeOfFunction(enclosingMethod);
            if (methodTypeInfo) {
                const methodType = methodTypeInfo.functionType;
                if (
                    FunctionType.isClassMethod(methodType) ||
                    FunctionType.isConstructorMethod(methodType) ||
                    FunctionType.isInstanceMethod(methodType)
                ) {
                    if (
                        methodType.shared.parameters.length > 0 &&
                        FunctionParam.isTypeDeclared(methodType.shared.parameters[0])
                    ) {
                        let paramType = FunctionType.getParamType(methodType, 0);
                        const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
                        paramType = makeTypeVarsBound(paramType, liveScopeIds);
                        implicitBindToType = evaluator.makeTopLevelTypeVarsConcrete(paramType);
                    }
                }
            }
        }

        if (bindToType && implicitBindToType) {
            const typeCondition = getTypeCondition(implicitBindToType);
            if (typeCondition) {
                bindToType = addConditionToType(bindToType, typeCondition);
            } else if (isClass(implicitBindToType)) {
                bindToType = implicitBindToType;
            }
        }
    }

    // Determine whether super() should return an instance of the class or
    // the class itself. It depends on whether the super() call is located
    // within an instance method or not.
    let resultIsInstance = true;
    if (node.d.args.length <= 1) {
        const enclosingMethod = ParseTreeUtils.getEnclosingFunction(node);
        if (enclosingMethod) {
            const methodType = evaluator.getTypeOfFunction(enclosingMethod);
            if (methodType) {
                if (
                    FunctionType.isStaticMethod(methodType.functionType) ||
                    FunctionType.isConstructorMethod(methodType.functionType) ||
                    FunctionType.isClassMethod(methodType.functionType)
                ) {
                    resultIsInstance = false;
                }
            }
        }
    }

    // Python docs indicate that super() isn't valid for
    // operations other than member accesses or attribute lookups.
    const parentNode = node.parent;
    if (parentNode?.nodeType === ParseNodeType.MemberAccess) {
        const memberName = parentNode.d.member.d.value;
        let effectiveTargetClass = isClass(concreteTargetClassType) ? concreteTargetClassType : undefined;

        // If the bind-to type is a protocol, don't use the effective target class.
        // This pattern is used for mixins, where the mixin type is a protocol class
        // that is used to decorate the "self" or "cls" parameter.
        let isProtocolClass = false;
        if (
            bindToType &&
            ClassType.isProtocolClass(bindToType) &&
            effectiveTargetClass &&
            !ClassType.isSameGenericClass(
                TypeBase.isInstance(bindToType) ? ClassType.cloneAsInstantiable(bindToType) : bindToType,
                effectiveTargetClass
            )
        ) {
            isProtocolClass = true;
            effectiveTargetClass = undefined;
        }

        if (bindToType) {
            bindToType = selfSpecializeClass(bindToType, { useBoundTypeVars: true });
        }

        const lookupResults = bindToType
            ? lookUpClassMember(bindToType, memberName, MemberAccessFlags.Default, effectiveTargetClass)
            : undefined;

        let resultType: Type;
        if (lookupResults && isInstantiableClass(lookupResults.classType)) {
            resultType = lookupResults.classType;

            if (isProtocolClass) {
                // If the bindToType is a protocol class, set the "include subclasses" flag
                // so we don't enforce that called methods are implemented within the protocol.
                resultType = ClassType.cloneIncludeSubclasses(resultType);
            }
        } else if (
            effectiveTargetClass &&
            !isAnyOrUnknown(effectiveTargetClass) &&
            !derivesFromAnyOrUnknown(effectiveTargetClass)
        ) {
            resultType = prefetched?.objectClass ?? UnknownType.create();
        } else {
            resultType = UnknownType.create();
        }

        let bindToSelfType: ClassType | TypeVarType | undefined;
        if (bindToType) {
            if (secondArgType) {
                // If a TypeVar was passed as the second argument, use it
                // to derive the the self type.
                if (isTypeVar(secondArgType)) {
                    bindToSelfType = convertToInstance(secondArgType);
                }
            } else {
                // If this is a zero-argument form of super(), synthesize
                // a Self type to bind to.
                bindToSelfType = TypeBase.cloneForCondition(
                    TypeVarType.cloneAsBound(
                        synthesizeTypeVarForSelfCls(
                            ClassType.cloneIncludeSubclasses(bindToType, /* includeSubclasses */ false),
                            /* isClsParam */ false
                        )
                    ),
                    bindToType.props?.condition
                );
            }
        }

        const type = resultIsInstance ? convertToInstance(resultType, /* includeSubclasses */ false) : resultType;

        return { type, bindToSelfType };
    }

    // Handle the super() call when used outside of a member access expression.
    if (isInstantiableClass(concreteTargetClassType)) {
        // We don't know which member is going to be accessed, so we cannot
        // deterministically determine the correct type in this case. We'll
        // use a heuristic that produces the "correct" (desired) behavior in
        // most cases. If there's a bindToType and the targetClassType is one
        // of the base classes of the bindToType, we'll return the next base
        // class.
        if (bindToType) {
            let nextBaseClassType: Type | undefined;

            if (
                ClassType.isSameGenericClass(
                    TypeBase.isInstance(bindToType) ? ClassType.cloneAsInstantiable(bindToType) : bindToType,
                    concreteTargetClassType
                )
            ) {
                if (bindToType.shared.baseClasses.length > 0) {
                    nextBaseClassType = bindToType.shared.baseClasses[0];
                }
            } else {
                const baseClassIndex = bindToType.shared.baseClasses.findIndex(
                    (baseClass) =>
                        isClass(baseClass) &&
                        ClassType.isSameGenericClass(baseClass, concreteTargetClassType as ClassType)
                );

                if (baseClassIndex >= 0 && baseClassIndex < bindToType.shared.baseClasses.length - 1) {
                    nextBaseClassType = bindToType.shared.baseClasses[baseClassIndex + 1];
                }
            }

            if (nextBaseClassType) {
                if (isInstantiableClass(nextBaseClassType)) {
                    nextBaseClassType = specializeForBaseClass(bindToType, nextBaseClassType);
                }
                return { type: resultIsInstance ? convertToInstance(nextBaseClassType) : nextBaseClassType };
            }

            // There's not much we can say about the type. Simply return object or type.
            if (prefetched?.typeClass && isInstantiableClass(prefetched.typeClass)) {
                return {
                    type: resultIsInstance ? evaluator.getObjectType() : convertToInstance(prefetched.typeClass),
                };
            }
        } else {
            // If the class derives from one or more unknown classes,
            // return unknown here to prevent spurious errors.
            if (concreteTargetClassType.shared.mro.some((mroBase) => isAnyOrUnknown(mroBase))) {
                return { type: UnknownType.create() };
            }

            const baseClasses = concreteTargetClassType.shared.baseClasses;
            if (baseClasses.length > 0) {
                const baseClassType = baseClasses[0];
                if (isInstantiableClass(baseClassType)) {
                    return {
                        type: resultIsInstance ? ClassType.cloneAsInstance(baseClassType) : baseClassType,
                    };
                }
            }
        }
    }

    return { type: UnknownType.create() };
}

export function getDeclaredTypeForExpressionWithEvaluator(
    evaluator: TypeEvaluator,
    expression: ExpressionNode,
    usage?: EvaluatorUsage
): Type | undefined {
    let symbol: Symbol | undefined;
    let selfType: ClassType | TypeVarType | undefined;
    let classOrObjectBase: ClassType | undefined;
    let memberAccessClass: Type | undefined;
    let bindFunction = true;
    let useDescriptorSetterType = false;

    switch (expression.nodeType) {
        case ParseNodeType.Name: {
            const symbolWithScope = evaluator.lookUpSymbolRecursive(expression, expression.d.value, /* honorCodeFlow */ true);
            if (symbolWithScope) {
                symbol = symbolWithScope.symbol;

                // Handle the case where the symbol is a class-level variable
                // where the type isn't declared in this class but is in
                // a parent class.
                if (
                    !evaluator.getDeclaredTypeOfSymbol(symbol, expression)?.type &&
                    symbolWithScope.scope.type === ScopeType.Class
                ) {
                    const enclosingClass = ParseTreeUtils.getEnclosingClassOrFunction(expression);
                    if (enclosingClass && enclosingClass.nodeType === ParseNodeType.Class) {
                        const classTypeInfo = evaluator.getTypeOfClass(enclosingClass);
                        if (classTypeInfo) {
                            const classMemberInfo = lookUpClassMember(
                                classTypeInfo.classType,
                                expression.d.value,
                                MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.DeclaredTypesOnly
                            );
                            if (classMemberInfo) {
                                symbol = classMemberInfo.symbol;
                            }
                        }
                    }
                }
            }
            break;
        }

        case ParseNodeType.TypeAnnotation: {
            return evaluator.getDeclaredTypeForExpression(expression.d.valueExpr, usage);
        }

        case ParseNodeType.MemberAccess: {
            const baseType = evaluator.getTypeOfExpression(expression.d.leftExpr, EvalFlags.MemberAccessBaseDefaults).type;
            const baseTypeConcrete = evaluator.makeTopLevelTypeVarsConcrete(baseType);
            const memberName = expression.d.member.d.value;

            // Normally, baseTypeConcrete will not be a composite type (a union),
            // but this can occur. In this case, it's not clear how to handle this
            // correctly. For now, we'll just loop through the subtypes and
            // use one of them. We'll sort the subtypes for determinism.
            doForEachSubtype(
                baseTypeConcrete,
                (baseSubtype) => {
                    if (isClassInstance(baseSubtype)) {
                        const classMemberInfo = lookUpObjectMember(
                            baseSubtype,
                            memberName,
                            MemberAccessFlags.DeclaredTypesOnly
                        );

                        classOrObjectBase = baseSubtype;
                        memberAccessClass = classMemberInfo?.classType;
                        symbol = classMemberInfo?.symbol;
                        useDescriptorSetterType = true;

                        // If this is an instance member (e.g. a dataclass field), don't
                        // bind it to the object if it's a function.
                        bindFunction = !classMemberInfo?.isInstanceMember;
                    } else if (isInstantiableClass(baseSubtype)) {
                        const classMemberInfo = lookUpClassMember(
                            baseSubtype,
                            memberName,
                            MemberAccessFlags.SkipInstanceMembers | MemberAccessFlags.DeclaredTypesOnly
                        );

                        classOrObjectBase = baseSubtype;
                        memberAccessClass = classMemberInfo?.classType;
                        symbol = classMemberInfo?.symbol;
                        useDescriptorSetterType = false;
                        bindFunction = true;
                    } else if (isModule(baseSubtype)) {
                        classOrObjectBase = undefined;
                        memberAccessClass = undefined;
                        symbol = ModuleType.getField(baseSubtype, memberName);
                        if (symbol && !symbol.hasTypedDeclarations()) {
                            // Do not use inferred types for the declared type.
                            symbol = undefined;
                        }
                        useDescriptorSetterType = false;
                        bindFunction = false;
                    }
                },
                /* sortSubtypes */ true
            );

            if (isTypeVar(baseType)) {
                selfType = baseType;
            }
            break;
        }

        case ParseNodeType.Index: {
            const baseType = evaluator.makeTopLevelTypeVarsConcrete(
                evaluator.getTypeOfExpression(expression.d.leftExpr, EvalFlags.IndexBaseDefaults).type
            );

            if (baseType && isClassInstance(baseType)) {
                if (ClassType.isTypedDictClass(baseType)) {
                    const typeFromTypedDict = getTypeOfIndexedTypedDict(
                        evaluator,
                        expression,
                        baseType,
                        usage || { method: 'get' }
                    );
                    if (typeFromTypedDict) {
                        return typeFromTypedDict.type;
                    }
                }

                let setItemType = evaluator.getBoundMagicMethod(baseType, '__setitem__');
                if (!setItemType) {
                    break;
                }

                if (isOverloaded(setItemType)) {
                    // Determine whether we need to use the slice overload.
                    const expectsSlice =
                        expression.d.items.length === 1 &&
                        expression.d.items[0].d.valueExpr.nodeType === ParseNodeType.Slice;
                    const overloads = OverloadedType.getOverloads(setItemType);
                    setItemType = overloads.find((overload) => {
                        if (overload.shared.parameters.length < 2) {
                            return false;
                        }

                        const keyType = FunctionType.getParamType(overload, 0);
                        const isSlice = isClassInstance(keyType) && ClassType.isBuiltIn(keyType, 'slice');
                        return expectsSlice === isSlice;
                    });

                    if (!setItemType) {
                        break;
                    }
                }

                if (isFunction(setItemType) && setItemType.shared.parameters.length >= 2) {
                    const paramType = FunctionType.getParamType(setItemType, 1);
                    if (!isAnyOrUnknown(paramType)) {
                        return paramType;
                    }
                }
            }
            break;
        }

        case ParseNodeType.Tuple: {
            // If this is a tuple expression with at least one item and no
            // unpacked items, and all of the items have declared types,
            // we can assume a declared type for the resulting tuple. This
            // is needed to enable bidirectional type inference when assigning
            // to an unpacked tuple.
            if (
                expression.d.items.length > 0 &&
                !expression.d.items.some((item) => item.nodeType === ParseNodeType.Unpack)
            ) {
                const itemTypes: Type[] = [];
                expression.d.items.forEach((expr) => {
                    const itemType = evaluator.getDeclaredTypeForExpression(expr, usage);
                    if (itemType) {
                        itemTypes.push(itemType);
                    }
                });

                if (itemTypes.length === expression.d.items.length) {
                    // If all items have a declared type, return a tuple of those types.
                    return makeTupleObject(
                        evaluator,
                        itemTypes.map((t) => {
                            return { type: t, isUnbounded: false };
                        })
                    );
                }
            }
            break;
        }
    }

    if (symbol) {
        let declaredType = evaluator.getDeclaredTypeOfSymbol(symbol)?.type;
        if (declaredType) {
            // If it's a descriptor, we need to get the setter type.
            if (useDescriptorSetterType && isClassInstance(declaredType)) {
                const setter = evaluator.getBoundMagicMethod(declaredType, '__set__');
                if (setter && isFunction(setter) && setter.shared.parameters.length >= 2) {
                    declaredType = FunctionType.getParamType(setter, 1);

                    if (isAnyOrUnknown(declaredType)) {
                        return undefined;
                    }
                }
            }

            if (classOrObjectBase) {
                if (memberAccessClass && isInstantiableClass(memberAccessClass)) {
                    declaredType = partiallySpecializeType(
                        declaredType,
                        memberAccessClass,
                        evaluator.getTypeClassType(),
                        selfType
                    );
                }

                if (isFunctionOrOverloaded(declaredType)) {
                    if (bindFunction) {
                        declaredType = evaluator.bindFunctionToClassOrObject(
                            classOrObjectBase,
                            declaredType,
                            /* memberClass */ undefined,
                            /* treatConstructorAsClassMethod */ undefined,
                            selfType
                        );
                    }
                }
            }

            return declaredType;
        }
    }

    return undefined;
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

export function getTypeOfIndexedObjectOrClassWithEvaluator(
    evaluator: TypeEvaluator,
    node: IndexNode,
    baseType: ClassType,
    selfType: ClassType | TypeVarType | undefined,
    usage: EvaluatorUsage
): TypeResult {
    // Handle index operations for TypedDict classes specially.
    if (isClassInstance(baseType) && ClassType.isTypedDictClass(baseType)) {
        const typeFromTypedDict = getTypeOfIndexedTypedDict(evaluator, node, baseType, usage);
        if (typeFromTypedDict) {
            return typeFromTypedDict;
        }
    }

    const magicMethodName = getIndexAccessMagicMethodNameForUsage(usage);
    const itemMethodType = evaluator.getBoundMagicMethod(baseType, magicMethodName, selfType, node.d.leftExpr);

    if (!itemMethodType) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportIndexIssue,
            LocMessage.methodNotDefinedOnType().format({
                name: magicMethodName,
                type: evaluator.printType(baseType),
            }),
            node.d.leftExpr
        );
        return { type: UnknownType.create() };
    }

    // Handle the special case where the object is a tuple and
    // the index is a constant number (integer) or a slice with integer
    // start and end values. In these cases, we can determine
    // the exact type by indexing into the tuple type array.
    if (
        node.d.items.length === 1 &&
        !node.d.trailingComma &&
        !node.d.items[0].d.name &&
        node.d.items[0].d.argCategory === ArgCategory.Simple &&
        isClassInstance(baseType)
    ) {
        const index0Expr = node.d.items[0].d.valueExpr;
        const valueType = evaluator.getTypeOfExpression(index0Expr).type;

        if (
            isClassInstance(valueType) &&
            ClassType.isBuiltIn(valueType, 'int') &&
            isLiteralType(valueType) &&
            typeof valueType.priv.literalValue === 'number'
        ) {
            const indexValue = valueType.priv.literalValue;
            const tupleType = getSpecializedTupleType(baseType);

            if (tupleType && tupleType.priv.tupleTypeArgs) {
                if (isTupleIndexUnambiguous(tupleType, indexValue)) {
                    if (indexValue >= 0 && indexValue < tupleType.priv.tupleTypeArgs.length) {
                        return { type: tupleType.priv.tupleTypeArgs[indexValue].type };
                    } else if (indexValue < 0 && tupleType.priv.tupleTypeArgs.length + indexValue >= 0) {
                        return {
                            type: tupleType.priv.tupleTypeArgs[tupleType.priv.tupleTypeArgs.length + indexValue]
                                .type,
                        };
                    }
                }
            }
        } else if (isClassInstance(valueType) && ClassType.isBuiltIn(valueType, 'slice')) {
            const tupleType = getSpecializedTupleType(baseType);

            if (tupleType && index0Expr.nodeType === ParseNodeType.Slice) {
                const slicedTupleType = getSlicedTupleType(evaluator, tupleType, index0Expr);
                if (slicedTupleType) {
                    return { type: slicedTupleType };
                }
            }
        }
    }

    const positionalArgs = node.d.items.filter((item) => item.d.argCategory === ArgCategory.Simple);
    const unpackedListArgs = node.d.items.filter((item) => item.d.argCategory === ArgCategory.UnpackedList);

    let positionalIndexType: Type;
    let isPositionalIndexTypeIncomplete = false;

    if (positionalArgs.length === 1 && unpackedListArgs.length === 0 && !node.d.trailingComma) {
        // Handle the common case where there is a single positional argument.
        const typeResult = evaluator.getTypeOfExpression(positionalArgs[0].d.valueExpr);
        positionalIndexType = typeResult.type;
        if (typeResult.isIncomplete) {
            isPositionalIndexTypeIncomplete = true;
        }
    } else {
        // Package up all of the positionals into a tuple.
        const tupleTypeArgs: TupleTypeArg[] = [];

        const getDeterministicTupleEntries = (type: Type): TupleTypeArg[] | undefined => {
            let aggregatedArgs: TupleTypeArg[] | undefined;
            let isDeterministic = true;

            doForEachSubtype(type, (subtype) => {
                if (!isDeterministic) {
                    return;
                }

                const tupleType = getSpecializedTupleType(subtype);
                const tupleTypeArgs = tupleType?.priv.tupleTypeArgs;

                if (
                    !tupleTypeArgs ||
                    tupleTypeArgs.some((entry) => entry.isUnbounded || isTypeVarTuple(entry.type))
                ) {
                    isDeterministic = false;
                    return;
                }

                if (!aggregatedArgs) {
                    aggregatedArgs = tupleTypeArgs.map((entry) => ({ type: entry.type, isUnbounded: false }));
                    return;
                }

                if (aggregatedArgs.length !== tupleTypeArgs.length) {
                    isDeterministic = false;
                    return;
                }

                for (let i = 0; i < aggregatedArgs.length; i++) {
                    aggregatedArgs[i] = {
                        type: combineTypes([aggregatedArgs[i].type, tupleTypeArgs[i].type]),
                        isUnbounded: false,
                    };
                }
            });

            if (!isDeterministic || !aggregatedArgs) {
                return undefined;
            }

            return aggregatedArgs;
        };

        node.d.items.forEach((arg) => {
            if (arg.d.argCategory === ArgCategory.Simple) {
                const typeResult = evaluator.getTypeOfExpression(arg.d.valueExpr);
                tupleTypeArgs.push({ type: typeResult.type, isUnbounded: false });
                if (typeResult.isIncomplete) {
                    isPositionalIndexTypeIncomplete = true;
                }
                return;
            }

            if (arg.d.argCategory === ArgCategory.UnpackedList) {
                const typeResult = evaluator.getTypeOfExpression(arg.d.valueExpr);
                if (typeResult.isIncomplete) {
                    isPositionalIndexTypeIncomplete = true;
                }

                const deterministicEntries = getDeterministicTupleEntries(typeResult.type);
                if (deterministicEntries) {
                    appendArray(tupleTypeArgs, deterministicEntries);
                    return;
                }

                const iterableType =
                    evaluator.getTypeOfIterator(typeResult, /* isAsync */ false, arg.d.valueExpr)?.type ??
                    UnknownType.create();
                tupleTypeArgs.push({ type: iterableType, isUnbounded: true });
            }
        });

        const unboundedCount = tupleTypeArgs.filter((typeArg) => typeArg.isUnbounded).length;
        if (unboundedCount > 1) {
            const firstUnboundedIndex = tupleTypeArgs.findIndex((typeArg) => typeArg.isUnbounded);
            const removedEntries = tupleTypeArgs.splice(firstUnboundedIndex);
            tupleTypeArgs.push({
                type: combineTypes(removedEntries.map((entry) => entry.type)),
                isUnbounded: true,
            });
        }

        positionalIndexType = makeTupleObject(evaluator, tupleTypeArgs);
    }

    const argList: Arg[] = [
        {
            argCategory: ArgCategory.Simple,
            typeResult: { type: positionalIndexType, isIncomplete: isPositionalIndexTypeIncomplete },
        },
    ];

    if (usage.method === 'set') {
        let setType = usage.setType?.type ?? AnyType.create();

        // Expand constrained type variables.
        if (isTypeVar(setType) && TypeVarType.hasConstraints(setType)) {
            const conditionFilter = isClassInstance(baseType) ? baseType.props?.condition : undefined;
            setType = evaluator.makeTopLevelTypeVarsConcrete(
                setType,
                /* makeParamSpecsConcrete */ undefined,
                conditionFilter
            );
        }

        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: {
                type: setType,
                isIncomplete: !!usage.setType?.isIncomplete,
            },
        });
    }

    const callResult = evaluator.validateCallArgs(
        node,
        argList,
        { type: itemMethodType },
        /* constraints */ undefined,
        /* skipUnknownArgCheck */ true,
        /* inferenceContext */ undefined
    );

    return {
        type: callResult.returnType ?? UnknownType.create(),
        isIncomplete: !!callResult.isTypeIncomplete,
    };
}

// Validates that the type is an iterator and returns the iterated type
// (i.e. the type returned from the '__next__' or '__anext__' method).
export function getTypeOfIteratorWithEvaluator(
    evaluator: TypeEvaluator,
    typeResult: TypeResult,
    isAsync: boolean,
    errorNode: ExpressionNode,
    prefetched: Partial<PrefetchedTypes> | undefined,
    emitNotIterableError = true
): TypeResult | undefined {
    const iterMethodName = isAsync ? '__aiter__' : '__iter__';
    const nextMethodName = isAsync ? '__anext__' : '__next__';
    let isValidIterator = true;
    let isIncomplete = typeResult.isIncomplete;

    let type = transformPossibleRecursiveTypeAlias(typeResult.type);
    type = evaluator.makeTopLevelTypeVarsConcrete(type);
    type = removeUnbound(type);

    if (isOptionalType(type) && emitNotIterableError) {
        if (!typeResult.isIncomplete) {
            evaluator.addDiagnostic(DiagnosticRule.reportOptionalIterable, LocMessage.noneNotIterable(), errorNode);
        }
        type = removeNoneFromUnion(type);
    }

    const iterableType = mapSubtypes(type, (subtype) => {
        subtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

        if (isAnyOrUnknown(subtype)) {
            return subtype;
        }

        const diag = new DiagnosticAddendum();
        if (isClass(subtype)) {
            // Handle an empty tuple specially.
            if (
                TypeBase.isInstance(subtype) &&
                isTupleClass(subtype) &&
                subtype.priv.tupleTypeArgs &&
                subtype.priv.tupleTypeArgs.length === 0
            ) {
                return NeverType.createNever();
            }

            const iterReturnType = evaluator.getTypeOfMagicMethodCall(subtype, iterMethodName, [], errorNode, undefined)?.type;

            if (!iterReturnType) {
                // There was no __iter__. See if we can fall back to
                // the __getitem__ method instead.
                if (!isAsync && isClassInstance(subtype)) {
                    const getItemReturnType = evaluator.getTypeOfMagicMethodCall(
                        subtype,
                        '__getitem__',
                        [
                            {
                                type:
                                    prefetched?.intClass && isInstantiableClass(prefetched.intClass)
                                        ? ClassType.cloneAsInstance(prefetched.intClass)
                                        : UnknownType.create(),
                            },
                        ],
                        errorNode,
                        undefined
                    )?.type;
                    if (getItemReturnType) {
                        return getItemReturnType;
                    }
                }

                diag.addMessage(LocMessage.methodNotDefined().format({ name: iterMethodName }));
            } else {
                const iterReturnTypeDiag = new DiagnosticAddendum();

                const returnType = evaluator.mapSubtypesExpandTypeVars(iterReturnType, /* options */ undefined, (subtype) => {
                    if (isAnyOrUnknown(subtype)) {
                        return subtype;
                    }

                    let nextReturnType = evaluator.getTypeOfMagicMethodCall(subtype, nextMethodName, [], errorNode, undefined)?.type;

                    if (!nextReturnType) {
                        iterReturnTypeDiag.addMessage(
                            LocMessage.methodNotDefinedOnType().format({
                                name: nextMethodName,
                                type: evaluator.printType(subtype),
                            })
                        );
                    } else {
                        // Convert any unpacked TypeVarTuples into object instances. We don't
                        // know anything more about them.
                        nextReturnType = mapSubtypes(nextReturnType, (returnSubtype) => {
                            if (isTypeVar(returnSubtype) && isUnpackedTypeVarTuple(returnSubtype)) {
                                return evaluator.getObjectType();
                            }

                            return returnSubtype;
                        });

                        if (!isAsync) {
                            return nextReturnType;
                        }

                        // If it's an async iteration, there's an implicit
                        // 'await' operator applied.
                        const awaitableResult = getTypeOfAwaitableWithEvaluator(
                            evaluator,
                            { type: nextReturnType, isIncomplete: typeResult.isIncomplete },
                            prefetched,
                            errorNode
                        );
                        if (awaitableResult.isIncomplete) {
                            isIncomplete = true;
                        }
                        return awaitableResult.type;
                    }

                    return undefined;
                });

                if (iterReturnTypeDiag.isEmpty()) {
                    return returnType;
                }

                diag.addAddendum(iterReturnTypeDiag);
            }
        }

        if (!isIncomplete && emitNotIterableError) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeNotIterable().format({ type: evaluator.printType(subtype) }) + diag.getString(),
                errorNode
            );
        }

        isValidIterator = false;
        return undefined;
    });

    return isValidIterator ? { type: iterableType, isIncomplete } : undefined;
}

export function getTypeOfStringListAsTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: StringListNode,
    flags: EvalFlags
): TypeResult {
    const reportTypeErrors = (flags & EvalFlags.StrLiteralAsType) !== 0;
    let updatedFlags = flags | EvalFlags.ForwardRefs | EvalFlags.InstantiableType;
    let typeResult: TypeResult | undefined;

    // In most cases, annotations within a string are not parsed by the interpreter.
    // There are a few exceptions (e.g. the "bound" value for a TypeVar constructor).
    if ((flags & EvalFlags.ParsesStringLiteral) === 0) {
        updatedFlags |= EvalFlags.NotParsed;
    }

    updatedFlags &= ~EvalFlags.TypeFormArg;

    if (node.d.annotation && (flags & EvalFlags.TypeExpression) !== 0) {
        return evaluator.getTypeOfExpression(node.d.annotation, updatedFlags);
    }

    if (node.d.strings.length === 1) {
        const tokenFlags = node.d.strings[0].d.token.flags;

        if (tokenFlags & StringTokenFlags.Bytes) {
            if (reportTypeErrors) {
                evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationBytesString(), node);
            }
            return { type: UnknownType.create() };
        }

        if (tokenFlags & StringTokenFlags.Raw) {
            if (reportTypeErrors) {
                evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationRawString(), node);
            }
            return { type: UnknownType.create() };
        }

        if (tokenFlags & StringTokenFlags.Format) {
            if (reportTypeErrors) {
                evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationFormatString(), node);
            }
            return { type: UnknownType.create() };
        }

        if (tokenFlags & StringTokenFlags.Template) {
            if (reportTypeErrors) {
                evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.annotationTemplateString(), node);
            }
            return { type: UnknownType.create() };
        }

        // We didn't know at parse time that this string node was going
        // to be evaluated as a forward-referenced type. We need
        // to re-invoke the parser at this stage.
        const expr = parseStringAsTypeAnnotationNode(node, reportTypeErrors);
        if (expr) {
            typeResult = evaluator.useSpeculativeMode(reportTypeErrors ? undefined : node, () => {
                return evaluator.getTypeOfExpression(expr, updatedFlags);
            });
        }
    }

    if (!typeResult) {
        if (reportTypeErrors) {
            evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, LocMessage.expectedTypeNotString(), node);
        }
        typeResult = { type: UnknownType.create() };
    }

    return typeResult;
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

export function getTypeOfUnpackOperatorWithEvaluator(
    evaluator: TypeEvaluator,
    node: UnpackNode,
    flags: EvalFlags,
    inferenceContext?: InferenceContext
) {
    let typeResult: TypeResult | undefined;
    let iterExpectedType: Type | undefined;

    if (inferenceContext) {
        const iterableType = evaluator.getBuiltInType(node, 'Iterable');
        if (iterableType && isInstantiableClass(iterableType)) {
            iterExpectedType = ClassType.cloneAsInstance(
                ClassType.specialize(iterableType, [inferenceContext.expectedType])
            );
        }
    }

    const iterTypeResult = evaluator.getTypeOfExpression(node.d.expr, flags, makeInferenceContext(iterExpectedType));
    const iterType = iterTypeResult.type;
    if ((flags & EvalFlags.NoTypeVarTuple) === 0 && isTypeVarTuple(iterType) && !iterType.priv.isUnpacked) {
        typeResult = { type: TypeVarType.cloneForUnpacked(iterType) };
    } else if (
        (flags & EvalFlags.AllowUnpackedTuple) !== 0 &&
        isInstantiableClass(iterType) &&
        ClassType.isBuiltIn(iterType, 'tuple')
    ) {
        typeResult = { type: ClassType.cloneForUnpacked(iterType) };
    } else if ((flags & EvalFlags.TypeExpression) !== 0) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.unpackInAnnotation(),
            node,
            node.d.starToken
        );
        typeResult = { type: UnknownType.create() };
    } else {
        const iteratorTypeResult = evaluator.getTypeOfIterator(iterTypeResult, /* isAsync */ false, node) ?? {
            type: UnknownType.create(!!iterTypeResult.isIncomplete),
            isIncomplete: iterTypeResult.isIncomplete,
        };
        typeResult = {
            type: iteratorTypeResult.type,
            typeErrors: iterTypeResult.typeErrors,
            unpackedType: iterType,
            isIncomplete: iteratorTypeResult.isIncomplete,
        };
    }

    return typeResult;
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

export function getTypeOfIterableWithEvaluator(
    evaluator: TypeEvaluator,
    typeResult: TypeResult,
    isAsync: boolean,
    errorNode: ExpressionNode,
    emitNotIterableError = true
): TypeResult | undefined {
    const iterMethodName = isAsync ? '__aiter__' : '__iter__';
    let isValidIterable = true;

    let type = evaluator.makeTopLevelTypeVarsConcrete(typeResult.type);

    if (isOptionalType(type)) {
        if (!typeResult.isIncomplete && emitNotIterableError) {
            evaluator.addDiagnostic(DiagnosticRule.reportOptionalIterable, LocMessage.noneNotIterable(), errorNode);
        }
        type = removeNoneFromUnion(type);
    }

    const iterableType = mapSubtypes(type, (subtype) => {
        if (isAnyOrUnknown(subtype)) {
            return subtype;
        }

        if (isClass(subtype)) {
            const iterReturnType = evaluator.getTypeOfMagicMethodCall(subtype, iterMethodName, [], errorNode, undefined)?.type;

            if (iterReturnType) {
                return evaluator.makeTopLevelTypeVarsConcrete(iterReturnType);
            }
        }

        if (emitNotIterableError) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.typeNotIterable().format({ type: evaluator.printType(subtype) }),
                errorNode
            );
        }

        isValidIterable = false;
        return undefined;
    });

    return isValidIterable ? { type: iterableType, isIncomplete: typeResult.isIncomplete } : undefined;
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

export function getTypeArgWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    flags: EvalFlags,
    supportsDictExpression: boolean,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResultWithNode {
    let typeResult: TypeResultWithNode;

    let adjustedFlags =
        flags | EvalFlags.InstantiableType | EvalFlags.ConvertEllipsisToAny | EvalFlags.StrLiteralAsType;

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    if (fileInfo.isStubFile) {
        adjustedFlags |= EvalFlags.ForwardRefs;
    }

    if (node.nodeType === ParseNodeType.List) {
        typeResult = {
            type: UnknownType.create(),
            typeList: node.d.items.map((entry) => {
                return { ...evaluator.getTypeOfExpression(entry, adjustedFlags), node: entry };
            }),
            node,
        };

        // Set the node's type so it isn't reevaluated later.
        evaluator.setTypeResultForNode(node, { type: UnknownType.create() });
    } else if (node.nodeType === ParseNodeType.Dictionary && supportsDictExpression) {
        const inlinedTypeDict =
            prefetched?.typedDictClass && isInstantiableClass(prefetched.typedDictClass)
                ? createTypedDictTypeInlined(evaluator, node, prefetched.typedDictClass)
                : undefined;
        const keyTypeFallback =
            prefetched?.strClass && isInstantiableClass(prefetched.strClass)
                ? prefetched.strClass
                : UnknownType.create();

        typeResult = {
            type: keyTypeFallback,
            inlinedTypeDict,
            node,
        };
    } else {
        typeResult = { ...evaluator.getTypeOfExpression(node, adjustedFlags), node };

        if (node.nodeType === ParseNodeType.Dictionary) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.dictInAnnotation(), node);
        }

        if ((flags & EvalFlags.NoClassVar) !== 0) {
            // "ClassVar" is not allowed as a type argument.
            if (isClass(typeResult.type) && ClassType.isBuiltIn(typeResult.type, 'ClassVar')) {
                evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.classVarNotAllowed(), node);
            }
        }
    }

    return typeResult;
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

export function assignClassWithTypeArgsWithEvaluator(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    inheritanceChain: InheritanceChain,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
): boolean {
    let curSrcType = srcType;
    let prevSrcType: ClassType | undefined;

    evaluator.inferVarianceForClass(destType);

    // If we're enforcing invariance, literal types must match.
    if ((flags & AssignTypeFlags.Invariant) !== 0) {
        const srcIsLiteral = isLiteralLikeType(srcType);
        const destIsLiteral = isLiteralLikeType(destType);

        if (srcIsLiteral !== destIsLiteral) {
            return false;
        }
    }

    for (let ancestorIndex = inheritanceChain.length - 1; ancestorIndex >= 0; ancestorIndex--) {
        const ancestorType = inheritanceChain[ancestorIndex];

        // If we've hit an "unknown", all bets are off, and we need to assume
        // that the type is assignable. If the destType is marked "@final",
        // we should be able to assume that it's not assignable, but we can't do
        // this in the general case because it breaks assumptions with the
        // NotImplemented symbol exported by typeshed's builtins.pyi. Instead,
        // we'll special-case only None.
        if (isUnknown(ancestorType)) {
            return !isNoneTypeClass(destType);
        }

        // If this isn't the first time through the loop, specialize
        // for the next ancestor in the chain.
        if (ancestorIndex < inheritanceChain.length - 1) {
            // If the curSrcType is a NamedTuple and the ancestorType is a tuple,
            // we need to handle this as a special case because the NamedTuple may
            // include typeParams from its parent class.
            let effectiveCurSrcType = curSrcType;
            if (
                ClassType.isBuiltIn(curSrcType, 'NamedTuple') &&
                ClassType.isBuiltIn(ancestorType, 'tuple') &&
                prevSrcType
            ) {
                effectiveCurSrcType = prevSrcType;
            }

            curSrcType = specializeForBaseClass(effectiveCurSrcType, ancestorType);
        }

        // If there are no type parameters on this class, we're done.
        const ancestorTypeParams = ClassType.getTypeParams(ancestorType);
        if (ancestorTypeParams.length === 0) {
            continue;
        }

        // If the dest type isn't specialized, there are no type args to validate.
        if (!ancestorType.priv.typeArgs) {
            return true;
        }

        prevSrcType = curSrcType;
    }

    // Handle tuple, which supports a variable number of type arguments.
    if (destType.priv.tupleTypeArgs && curSrcType.priv.tupleTypeArgs) {
        return assignTupleTypeArgs(
            evaluator,
            destType,
            curSrcType,
            diag,
            constraints,
            flags,
            recursionCount
        );
    }

    if (destType.priv.typeArgs) {
        // If the dest type is specialized, make sure the specialized source
        // type arguments are assignable to the dest type arguments.
        return evaluator.assignTypeArgs(
            destType,
            curSrcType,
            // Don't emit a diag addendum if we're in an invariant context. It's
            // sufficient to simply indicate that the types are not the same
            // in this case. Adding more information is unnecessary and confusing.
            (flags & AssignTypeFlags.Invariant) === 0 ? diag : undefined,
            constraints,
            flags,
            recursionCount
        );
    }

    if (constraints && curSrcType.priv.typeArgs) {
        // Populate the typeVar map with type arguments of the source.
        const srcTypeArgs = curSrcType.priv.typeArgs;
        for (let i = 0; i < destType.shared.typeParams.length; i++) {
            let typeArgType: Type;
            const typeParam = destType.shared.typeParams[i];
            const variance = TypeVarType.getVariance(typeParam);

            if (curSrcType.priv.tupleTypeArgs) {
                typeArgType = convertToInstance(
                    makeTupleObject(evaluator, curSrcType.priv.tupleTypeArgs, /* isUnpacked */ true)
                );
            } else {
                typeArgType = i < srcTypeArgs.length ? srcTypeArgs[i] : UnknownType.create();
            }

            constraints.setBounds(
                typeParam,
                variance !== Variance.Contravariant ? typeArgType : undefined,
                variance !== Variance.Covariant ? typeArgType : undefined,
                /* retainLiterals */ true
            );
        }
    }

    return true;
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

export function getTypeOfYieldWithEvaluator(
    evaluator: TypeEvaluator,
    node: YieldNode
): TypeResult {
    let expectedYieldType: Type | undefined;
    let sentType: Type | undefined;
    let isIncomplete = false;

    const enclosingFunction = ParseTreeUtils.getEnclosingFunction(node);
    if (enclosingFunction) {
        const functionTypeInfo = evaluator.getTypeOfFunction(enclosingFunction);
        if (functionTypeInfo) {
            let returnType = FunctionType.getEffectiveReturnType(functionTypeInfo.functionType);
            if (returnType) {
                const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(node);
                returnType = makeTypeVarsBound(returnType, liveScopeIds);

                expectedYieldType = getGeneratorYieldType(returnType, !!enclosingFunction.d.isAsync);

                const generatorTypeArgs = getGeneratorTypeArgs(returnType);
                if (generatorTypeArgs && generatorTypeArgs.length >= 2) {
                    sentType = makeTypeVarsBound(generatorTypeArgs[1], liveScopeIds);
                }
            }
        }
    }

    if (node.d.expr) {
        const exprResult = evaluator.getTypeOfExpression(
            node.d.expr,
            /* flags */ undefined,
            makeInferenceContext(expectedYieldType)
        );
        if (exprResult.isIncomplete) {
            isIncomplete = true;
        }
    }

    return { type: sentType || UnknownType.create(), isIncomplete };
}

export function getTypeOfRevealLocalsWithEvaluator(
    evaluator: TypeEvaluator,
    node: CallNode
) {
    let curNode: ParseNode | undefined = node;
    let scope: Scope | undefined;

    while (curNode) {
        scope = ScopeUtils.getScopeForNode(curNode);

        // Stop when we get a valid scope that's not a list comprehension
        // scope. That includes lambdas, functions, classes, and modules.
        if (scope && scope.type !== ScopeType.Comprehension) {
            break;
        }

        curNode = curNode.parent;
    }

    const infoMessages: string[] = [];

    if (scope) {
        scope.symbolTable.forEach((symbol, name) => {
            if (!symbol.isIgnoredForProtocolMatch()) {
                const typeOfSymbol = evaluator.getEffectiveTypeOfSymbol(symbol);
                infoMessages.push(
                    LocAddendum.typeOfSymbol().format({
                        name,
                        type: evaluator.printType(typeOfSymbol, { expandTypeAlias: true }),
                    })
                );
            }
        });
    }

    if (infoMessages.length > 0) {
        evaluator.addInformation(infoMessages.join('\n'), node);
    } else {
        evaluator.addInformation(LocMessage.revealLocalsNone(), node);
    }

    return evaluator.getNoneType();
}

export function getTypeOfLambdaForCallWithEvaluator(
    evaluator: TypeEvaluator,
    node: CallNode,
    inferenceContext: InferenceContext | undefined
): TypeResult {
    assert(node.d.leftExpr.nodeType === ParseNodeType.Lambda);

    const expectedType = FunctionType.createSynthesizedInstance('');
    expectedType.shared.declaredReturnType = inferenceContext
        ? inferenceContext.expectedType
        : UnknownType.create();

    let isArgTypeIncomplete = false;
    node.d.args.forEach((arg, index) => {
        const argTypeResult = evaluator.getTypeOfExpression(arg.d.valueExpr);
        if (argTypeResult.isIncomplete) {
            isArgTypeIncomplete = true;
        }

        FunctionType.addParam(
            expectedType,
            FunctionParam.create(
                ParamCategory.Simple,
                argTypeResult.type,
                FunctionParamFlags.NameSynthesized | FunctionParamFlags.TypeDeclared,
                `p${index.toString()}`
            )
        );
    });

    // If the lambda's param list ends with a "/" positional parameter separator,
    // add a corresponding separator to the expected type.
    const lambdaParams = (node.d.leftExpr as LambdaNode).d.params;
    if (lambdaParams.length > 0) {
        const lastParam = lambdaParams[lambdaParams.length - 1];
        if (lastParam.d.category === ParamCategory.Simple && !lastParam.d.name) {
            FunctionType.addPositionOnlyParamSeparator(expectedType);
        }
    }

    function getLambdaType() {
        return evaluator.getTypeOfExpression(node.d.leftExpr, EvalFlags.CallBaseDefaults, makeInferenceContext(expectedType));
    }

    // If one or more of the arguments are incomplete, use speculative mode
    // for the lambda evaluation because it may need to be reevaluated once
    // the arg types are complete.
    let typeResult =
        isArgTypeIncomplete || evaluator.isSpeculativeModeInUse(node) || inferenceContext?.isTypeIncomplete
            ? evaluator.useSpeculativeMode(node.d.leftExpr, getLambdaType)
            : getLambdaType();

    // If bidirectional type inference failed, use normal type inference instead.
    if (typeResult.typeErrors) {
        typeResult = evaluator.getTypeOfExpression(node.d.leftExpr, EvalFlags.CallBaseDefaults);
    }

    return typeResult;
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

export function getTypeOfEllipsisWithEvaluator(
    evaluator: TypeEvaluator,
    flags: EvalFlags,
    typeResult: TypeResult | undefined,
    node: ExpressionNode
) {
    if ((flags & EvalFlags.ConvertEllipsisToAny) !== 0) {
        typeResult = { type: AnyType.create(/* isEllipsis */ true) };
    } else {
        if ((flags & EvalFlags.TypeExpression) !== 0 && (flags & EvalFlags.AllowEllipsis) === 0) {
            evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.ellipsisContext(), node);
            typeResult = { type: UnknownType.create() };
        } else {
            const ellipsisType =
                evaluator.getBuiltInObject(node, 'EllipsisType') ?? evaluator.getBuiltInObject(node, 'ellipsis') ?? AnyType.create();
            typeResult = { type: ellipsisType };
        }
    }
    return typeResult;
}

export function getTypeOfArgWithEvaluator(
    evaluator: TypeEvaluator,
    arg: Arg,
    inferenceContext: InferenceContext | undefined
): TypeResult {
    if (arg.typeResult) {
        const type = arg.typeResult.type;
        return { type: type?.props?.specialForm ?? type, isIncomplete: arg.typeResult.isIncomplete };
    }

    if (!arg.valueExpression) {
        // We shouldn't ever get here, but just in case.
        return { type: UnknownType.create() };
    }

    // If there was no defined type provided, there should always
    // be a value expression from which we can retrieve the type.
    return evaluator.getTypeOfExpression(arg.valueExpression, /* flags */ undefined, inferenceContext);
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

export function getTypeOfMemberWithEvaluator(
    evaluator: TypeEvaluator,
    member: ClassMember
): Type {
    if (isInstantiableClass(member.classType)) {
        return partiallySpecializeType(
            evaluator.getEffectiveTypeOfSymbol(member.symbol),
            member.classType,
            evaluator.getTypeClassType(),
            /* selfClass */ undefined
        );
    }
    return UnknownType.create();
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

export function getTypeOfConstantWithEvaluator(
    evaluator: TypeEvaluator,
    node: ConstantNode,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResult {
    let type: Type | undefined;

    if (node.d.constType === KeywordType.None) {
        if (prefetched?.noneTypeClass) {
            type =
                (flags & EvalFlags.InstantiableType) !== 0
                    ? prefetched.noneTypeClass
                    : convertToInstance(prefetched.noneTypeClass);

            if (isTypeFormSupportedForNode(node)) {
                type = TypeBase.cloneWithTypeForm(type, convertToInstance(type));
            }
        }
    } else if (
        node.d.constType === KeywordType.True ||
        node.d.constType === KeywordType.False ||
        node.d.constType === KeywordType.Debug
    ) {
        type = evaluator.getBuiltInObject(node, 'bool');

        if (type && isClassInstance(type)) {
            if (node.d.constType === KeywordType.True) {
                type = ClassType.cloneWithLiteral(type, /* value */ true);
            } else if (node.d.constType === KeywordType.False) {
                type = ClassType.cloneWithLiteral(type, /* value */ false);
            }
        }
    }

    return { type: type ?? UnknownType.create() };
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

export function getTypeOfAssertTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: CallNode,
    inferenceContext: InferenceContext | undefined
): TypeResult {
    if (
        node.d.args.length !== 2 ||
        node.d.args[0].d.argCategory !== ArgCategory.Simple ||
        node.d.args[0].d.name !== undefined ||
        node.d.args[0].d.argCategory !== ArgCategory.Simple ||
        node.d.args[1].d.name !== undefined
    ) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.assertTypeArgs(), node);
        return { type: UnknownType.create() };
    }

    const arg0TypeResult = evaluator.getTypeOfExpression(node.d.args[0].d.valueExpr, /* flags */ undefined, inferenceContext);
    if (arg0TypeResult.isIncomplete) {
        return { type: UnknownType.create(/* isIncomplete */ true), isIncomplete: true };
    }

    const assertedType = convertToInstance(
        getTypeOfArgExpectingTypeWithEvaluator(evaluator, convertArgumentNodeToArg(node.d.args[1]), {
            typeExpression: true,
        }).type
    );

    const arg0Type = evaluator.stripTypeGuard(arg0TypeResult.type);

    if (
        !isTypeSame(assertedType, arg0Type, {
            treatAnySameAsUnknown: true,
            ignorePseudoGeneric: true,
            ignoreConditions: true,
        })
    ) {
        const srcDestTypes = printSrcDestTypesWithEvaluator(arg0TypeResult.type, assertedType, evaluator, {
            expandTypeAlias: true,
        });

        evaluator.addDiagnostic(
            DiagnosticRule.reportAssertTypeFailure,
            LocMessage.assertTypeTypeMismatch().format({
                expected: srcDestTypes.destType,
                received: srcDestTypes.sourceType,
            }),
            node.d.args[0].d.valueExpr
        );
    }

    return { type: arg0TypeResult.type };
}

export function getTypeOfTypeFormWithEvaluator(
    evaluator: TypeEvaluator,
    node: CallNode,
    typeFormClass: ClassType
): TypeResult {
    if (
        node.d.args.length !== 1 ||
        node.d.args[0].d.argCategory !== ArgCategory.Simple ||
        node.d.args[0].d.name !== undefined
    ) {
        evaluator.addDiagnostic(DiagnosticRule.reportCallIssue, LocMessage.typeFormArgs(), node);
        return { type: UnknownType.create() };
    }

    const typeFormResult = getTypeOfArgExpectingTypeWithEvaluator(
        evaluator,
        convertArgumentNodeToArg(node.d.args[0]),
        {
            typeFormArg: isTypeFormSupportedForNode(node),
            noNonTypeSpecialForms: true,
            typeExpression: true,
        }
    );

    if (!typeFormResult.typeErrors && typeFormResult.type.props?.typeForm) {
        typeFormResult.type = convertToInstance(
            ClassType.specialize(typeFormClass, [convertToInstance(typeFormResult.type.props.typeForm)])
        );
    }

    return typeFormResult;
}

export function evaluateCastCallWithEvaluator(
    evaluator: TypeEvaluator,
    argList: Arg[],
    errorNode: ExpressionNode
): Type {
    if (argList[0].argCategory !== ArgCategory.Simple && argList[0].valueExpression) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportInvalidTypeForm,
            LocMessage.unpackInAnnotation(),
            argList[0].valueExpression
        );
    }

    let castToType = getTypeOfArgExpectingTypeWithEvaluator(evaluator, argList[0], { typeExpression: true }).type;

    const liveScopeIds = ParseTreeUtils.getTypeVarScopesForNode(errorNode);
    castToType = makeTypeVarsBound(castToType, liveScopeIds);

    let castFromType = evaluator.getTypeOfArg(argList[1], /* inferenceContext */ undefined).type;

    if (castFromType.props?.specialForm) {
        castFromType = castFromType.props.specialForm;
    }

    if (TypeBase.isInstantiable(castToType) && !isUnknown(castToType)) {
        if (
            isTypeSame(convertToInstance(castToType), castFromType, {
                ignorePseudoGeneric: true,
            })
        ) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportUnnecessaryCast,
                LocMessage.unnecessaryCast().format({
                    type: evaluator.printType(castFromType),
                }),
                errorNode
            );
        }
    }

    return convertToInstance(castToType);
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

export function getElementTypeFromComprehensionWithEvaluator(
    evaluator: TypeEvaluator,
    node: ComprehensionNode,
    flags: EvalFlags,
    expectedValueOrElementType?: Type,
    expectedKeyType?: Type
): TypeResult {
    let isIncomplete = false;
    let typeErrors = false;

    for (const forIfNode of node.d.forIfNodes) {
        if (evaluateComprehensionForIfWithEvaluator(evaluator, forIfNode)) {
            isIncomplete = true;
        }
    }

    let type: Type = UnknownType.create();
    if (node.d.expr.nodeType === ParseNodeType.DictionaryKeyEntry) {
        const keyTypeResult = evaluator.getTypeOfExpression(
            node.d.expr.d.keyExpr,
            flags,
            makeInferenceContext(expectedKeyType)
        );
        if (keyTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        if (keyTypeResult.typeErrors) {
            typeErrors = true;
        }
        let keyType = keyTypeResult.type;
        if (!expectedKeyType || !containsLiteralType(expectedKeyType)) {
            keyType = evaluator.stripLiteralValue(keyType);
        }

        const valueTypeResult = evaluator.getTypeOfExpression(
            node.d.expr.d.valueExpr,
            flags,
            makeInferenceContext(expectedValueOrElementType)
        );
        if (valueTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        if (valueTypeResult.typeErrors) {
            typeErrors = true;
        }
        let valueType = valueTypeResult.type;
        if (!expectedValueOrElementType || !containsLiteralType(expectedValueOrElementType)) {
            valueType = evaluator.stripLiteralValue(valueType);
        }

        type = makeTupleObject(evaluator, [
            { type: keyType, isUnbounded: false },
            { type: valueType, isUnbounded: false },
        ]);
    } else if (node.d.expr.nodeType === ParseNodeType.DictionaryExpandEntry) {
        evaluator.getTypeOfExpression(node.d.expr.d.expr, flags, makeInferenceContext(expectedValueOrElementType));
    } else if (isExpressionNode(node)) {
        const exprTypeResult = evaluator.getTypeOfExpression(
            node.d.expr as ExpressionNode,
            flags,
            makeInferenceContext(expectedValueOrElementType)
        );
        if (exprTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        if (exprTypeResult.typeErrors) {
            typeErrors = true;
        }
        type = exprTypeResult.type;
    }

    return { type, isIncomplete, typeErrors };
}

export function getExpectedEntryTypeForIterableWithEvaluator(
    evaluator: TypeEvaluator,
    node: ListNode | SetNode | ComprehensionNode,
    expectedClassType: Type | undefined,
    inferenceContext?: InferenceContext
): Type | undefined {
    if (!inferenceContext) {
        return undefined;
    }

    if (!expectedClassType || !isInstantiableClass(expectedClassType)) {
        return undefined;
    }

    if (isAnyOrUnknown(inferenceContext.expectedType)) {
        return inferenceContext.expectedType;
    }

    if (!isClassInstance(inferenceContext.expectedType)) {
        return undefined;
    }

    const constraints = new ConstraintTracker();
    if (
        !addConstraintsForExpectedType(
            evaluator,
            ClassType.cloneAsInstance(expectedClassType),
            inferenceContext.expectedType,
            constraints,
            ParseTreeUtils.getTypeVarScopesForNode(node),
            node.start
        )
    ) {
        return undefined;
    }

    const specializedListOrSet = solveAndApplyConstraintsWithEvaluator(
        evaluator,
        expectedClassType,
        constraints
    ) as ClassType;
    if (!specializedListOrSet.priv.typeArgs) {
        return undefined;
    }

    return specializedListOrSet.priv.typeArgs[0];
}

const maxSingleOverloadArgTypeExpansionCount = 64;

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

export function getTypeOfMemberInternalWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode | undefined,
    member: ClassMember,
    selfClass: ClassType | TypeVarType | undefined,
    flags: MemberAccessFlags
): TypeResult | undefined {
    if (isAnyOrUnknown(member.classType)) {
        return {
            type: member.classType,
            isIncomplete: false,
        };
    }

    if (!isInstantiableClass(member.classType)) {
        return undefined;
    }

    const typeResult = evaluator.getEffectiveTypeOfSymbolForUsage(member.symbol);

    if (!typeResult) {
        return undefined;
    }

    if ((flags & MemberAccessFlags.TypeExpression) !== 0 && errorNode) {
        typeResult.type = validateSymbolIsTypeExpressionWithEvaluator(
            evaluator,
            errorNode,
            typeResult.type,
            !!typeResult.includesVariableDecl
        );
    }

    evaluator.inferReturnTypeIfNecessary(typeResult.type);

    if (
        errorNode &&
        selfClass &&
        isClass(selfClass) &&
        member.isInstanceMember &&
        isClass(member.unspecializedClassType) &&
        (flags & MemberAccessFlags.DisallowGenericInstanceVariableAccess) !== 0 &&
        requiresSpecialization(typeResult.type, { ignoreSelf: true, ignoreImplicitTypeArgs: true })
    ) {
        const specializedType = partiallySpecializeType(
            typeResult.type,
            member.unspecializedClassType,
            evaluator.getTypeClassType(),
            selfSpecializeClass(selfClass, { overrideTypeArgs: true })
        );

        if (
            findSubtype(
                specializedType,
                (subtype) =>
                    !isFunctionOrOverloaded(subtype) &&
                    requiresSpecialization(subtype, { ignoreSelf: true, ignoreImplicitTypeArgs: true })
            )
        ) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportGeneralTypeIssues,
                LocMessage.genericInstanceVariableAccess(),
                errorNode
            );
        }
    }

    return {
        type: partiallySpecializeType(typeResult.type, member.classType, evaluator.getTypeClassType(), selfClass),
        isIncomplete: !!typeResult.isIncomplete,
    };
}

export function assignClassWithEvaluator(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number,
    reportErrorsUsingObjType: boolean,
    prefetched: Partial<PrefetchedTypes> | undefined
): boolean {
    if (ClassType.isHierarchyPartiallyEvaluated(destType) || ClassType.isHierarchyPartiallyEvaluated(srcType)) {
        return true;
    }

    if (ClassType.isTypedDictClass(srcType)) {
        if (ClassType.isTypedDictClass(destType) && !ClassType.isSameGenericClass(destType, srcType)) {
            if (
                !assignTypedDictToTypedDict(
                    evaluator,
                    destType,
                    srcType,
                    diag,
                    constraints,
                    flags,
                    recursionCount
                )
            ) {
                return false;
            }

            if ((flags & AssignTypeFlags.Invariant) !== 0) {
                return assignTypedDictToTypedDict(
                    evaluator,
                    srcType,
                    destType,
                    /* diag */ undefined,
                    /* constraints */ undefined,
                    flags,
                    recursionCount
                );
            }

            return true;
        }

        if (ClassType.isBuiltIn(destType, 'Mapping')) {
            const mappingValueType = getTypedDictMappingEquivalent(evaluator, srcType);

            if (
                mappingValueType &&
                prefetched?.mappingClass &&
                isInstantiableClass(prefetched.mappingClass) &&
                prefetched?.strClass &&
                isInstantiableClass(prefetched.strClass)
            ) {
                srcType = ClassType.specialize(prefetched.mappingClass, [
                    ClassType.cloneAsInstance(prefetched.strClass),
                    mappingValueType,
                ]);
            }
        } else if (ClassType.isBuiltIn(destType, ['dict', 'MutableMapping'])) {
            const dictValueType = getTypedDictDictEquivalent(evaluator, srcType, recursionCount);

            if (
                dictValueType &&
                prefetched?.dictClass &&
                isInstantiableClass(prefetched.dictClass) &&
                prefetched.strClass &&
                isInstantiableClass(prefetched.strClass)
            ) {
                srcType = ClassType.specialize(prefetched.dictClass, [
                    ClassType.cloneAsInstance(prefetched.strClass),
                    dictValueType,
                ]);
            }
        }
    }

    if (destType.priv.includePromotions) {
        const promotionList = typePromotions.get(destType.shared.fullName);
        if (
            promotionList &&
            promotionList.some((srcName) =>
                srcType.shared.mro.some((mroClass) => isClass(mroClass) && srcName === mroClass.shared.fullName)
            )
        ) {
            if ((flags & AssignTypeFlags.Invariant) === 0) {
                return true;
            }
        }
    }

    const inheritanceChain: InheritanceChain = [];
    const isDerivedFrom = ClassType.isDerivedFrom(srcType, destType, inheritanceChain);

    if (ClassType.isProtocolClass(destType) && !isDerivedFrom) {
        if (
            !assignClassToProtocol(
                evaluator,
                destType,
                ClassType.cloneAsInstance(srcType),
                diag?.createAddendum(),
                constraints,
                flags,
                recursionCount
            )
        ) {
            diag?.addMessage(
                LocAddendum.protocolIncompatible().format({
                    sourceType: evaluator.printType(convertToInstance(srcType)),
                    destType: evaluator.printType(convertToInstance(destType)),
                })
            );
            return false;
        }

        return true;
    }

    if ((flags & AssignTypeFlags.Invariant) === 0 || ClassType.isSameGenericClass(srcType, destType)) {
        if (isDerivedFrom) {
            assert(inheritanceChain.length > 0);

            if (
                assignClassWithTypeArgsWithEvaluator(
                    evaluator,
                    destType,
                    srcType,
                    inheritanceChain,
                    diag?.createAddendum(),
                    constraints,
                    flags,
                    recursionCount
                )
            ) {
                return true;
            }
        }
    }

    if (ClassType.isBuiltIn(destType, 'object')) {
        if ((flags & AssignTypeFlags.Invariant) === 0) {
            return true;
        }
    }

    if (diag) {
        const destErrorType = reportErrorsUsingObjType ? ClassType.cloneAsInstance(destType) : destType;
        const srcErrorType = reportErrorsUsingObjType ? ClassType.cloneAsInstance(srcType) : srcType;

        let destErrorTypeText = evaluator.printType(destErrorType);
        let srcErrorTypeText = evaluator.printType(srcErrorType);

        if (destErrorTypeText === srcErrorTypeText && destType.shared.fullName && srcType.shared.fullName) {
            destErrorTypeText = destType.shared.fullName;
            srcErrorTypeText = srcType.shared.fullName;
        }

        diag?.addMessage(
            LocAddendum.typeIncompatible().format({
                sourceType: srcErrorTypeText,
                destType: destErrorTypeText,
            })
        );

        if (ClassType.isBuiltIn(destType, 'bytes')) {
            const promotions = typePromotions.get(destType.shared.fullName);
            if (promotions && promotions.some((name) => name === srcType.shared.fullName)) {
                diag?.addMessage(LocAddendum.bytesTypePromotions());
            }
        }
    }

    return false;
}
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
import { ArgCategory, ArgumentNode, AssignmentNode, ExpressionNode, FunctionNode, ImportFromAsNode, NameNode, ParamCategory, ParseNode, ParseNodeType, SliceNode, StringListNode, StringNode, TypeParameterNode, YieldFromNode } from '../../parser/parseNodes';
import { KeywordType, OperatorType } from '../../parser/tokenizerTypes';
import { Parser, ParseOptions, ParseTextMode } from '../../parser/parser';
import { TextRange } from '../../common/textRange';
import { TextRangeCollection } from '../../common/textRangeCollection';
import { Uri } from '../../common/uri/uri';
import { assert } from '../../common/debug';
import { appendArray } from '../../common/collectionUtils';
import { convertOffsetsToRange } from '../../common/positionUtils';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { isAnnotationEvaluationPostponed } from '../analyzerFileInfo';
import { Declaration, DeclarationType } from '../declaration';
import { Arg, ArgWithExpression, AssignTypeFlags, CallResult, EvalFlags, EvaluatorUsage, ExpectedTypeOptions, MagicMethodDeprecationInfo, PrefetchedTypes, PrintTypeOptions, Reachability, SymbolDeclInfo, TypeEvaluator, TypeResult, TypeResultWithNode, ValidateTypeArgsOptions } from '../typeEvaluatorTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { AnyType, ClassType, ClassTypeFlags, combineTypes, findSubtype, FunctionParam, FunctionParamFlags, FunctionType, FunctionTypeFlags, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isNever, isOverloaded, isParamSpec, isPositionOnlySeparator, isTypeVar, isTypeSame, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedClass, isUnpackedTypeVarTuple, maxTypeRecursionCount, ModuleType, NeverType, OverloadedType, ParamSpecType, removeUnbound, TupleTypeArg, Type, TypeAliasInfo, TypeBase, TypeCategory, TypeCondition, TypeVarScopeId, TypeVarScopeType, TypeVarTupleType, TypeVarType, UnionType, UnknownType, Variance } from '../types';
import { addConditionToType, combineSameSizedTuples, combineVariances, computeMroLinearization, containsLiteralType, convertToInstance, convertToInstantiable, derivesFromClassRecursive, doForEachSubtype, addTypeVarsToListIfUnique, getGeneratorTypeArgs, getTypeCondition, getTypeVarArgsRecursive, InferenceContext, invertVariance, isEffectivelyInstantiable, isEllipsisType, isIncompleteUnknown, isInstantiableMetaclass, isLiteralType, isNoneInstance, isNoneTypeClass, isOptionalType, isPartlyUnknown, isSentinelLiteral, isTupleClass, isTypeAliasPlaceholder, isUnboundedTupleClass, lookUpClassMember, lookUpObjectMember, makeFunctionTypeVarsBound, makeTypeVarsBound, mapSignatures, mapSubtypes, MemberAccessFlags, requiresSpecialization, selfSpecializeClass, simplifyFunctionToParamSpec, sortTypes, specializeWithDefaultTypeArgs, specializeTupleClass, synthesizeTypeVarForSelfCls, transformPossibleRecursiveTypeAlias, validateTypeVarDefault } from '../typeUtils';
import { getParamListDetails, ParamKind, ParamListDetails, VirtualParamDetails } from '../parameterUtils';
import { ConstraintTracker } from '../constraintTracker';
import { makeTupleObject } from '../tuples';
import { ScopeType, SymbolWithScope } from '../scope';
import { CodeFlowEngine } from '../codeFlowEngine';
import { Symbol, SynthesizedTypeInfo } from '../symbol';
import { getDeclarationsWithUsesLocalNameRemoved, synthesizeAliasDeclaration } from '../declarationUtils';
import { getBoundInitMethod, validateConstructorArgs } from '../constructors';
import { isPrivateOrProtectedName } from '../symbolNameUtils';
import * as ScopeUtils from '../scopeUtils';
import { getFunctionInfoFromDecorators } from '../decorators';

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
// typeVarHandling.ts
// TypeVar, TypeVarTuple, variance inference, type form, and expansion logic.
// Extracted from evaluatorCore.ts for modularization.

import { assert } from '../../common/debug';
import { Diagnostic } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { LocMessage } from '../../localization/localize';
import { PythonVersion, pythonVersion3_13 } from '../../common/pythonVersion';
import { Uri } from '../../common/uri/uri';
import { ArgCategory, ExpressionNode, ParamCategory, ParseNode, ParseNodeType } from '../../parser/parseNodes';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import * as ParseTreeUtils from '../parseTreeUtils';
import { Scope } from '../scope';
import { Symbol } from '../symbol';
import { ConstraintTracker } from '../constraintTracker';
import { Arg, EvalFlags, PrefetchedTypes, TypeEvaluator } from '../typeEvaluatorTypes';
import { AnyType, ClassType, combineTypes, FunctionParam, FunctionParamFlags, FunctionType, isClass, isClassInstance, isFunction, isInstantiableClass, isNever, isParamSpec, isTypeSame, isTypeVar, isTypeVarTuple, isUnion, isUnpacked, isUnpackedClass, maxTypeRecursionCount, ParamSpecType, Type, TypeBase, TypeCategory, TypeCondition, TypeVarKind, TypeVarTupleType, TypeVarType, UnionType, UnknownType, Variance } from '../types';
import { addConditionToType, combineSameSizedTuples, combineVariances, convertToInstance, convertToInstantiable, doForEachSubtype, getTypeCondition, getTypeVarArgsRecursive, invertVariance, isTupleClass, makeTypeVarsBound, mapSubtypes, requiresSpecialization, selfSpecializeClass, simplifyFunctionToParamSpec, sortTypes, specializeWithDefaultTypeArgs, transformPossibleRecursiveTypeAlias } from '../typeUtils';
import { makeTupleObject } from '../tuples';
import { applyConditionFilterToTypeWithEvaluator, expandArgTypeWithEvaluator, getObjectTypeFromPrefetched, getTypeVarTupleDefaultTypeWithEvaluator, isSymbolValidTypeExpressionCheck, MapSubtypesExpandOptions, specializeTypeAliasWithDefaultsWithEvaluator, typePromotions, verifyTypeVarDefaultIsCompatibleWithEvaluator } from './evaluatorCore';
import { getBooleanValueFromNode } from './specialFormCreation';
import { isTypeFormSupportedForNode } from './pureHelpers';

export function getPseudoGenericTypeVarNameForParam(paramName: string) {
    return `__type_of_${paramName}`;
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

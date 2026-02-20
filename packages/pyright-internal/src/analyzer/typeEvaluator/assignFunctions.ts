// assignFunctions.ts
// Function and parameter assignment/compatibility logic.
// Extracted from evaluatorCore.ts for modularization.

import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { assert } from '../../common/debug';
import { LocAddendum } from '../../localization/localize';
import { AssignTypeFlags, PrefetchedTypes, TypeEvaluator } from '../typeEvaluatorTypes';
import { ClassType, combineTypes, FunctionParam, FunctionType, FunctionTypeFlags, InheritanceChain, isAnyOrUnknown, isClass, isClassInstance, isFunctionOrOverloaded, isInstantiableClass, isOverloaded, isParamSpec, isPositionOnlySeparator, isTypeSame, isTypeVar, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedTypeVarTuple, findSubtype, Type, TypeAliasInfo, TypeBase, TypeCondition, TypeVarType, UnionType, UnknownType, Variance } from '../types';
import { containsLiteralType, convertToInstance, doForEachSubtype, getTypeCondition, isIncompleteUnknown, isLiteralLikeType, isLiteralType, isNoneInstance, isNoneTypeClass, isOptionalType, makeTypeVarsBound, requiresSpecialization, sortTypes, specializeForBaseClass } from '../typeUtils';
import { ConstraintTracker } from '../constraintTracker';
import { makeTupleObject, assignTupleTypeArgs } from '../tuples';
import { getParamListDetails, ParamKind, VirtualParamDetails } from '../parameterUtils';
import { ParamCategory } from '../../parser/parseNodes';
import { adjustSourceParamDetailsForDestVariadicWithEvaluator } from './specialFormCreation';
import { assignClassToProtocol } from '../protocols';
import { assignTypedDictToTypedDict, getTypedDictDictEquivalent, getTypedDictMappingEquivalent } from '../typedDicts';
import { typePromotions } from './evaluatorCore';

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


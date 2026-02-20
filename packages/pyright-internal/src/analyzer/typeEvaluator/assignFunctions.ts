// assignFunctions.ts
// Function and parameter assignment/compatibility logic.
// Extracted from evaluatorCore.ts for modularization.

import { LocAddendum } from '../../localization/localize';
import { DiagnosticAddendum } from '../../common/diagnostic';
import { AssignTypeFlags, PrefetchedTypes, TypeEvaluator } from '../typeEvaluatorTypes';
import { ClassType, FunctionParam, FunctionType, FunctionTypeFlags, isAnyOrUnknown, isClassInstance, isInstantiableClass, isOverloaded, isParamSpec, isPositionOnlySeparator, isTypeSame, isTypeVar, isTypeVarTuple, isUnknown, isUnpacked, isUnpackedTypeVarTuple, Type } from '../types';
import { containsLiteralType, convertToInstance, requiresSpecialization } from '../typeUtils';
import { ConstraintTracker } from '../constraintTracker';
import { makeTupleObject } from '../tuples';
import { getParamListDetails, ParamKind, VirtualParamDetails } from '../parameterUtils';
import { ParamCategory } from '../../parser/parseNodes';
import { adjustSourceParamDetailsForDestVariadicWithEvaluator } from './specialFormCreation';

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


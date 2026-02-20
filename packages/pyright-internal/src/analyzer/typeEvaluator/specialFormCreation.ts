// specialFormCreation.ts
// Special form type creation functions (ClassVar, Final, Annotated, Callable, etc.)
// Extracted from evaluatorCore.ts for modularization.
import { LocAddendum, LocMessage } from '../../localization/localize';
import { ExpressionNode, FunctionNode, NameNode, ParamCategory, ParameterNode, ParseNode, ParseNodeType, TypeParameterNode } from '../../parser/parseNodes';
import { KeywordType, OperatorType } from '../../parser/tokenizerTypes';
import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { assert } from '../../common/debug';
import { appendArray } from '../../common/collectionUtils';
import { TextRange } from '../../common/textRange';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { Declaration, DeclarationType } from '../declaration';
import { AbstractSymbol, Arg, ArgWithExpression, AssignTypeFlags, EvalFlags, MagicMethodDeprecationInfo, PrefetchedTypes, TypeEvaluator, TypeResult, TypeResultWithNode, ValidateTypeArgsOptions } from '../typeEvaluatorTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { AnyType, ClassType, ClassTypeFlags, combineTypes, FunctionParam, FunctionParamFlags, FunctionType, FunctionTypeFlags, isAny, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isNever, isOverloaded, isParamSpec, isTypeVar, isTypeSame, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedClass, isUnpackedTypeVarTuple, maxTypeRecursionCount, NeverType, OverloadedType, ParamSpecType, TupleTypeArg, Type, TypeAliasInfo, TypeBase, TypeCategory, TypeCondition, TypeVarKind, TypeVarScopeId, TypeVarScopeType, TypeVarTupleType, TypeVarType, UnionType, UnknownType, Variance } from '../types';
import { addConditionToType, applySolvedTypeVars, ApplyTypeVarOptions, ClassMember, combineVariances, computeMroLinearization, convertToInstance, convertToInstantiable, derivesFromAnyOrUnknown, derivesFromClassRecursive, doForEachSubtype, addTypeVarsToListIfUnique, explodeGenericClass, getSpecializedTupleType, getTypeCondition, getTypeVarArgsRecursive, getTypeVarScopeId, getTypeVarScopeIds, InferenceContext, isEffectivelyInstantiable, isEllipsisType, isInstantiableMetaclass, isLiteralType, isNoneInstance, isNoneTypeClass, isTupleClass, isTypeAliasPlaceholder, isUnboundedTupleClass, lookUpClassMember, makeFunctionTypeVarsBound, makeInferenceContext, mapSubtypes, partiallySpecializeType, requiresSpecialization, requiresTypeArgs, selfSpecializeClass, specializeForBaseClass, specializeWithDefaultTypeArgs, specializeTupleClass, stripTypeForm, synthesizeTypeVarForSelfCls, transformPossibleRecursiveTypeAlias, validateTypeVarDefault } from '../typeUtils';
import { getParamListDetails, ParamKind, ParamListDetails, VirtualParamDetails } from '../parameterUtils';
import { ConstraintTracker } from '../constraintTracker';
import { assignTupleTypeArgs, makeTupleObject } from '../tuples';
import { Symbol, SymbolFlags } from '../symbol';
import { isTypeFormSupportedForNode, applyUnpackToTupleLikeType } from './pureHelpers';

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
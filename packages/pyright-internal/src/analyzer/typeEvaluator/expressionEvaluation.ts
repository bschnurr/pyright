// expressionEvaluation.ts
// Expression type evaluation: getTypeOf* functions and related helpers.
// Extracted from evaluatorCore.ts for modularization.

import { appendArray } from '../../common/collectionUtils';
import { assert } from '../../common/debug';
import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../../localization/localize';
import { ArgCategory, CallNode, ConstantNode, ExpressionNode, FormatStringNode, IndexNode, LambdaNode, ListNode, ParseNode, ParseNodeType, SliceNode, StringListNode, StringNode, TypeAnnotationNode, UnpackNode, WithNode, YieldFromNode, YieldNode, ParamCategory } from '../../parser/parseNodes';
import { KeywordType, OperatorType, StringTokenFlags } from '../../parser/tokenizerTypes';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { isAnnotationEvaluationPostponed } from '../analyzerFileInfo';
import { getFunctionInfoFromDecorators } from '../decorators';
import * as ParseTreeUtils from '../parseTreeUtils';
import { Scope, ScopeType } from '../scope';
import * as ScopeUtils from '../scopeUtils';
import { Symbol } from '../symbol';
import { Arg, AssignTypeFlags, CallResult, EvalFlags, EvaluatorUsage, ExpectedTypeOptions, MagicMethodDeprecationInfo, PrefetchedTypes, TypeEvaluator, TypeResult, TypeResultWithNode } from '../typeEvaluatorTypes';
import { AnyType, ClassType, combineTypes, findSubtype, FunctionParam, FunctionParamFlags, FunctionType, FunctionTypeFlags, isAny, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isOverloaded, isTypeSame, isTypeVar, isTypeVarTuple, isUnion, isUnknown, isUnpacked, isUnpackedTypeVarTuple, ModuleType, NeverType, OverloadedType, removeUnbound, TupleTypeArg, Type, TypeBase, TypeCondition, TypeVarType, UnknownType } from '../types';
import { addConditionToType, ClassMember, convertToInstance, derivesFromAnyOrUnknown, derivesFromClassRecursive, doForEachSubtype, getGeneratorTypeArgs, getGeneratorYieldType, getSpecializedTupleType, getTypeCondition, InferenceContext, isLiteralType, isMetaclassInstance, isNoneInstance, isNoneTypeClass, isOptionalType, isTupleClass, isTupleIndexUnambiguous, lookUpClassMember, lookUpObjectMember, makeInferenceContext, makeTypeVarsBound, mapSubtypes, MemberAccessFlags, partiallySpecializeType, removeNoneFromUnion, requiresSpecialization, selfSpecializeClass, specializeForBaseClass, synthesizeTypeVarForSelfCls, transformPossibleRecursiveTypeAlias } from '../typeUtils';
import { getSlicedTupleType, makeTupleObject } from '../tuples';
import { createTypedDictTypeInlined, getTypeOfIndexedTypedDict } from '../typedDicts';
import { cloneBuiltinClassWithLiteralWithEvaluator, cloneBuiltinObjectWithLiteralWithEvaluator, convertArgumentNodeToArg, convertSpecialFormToRuntimeValueWithPrefetched, getTypeOfArgExpectingTypeWithEvaluator, getTypeOfAwaitableWithEvaluator, parseStringAsTypeAnnotationNode, printSrcDestTypesWithEvaluator } from './evaluatorCore';
import { getIndexAccessMagicMethodNameForUsage, validateSymbolIsTypeExpressionWithEvaluator } from './memberResolution';
import { isTypeFormSupportedForNode } from './pureHelpers';

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


export function getTypeOfStringWithEvaluator(
    evaluator: TypeEvaluator,
    node: StringNode | FormatStringNode,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResult {
    const isBytes = (node.d.token.flags & StringTokenFlags.Bytes) !== 0;
    let typeResult: TypeResult | undefined;
    let isIncomplete = false;

    if (node.nodeType === ParseNodeType.String) {
        typeResult = {
            type: cloneBuiltinObjectWithLiteralWithEvaluator(evaluator, node, isBytes ? 'bytes' : 'str', node.d.value),
            isIncomplete,
        };
    } else {
        const isTemplateString = (node.d.token.flags & StringTokenFlags.Template) !== 0;
        let isLiteralString = true;

        node.d.fieldExprs.forEach((expr) => {
            const exprTypeResult = evaluator.getTypeOfExpression(expr);
            const exprType = exprTypeResult.type;

            if (exprTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            doForEachSubtype(exprType, (exprSubtype) => {
                if (!isClassInstance(exprSubtype)) {
                    isLiteralString = false;
                    return;
                }

                if (ClassType.isBuiltIn(exprSubtype, 'LiteralString')) {
                    return;
                }

                if (ClassType.isBuiltIn(exprSubtype, 'str') && exprSubtype.priv.literalValue !== undefined) {
                    return;
                }

                isLiteralString = false;
            });
        });

        if (isTemplateString) {
            const templateType =
                prefetched?.templateClass && isInstantiableClass(prefetched?.templateClass)
                    ? ClassType.cloneAsInstance(prefetched.templateClass)
                    : UnknownType.create();

            typeResult = { type: templateType, isIncomplete };
        } else if (!isBytes && isLiteralString) {
            const literalStringType = evaluator.getTypingType(node, 'LiteralString');
            if (literalStringType && isInstantiableClass(literalStringType)) {
                typeResult = { type: ClassType.cloneAsInstance(literalStringType), isIncomplete };
            }
        }

        if (!typeResult) {
            typeResult = {
                type: evaluator.getBuiltInObject(node, isBytes ? 'bytes' : 'str'),
                isIncomplete,
            };

            if (isClass(typeResult.type) && typeResult.type.priv.includePromotions) {
                typeResult.type = ClassType.cloneRemoveTypePromotions(typeResult.type);
            }
        }
    }

    return typeResult;
}


export function createLiteralTypeWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType,
    node: IndexNode,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined
): Type {
    if (node.d.items.length === 0) {
        evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.literalEmptyArgs(), node.d.leftExpr);
        return UnknownType.create();
    }

    const literalTypes: Type[] = [];
    let isValidTypeForm = true;

    for (const item of node.d.items) {
        let type: Type | undefined;
        const itemExpr = item.d.valueExpr;

        if (item.d.argCategory !== ArgCategory.Simple) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.unpackedArgInTypeArgument(),
                    itemExpr
                );
                type = UnknownType.create();
                isValidTypeForm = false;
            }
        } else if (item.d.name) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(
                    DiagnosticRule.reportInvalidTypeForm,
                    LocMessage.keywordArgInTypeArgument(),
                    itemExpr
                );
                type = UnknownType.create();
                isValidTypeForm = false;
            }
        } else if (itemExpr.nodeType === ParseNodeType.StringList) {
            const isBytes = (itemExpr.d.strings[0].d.token.flags & StringTokenFlags.Bytes) !== 0;
            const value = itemExpr.d.strings.map((s) => s.d.value).join('');
            if (isBytes) {
                type = cloneBuiltinClassWithLiteralWithEvaluator(evaluator, node, classType, 'bytes', value);
            } else {
                type = cloneBuiltinClassWithLiteralWithEvaluator(evaluator, node, classType, 'str', value);
            }

            if ((flags & EvalFlags.TypeExpression) !== 0) {
                itemExpr.d.strings.forEach((stringNode) => {
                    if ((stringNode.d.token.flags & StringTokenFlags.NamedUnicodeEscape) !== 0) {
                        evaluator.addDiagnostic(
                            DiagnosticRule.reportInvalidTypeForm,
                            LocMessage.literalNamedUnicodeEscape(),
                            stringNode
                        );
                        isValidTypeForm = false;
                    }
                });
            }
        } else if (itemExpr.nodeType === ParseNodeType.Number) {
            if (!itemExpr.d.isImaginary && itemExpr.d.isInteger) {
                type = cloneBuiltinClassWithLiteralWithEvaluator(evaluator, node, classType, 'int', itemExpr.d.value);
            }
        } else if (itemExpr.nodeType === ParseNodeType.Constant) {
            if (itemExpr.d.constType === KeywordType.True) {
                type = cloneBuiltinClassWithLiteralWithEvaluator(evaluator, node, classType, 'bool', true);
            } else if (itemExpr.d.constType === KeywordType.False) {
                type = cloneBuiltinClassWithLiteralWithEvaluator(evaluator, node, classType, 'bool', false);
            } else if (itemExpr.d.constType === KeywordType.None) {
                type = prefetched?.noneTypeClass ?? UnknownType.create();
            }
        } else if (itemExpr.nodeType === ParseNodeType.UnaryOperation) {
            if (itemExpr.d.operator === OperatorType.Subtract || itemExpr.d.operator === OperatorType.Add) {
                if (itemExpr.d.expr.nodeType === ParseNodeType.Number) {
                    if (!itemExpr.d.expr.d.isImaginary && itemExpr.d.expr.d.isInteger) {
                        type = cloneBuiltinClassWithLiteralWithEvaluator(
                            evaluator,
                            node,
                            classType,
                            'int',
                            itemExpr.d.operator === OperatorType.Subtract
                                ? -itemExpr.d.expr.d.value
                                : itemExpr.d.expr.d.value
                        );
                    }
                }
            }
        }

        if (!type) {
            const exprType = evaluator.getTypeOfExpression(
                itemExpr,
                (flags & (EvalFlags.ForwardRefs | EvalFlags.TypeExpression)) | EvalFlags.NoConvertSpecialForm
            );

            if (
                isClassInstance(exprType.type) &&
                ClassType.isEnumClass(exprType.type) &&
                exprType.type.priv.literalValue !== undefined
            ) {
                type = ClassType.cloneAsInstantiable(exprType.type);
            } else {
                let isLiteralType = true;

                doForEachSubtype(exprType.type, (subtype) => {
                    if (!isInstantiableClass(subtype) || subtype.priv.literalValue === undefined) {
                        if (!isNoneTypeClass(subtype)) {
                            isLiteralType = false;
                        }
                    }
                });

                if (isLiteralType) {
                    type = exprType.type;
                }
            }
        }

        if (!type) {
            if ((flags & EvalFlags.TypeExpression) !== 0) {
                evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.literalUnsupportedType(), item);
                type = UnknownType.create();
                isValidTypeForm = false;
            } else {
                return ClassType.cloneAsInstance(classType);
            }
        }

        literalTypes.push(type);
    }

    let result = combineTypes(literalTypes, { skipElideRedundantLiterals: true });

    if (isUnion(result) && prefetched?.unionTypeClass && isInstantiableClass(prefetched.unionTypeClass)) {
        result = TypeBase.cloneAsSpecialForm(result, ClassType.cloneAsInstance(prefetched.unionTypeClass));
    }

    if (isTypeFormSupportedForNode(node) && isValidTypeForm) {
        result = TypeBase.cloneWithTypeForm(result, convertToInstance(result));
    }

    return result;
}



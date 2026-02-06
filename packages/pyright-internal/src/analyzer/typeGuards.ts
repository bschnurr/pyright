/*
 * typeGuards.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Provides logic for narrowing types based on conditional
 * expressions. The logic handles both positive ("if") and
 * negative ("else") narrowing cases.
 */

import {
    ArgCategory,
    AssignmentExpressionNode,
    ExpressionNode,
    isExpressionNode,
    NameNode,
    ParseNode,
    ParseNodeType,
} from '../parser/parseNodes';
import { KeywordType, OperatorType } from '../parser/tokenizerTypes';
import { addConstraintsForExpectedType } from './constraintSolver';
import { Declaration, DeclarationType } from './declaration';
import { transformTypeForEnumMember } from './enums';
import * as ParseTreeUtils from './parseTreeUtils';
import { ScopeType } from './scope';
import { getScopeForNode, isScopeContainedWithin } from './scopeUtils';
import { getTypedDictMembersForClass } from './typedDicts';
import * as TypeEvaluatorNarrowing from './typeEvaluator/narrowing';
import { EvalFlags, TypeEvaluator } from './typeEvaluatorTypes';
import {
    ClassType,
    EnumLiteral,
    FunctionType,
    isClassInstance,
    isFunction,
    isInstantiableClass,
    isOverloaded,
    maxTypeRecursionCount,
    OverloadedType,
    Type,
    TypeVarType,
} from './types';
import {
    isLiteralType,
    isLiteralTypeOrUnion,
    isNoneInstance,
    lookUpClassMember,
    lookUpObjectMember,
} from './typeUtils';

export interface TypeNarrowingResult {
    type: Type;
    isIncomplete: boolean;
}

export type TypeNarrowingCallback = (type: Type) => TypeNarrowingResult | undefined;

function getTruthinessNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.TruthinessNarrowingContext {
    return {
        canBeTruthy: (type) => evaluator.canBeTruthy(type),
        canBeFalsy: (type) => evaluator.canBeFalsy(type),
        removeFalsinessFromType: (type) => evaluator.removeFalsinessFromType(type),
        removeTruthinessFromType: (type) => evaluator.removeTruthinessFromType(type),
    };
}

function getIsNoneNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.IsNoneNarrowingContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
        getNoneType: () => evaluator.getNoneType(),
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
        mapSubtypesExpandTypeVars: (type, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, /* options */ undefined, callback),
    };
}

function getIsEllipsisNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.IsEllipsisNarrowingContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
        getBuiltInObject: (node, name) => evaluator.getBuiltInObject(node, name),
        mapSubtypesExpandTypeVars: (type, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, /* options */ undefined, callback),
    };
}

function getClassComparisonContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.ClassComparisonContext {
    return {
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
    };
}

function getLiteralComparisonContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.LiteralComparisonContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
        enumerateLiteralsForType: (type) => enumerateLiteralsForType(evaluator, type),
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
        mapSubtypesExpandTypeVars: (type, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, /* options */ undefined, (subtype) => callback(subtype)),
    };
}

function getDiscriminatedDictEntryContext(
    evaluator: TypeEvaluator
): TypeEvaluatorNarrowing.DiscriminatedDictEntryContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
        getTypedDictMembersForClass: (type) => getTypedDictMembersForClass(evaluator, type),
    };
}

function getDiscriminatedTupleContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.DiscriminatedTupleContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
    };
}

function getDiscriminatedLiteralFieldContext(
    evaluator: TypeEvaluator
): TypeEvaluatorNarrowing.DiscriminatedLiteralFieldContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
        getTypeOfMember: (member) => evaluator.getTypeOfMember(member),
        lookUpObjectMember: (type, memberName) => lookUpObjectMember(type, memberName),
        lookUpClassMember: (type, memberName) => lookUpClassMember(type, memberName),
    };
}

function getDiscriminatedFieldNoneContext(
    evaluator: TypeEvaluator
): TypeEvaluatorNarrowing.DiscriminatedFieldNoneContext {
    return {
        getTypeOfMember: (member) => evaluator.getTypeOfMember(member),
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
        lookUpObjectMember: (type, memberName) => lookUpObjectMember(type, memberName),
        lookUpClassMember: (type, memberName) => lookUpClassMember(type, memberName),
    };
}

function getEnumerateLiteralsContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.EnumerateLiteralsContext {
    return {
        getEffectiveTypeOfSymbol: (symbol) => evaluator.getEffectiveTypeOfSymbol(symbol),
        transformTypeForEnumMember: (enumClassType, memberName) =>
            transformTypeForEnumMember(evaluator, enumClassType, memberName),
    };
}

function getTypeIsNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.TypeIsNarrowingContext {
    return {
        mapSubtypesExpandTypeVars: (type, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, /* options */ undefined, callback),
    };
}

function getIsInstanceNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.IsInstanceNarrowingContext {
    return {
        addConstraintsForExpectedType: (type, expectedType, constraints, errorNodeStart) =>
            addConstraintsForExpectedType(
                evaluator,
                type,
                expectedType,
                constraints,
                /* liveTypeVarScopes */ undefined,
                errorNodeStart
            ),
        assignType: (destType, srcType, flags) =>
            evaluator.assignType(destType, srcType, /* diag */ undefined, /* constraints */ undefined, flags),
        createSubclass: (errorNode, type1, type2) => evaluator.createSubclass(errorNode, type1, type2),
        expandPromotionTypes: (node, type) => evaluator.expandPromotionTypes(node, type),
        getCallbackProtocolType: (objType, recursionCount) =>
            evaluator.getCallbackProtocolType(objType, recursionCount),
        getDictClassType: () => evaluator.getDictClassType(),
        getStrClassType: () => evaluator.getStrClassType(),
        getTupleClassType: () => evaluator.getTupleClassType(),
        getTypeClassType: () => evaluator.getTypeClassType(),
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
        mapSubtypesExpandTypeVars: (type, options, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, options, callback),
        solveAndApplyConstraints: (type, constraints, options) =>
            evaluator.solveAndApplyConstraints(type, constraints, options),
    };
}

function getIsInstanceClassTypeContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.IsInstanceClassTypeContext {
    return {
        getTupleClassType: () => evaluator.getTupleClassType(),
        maxTypeRecursionCount,
    };
}

function getTupleLengthNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.TupleLengthNarrowingContext {
    return {
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
    };
}

function getContainerNarrowingContext(evaluator: TypeEvaluator): TypeEvaluatorNarrowing.ContainerNarrowingContext {
    return {
        assignType: (destType, srcType) => evaluator.assignType(destType, srcType),
        enumerateLiteralsForType: (type) => enumerateLiteralsForType(evaluator, type),
        isTypeComparable: (srcType, destType) => evaluator.isTypeComparable(srcType, destType),
        makeTopLevelTypeVarsConcrete: (type) => evaluator.makeTopLevelTypeVarsConcrete(type),
        mapSubtypesExpandTypeVars: (type, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, /* options */ undefined, callback),
    };
}

function getTypedDictKeyNarrowingContext(
    evaluator: TypeEvaluator
): TypeEvaluatorNarrowing.TypedDictKeyNarrowingContext {
    return {
        getTypedDictMembersForClass: (type, allowNarrowed) =>
            getTypedDictMembersForClass(evaluator, type, allowNarrowed),
        mapSubtypesExpandTypeVars: (type, callback) =>
            evaluator.mapSubtypesExpandTypeVars(type, /* options */ undefined, callback),
    };
}

// Given a reference expression and a test expression, returns a callback that
// can be used to narrow the type described by the reference expression.
// If the specified flow node is not associated with the test expression,
// it returns undefined.
export function getTypeNarrowingCallback(
    evaluator: TypeEvaluator,
    reference: ExpressionNode,
    testExpression: ExpressionNode,
    isPositiveTest: boolean,
    recursionCount = 0
): TypeNarrowingCallback | undefined {
    if (recursionCount > maxTypeRecursionCount) {
        return undefined;
    }

    recursionCount++;

    if (testExpression.nodeType === ParseNodeType.AssignmentExpression) {
        return getTypeNarrowingCallbackForAssignmentExpression(
            evaluator,
            reference,
            testExpression,
            isPositiveTest,
            recursionCount
        );
    }

    if (testExpression.nodeType === ParseNodeType.BinaryOperation) {
        const isOrIsNotOperator =
            testExpression.d.operator === OperatorType.Is || testExpression.d.operator === OperatorType.IsNot;
        const equalsOrNotEqualsOperator =
            testExpression.d.operator === OperatorType.Equals || testExpression.d.operator === OperatorType.NotEquals;
        const comparisonOperator =
            equalsOrNotEqualsOperator ||
            testExpression.d.operator === OperatorType.LessThan ||
            testExpression.d.operator === OperatorType.LessThanOrEqual ||
            testExpression.d.operator === OperatorType.GreaterThan ||
            testExpression.d.operator === OperatorType.GreaterThanOrEqual;

        if (isOrIsNotOperator || equalsOrNotEqualsOperator) {
            // Invert the "isPositiveTest" value if this is an "is not" operation.
            const adjIsPositiveTest =
                testExpression.d.operator === OperatorType.Is || testExpression.d.operator === OperatorType.Equals
                    ? isPositiveTest
                    : !isPositiveTest;

            // Look for "X is None", "X is not None", "X == None", and "X != None".
            // These are commonly-used patterns used in control flow.
            if (
                testExpression.d.rightExpr.nodeType === ParseNodeType.Constant &&
                testExpression.d.rightExpr.d.constType === KeywordType.None
            ) {
                // Allow the LHS to be either a simple expression or an assignment
                // expression that assigns to a simple name.
                let leftExpression = testExpression.d.leftExpr;
                if (leftExpression.nodeType === ParseNodeType.AssignmentExpression) {
                    leftExpression = leftExpression.d.name;
                }

                if (
                    ParseTreeUtils.isMatchingExpression(reference, leftExpression, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    )
                ) {
                    return (type: Type) => {
                        return {
                            type: TypeEvaluatorNarrowing.narrowTypeForIsNone(
                                getIsNoneNarrowingContext(evaluator),
                                type,
                                adjIsPositiveTest
                            ),
                            isIncomplete: false,
                        };
                    };
                }

                if (
                    leftExpression.nodeType === ParseNodeType.Index &&
                    ParseTreeUtils.isMatchingExpression(reference, leftExpression.d.leftExpr, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    ) &&
                    leftExpression.d.items.length === 1 &&
                    !leftExpression.d.trailingComma &&
                    leftExpression.d.items[0].d.argCategory === ArgCategory.Simple &&
                    !leftExpression.d.items[0].d.name &&
                    leftExpression.d.items[0].d.valueExpr.nodeType === ParseNodeType.Number &&
                    leftExpression.d.items[0].d.valueExpr.d.isInteger &&
                    !leftExpression.d.items[0].d.valueExpr.d.isImaginary
                ) {
                    const indexValue = leftExpression.d.items[0].d.valueExpr.d.value;
                    if (typeof indexValue === 'number') {
                        return (type: Type) => {
                            return {
                                type: TypeEvaluatorNarrowing.narrowTupleTypeForIsNone(
                                    getIsNoneNarrowingContext(evaluator),
                                    type,
                                    adjIsPositiveTest,
                                    indexValue
                                ),
                                isIncomplete: false,
                            };
                        };
                    }
                }
            }

            // Look for "X is ...", "X is not ...", "X == ...", and "X != ...".
            if (testExpression.d.rightExpr.nodeType === ParseNodeType.Ellipsis) {
                // Allow the LHS to be either a simple expression or an assignment
                // expression that assigns to a simple name.
                let leftExpression = testExpression.d.leftExpr;
                if (leftExpression.nodeType === ParseNodeType.AssignmentExpression) {
                    leftExpression = leftExpression.d.name;
                }

                if (
                    ParseTreeUtils.isMatchingExpression(reference, leftExpression, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    )
                ) {
                    return (type: Type) => {
                        return {
                            type: TypeEvaluatorNarrowing.narrowTypeForIsEllipsis(
                                getIsEllipsisNarrowingContext(evaluator),
                                testExpression,
                                type,
                                adjIsPositiveTest
                            ),
                            isIncomplete: false,
                        };
                    };
                }
            }

            // Look for "type(X) is Y", "type(X) is not Y", "type(X) == Y" or "type(X) != Y".
            if (testExpression.d.leftExpr.nodeType === ParseNodeType.Call) {
                if (
                    testExpression.d.leftExpr.d.args.length === 1 &&
                    testExpression.d.leftExpr.d.args[0].d.argCategory === ArgCategory.Simple
                ) {
                    const arg0Expr = testExpression.d.leftExpr.d.args[0].d.valueExpr;
                    if (
                        ParseTreeUtils.isMatchingExpression(reference, arg0Expr, (ref, expr) =>
                            isNameSameScope(evaluator, ref, expr)
                        )
                    ) {
                        const callType = evaluator.getTypeOfExpression(
                            testExpression.d.leftExpr.d.leftExpr,
                            EvalFlags.CallBaseDefaults
                        ).type;

                        if (isInstantiableClass(callType) && ClassType.isBuiltIn(callType, 'type')) {
                            const rhsResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                            const classTypes: ClassType[] = [];
                            let isClassType = true;

                            evaluator.mapSubtypesExpandTypeVars(
                                rhsResult.type,
                                /* options */ undefined,
                                (expandedSubtype) => {
                                    if (isInstantiableClass(expandedSubtype)) {
                                        classTypes.push(expandedSubtype);
                                    } else {
                                        isClassType = false;
                                    }
                                    return undefined;
                                }
                            );

                            if (isClassType && classTypes.length > 0) {
                                return (type: Type) => {
                                    return {
                                        type: TypeEvaluatorNarrowing.narrowTypeForTypeIs(
                                            getTypeIsNarrowingContext(evaluator),
                                            type,
                                            classTypes,
                                            adjIsPositiveTest
                                        ),
                                        isIncomplete: !!rhsResult.isIncomplete,
                                    };
                                };
                            }
                        }
                    }
                }
            }

            if (isOrIsNotOperator) {
                if (
                    ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    )
                ) {
                    const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                    const rightType = rightTypeResult.type;

                    // Look for "X is Y" or "X is not Y" where Y is a literal.
                    if (isClassInstance(rightType) && rightType.priv.literalValue !== undefined) {
                        return (type: Type) => {
                            return {
                                type: TypeEvaluatorNarrowing.narrowTypeForLiteralComparison(
                                    getLiteralComparisonContext(evaluator),
                                    type,
                                    rightType,
                                    adjIsPositiveTest,
                                    /* isIsOperator */ true
                                ),
                                isIncomplete: !!rightTypeResult.isIncomplete,
                            };
                        };
                    }

                    // Look for X is <class> or X is not <class>.
                    if (isInstantiableClass(rightType)) {
                        return (type: Type) => {
                            return {
                                type: TypeEvaluatorNarrowing.narrowTypeForClassComparison(
                                    getClassComparisonContext(evaluator),
                                    type,
                                    rightType,
                                    adjIsPositiveTest
                                ),
                                isIncomplete: !!rightTypeResult.isIncomplete,
                            };
                        };
                    }
                }

                // Look for X[<literal>] is <literal> or X[<literal>] is not <literal>.
                if (
                    testExpression.d.leftExpr.nodeType === ParseNodeType.Index &&
                    testExpression.d.leftExpr.d.items.length === 1 &&
                    !testExpression.d.leftExpr.d.trailingComma &&
                    testExpression.d.leftExpr.d.items[0].d.argCategory === ArgCategory.Simple &&
                    ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr.d.leftExpr, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    )
                ) {
                    const indexTypeResult = evaluator.getTypeOfExpression(
                        testExpression.d.leftExpr.d.items[0].d.valueExpr
                    );
                    const indexType = indexTypeResult.type;

                    if (isClassInstance(indexType) && isLiteralType(indexType)) {
                        if (ClassType.isBuiltIn(indexType, 'str')) {
                            const rightType = evaluator.getTypeOfExpression(testExpression.d.rightExpr).type;
                            if (isClassInstance(rightType) && rightType.priv.literalValue !== undefined) {
                                return (type: Type) => {
                                    return {
                                        type: narrowTypeForDiscriminatedDictEntryComparison(
                                            evaluator,
                                            type,
                                            indexType,
                                            rightType,
                                            adjIsPositiveTest
                                        ),
                                        isIncomplete: !!indexTypeResult.isIncomplete,
                                    };
                                };
                            }
                        } else if (ClassType.isBuiltIn(indexType, 'int')) {
                            const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                            const rightType = rightTypeResult.type;

                            if (isClassInstance(rightType) && rightType.priv.literalValue !== undefined) {
                                let canNarrow = false;
                                // Narrowing can be applied only for bool or enum literals.
                                if (ClassType.isBuiltIn(rightType, 'bool')) {
                                    canNarrow = true;
                                } else if (rightType.priv.literalValue instanceof EnumLiteral) {
                                    canNarrow = true;
                                }

                                if (canNarrow) {
                                    return (type: Type) => {
                                        return {
                                            type: narrowTypeForDiscriminatedTupleComparison(
                                                evaluator,
                                                type,
                                                indexType,
                                                rightType,
                                                adjIsPositiveTest
                                            ),
                                            isIncomplete: !!rightTypeResult.isIncomplete,
                                        };
                                    };
                                }
                            }
                        }
                    }
                }
            }

            if (equalsOrNotEqualsOperator) {
                // Look for X == <literal> or X != <literal>
                const adjIsPositiveTest =
                    testExpression.d.operator === OperatorType.Equals ? isPositiveTest : !isPositiveTest;

                if (
                    ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    )
                ) {
                    const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                    const rightType = rightTypeResult.type;

                    if (isClassInstance(rightType) && rightType.priv.literalValue !== undefined) {
                        return (type: Type) => {
                            return {
                                type: TypeEvaluatorNarrowing.narrowTypeForLiteralComparison(
                                    getLiteralComparisonContext(evaluator),
                                    type,
                                    rightType,
                                    adjIsPositiveTest,
                                    /* isIsOperator */ false
                                ),
                                isIncomplete: !!rightTypeResult.isIncomplete,
                            };
                        };
                    }
                }

                // Look for X[<literal>] == <literal> or X[<literal>] != <literal>
                if (
                    testExpression.d.leftExpr.nodeType === ParseNodeType.Index &&
                    testExpression.d.leftExpr.d.items.length === 1 &&
                    !testExpression.d.leftExpr.d.trailingComma &&
                    testExpression.d.leftExpr.d.items[0].d.argCategory === ArgCategory.Simple &&
                    ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr.d.leftExpr, (ref, expr) =>
                        isNameSameScope(evaluator, ref, expr)
                    )
                ) {
                    const indexTypeResult = evaluator.getTypeOfExpression(
                        testExpression.d.leftExpr.d.items[0].d.valueExpr
                    );
                    const indexType = indexTypeResult.type;

                    if (isClassInstance(indexType) && isLiteralType(indexType)) {
                        if (ClassType.isBuiltIn(indexType, ['str', 'int'])) {
                            const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                            const rightType = rightTypeResult.type;

                            if (isLiteralTypeOrUnion(rightType)) {
                                return (type: Type) => {
                                    let narrowedType: Type;

                                    if (ClassType.isBuiltIn(indexType, 'str')) {
                                        narrowedType = narrowTypeForDiscriminatedDictEntryComparison(
                                            evaluator,
                                            type,
                                            indexType,
                                            rightType,
                                            adjIsPositiveTest
                                        );
                                    } else {
                                        narrowedType = narrowTypeForDiscriminatedTupleComparison(
                                            evaluator,
                                            type,
                                            indexType,
                                            rightType,
                                            adjIsPositiveTest
                                        );
                                    }

                                    return {
                                        type: narrowedType,
                                        isIncomplete: !!indexTypeResult.isIncomplete || !!rightTypeResult.isIncomplete,
                                    };
                                };
                            }
                        }
                    }
                }
            }

            // Look for X.Y == <literal> or X.Y != <literal>
            if (
                equalsOrNotEqualsOperator &&
                testExpression.d.leftExpr.nodeType === ParseNodeType.MemberAccess &&
                ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr.d.leftExpr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                const rightType = rightTypeResult.type;
                const memberName = testExpression.d.leftExpr.d.member;

                if (isClassInstance(rightType)) {
                    if (rightType.priv.literalValue !== undefined || isNoneInstance(rightType)) {
                        return (type: Type) => {
                            return {
                                type: narrowTypeForDiscriminatedLiteralFieldComparison(
                                    evaluator,
                                    type,
                                    memberName.d.value,
                                    rightType,
                                    adjIsPositiveTest
                                ),
                                isIncomplete: !!rightTypeResult.isIncomplete,
                            };
                        };
                    }
                }
            }

            // Look for X.Y is <literal> or X.Y is not <literal> where <literal> is
            // an enum or bool literal
            if (
                testExpression.d.leftExpr.nodeType === ParseNodeType.MemberAccess &&
                ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr.d.leftExpr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                const rightType = rightTypeResult.type;
                const memberName = testExpression.d.leftExpr.d.member;

                if (
                    isClassInstance(rightType) &&
                    (ClassType.isEnumClass(rightType) || ClassType.isBuiltIn(rightType, 'bool')) &&
                    rightType.priv.literalValue !== undefined
                ) {
                    return (type: Type) => {
                        return {
                            type: narrowTypeForDiscriminatedLiteralFieldComparison(
                                evaluator,
                                type,
                                memberName.d.value,
                                rightType,
                                adjIsPositiveTest
                            ),
                            isIncomplete: !!rightTypeResult.isIncomplete,
                        };
                    };
                }
            }

            // Look for X.Y is None or X.Y is not None
            // These are commonly-used patterns used in control flow.
            if (
                testExpression.d.leftExpr.nodeType === ParseNodeType.MemberAccess &&
                ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr.d.leftExpr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                ) &&
                testExpression.d.rightExpr.nodeType === ParseNodeType.Constant &&
                testExpression.d.rightExpr.d.constType === KeywordType.None
            ) {
                const memberName = testExpression.d.leftExpr.d.member;
                return (type: Type) => {
                    return {
                        type: narrowTypeForDiscriminatedFieldNoneComparison(
                            evaluator,
                            type,
                            memberName.d.value,
                            adjIsPositiveTest
                        ),
                        isIncomplete: false,
                    };
                };
            }
        }

        // Look for len(x) == <literal>, len(x) != <literal>, len(x) < <literal>, etc.
        if (
            comparisonOperator &&
            testExpression.d.leftExpr.nodeType === ParseNodeType.Call &&
            testExpression.d.leftExpr.d.args.length === 1
        ) {
            const arg0Expr = testExpression.d.leftExpr.d.args[0].d.valueExpr;

            if (
                ParseTreeUtils.isMatchingExpression(reference, arg0Expr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                const callTypeResult = evaluator.getTypeOfExpression(
                    testExpression.d.leftExpr.d.leftExpr,
                    EvalFlags.CallBaseDefaults
                );
                const callType = callTypeResult.type;

                if (isFunction(callType) && callType.shared.fullName === 'builtins.len') {
                    const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                    const rightType = rightTypeResult.type;

                    if (
                        isClassInstance(rightType) &&
                        typeof rightType.priv.literalValue === 'number' &&
                        rightType.priv.literalValue >= 0
                    ) {
                        let tupleLength = rightType.priv.literalValue;

                        // We'll treat <, <= and == as positive tests with >=, > and != as
                        // their negative counterparts.
                        const isLessOrEqual =
                            testExpression.d.operator === OperatorType.Equals ||
                            testExpression.d.operator === OperatorType.LessThan ||
                            testExpression.d.operator === OperatorType.LessThanOrEqual;

                        const adjIsPositiveTest = isLessOrEqual ? isPositiveTest : !isPositiveTest;

                        // For <= (or its negative counterpart >), adjust the tuple length by 1.
                        if (
                            testExpression.d.operator === OperatorType.LessThanOrEqual ||
                            testExpression.d.operator === OperatorType.GreaterThan
                        ) {
                            tupleLength++;
                        }

                        const isEqualityCheck =
                            testExpression.d.operator === OperatorType.Equals ||
                            testExpression.d.operator === OperatorType.NotEquals;

                        return (type: Type) => {
                            return {
                                type: narrowTypeForTupleLength(
                                    evaluator,
                                    type,
                                    tupleLength,
                                    adjIsPositiveTest,
                                    !isEqualityCheck
                                ),
                                isIncomplete: !!callTypeResult.isIncomplete || !!rightTypeResult.isIncomplete,
                            };
                        };
                    }
                }
            }
        }

        if (testExpression.d.operator === OperatorType.In || testExpression.d.operator === OperatorType.NotIn) {
            // Look for "x in y" or "x not in y" where y is one of several built-in types.
            if (
                ParseTreeUtils.isMatchingExpression(reference, testExpression.d.leftExpr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                const rightTypeResult = evaluator.getTypeOfExpression(testExpression.d.rightExpr);
                const rightType = rightTypeResult.type;
                const adjIsPositiveTest =
                    testExpression.d.operator === OperatorType.In ? isPositiveTest : !isPositiveTest;

                return (type: Type) => {
                    return {
                        type: narrowTypeForContainerType(evaluator, type, rightType, adjIsPositiveTest),
                        isIncomplete: !!rightTypeResult.isIncomplete,
                    };
                };
            }

            if (
                ParseTreeUtils.isMatchingExpression(reference, testExpression.d.rightExpr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                // Look for <string literal> in y where y is a union that contains
                // one or more TypedDicts.
                const leftTypeResult = evaluator.getTypeOfExpression(testExpression.d.leftExpr);
                const leftType = leftTypeResult.type;

                if (isClassInstance(leftType) && ClassType.isBuiltIn(leftType, 'str') && isLiteralType(leftType)) {
                    const adjIsPositiveTest =
                        testExpression.d.operator === OperatorType.In ? isPositiveTest : !isPositiveTest;
                    return (type: Type) => {
                        return {
                            type: narrowTypeForTypedDictKey(
                                evaluator,
                                type,
                                ClassType.cloneAsInstantiable(leftType),
                                adjIsPositiveTest
                            ),
                            isIncomplete: !!leftTypeResult.isIncomplete,
                        };
                    };
                }
            }
        }
    }

    if (testExpression.nodeType === ParseNodeType.Call) {
        // Look for "isinstance(X, Y)" or "issubclass(X, Y)".
        if (testExpression.d.args.length === 2) {
            // Make sure the first parameter is a supported expression type
            // and the second parameter is a valid class type or a tuple
            // of valid class types.
            const arg0Expr = testExpression.d.args[0].d.valueExpr;
            const arg1Expr = testExpression.d.args[1].d.valueExpr;

            if (
                ParseTreeUtils.isMatchingExpression(reference, arg0Expr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                const callTypeResult = evaluator.getTypeOfExpression(
                    testExpression.d.leftExpr,
                    EvalFlags.CallBaseDefaults
                );
                const callType = callTypeResult.type;

                if (isFunction(callType) && FunctionType.isBuiltIn(callType, ['isinstance', 'issubclass'])) {
                    const isInstanceCheck = FunctionType.isBuiltIn(callType, 'isinstance');
                    const arg1TypeResult = evaluator.getTypeOfExpression(arg1Expr, EvalFlags.IsInstanceArgDefaults);
                    const arg1Type = arg1TypeResult.type;

                    const classTypeList = getIsInstanceClassTypes(evaluator, arg1Type);
                    const isIncomplete = !!callTypeResult.isIncomplete || !!arg1TypeResult.isIncomplete;

                    if (classTypeList) {
                        return (type: Type) => {
                            return {
                                type: narrowTypeForInstanceOrSubclass(
                                    evaluator,
                                    type,
                                    classTypeList,
                                    isInstanceCheck,
                                    /* isTypeIsCheck */ false,
                                    isPositiveTest,
                                    testExpression
                                ),
                                isIncomplete,
                            };
                        };
                    } else if (isIncomplete) {
                        // If the type is incomplete, it may include unknowns, which will result
                        // in classTypeList being undefined.
                        return (type: Type) => {
                            return {
                                type,
                                isIncomplete: true,
                            };
                        };
                    }
                }
            }
        }

        // Look for "bool(X)"
        if (testExpression.d.args.length === 1 && !testExpression.d.args[0].d.name) {
            if (
                ParseTreeUtils.isMatchingExpression(reference, testExpression.d.args[0].d.valueExpr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                const callTypeResult = evaluator.getTypeOfExpression(
                    testExpression.d.leftExpr,
                    EvalFlags.CallBaseDefaults
                );
                const callType = callTypeResult.type;

                if (isInstantiableClass(callType) && ClassType.isBuiltIn(callType, 'bool')) {
                    return (type: Type) => {
                        return {
                            type: narrowTypeForTruthiness(evaluator, type, isPositiveTest),
                            isIncomplete: !!callTypeResult.isIncomplete,
                        };
                    };
                }
            }
        }

        // Look for a TypeGuard function.
        if (testExpression.d.args.length >= 1) {
            const arg0Expr = testExpression.d.args[0].d.valueExpr;
            if (
                ParseTreeUtils.isMatchingExpression(reference, arg0Expr, (ref, expr) =>
                    isNameSameScope(evaluator, ref, expr)
                )
            ) {
                // Does this look like it's a custom type guard function?
                let isPossiblyTypeGuard = false;

                const isFunctionReturnTypeGuard = (type: FunctionType) => {
                    return (
                        type.shared.declaredReturnType &&
                        isClassInstance(type.shared.declaredReturnType) &&
                        ClassType.isBuiltIn(type.shared.declaredReturnType, ['TypeGuard', 'TypeIs'])
                    );
                };

                const callTypeResult = evaluator.getTypeOfExpression(
                    testExpression.d.leftExpr,
                    EvalFlags.CallBaseDefaults
                );
                const callType = callTypeResult.type;

                if (isFunction(callType) && isFunctionReturnTypeGuard(callType)) {
                    isPossiblyTypeGuard = true;
                } else if (
                    isOverloaded(callType) &&
                    OverloadedType.getOverloads(callType).some((o) => isFunctionReturnTypeGuard(o))
                ) {
                    isPossiblyTypeGuard = true;
                } else if (isClassInstance(callType)) {
                    isPossiblyTypeGuard = true;
                }

                if (isPossiblyTypeGuard) {
                    // Evaluate the type guard call expression.
                    const functionReturnTypeResult = evaluator.getTypeOfExpression(testExpression);
                    const functionReturnType = functionReturnTypeResult.type;

                    if (
                        isClassInstance(functionReturnType) &&
                        ClassType.isBuiltIn(functionReturnType, ['TypeGuard', 'TypeIs']) &&
                        functionReturnType.priv.typeArgs &&
                        functionReturnType.priv.typeArgs.length > 0
                    ) {
                        const isStrictTypeGuard = ClassType.isBuiltIn(functionReturnType, 'TypeIs');
                        const typeGuardType = functionReturnType.priv.typeArgs[0];
                        const isIncomplete = !!callTypeResult.isIncomplete || !!functionReturnTypeResult.isIncomplete;

                        return (type: Type) => {
                            return {
                                type: narrowTypeForUserDefinedTypeGuard(
                                    evaluator,
                                    type,
                                    typeGuardType,
                                    isPositiveTest,
                                    isStrictTypeGuard,
                                    testExpression
                                ),
                                isIncomplete,
                            };
                        };
                    }
                }
            }
        }
    }

    if (
        ParseTreeUtils.isMatchingExpression(reference, testExpression, (ref, expr) =>
            isNameSameScope(evaluator, ref, expr)
        )
    ) {
        return (type: Type) => {
            return {
                type: narrowTypeForTruthiness(evaluator, type, isPositiveTest),
                isIncomplete: false,
            };
        };
    }

    // Is this a reference to an aliased conditional expression (a local variable
    // that was assigned a value that can inform type narrowing of the reference expression)?
    const narrowingCallback = getTypeNarrowingCallbackForAliasedCondition(
        evaluator,
        reference,
        testExpression,
        isPositiveTest,
        recursionCount
    );
    if (narrowingCallback) {
        return narrowingCallback;
    }

    // We normally won't find a "not" operator here because they are stripped out
    // by the binder when it creates condition flow nodes, but we can find this
    // in the case of local variables type narrowing.
    if (reference.nodeType === ParseNodeType.Name) {
        if (
            testExpression.nodeType === ParseNodeType.UnaryOperation &&
            testExpression.d.operator === OperatorType.Not
        ) {
            return getTypeNarrowingCallback(
                evaluator,
                reference,
                testExpression.d.expr,
                !isPositiveTest,
                recursionCount
            );
        }
    }

    return undefined;
}

function getTypeNarrowingCallbackForAliasedCondition(
    evaluator: TypeEvaluator,
    reference: ExpressionNode,
    testExpression: ExpressionNode,
    isPositiveTest: boolean,
    recursionCount: number
) {
    if (
        testExpression.nodeType !== ParseNodeType.Name ||
        reference.nodeType !== ParseNodeType.Name ||
        testExpression === reference
    ) {
        return undefined;
    }

    // Make sure the reference expression is a constant parameter or variable.
    // If the reference expression is modified within the scope multiple times,
    // we need to validate that it is not modified between the test expression
    // evaluation and the conditional check.
    const testExprDecl = getDeclsForLocalVar(evaluator, testExpression, testExpression, /* requireUnique */ true);
    if (!testExprDecl || testExprDecl.length !== 1 || testExprDecl[0].type !== DeclarationType.Variable) {
        return undefined;
    }

    const referenceDecls = getDeclsForLocalVar(evaluator, reference, testExpression, /* requireUnique */ false);
    if (!referenceDecls) {
        return undefined;
    }

    let modifyingDecls: Declaration[] = [];
    if (referenceDecls.length > 1) {
        // If there is more than one assignment to the reference variable within
        // the local scope, make sure that none of these assignments are done
        // after the test expression but before the condition check.
        //
        // This is OK:
        //  val = None
        //  is_none = val is None
        //  if is_none: ...
        //
        // This is not OK:
        //  val = None
        //  is_none = val is None
        //  val = 1
        //  if is_none: ...
        modifyingDecls = referenceDecls.filter((decl) => {
            return (
                evaluator.isNodeReachable(testExpression, decl.node) &&
                evaluator.isNodeReachable(decl.node, testExprDecl[0].node)
            );
        });
    }

    if (modifyingDecls.length !== 0) {
        return undefined;
    }

    const initNode = testExprDecl[0].inferredTypeSource;

    if (!initNode || ParseTreeUtils.isNodeContainedWithin(testExpression, initNode) || !isExpressionNode(initNode)) {
        return undefined;
    }

    return getTypeNarrowingCallback(evaluator, reference, initNode, isPositiveTest, recursionCount);
}

// Determines whether the symbol is a local variable or parameter within
// the current scope. If requireUnique is true, there can be only one
// declaration (assignment) of the symbol, otherwise it is rejected.
function getDeclsForLocalVar(
    evaluator: TypeEvaluator,
    name: NameNode,
    reachableFrom: ParseNode,
    requireUnique: boolean
): Declaration[] | undefined {
    const scope = getScopeForNode(name);
    if (scope?.type !== ScopeType.Function && scope?.type !== ScopeType.Module) {
        return undefined;
    }

    const symbol = scope.lookUpSymbol(name.d.value);
    if (!symbol) {
        return undefined;
    }

    const decls = symbol.getDeclarations();
    if (requireUnique && decls.length > 1) {
        return undefined;
    }

    if (
        decls.length === 0 ||
        decls.some((decl) => decl.type !== DeclarationType.Variable && decl.type !== DeclarationType.Param)
    ) {
        return undefined;
    }

    // If there are any assignments within different scopes (e.g. via a "global" or
    // "nonlocal" reference), don't consider it a local variable.
    let prevDeclScope: ParseNode | undefined;
    if (
        decls.some((decl) => {
            const nodeToConsider = decl.type === DeclarationType.Param ? decl.node.d.name! : decl.node;
            const declScopeNode = ParseTreeUtils.getExecutionScopeNode(nodeToConsider);
            if (prevDeclScope && declScopeNode !== prevDeclScope) {
                return true;
            }
            prevDeclScope = declScopeNode;
            return false;
        })
    ) {
        return undefined;
    }

    const reachableDecls = decls.filter((decl) => evaluator.isNodeReachable(reachableFrom, decl.node));

    return reachableDecls.length > 0 ? reachableDecls : undefined;
}

function getTypeNarrowingCallbackForAssignmentExpression(
    evaluator: TypeEvaluator,
    reference: ExpressionNode,
    testExpression: AssignmentExpressionNode,
    isPositiveTest: boolean,
    recursionCount: number
) {
    return (
        getTypeNarrowingCallback(evaluator, reference, testExpression.d.rightExpr, isPositiveTest, recursionCount) ??
        getTypeNarrowingCallback(evaluator, reference, testExpression.d.name, isPositiveTest, recursionCount)
    );
}

function narrowTypeForUserDefinedTypeGuard(
    evaluator: TypeEvaluator,
    type: Type,
    typeGuardType: Type,
    isPositiveTest: boolean,
    isStrictTypeGuard: boolean,
    errorNode: ExpressionNode
): Type {
    return TypeEvaluatorNarrowing.narrowTypeForUserDefinedTypeGuard(
        getIsInstanceNarrowingContext(evaluator),
        type,
        typeGuardType,
        isPositiveTest,
        isStrictTypeGuard,
        errorNode
    );
}

// Narrow the type based on whether the subtype can be true or false.
function narrowTypeForTruthiness(evaluator: TypeEvaluator, type: Type, isPositiveTest: boolean) {
    return TypeEvaluatorNarrowing.narrowTypeForTruthiness(
        getTruthinessNarrowingContext(evaluator),
        type,
        isPositiveTest
    );
}

// The "isinstance" and "issubclass" calls support two forms - a simple form
// that accepts a single class, and a more complex form that accepts a tuple
// of classes (including arbitrarily-nested tuples). This method determines
// which form and returns a list of classes or undefined.
export function getIsInstanceClassTypes(
    evaluator: TypeEvaluator,
    argType: Type
): (ClassType | TypeVarType | FunctionType)[] | undefined {
    return TypeEvaluatorNarrowing.getIsInstanceClassTypes(getIsInstanceClassTypeContext(evaluator), argType);
}

export function narrowTypeForInstanceOrSubclass(
    evaluator: TypeEvaluator,
    type: Type,
    filterTypes: Type[],
    isInstanceCheck: boolean,
    isTypeIsCheck: boolean,
    isPositiveTest: boolean,
    errorNode: ExpressionNode
) {
    return TypeEvaluatorNarrowing.narrowTypeForInstanceOrSubclass(
        getIsInstanceNarrowingContext(evaluator),
        type,
        filterTypes,
        isInstanceCheck,
        isTypeIsCheck,
        isPositiveTest,
        errorNode
    );
}

// Attempts to narrow a union of tuples based on their known length.
function narrowTypeForTupleLength(
    evaluator: TypeEvaluator,
    referenceType: Type,
    lengthValue: number,
    isPositiveTest: boolean,
    isLessThanCheck: boolean
) {
    return TypeEvaluatorNarrowing.narrowTypeForTupleLength(
        getTupleLengthNarrowingContext(evaluator),
        referenceType,
        lengthValue,
        isPositiveTest,
        isLessThanCheck
    );
}

// Attempts to narrow a type (make it more constrained) based on an "in" binary operator.
function narrowTypeForContainerType(
    evaluator: TypeEvaluator,
    referenceType: Type,
    containerType: Type,
    isPositiveTest: boolean
) {
    return TypeEvaluatorNarrowing.narrowTypeForContainerType(
        getContainerNarrowingContext(evaluator),
        referenceType,
        containerType,
        isPositiveTest
    );
}

export function getElementTypeForContainerNarrowing(containerType: Type) {
    return TypeEvaluatorNarrowing.getElementTypeForContainerNarrowing(containerType);
}

export function narrowTypeForContainerElementType(evaluator: TypeEvaluator, referenceType: Type, elementType: Type) {
    return TypeEvaluatorNarrowing.narrowTypeForContainerElementType(
        getContainerNarrowingContext(evaluator),
        referenceType,
        elementType
    );
}

// Attempts to narrow a type based on whether it is a TypedDict with
// a literal key value.
function narrowTypeForTypedDictKey(
    evaluator: TypeEvaluator,
    referenceType: Type,
    literalKey: ClassType,
    isPositiveTest: boolean
): Type {
    return TypeEvaluatorNarrowing.narrowTypeForTypedDictKey(
        getTypedDictKeyNarrowingContext(evaluator),
        referenceType,
        literalKey,
        isPositiveTest
    );
}

// Attempts to narrow a TypedDict type based on a comparison (equal or not
// equal) between a discriminating entry type that has a declared literal
// type to a literal value.
export function narrowTypeForDiscriminatedDictEntryComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    indexLiteralType: ClassType,
    literalType: Type,
    isPositiveTest: boolean
): Type {
    return TypeEvaluatorNarrowing.narrowTypeForDiscriminatedDictEntryComparison(
        getDiscriminatedDictEntryContext(evaluator),
        referenceType,
        indexLiteralType,
        literalType,
        isPositiveTest
    );
}

export function narrowTypeForDiscriminatedTupleComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    indexLiteralType: ClassType,
    literalType: Type,
    isPositiveTest: boolean
): Type {
    return TypeEvaluatorNarrowing.narrowTypeForDiscriminatedTupleComparison(
        getDiscriminatedTupleContext(evaluator),
        referenceType,
        indexLiteralType,
        literalType,
        isPositiveTest
    );
}

// Attempts to narrow a type based on a comparison (equal or not equal)
// between a discriminating field that has a declared literal type to a
// literal value.
export function narrowTypeForDiscriminatedLiteralFieldComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    memberName: string,
    literalType: ClassType,
    isPositiveTest: boolean
): Type {
    return TypeEvaluatorNarrowing.narrowTypeForDiscriminatedLiteralFieldComparison(
        getDiscriminatedLiteralFieldContext(evaluator),
        referenceType,
        memberName,
        literalType,
        isPositiveTest
    );
}

// Attempts to narrow a type based on a comparison (equal or not equal)
// between a discriminating field that has a declared None type to a
// None.
function narrowTypeForDiscriminatedFieldNoneComparison(
    evaluator: TypeEvaluator,
    referenceType: Type,
    memberName: string,
    isPositiveTest: boolean
): Type {
    return TypeEvaluatorNarrowing.narrowTypeForDiscriminatedFieldNoneComparison(
        getDiscriminatedFieldNoneContext(evaluator),
        referenceType,
        memberName,
        isPositiveTest
    );
}

export function enumerateLiteralsForType(evaluator: TypeEvaluator, type: ClassType): ClassType[] | undefined {
    return TypeEvaluatorNarrowing.enumerateLiteralsForType(getEnumerateLiteralsContext(evaluator), type);
}

// Determines whether the expression name node is in the same scope or
// an outer scope from the reference name node. This allows isMatchingExpression
// to determine whether two name nodes are referring to the same symbol.
function isNameSameScope(evaluator: TypeEvaluator, reference: NameNode, expression: NameNode): boolean {
    const refSymbol = evaluator.lookUpSymbolRecursive(reference, reference.d.value, /* honorCodeFlow */ false);
    const exprSymbol = evaluator.lookUpSymbolRecursive(expression, expression.d.value, /* honorCodeFlow */ false);

    if (!refSymbol || !exprSymbol) {
        // This shouldn't happen, but just to be safe...
        return true;
    }

    const refScope = refSymbol.scope;
    const exprScope = exprSymbol.scope;

    if (refScope === exprScope) {
        return true;
    }

    return isScopeContainedWithin(refScope, exprScope);
}

/*
 * narrowing.ts
 *
 * This file is a scaffolding layer for type narrowing operations.
 *
 * In Pyright, narrowing is implemented across multiple layers:
 * - `codeFlowEngine.ts` performs flow-sensitive analysis and applies narrowing as it
 *   walks backward through the flow graph.
 * - `typeGuards.ts` implements reusable narrowing operations like `isinstance`-style
 *   filters and type-guard handling.
 * - `typeEvaluator.ts` provides evaluator-specific glue (e.g., looking up symbols,
 *   resolving expressions, emitting diagnostics).
 *
 * This module is intentionally light on concrete logic for now. It provides a
 * documented "shape" for future extraction and a place to explain how narrowing
 * would conceptually work.
 */

import { ExpressionNode } from '../../parser/parseNodes';
import { TypeEvaluator, TypeResult } from '../typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    combineTypes,
    EnumLiteral,
    findSubtype,
    isAny,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunctionOrOverloaded,
    isInstantiableClass,
    isNever,
    isTypeSame,
    isTypeVar,
    isUnion,
    isUnknown,
    SentinelLiteral,
    Type,
    TypeBase,
    TypeCategory,
    TypedDictEntries,
    TypeVarType,
    UnionType,
    UnknownType,
} from '../types';
import {
    addConditionToType,
    convertToInstance,
    convertToInstantiable,
    getSpecializedTupleType,
    getTypeCondition,
    isIncompleteUnknown,
    isLiteralType,
    isNoneInstance,
    isSentinelLiteral,
    isTupleClass,
    isUnboundedTupleClass,
    mapSubtypes,
    transformPossibleRecursiveTypeAlias,
} from '../typeUtils';

export interface NarrowingContext {
    evaluator: TypeEvaluator;
}

export interface NarrowForConditionOptions {
    isPositiveTest: boolean;
}

export interface NarrowTypeBasedOnAssignmentContext {
    // This is intentionally a small surface area: the evaluator owns assignability
    // rules (and recursion limits, diag addenda, etc.) and passes a minimal adapter.
    assignType: (destType: Type, srcType: Type) => boolean;
}

export interface StripTypeGuardContext {
    getBoolType: () => Type;
}

export interface StripLiteralValueContext {
    // Returns an instance type for `str` used when lowering `LiteralString`.
    // If undefined, `LiteralString` is left as-is.
    getStrInstanceTypeForLiteralString: () => Type | undefined;
}

export interface TruthinessContext {
    maxTypeRecursionCount: number;
    makeTopLevelTypeVarsConcrete: (type: Type) => Type;
    getTypedDictMembersForClass: (type: ClassType, allowNarrowed: boolean) => TypedDictEntries | undefined;
    lookUpObjectMember: (type: ClassType, memberName: string) => any;
    getTypeOfMember: (member: any) => Type;
}

export interface TruthinessNarrowingContext {
    canBeTruthy: (type: Type) => boolean;
    canBeFalsy: (type: Type) => boolean;
    removeFalsinessFromType: (type: Type) => Type;
    removeTruthinessFromType: (type: Type) => Type;
}

export interface IsNoneNarrowingContext {
    assignType: (destType: Type, srcType: Type) => boolean;
    getNoneType: () => Type;
    makeTopLevelTypeVarsConcrete: (type: Type) => Type;
    mapSubtypesExpandTypeVars: (
        type: Type,
        callback: (subtype: Type, unexpandedSubtype: Type) => Type | undefined
    ) => Type;
}

export interface IsEllipsisNarrowingContext {
    assignType: (destType: Type, srcType: Type) => boolean;
    getBuiltInObject: (node: ExpressionNode, className: string) => Type | undefined;
    mapSubtypesExpandTypeVars: (
        type: Type,
        callback: (subtype: Type, unexpandedSubtype: Type) => Type | undefined
    ) => Type;
}

export interface ClassComparisonContext {
    makeTopLevelTypeVarsConcrete: (type: Type) => Type;
}

export interface LiteralComparisonContext {
    assignType: (destType: Type, srcType: Type) => boolean;
    enumerateLiteralsForType: (type: ClassType) => ClassType[] | undefined;
    makeTopLevelTypeVarsConcrete: (type: Type) => Type;
    mapSubtypesExpandTypeVars: (type: Type, callback: (subtype: Type) => Type | undefined) => Type;
}

// Conceptual narrowing entrypoint.
//
// A real implementation typically:
// 1. Determines the "reference" being tested (name/member/index expression).
// 2. Classifies the condition shape:
//    - truthiness (`if x:`)
//    - isinstance / issubclass (`if isinstance(x, T):`)
//    - equality / identity (`if x is None:`, `if x == 3:`)
//    - type guard / type is (PEP 647 / PEP 742)
// 3. Computes a narrowed type, usually by filtering union subtypes.
// 4. Hands the narrowing callback to the code-flow engine so it is applied at
//    the correct program point.
//
// This scaffolding function currently returns the input type unchanged and is
// meant as a documentation anchor. Future refactors will move real narrowing
// glue here (while delegating reusable narrowing transforms to `typeGuards.ts`).
export function narrowTypeForCondition(
    ctx: NarrowingContext,
    originalType: Type,
    _conditionNode: ExpressionNode,
    _options: NarrowForConditionOptions
): Type {
    // Placeholder logic:
    // - If the condition is a truthiness check and the test is positive, remove
    //   definitely-falsy members from the union.
    // - If the test is negative, remove definitely-truthy members.
    //
    // - For `isinstance(x, T)`, intersect `type(x)` with `T`.
    // - For `x is None`, remove `None` (positive/negative affects which side).
    // - For `x == Literal`, keep only subtypes compatible with that literal.
    //
    // Implementing this correctly requires evaluator services (expression analysis,
    // symbol resolution, and flow graph integration), which will be extracted in
    // later slices.
    void ctx;
    return originalType;
}

// When a value is assigned to a variable with a declared type,
// we may be able to narrow the type based on the assignment.
//
// NOTE: This logic intentionally mirrors the evaluator's historical behavior.
// The typing spec does not currently define assignment-based narrowing rules.
export function narrowTypeBasedOnAssignment(
    ctx: NarrowTypeBasedOnAssignmentContext,
    declaredType: Type,
    assignedTypeResult: TypeResult
): TypeResult {
    // TODO: The rules for narrowing types on assignment are not defined in
    // the typing spec. Pyright's current logic is currently not even internally
    // consistent and probably not sound from a type theory perspective. It
    // should be completely reworked once there has been a public discussion
    // about the correct behavior.

    const narrowedType = mapSubtypes(assignedTypeResult.type, (assignedSubtype) => {
        // Handle the special case where the assigned type is a literal type.
        // Some types include very large unions of literal types, and we don't
        // want to use an n^2 loop to compare them.
        if (isClass(assignedSubtype) && isLiteralType(assignedSubtype)) {
            if (isUnion(declaredType) && UnionType.containsType(declaredType, assignedSubtype)) {
                return assignedSubtype;
            }
        }

        const narrowedSubtype = mapSubtypes(declaredType, (declaredSubtype) => {
            if (!ctx.assignType(declaredSubtype, assignedSubtype)) {
                return undefined;
            }

            // Retain unknowns for code flow analysis convergence and for
            // unknown type reporting in strict mode.
            if (isUnknown(assignedSubtype)) {
                return assignedSubtype;
            }

            // If the two types are bidirectionally assignable, they are
            // either equivalent (in which case it doesn't matter which
            // one we choose) or one or both include gradual types (Any, etc.),
            // in which case we'll want to stick with the declared subtype.
            if (ctx.assignType(assignedSubtype, declaredSubtype)) {
                // We need to be careful with TypedDict types that have
                // narrowed fields. In this case, we want to return the
                // assigned type.
                if (
                    isClass(assignedSubtype) &&
                    assignedSubtype.priv.typedDictNarrowedEntries &&
                    isTypeSame(assignedSubtype, declaredSubtype, { ignoreTypedDictNarrowEntries: true })
                ) {
                    return assignedSubtype;
                }

                // We also need to be careful with callback protocols.
                if (isClassInstance(declaredSubtype) && ClassType.isProtocolClass(declaredSubtype)) {
                    if (isFunctionOrOverloaded(assignedSubtype)) {
                        return assignedSubtype;
                    }
                }

                return declaredSubtype;
            }

            return assignedSubtype;
        });

        // If we couldn't assign the assigned subtype any of the declared
        // subtypes, the types are incompatible. Return the unnarrowed form.
        if (isNever(narrowedSubtype)) {
            return assignedSubtype;
        }

        return narrowedSubtype;
    });

    // If the result of narrowing is an Unknown that is incomplete, propagate the
    // incomplete type for the benefit of code flow analysis.
    // If the result of narrowing is a complete Unknown, combine the Unknown type
    // with the declared type. In strict mode, this will retain the "unknown type"
    // diagnostics while still providing reasonable completion suggestions.
    if (isIncompleteUnknown(narrowedType)) {
        return { type: narrowedType, isIncomplete: assignedTypeResult.isIncomplete };
    } else if (isUnknown(narrowedType)) {
        return { type: combineTypes([narrowedType, declaredType]), isIncomplete: assignedTypeResult.isIncomplete };
    }

    return { type: narrowedType, isIncomplete: assignedTypeResult.isIncomplete };
}

export function stripTypeGuard(ctx: StripTypeGuardContext, type: Type): Type {
    return mapSubtypes(type, (subtype) => {
        if (isClassInstance(subtype) && ClassType.isBuiltIn(subtype, ['TypeGuard', 'TypeIs'])) {
            return ctx.getBoolType();
        }

        return subtype;
    });
}

export function stripLiteralValue(ctx: StripLiteralValueContext, type: Type): Type {
    // Handle the not-uncommon case where the type is a union that consists
    // only of literal values.
    if (isUnion(type) && type.priv.subtypes.length > 0) {
        if (
            type.priv.literalInstances.literalStrMap?.size === type.priv.subtypes.length ||
            type.priv.literalInstances.literalIntMap?.size === type.priv.subtypes.length ||
            type.priv.literalInstances.literalEnumMap?.size === type.priv.subtypes.length
        ) {
            return stripLiteralValue(ctx, type.priv.subtypes[0]);
        }
    }

    return mapSubtypes(type, (subtype) => {
        if (isClass(subtype)) {
            if (subtype.priv.literalValue !== undefined) {
                subtype = ClassType.cloneWithLiteral(subtype, /* value */ undefined);
            }

            if (ClassType.isBuiltIn(subtype, 'LiteralString')) {
                // Handle "LiteralString" specially.
                const strInstance = ctx.getStrInstanceTypeForLiteralString();
                if (strInstance && isClass(strInstance)) {
                    return TypeBase.cloneForCondition(strInstance, getTypeCondition(subtype));
                }
            }
        }

        return subtype;
    });
}

export function canBeFalsy(ctx: TruthinessContext, type: Type, recursionCount = 0): boolean {
    type = ctx.makeTopLevelTypeVarsConcrete(type);

    if (recursionCount > ctx.maxTypeRecursionCount) {
        return true;
    }
    recursionCount++;

    switch (type.category) {
        case TypeCategory.Unbound:
        case TypeCategory.Unknown:
        case TypeCategory.Any:
        case TypeCategory.Never: {
            return true;
        }

        case TypeCategory.Union: {
            return findSubtype(type, (subtype: Type) => canBeFalsy(ctx, subtype, recursionCount)) !== undefined;
        }

        case TypeCategory.Function:
        case TypeCategory.Overloaded:
        case TypeCategory.Module:
        case TypeCategory.TypeVar: {
            return false;
        }

        case TypeCategory.Class: {
            if (TypeBase.isInstantiable(type)) {
                return false;
            }

            // Sentinels are always truthy.
            if (isSentinelLiteral(type)) {
                return false;
            }

            // Handle tuples specially.
            if (isTupleClass(type) && type.priv.tupleTypeArgs) {
                return isUnboundedTupleClass(type) || type.priv.tupleTypeArgs.length === 0;
            }

            // Handle subclasses of tuple, such as NamedTuple.
            const tupleBaseClass = type.shared.mro.find((mroClass) => !isClass(mroClass) || isTupleClass(mroClass));
            if (tupleBaseClass && isClass(tupleBaseClass) && tupleBaseClass.priv.tupleTypeArgs) {
                return isUnboundedTupleClass(tupleBaseClass) || tupleBaseClass.priv.tupleTypeArgs.length === 0;
            }

            // Handle TypedDicts specially. If one or more entries are required
            // or known to exist, we can say for sure that the type is not falsy.
            if (ClassType.isTypedDictClass(type)) {
                const tdEntries = ctx.getTypedDictMembersForClass(type, /* allowNarrowed */ true);
                if (tdEntries) {
                    for (const tdEntry of tdEntries.knownItems.values()) {
                        if (tdEntry.isRequired || tdEntry.isProvided) {
                            return false;
                        }
                    }
                }
            }

            // Check for bool, int, str and bytes literals that are never falsy.
            if (type.priv.literalValue !== undefined) {
                if (ClassType.isBuiltIn(type, ['bool', 'int', 'str', 'bytes'])) {
                    return !type.priv.literalValue || type.priv.literalValue === BigInt(0);
                }

                if (type.priv.literalValue instanceof EnumLiteral) {
                    // Does the Enum class forward the truthiness check to the underlying member type?
                    if (type.priv.literalValue.isReprEnum) {
                        return canBeFalsy(ctx, type.priv.literalValue.itemType, recursionCount);
                    }
                }
            }

            // If this is a protocol class, don't make any assumptions about the absence
            // of specific methods. These could be provided by a class that conforms
            // to the protocol.
            if (ClassType.isProtocolClass(type)) {
                return true;
            }

            const lenMethod = ctx.lookUpObjectMember(type, '__len__');
            if (lenMethod) {
                return true;
            }

            const boolMethod = ctx.lookUpObjectMember(type, '__bool__');
            if (boolMethod) {
                const boolMethodType = ctx.getTypeOfMember(boolMethod);

                // If the __bool__ function unconditionally returns True, it can never be falsy.
                if (isFunctionOrOverloaded(boolMethodType) && (boolMethodType as any).shared?.declaredReturnType) {
                    const returnType = (boolMethodType as any).shared.declaredReturnType;
                    if (
                        isClassInstance(returnType) &&
                        ClassType.isBuiltIn(returnType, 'bool') &&
                        returnType.priv.literalValue === true
                    ) {
                        return false;
                    }
                }

                return true;
            }

            // If the class is not final, it's possible that it could be overridden
            // such that it is falsy. To be fully correct, we'd need to do the
            // following:
            // return !ClassType.isFinal(type);
            // However, pragmatically if the class is not an `object`, it's typically
            // OK to assume that it will not be overridden in this manner.
            return ClassType.isBuiltIn(type, 'object');
        }
    }
}

export function canBeTruthy(ctx: TruthinessContext, type: Type, recursionCount = 0): boolean {
    type = ctx.makeTopLevelTypeVarsConcrete(type);

    if (recursionCount > ctx.maxTypeRecursionCount) {
        return true;
    }
    recursionCount++;

    switch (type.category) {
        case TypeCategory.Unknown:
        case TypeCategory.Function:
        case TypeCategory.Overloaded:
        case TypeCategory.Module:
        case TypeCategory.TypeVar:
        case TypeCategory.Never:
        case TypeCategory.Any: {
            return true;
        }

        case TypeCategory.Union: {
            return findSubtype(type, (subtype: Type) => canBeTruthy(ctx, subtype, recursionCount)) !== undefined;
        }

        case TypeCategory.Unbound: {
            return false;
        }

        case TypeCategory.Class: {
            if (TypeBase.isInstantiable(type)) {
                return true;
            }

            if (isNoneInstance(type)) {
                return false;
            }

            // Check for tuple[()] (an empty tuple).
            if (type.priv.tupleTypeArgs && type.priv.tupleTypeArgs.length === 0) {
                return false;
            }

            // Check for bool, int, str and bytes literals that are never falsy.
            if (type.priv.literalValue !== undefined) {
                if (ClassType.isBuiltIn(type, ['bool', 'int', 'str', 'bytes'])) {
                    return !!type.priv.literalValue && type.priv.literalValue !== BigInt(0);
                }

                if (type.priv.literalValue instanceof EnumLiteral) {
                    // Does the Enum class forward the truthiness check to the underlying member type?
                    if (type.priv.literalValue.isReprEnum) {
                        return canBeTruthy(ctx, type.priv.literalValue.itemType, recursionCount);
                    }
                }
            }

            // If this is a protocol class, don't make any assumptions about the absence
            // of specific methods. These could be provided by a class that conforms
            // to the protocol.
            if (ClassType.isProtocolClass(type)) {
                return true;
            }

            const boolMethod = ctx.lookUpObjectMember(type, '__bool__');
            if (boolMethod) {
                const boolMethodType = ctx.getTypeOfMember(boolMethod);

                // If the __bool__ function unconditionally returns False, it can never be truthy.
                if (isFunctionOrOverloaded(boolMethodType) && (boolMethodType as any).shared?.declaredReturnType) {
                    const returnType = (boolMethodType as any).shared.declaredReturnType;
                    if (
                        isClassInstance(returnType) &&
                        ClassType.isBuiltIn(returnType, 'bool') &&
                        returnType.priv.literalValue === false
                    ) {
                        return false;
                    }
                }
            }

            return true;
        }
    }
}

export function removeTruthinessFromType(ctx: TruthinessContext, type: Type): Type {
    return mapSubtypes(type, (subtype) => {
        const concreteSubtype = ctx.makeTopLevelTypeVarsConcrete(subtype);

        if (isClassInstance(concreteSubtype)) {
            if (concreteSubtype.priv.literalValue !== undefined) {
                let isLiteralFalsy: boolean;

                if (concreteSubtype.priv.literalValue instanceof EnumLiteral) {
                    isLiteralFalsy = !canBeTruthy(ctx, concreteSubtype);
                } else {
                    isLiteralFalsy = !concreteSubtype.priv.literalValue;
                }

                // If the object is already definitely falsy, it's fine to
                // include, otherwise it should be removed.
                return isLiteralFalsy ? subtype : undefined;
            }

            // If the object is a sentinel, we can eliminate it.
            if (isSentinelLiteral(concreteSubtype)) {
                return undefined;
            }

            // If the object is a bool, make it "false", since
            // "true" is a truthy value.
            if (ClassType.isBuiltIn(concreteSubtype, 'bool')) {
                return ClassType.cloneWithLiteral(concreteSubtype, /* value */ false);
            }

            // If the object is an int, str or bytes, narrow to a literal type.
            // This is slightly unsafe in that someone could subclass `int`, `str`
            // or `bytes` and override the `__bool__` method to change its behavior,
            // but this is extremely unlikely (and ill advised).
            if (ClassType.isBuiltIn(concreteSubtype, 'int')) {
                return ClassType.cloneWithLiteral(concreteSubtype, /* value */ 0);
            } else if (ClassType.isBuiltIn(concreteSubtype, ['str', 'bytes'])) {
                return ClassType.cloneWithLiteral(concreteSubtype, /* value */ '');
            }
        }

        // If it's possible for the type to be falsy, include it.
        if (canBeFalsy(ctx, subtype)) {
            return subtype;
        }

        return undefined;
    });
}

export function removeFalsinessFromType(ctx: TruthinessContext, type: Type): Type {
    return mapSubtypes(type, (subtype) => {
        const concreteSubtype = ctx.makeTopLevelTypeVarsConcrete(subtype);

        if (isClassInstance(concreteSubtype)) {
            if (concreteSubtype.priv.literalValue !== undefined) {
                let isLiteralTruthy: boolean;

                if (concreteSubtype.priv.literalValue instanceof EnumLiteral) {
                    isLiteralTruthy = !canBeFalsy(ctx, concreteSubtype);
                } else if (concreteSubtype.priv.literalValue instanceof SentinelLiteral) {
                    isLiteralTruthy = true;
                } else {
                    isLiteralTruthy = !!concreteSubtype.priv.literalValue;
                }

                // If the object is already definitely truthy, it's fine to
                // include, otherwise it should be removed.
                return isLiteralTruthy ? subtype : undefined;
            }

            // If the object is a bool, make it "true", since
            // "false" is a falsy value.
            if (ClassType.isBuiltIn(concreteSubtype, 'bool')) {
                return ClassType.cloneWithLiteral(concreteSubtype, /* value */ true);
            }

            // If the object is a "None" instance, we can eliminate it.
            if (isNoneInstance(concreteSubtype)) {
                return undefined;
            }

            // If this is an instance of a class that cannot be subclassed,
            // we cannot say definitively that it's not falsy because a subclass
            // could override `__bool__`. For this reason, the code should not
            // remove any classes that are not final.
            // if (!ClassType.isFinal(concreteSubtype)) {
            //     return subtype;
            // }
            // However, we're going to pragmatically assume that any classes
            // other than `object` will not be overridden in this manner.
            if (ClassType.isBuiltIn(concreteSubtype, 'object')) {
                return subtype;
            }
        }

        // If it's possible for the type to be truthy, include it.
        if (canBeTruthy(ctx, subtype)) {
            return subtype;
        }

        return undefined;
    });
}

export function narrowTypeForTruthiness(ctx: TruthinessNarrowingContext, type: Type, isPositiveTest: boolean) {
    return mapSubtypes(type, (subtype) => {
        if (isPositiveTest) {
            if (ctx.canBeTruthy(subtype)) {
                return ctx.removeFalsinessFromType(subtype);
            }
        } else {
            if (ctx.canBeFalsy(subtype)) {
                return ctx.removeTruthinessFromType(subtype);
            }
        }
        return undefined;
    });
}

// Handle type narrowing for expressions of the form "a[I] is None" and "a[I] is not None" where
// I is an integer and a is a union of Tuples (or subtypes thereof) with known lengths and entry types.
export function narrowTupleTypeForIsNone(
    ctx: IsNoneNarrowingContext,
    type: Type,
    isPositiveTest: boolean,
    indexValue: number
): Type {
    return ctx.mapSubtypesExpandTypeVars(type, (subtype) => {
        const tupleType = getSpecializedTupleType(subtype);
        if (!tupleType || isUnboundedTupleClass(tupleType) || !tupleType.priv.tupleTypeArgs) {
            return subtype;
        }

        const tupleLength = tupleType.priv.tupleTypeArgs.length;
        if (indexValue < 0 || indexValue >= tupleLength) {
            return subtype;
        }

        const typeOfEntry = ctx.makeTopLevelTypeVarsConcrete(tupleType.priv.tupleTypeArgs[indexValue].type);

        if (isPositiveTest) {
            if (!ctx.assignType(typeOfEntry, ctx.getNoneType())) {
                return undefined;
            }
        } else {
            if (isNoneInstance(typeOfEntry)) {
                return undefined;
            }
        }

        return subtype;
    });
}

// Handle type narrowing for expressions of the form "x is None" and "x is not None".
export function narrowTypeForIsNone(ctx: IsNoneNarrowingContext, type: Type, isPositiveTest: boolean): Type {
    const expandedType = mapSubtypes(type, (subtype) => {
        return transformPossibleRecursiveTypeAlias(subtype);
    });

    let resultIncludesNoneSubtype = false;

    const result = ctx.mapSubtypesExpandTypeVars(expandedType, (subtype, unexpandedSubtype) => {
        if (isUnknown(subtype)) {
            return subtype;
        }

        if (isAny(subtype)) {
            return subtype;
        }

        let useExpandedSubtype = false;
        if (isTypeVar(unexpandedSubtype) && !TypeVarType.isSelf(unexpandedSubtype)) {
            if (
                unexpandedSubtype.shared.constraints.some((constraint) => {
                    return ctx.assignType(constraint, ctx.getNoneType());
                })
            ) {
                useExpandedSubtype = true;
            }

            if (
                unexpandedSubtype.shared.boundType &&
                ctx.assignType(unexpandedSubtype.shared.boundType, ctx.getNoneType())
            ) {
                useExpandedSubtype = true;
            }
        }

        const adjustedSubtype = useExpandedSubtype ? subtype : unexpandedSubtype;

        if (isNoneInstance(subtype)) {
            resultIncludesNoneSubtype = true;
            return isPositiveTest ? adjustedSubtype : undefined;
        }

        if (ctx.assignType(subtype, ctx.getNoneType())) {
            resultIncludesNoneSubtype = true;
            return isPositiveTest ? addConditionToType(ctx.getNoneType(), subtype.props?.condition) : adjustedSubtype;
        }

        return isPositiveTest ? undefined : adjustedSubtype;
    });

    if (isPositiveTest && resultIncludesNoneSubtype) {
        return mapSubtypes(result, (subtype) => {
            return isNoneInstance(subtype) ? subtype : undefined;
        });
    }

    return result;
}

// Handle type narrowing for expressions of the form "x is ..." and "x is not ...".
export function narrowTypeForIsEllipsis(
    ctx: IsEllipsisNarrowingContext,
    node: ExpressionNode,
    type: Type,
    isPositiveTest: boolean
): Type {
    const expandedType = mapSubtypes(type, (subtype) => {
        return transformPossibleRecursiveTypeAlias(subtype);
    });

    let resultIncludesEllipsisSubtype = false;

    const ellipsisType =
        ctx.getBuiltInObject(node, 'EllipsisType') ?? ctx.getBuiltInObject(node, 'ellipsis') ?? AnyType.create();

    const isEllipsisInstance = (subtype: Type) => {
        return isClassInstance(subtype) && ClassType.isBuiltIn(subtype, ['EllipsisType', 'ellipsis']);
    };

    const result = ctx.mapSubtypesExpandTypeVars(expandedType, (subtype, unexpandedSubtype) => {
        if (isUnknown(subtype)) {
            return subtype;
        }

        if (isAny(subtype)) {
            return subtype;
        }

        const adjustedSubtype =
            isTypeVar(unexpandedSubtype) && !TypeVarType.hasConstraints(unexpandedSubtype)
                ? unexpandedSubtype
                : subtype;

        if (isEllipsisInstance(subtype)) {
            resultIncludesEllipsisSubtype = true;
            return isPositiveTest ? adjustedSubtype : undefined;
        }

        if (ctx.assignType(subtype, ellipsisType)) {
            resultIncludesEllipsisSubtype = true;
            return isPositiveTest ? addConditionToType(ellipsisType, subtype.props?.condition) : adjustedSubtype;
        }

        return isPositiveTest ? undefined : adjustedSubtype;
    });

    if (isPositiveTest && resultIncludesEllipsisSubtype) {
        return mapSubtypes(result, (subtype) => {
            return isEllipsisInstance(subtype) ? subtype : undefined;
        });
    }

    return result;
}

// Attempts to narrow a type based on a comparison with a class using "is" or
// "is not". This pattern is sometimes used for sentinels.
export function narrowTypeForClassComparison(
    ctx: ClassComparisonContext,
    referenceType: Type,
    classType: ClassType,
    isPositiveTest: boolean
): Type {
    return mapSubtypes(referenceType, (subtype) => {
        let concreteSubtype = ctx.makeTopLevelTypeVarsConcrete(subtype);

        if (isPositiveTest) {
            if (
                isClassInstance(concreteSubtype) &&
                TypeBase.isInstance(subtype) &&
                ClassType.isBuiltIn(concreteSubtype, 'type')
            ) {
                concreteSubtype =
                    concreteSubtype.priv.typeArgs && concreteSubtype.priv.typeArgs.length > 0
                        ? convertToInstantiable(concreteSubtype.priv.typeArgs[0])
                        : UnknownType.create();
            }

            if (isAnyOrUnknown(concreteSubtype)) {
                return addConditionToType(classType, getTypeCondition(concreteSubtype));
            }

            if (isClass(concreteSubtype)) {
                if (TypeBase.isInstance(concreteSubtype)) {
                    return ClassType.isBuiltIn(concreteSubtype, 'object') ? classType : undefined;
                }

                const isSuperType = isFilterSuperclass(subtype, concreteSubtype, classType, classType);

                if (!classType.priv.includeSubclasses) {
                    if (!concreteSubtype.priv.includeSubclasses) {
                        return ClassType.isSameGenericClass(concreteSubtype, classType) ? classType : undefined;
                    }

                    if (isSuperType) {
                        return addConditionToType(classType, getTypeCondition(concreteSubtype));
                    }

                    const isSubType = ClassType.isDerivedFrom(classType, concreteSubtype);
                    if (isSubType) {
                        return addConditionToType(classType, getTypeCondition(concreteSubtype));
                    }

                    return undefined;
                }

                if (ClassType.isFinal(concreteSubtype) && !isSuperType) {
                    return undefined;
                }
            }
        } else {
            if (
                isInstantiableClass(concreteSubtype) &&
                ClassType.isSameGenericClass(classType, concreteSubtype) &&
                ClassType.isFinal(classType)
            ) {
                return undefined;
            }
        }

        return subtype;
    });
}

function isFilterSuperclass(
    varType: Type,
    concreteVarType: ClassType,
    filterType: Type,
    concreteFilterType: ClassType
) {
    if (isTypeVar(filterType) || concreteFilterType.priv.literalValue !== undefined) {
        return isTypeSame(convertToInstance(filterType), varType);
    }

    if (concreteFilterType.priv.includeSubclasses) {
        return false;
    }

    if (ClassType.isDerivedFrom(concreteVarType, concreteFilterType)) {
        return true;
    }

    if (ClassType.isBuiltIn(concreteFilterType, 'dict') && ClassType.isTypedDictClass(concreteVarType)) {
        return true;
    }

    return false;
}

// Attempts to narrow a type (make it more constrained) based on a comparison
// (equal or not equal) to a literal value. It also handles "is" or "is not"
// operators if isIsOperator is true.
export function narrowTypeForLiteralComparison(
    ctx: LiteralComparisonContext,
    referenceType: Type,
    literalType: ClassType,
    isPositiveTest: boolean,
    isIsOperator: boolean
): Type {
    return ctx.mapSubtypesExpandTypeVars(referenceType, (subtype) => {
        subtype = ctx.makeTopLevelTypeVarsConcrete(subtype);

        if (isAnyOrUnknown(subtype)) {
            if (isPositiveTest) {
                return literalType;
            }

            return subtype;
        }

        if (isClassInstance(subtype) && ClassType.isSameGenericClass(literalType, subtype)) {
            if (subtype.priv.literalValue !== undefined) {
                const literalValueMatches = ClassType.isLiteralValueSame(subtype, literalType);
                if (isPositiveTest) {
                    return literalValueMatches ? subtype : undefined;
                }

                const isSingleton =
                    ClassType.isEnumClass(literalType) ||
                    isSentinelLiteral(subtype) ||
                    ClassType.isBuiltIn(literalType, 'bool');

                return literalValueMatches && (isSingleton || !isIsOperator) ? undefined : subtype;
            }

            if (isPositiveTest) {
                return literalType;
            }

            const allLiteralTypes = ctx.enumerateLiteralsForType(subtype);
            if (allLiteralTypes && allLiteralTypes.length > 0) {
                return combineTypes(allLiteralTypes.filter((type) => !ClassType.isLiteralValueSame(type, literalType)));
            }

            return subtype;
        }

        if (isPositiveTest) {
            if (isClassInstance(subtype) && ClassType.isBuiltIn(subtype, 'LiteralString')) {
                return literalType;
            }

            if (isIsOperator || isNoneInstance(subtype)) {
                const isSubtype = ctx.assignType(subtype, literalType);
                return isSubtype ? literalType : undefined;
            }
        }

        return subtype;
    });
}

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

import { ExpressionNode, ParamCategory } from '../../parser/parseNodes';
import { getFileInfo } from '../analyzerNodeInfo';
import { ConstraintTracker } from '../constraintTracker';
import * as ParseTreeUtils from '../parseTreeUtils';
import { Symbol, SymbolFlags } from '../symbol';
import { AssignTypeFlags, MapSubtypesOptions, TypeEvaluator, TypeResult } from '../typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    ClassTypeFlags,
    combineTypes,
    EnumLiteral,
    findSubtype,
    FunctionParam,
    FunctionParamFlags,
    FunctionType,
    FunctionTypeFlags,
    isAny,
    isAnyOrUnknown,
    isClass,
    isClassInstance,
    isFunction,
    isFunctionOrOverloaded,
    isInstantiableClass,
    isModule,
    isNever,
    isParamSpec,
    isTypeSame,
    isTypeVar,
    isUnion,
    isUnknown,
    OverloadedType,
    SentinelLiteral,
    Type,
    TypeBase,
    TypeCategory,
    TypeCondition,
    TypedDictEntries,
    TypeVarType,
    UnionType,
    UnknownType,
} from '../types';
import {
    addConditionToType,
    ApplyTypeVarOptions,
    computeMroLinearization,
    convertToInstance,
    convertToInstantiable,
    derivesFromAnyOrUnknown,
    doForEachSubtype,
    getSpecializedTupleType,
    getTypeCondition,
    getTypeVarScopeIds,
    isIncompleteUnknown,
    isInstantiableMetaclass,
    isLiteralType,
    isLiteralTypeOrUnion,
    isMaybeDescriptorInstance,
    isMetaclassInstance,
    isNoneInstance,
    isNoneTypeClass,
    isProperty,
    isSentinelLiteral,
    isTupleClass,
    isTupleGradualForm,
    isUnboundedTupleClass,
    lookUpClassMember,
    makeTypeVarsFree,
    mapSubtypes,
    MemberAccessFlags,
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

export interface DiscriminatedDictEntryContext {
    assignType: (destType: Type, srcType: Type) => boolean;
    getTypedDictMembersForClass: (type: ClassType) => TypedDictEntries | undefined;
}

export interface DiscriminatedTupleContext {
    assignType: (destType: Type, srcType: Type) => boolean;
}

export interface DiscriminatedLiteralFieldContext {
    assignType: (destType: Type, srcType: Type) => boolean;
    getTypeOfMember: (member: any) => Type;
    lookUpObjectMember: (type: ClassType, memberName: string) => any;
    lookUpClassMember: (type: ClassType, memberName: string) => any;
}

export interface DiscriminatedFieldNoneContext {
    getTypeOfMember: (member: any) => Type;
    makeTopLevelTypeVarsConcrete: (type: Type) => Type;
    lookUpObjectMember: (type: ClassType, memberName: string) => any;
    lookUpClassMember: (type: ClassType, memberName: string) => any;
}

export interface TypeIsNarrowingContext {
    mapSubtypesExpandTypeVars: (
        type: Type,
        callback: (subtype: Type, unexpandedSubtype: Type) => Type | undefined
    ) => Type;
}

export interface IsInstanceNarrowingContext {
    addConstraintsForExpectedType: (
        type: ClassType,
        expectedType: Type,
        constraints: ConstraintTracker,
        errorNodeStart: number
    ) => boolean;
    assignType: (destType: Type, srcType: Type, flags?: AssignTypeFlags) => boolean;
    createSubclass: (errorNode: ExpressionNode, type1: ClassType, type2: ClassType) => ClassType;
    expandPromotionTypes: (node: ExpressionNode, type: Type) => Type;
    getCallbackProtocolType: (objType: ClassType, recursionCount?: number) => FunctionType | OverloadedType | undefined;
    getDictClassType: () => ClassType | undefined;
    getStrClassType: () => ClassType | undefined;
    getTupleClassType: () => ClassType | undefined;
    getTypeClassType: () => ClassType | undefined;
    makeTopLevelTypeVarsConcrete: (type: Type) => Type;
    mapSubtypesExpandTypeVars: (
        type: Type,
        options: MapSubtypesOptions | undefined,
        callback: (subtype: Type, unexpandedSubtype: Type) => Type | undefined
    ) => Type;
    solveAndApplyConstraints: (type: Type, constraints: ConstraintTracker, options: ApplyTypeVarOptions) => Type;
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

// Attempts to narrow a TypedDict type based on a comparison (equal or not
// equal) between a discriminating entry type that has a declared literal
// type to a literal value.
export function narrowTypeForDiscriminatedDictEntryComparison(
    ctx: DiscriminatedDictEntryContext,
    referenceType: Type,
    indexLiteralType: ClassType,
    literalType: Type,
    isPositiveTest: boolean
): Type {
    let canNarrow = true;

    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
            const symbolMap = ctx.getTypedDictMembersForClass(subtype);
            const tdEntry = symbolMap?.knownItems.get(indexLiteralType.priv.literalValue as string);

            if (tdEntry && isLiteralTypeOrUnion(tdEntry.valueType)) {
                if (isPositiveTest) {
                    let foundMatch = false;

                    doForEachSubtype(literalType, (literalSubtype) => {
                        if (ctx.assignType(tdEntry.valueType, literalSubtype)) {
                            foundMatch = true;
                        }
                    });

                    return foundMatch ? subtype : undefined;
                } else {
                    let foundNonMatch = false;

                    doForEachSubtype(literalType, (literalSubtype) => {
                        if (!ctx.assignType(literalSubtype, tdEntry.valueType)) {
                            foundNonMatch = true;
                        }
                    });

                    return foundNonMatch ? subtype : undefined;
                }
            }
        }

        canNarrow = false;
        return subtype;
    });

    return canNarrow ? narrowedType : referenceType;
}

export function narrowTypeForDiscriminatedTupleComparison(
    ctx: DiscriminatedTupleContext,
    referenceType: Type,
    indexLiteralType: ClassType,
    literalType: Type,
    isPositiveTest: boolean
): Type {
    let canNarrow = true;

    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        if (
            isClassInstance(subtype) &&
            ClassType.isTupleClass(subtype) &&
            !isUnboundedTupleClass(subtype) &&
            typeof indexLiteralType.priv.literalValue === 'number' &&
            isClassInstance(literalType)
        ) {
            const indexValue = indexLiteralType.priv.literalValue;
            if (subtype.priv.tupleTypeArgs && indexValue >= 0 && indexValue < subtype.priv.tupleTypeArgs.length) {
                const tupleEntryType = subtype.priv.tupleTypeArgs[indexValue]?.type;
                if (tupleEntryType && isLiteralTypeOrUnion(tupleEntryType)) {
                    if (isPositiveTest) {
                        return ctx.assignType(tupleEntryType, literalType) ? subtype : undefined;
                    } else {
                        return ctx.assignType(literalType, tupleEntryType) ? undefined : subtype;
                    }
                }
            }
        }

        canNarrow = false;
        return subtype;
    });

    return canNarrow ? narrowedType : referenceType;
}

// Attempts to narrow a type based on a comparison (equal or not equal)
// between a discriminating field that has a declared literal type to a
// literal value.
export function narrowTypeForDiscriminatedLiteralFieldComparison(
    ctx: DiscriminatedLiteralFieldContext,
    referenceType: Type,
    memberName: string,
    literalType: ClassType,
    isPositiveTest: boolean
): Type {
    const narrowedType = mapSubtypes(referenceType, (subtype) => {
        let memberInfo: any;

        if (isClassInstance(subtype)) {
            memberInfo = ctx.lookUpObjectMember(subtype, memberName);
        } else if (isInstantiableClass(subtype)) {
            memberInfo = ctx.lookUpClassMember(subtype, memberName);
        }

        if (memberInfo && memberInfo.isTypeDeclared) {
            let memberType = ctx.getTypeOfMember(memberInfo);

            // Handle the case where the field is a property
            // that has a declared literal return type for its getter.
            if (isClassInstance(subtype) && isClassInstance(memberType) && isProperty(memberType)) {
                const getterType = memberType.priv.fgetInfo?.methodType;
                if (getterType && getterType.shared.declaredReturnType) {
                    const getterReturnType = FunctionType.getEffectiveReturnType(getterType);
                    if (getterReturnType) {
                        memberType = getterReturnType;
                    }
                }
            }

            if (isLiteralTypeOrUnion(memberType, /* allowNone */ true)) {
                if (isPositiveTest) {
                    return ctx.assignType(memberType, literalType) ? subtype : undefined;
                } else {
                    return ctx.assignType(literalType, memberType) ? undefined : subtype;
                }
            }
        }

        return subtype;
    });

    return narrowedType;
}

// Attempts to narrow a type based on a comparison (equal or not equal)
// between a discriminating field that has a declared None type to a
// None.
export function narrowTypeForDiscriminatedFieldNoneComparison(
    ctx: DiscriminatedFieldNoneContext,
    referenceType: Type,
    memberName: string,
    isPositiveTest: boolean
): Type {
    return mapSubtypes(referenceType, (subtype) => {
        let memberInfo: any;
        if (isClassInstance(subtype)) {
            memberInfo = ctx.lookUpObjectMember(subtype, memberName);
        } else if (isInstantiableClass(subtype)) {
            memberInfo = ctx.lookUpClassMember(subtype, memberName);
        }

        if (memberInfo && memberInfo.isTypeDeclared) {
            const memberType = ctx.makeTopLevelTypeVarsConcrete(ctx.getTypeOfMember(memberInfo));
            let canNarrow = true;

            if (isPositiveTest) {
                doForEachSubtype(memberType, (memberSubtype) => {
                    memberSubtype = ctx.makeTopLevelTypeVarsConcrete(memberSubtype);

                    // Don't attempt to narrow if the member is a descriptor or property.
                    if (isProperty(memberSubtype) || isMaybeDescriptorInstance(memberSubtype)) {
                        canNarrow = false;
                    }

                    if (isAnyOrUnknown(memberSubtype) || isNoneInstance(memberSubtype) || isNever(memberSubtype)) {
                        canNarrow = false;
                    }
                });
            } else {
                canNarrow = isNoneInstance(memberType);
            }

            if (canNarrow) {
                return undefined;
            }
        }

        return subtype;
    });
}

// Attempts to narrow a type based on a "type(x) is y" or "type(x) is not y" check.
export function narrowTypeForTypeIs(
    ctx: TypeIsNarrowingContext,
    type: Type,
    classTypes: ClassType[],
    isPositiveTest: boolean
): Type {
    if (!isPositiveTest && classTypes.length > 1) {
        return type;
    }

    const typesToCombine = classTypes.map((classType) => {
        return ctx.mapSubtypesExpandTypeVars(type, (subtype, unexpandedSubtype) => {
            if (isClassInstance(subtype)) {
                const matches = ClassType.isDerivedFrom(classType, ClassType.cloneAsInstantiable(subtype));
                if (isPositiveTest) {
                    if (matches) {
                        if (ClassType.isSameGenericClass(ClassType.cloneAsInstantiable(subtype), classType)) {
                            return addConditionToType(subtype, getTypeCondition(classType));
                        }

                        return addConditionToType(ClassType.cloneAsInstance(classType), subtype.props?.condition);
                    }

                    if (!classType.priv.includeSubclasses) {
                        return undefined;
                    }

                    if (!isTypeVar(unexpandedSubtype) || !TypeVarType.isSelf(unexpandedSubtype)) {
                        return addConditionToType(subtype, classType.props?.condition);
                    }
                }

                if (!classType.priv.includeSubclasses) {
                    if (matches && ClassType.isFinal(subtype)) {
                        return undefined;
                    }

                    return subtype;
                }
            }

            if (isAnyOrUnknown(subtype)) {
                return isPositiveTest
                    ? ClassType.cloneAsInstance(addConditionToType(classType, getTypeCondition(subtype)))
                    : subtype;
            }

            return unexpandedSubtype;
        });
    });

    return combineTypes(typesToCombine);
}

export function narrowTypeForUserDefinedTypeGuard(
    ctx: IsInstanceNarrowingContext,
    type: Type,
    typeGuardType: Type,
    isPositiveTest: boolean,
    isStrictTypeGuard: boolean,
    errorNode: ExpressionNode
): Type {
    // For non-strict type guards, always narrow to the typeGuardType
    // in the positive case and don't narrow in the negative case.
    if (!isStrictTypeGuard) {
        let result = type;

        if (isPositiveTest) {
            result = typeGuardType;

            // If the type guard is a non-constrained TypeVar, add a
            // condition to the resulting type.
            if (isTypeVar(type) && !isParamSpec(type) && !TypeVarType.hasConstraints(type)) {
                result = addConditionToType(result, [{ typeVar: type, constraintIndex: 0 }]);
            }
            return result;
        }

        return result;
    }

    const filterTypes: Type[] = [];
    doForEachSubtype(typeGuardType, (typeGuardSubtype) => {
        filterTypes.push(convertToInstantiable(typeGuardSubtype));
    });

    return narrowTypeForInstanceOrSubclass(
        ctx,
        type,
        filterTypes,
        /* isInstanceCheck */ true,
        /* isTypeIsCheck */ true,
        isPositiveTest,
        errorNode
    );
}

export function narrowTypeForInstanceOrSubclass(
    ctx: IsInstanceNarrowingContext,
    type: Type,
    filterTypes: Type[],
    isInstanceCheck: boolean,
    isTypeIsCheck: boolean,
    isPositiveTest: boolean,
    errorNode: ExpressionNode
): Type {
    const narrowedType = narrowTypeForInstanceOrSubclassInternal(
        ctx,
        type,
        filterTypes,
        isInstanceCheck,
        isTypeIsCheck,
        isPositiveTest,
        /* allowIntersections */ false,
        errorNode
    );

    if (!isNever(narrowedType)) {
        return narrowedType;
    }

    return narrowTypeForInstanceOrSubclassInternal(
        ctx,
        type,
        filterTypes,
        isInstanceCheck,
        isTypeIsCheck,
        isPositiveTest,
        /* allowIntersections */ true,
        errorNode
    );
}

function narrowTypeForInstanceOrSubclassInternal(
    ctx: IsInstanceNarrowingContext,
    type: Type,
    filterTypes: Type[],
    isInstanceCheck: boolean,
    isTypeIsCheck: boolean,
    isPositiveTest: boolean,
    allowIntersections: boolean,
    errorNode: ExpressionNode
): Type {
    const result = mapSubtypes(type, (subtype) => {
        let adjSubtype = subtype;
        let resultRequiresAdj = false;
        let adjFilterTypes = filterTypes;

        if (!isInstanceCheck) {
            const isTypeInstance = isClassInstance(subtype) && ClassType.isBuiltIn(subtype, 'type');

            if (isMetaclassInstance(subtype) && !isTypeInstance) {
                adjFilterTypes = filterTypes.map((filterType) => convertToInstantiable(filterType));
            } else {
                adjSubtype = convertToInstance(subtype);

                if (!isAnyOrUnknown(subtype) || isPositiveTest) {
                    resultRequiresAdj = true;
                }
            }
        }

        const narrowedResult = narrowTypeForInstance(
            ctx,
            adjSubtype,
            adjFilterTypes,
            isTypeIsCheck,
            isPositiveTest,
            allowIntersections,
            errorNode
        );

        if (!resultRequiresAdj) {
            return narrowedResult;
        }

        if (isAnyOrUnknown(narrowedResult)) {
            const typeClass = ctx.getTypeClassType();
            if (typeClass) {
                return ClassType.specialize(ClassType.cloneAsInstance(typeClass), [narrowedResult]);
            }
        }

        return convertToInstantiable(narrowedResult);
    });

    return result;
}

function narrowTypeForInstance(
    ctx: IsInstanceNarrowingContext,
    type: Type,
    filterTypes: Type[],
    isTypeIsCheck: boolean,
    isPositiveTest: boolean,
    allowIntersections: boolean,
    errorNode: ExpressionNode
): Type {
    let expandedTypes = mapSubtypes(type, (subtype) => {
        return transformPossibleRecursiveTypeAlias(subtype);
    });

    expandedTypes = ctx.expandPromotionTypes(errorNode, expandedTypes);

    const convertVarTypeToFree = (varType: Type): Type => {
        if (isTypeIsCheck) {
            return varType;
        }

        return makeTypeVarsFree(varType, ParseTreeUtils.getTypeVarScopesForNode(errorNode));
    };

    const filterClassType = (
        varType: Type,
        concreteVarType: ClassType,
        conditions: TypeCondition[] | undefined,
        negativeFallbackType: Type
    ): Type[] => {
        const filteredTypes: Type[] = [];

        let foundSuperclass = false;
        let isClassRelationshipIndeterminate = false;

        for (const filterType of filterTypes) {
            const concreteFilterType = ctx.makeTopLevelTypeVarsConcrete(filterType);

            if (isInstantiableClass(concreteFilterType)) {
                const filterMetaclass = concreteFilterType.shared.effectiveMetaclass;
                if (
                    isInstantiableMetaclass(concreteVarType) &&
                    TypeBase.getInstantiableDepth(concreteFilterType) > 0 &&
                    filterMetaclass &&
                    isInstantiableClass(filterMetaclass)
                ) {
                    const metaclassType = convertToInstance(concreteVarType);
                    let isMetaclassOverlap = ctx.assignType(
                        convertVarTypeToFree(metaclassType),
                        ClassType.cloneAsInstance(filterMetaclass)
                    );

                    if (ClassType.isBuiltIn(filterMetaclass, 'type') && !filterMetaclass.priv.isTypeArgExplicit) {
                        if (!isClass(metaclassType) || !ClassType.isBuiltIn(metaclassType, 'type')) {
                            isMetaclassOverlap = false;
                        }
                    }

                    if (isMetaclassOverlap) {
                        if (isPositiveTest) {
                            filteredTypes.push(filterType);
                            foundSuperclass = true;
                        } else if (
                            !isTypeSame(metaclassType, filterMetaclass) ||
                            filterMetaclass.priv.includeSubclasses
                        ) {
                            filteredTypes.push(metaclassType);
                            isClassRelationshipIndeterminate = true;
                        }
                        continue;
                    }
                }

                let runtimeVarType = concreteVarType;

                if (!isTypeIsCheck) {
                    runtimeVarType = makeTypeVarsFree(
                        runtimeVarType,
                        ParseTreeUtils.getTypeVarScopesForNode(errorNode)
                    );
                }

                if (isInstantiableClass(runtimeVarType) && ClassType.isTypedDictClass(runtimeVarType)) {
                    const dictClass = ctx.getDictClassType();
                    const strType = ctx.getStrClassType();

                    if (dictClass && strType) {
                        runtimeVarType = ClassType.specialize(dictClass, [
                            ClassType.cloneAsInstance(strType),
                            UnknownType.create(),
                        ]);
                    }
                }

                const filterIsSuperclass = ctx.assignType(
                    filterType,
                    runtimeVarType,
                    AssignTypeFlags.AllowIsinstanceSpecialForms | AssignTypeFlags.AllowProtocolClassSource
                );

                let filterIsSubclass = ctx.assignType(
                    runtimeVarType,
                    filterType,
                    AssignTypeFlags.AllowIsinstanceSpecialForms | AssignTypeFlags.AllowProtocolClassSource
                );

                if (filterIsSuperclass) {
                    foundSuperclass = true;
                }

                if (ClassType.isBuiltIn(runtimeVarType, 'TypeForm')) {
                    isClassRelationshipIndeterminate = true;
                    filterIsSubclass = true;
                }

                if (filterIsSuperclass) {
                    if (!isTypeIsCheck && concreteFilterType.priv.includeSubclasses) {
                        isClassRelationshipIndeterminate = true;
                    }

                    if (filterIsSubclass && !ClassType.isSameGenericClass(runtimeVarType, concreteFilterType)) {
                        if (
                            !ClassType.isBuiltIn(concreteFilterType, 'type') ||
                            TypeBase.getInstantiableDepth(runtimeVarType) === 0
                        ) {
                            isClassRelationshipIndeterminate = true;
                        }
                    }
                }

                if (isTypeVar(varType) && isTypeVar(filterType)) {
                    isClassRelationshipIndeterminate = true;
                }

                if (isPositiveTest) {
                    if (filterIsSuperclass) {
                        if (isTypeVar(varType) && TypeVarType.isSelf(varType)) {
                            filteredTypes.push(addConditionToType(varType, conditions));
                        } else {
                            filteredTypes.push(addConditionToType(concreteVarType, conditions));
                        }
                    } else if (filterIsSubclass) {
                        let specializedFilterType = filterType;

                        if (isClass(filterType)) {
                            if (ClassType.isSpecialBuiltIn(filterType) || filterType.shared.typeParams.length > 0) {
                                if (
                                    !filterType.priv.isTypeArgExplicit &&
                                    !ClassType.isSameGenericClass(concreteVarType, filterType)
                                ) {
                                    const constraints = new ConstraintTracker();
                                    const unspecializedFilterType = ClassType.specialize(
                                        filterType,
                                        /* typeArg */ undefined
                                    );

                                    if (
                                        ctx.addConstraintsForExpectedType(
                                            ClassType.cloneAsInstance(unspecializedFilterType),
                                            ClassType.cloneAsInstance(concreteVarType),
                                            constraints,
                                            errorNode.start
                                        )
                                    ) {
                                        specializedFilterType = ctx.solveAndApplyConstraints(
                                            unspecializedFilterType,
                                            constraints,
                                            {
                                                replaceUnsolved: {
                                                    scopeIds: getTypeVarScopeIds(filterType),
                                                    useUnknown: true,
                                                    tupleClassType: ctx.getTupleClassType(),
                                                },
                                            }
                                        ) as ClassType;
                                    }
                                }
                            }
                        }

                        filteredTypes.push(addConditionToType(specializedFilterType, conditions));
                    } else if (
                        ClassType.isSameGenericClass(
                            ClassType.cloneAsInstance(concreteVarType),
                            ClassType.cloneAsInstance(concreteFilterType)
                        )
                    ) {
                        if (!isTypeIsCheck) {
                            if (
                                concreteVarType.priv?.literalValue === undefined &&
                                concreteFilterType.priv?.literalValue === undefined
                            ) {
                                const intersection = intersectSameClassType(concreteVarType, concreteFilterType);
                                filteredTypes.push(intersection ?? varType);
                            }
                        }
                    } else if (
                        allowIntersections &&
                        !ClassType.isFinal(concreteVarType) &&
                        !ClassType.isFinal(concreteFilterType)
                    ) {
                        let newClassType = ctx.createSubclass(errorNode, concreteVarType, concreteFilterType);
                        if (isTypeVar(varType) && !isParamSpec(varType) && !TypeVarType.hasConstraints(varType)) {
                            newClassType = addConditionToType(newClassType, [{ typeVar: varType, constraintIndex: 0 }]);
                        }

                        filteredTypes.push(addConditionToType(newClassType, concreteVarType.props?.condition));
                    }
                } else {
                    if (isAnyOrUnknown(varType)) {
                        filteredTypes.push(addConditionToType(varType, conditions));
                    } else if (derivesFromAnyOrUnknown(varType) && !isTypeSame(concreteVarType, concreteFilterType)) {
                        filteredTypes.push(addConditionToType(varType, conditions));
                    }
                }
            } else if (isTypeVar(filterType) && TypeBase.isInstantiable(filterType)) {
                if (TypeBase.isInstance(varType)) {
                    if (isTypeVar(varType) && isTypeSame(convertToInstance(filterType), varType)) {
                        if (isPositiveTest) {
                            filteredTypes.push(varType);
                        } else {
                            foundSuperclass = true;
                        }
                    } else {
                        if (isPositiveTest) {
                            filteredTypes.push(convertToInstance(filterType));
                        } else {
                            filteredTypes.push(varType);
                            isClassRelationshipIndeterminate = true;
                        }
                    }
                }
            } else if (isFunction(filterType)) {
                let isCallable = false;

                if (isClass(concreteVarType)) {
                    if (TypeBase.isInstantiable(varType)) {
                        isCallable = true;
                    } else {
                        isCallable = !!lookUpClassMember(
                            concreteVarType,
                            '__call__',
                            MemberAccessFlags.SkipInstanceMembers
                        );
                    }
                }

                if (isCallable) {
                    if (isPositiveTest) {
                        filteredTypes.push(convertToInstantiable(varType));
                    } else {
                        foundSuperclass = true;
                    }
                } else if (
                    ctx.assignType(
                        convertVarTypeToFree(concreteVarType),
                        filterType,
                        AssignTypeFlags.AllowIsinstanceSpecialForms
                    )
                ) {
                    if (isPositiveTest) {
                        filteredTypes.push(addConditionToType(filterType, concreteVarType.props?.condition));
                    }
                } else if (allowIntersections && isPositiveTest) {
                    const className = `<callable subtype of ${concreteVarType.shared.name}>`;
                    const fileInfo = getFileInfo(errorNode);
                    let newClassType = ClassType.createInstantiable(
                        className,
                        ParseTreeUtils.getClassFullName(errorNode, fileInfo.moduleName, className),
                        fileInfo.moduleName,
                        fileInfo.fileUri,
                        ClassTypeFlags.None,
                        ParseTreeUtils.getTypeSourceId(errorNode),
                        /* declaredMetaclass */ undefined,
                        concreteVarType.shared.effectiveMetaclass,
                        concreteVarType.shared.docString
                    );
                    newClassType.shared.baseClasses = [concreteVarType];
                    computeMroLinearization(newClassType);

                    newClassType = addConditionToType(newClassType, concreteVarType.props?.condition);

                    const callMethod = FunctionType.createSynthesizedInstance('__call__');
                    const selfParam = FunctionParam.create(
                        ParamCategory.Simple,
                        ClassType.cloneAsInstance(newClassType),
                        FunctionParamFlags.TypeDeclared,
                        'self'
                    );
                    FunctionType.addParam(callMethod, selfParam);
                    FunctionType.addDefaultParams(callMethod);
                    callMethod.shared.declaredReturnType = UnknownType.create();
                    ClassType.getSymbolTable(newClassType).set(
                        '__call__',
                        Symbol.createWithType(SymbolFlags.ClassMember, callMethod)
                    );

                    filteredTypes.push(ClassType.cloneAsInstance(newClassType));
                }
            }
        }

        if (!isPositiveTest) {
            if (!foundSuperclass || isClassRelationshipIndeterminate) {
                filteredTypes.push(convertToInstantiable(negativeFallbackType));
            }
        }

        return filteredTypes.map((t) => convertToInstance(t));
    };

    const isFilterTypeCallbackProtocol = (filterType: Type) => {
        return (
            isInstantiableClass(filterType) &&
            ctx.getCallbackProtocolType(ClassType.cloneAsInstance(filterType)) !== undefined
        );
    };

    const filterFunctionType = (varType: FunctionType | OverloadedType, unexpandedType: Type): Type[] => {
        const filteredTypes: Type[] = [];

        if (isPositiveTest) {
            for (const filterType of filterTypes) {
                const concreteFilterType = ctx.makeTopLevelTypeVarsConcrete(filterType);

                if (!isTypeIsCheck && isFilterTypeCallbackProtocol(concreteFilterType)) {
                    filteredTypes.push(convertToInstance(varType));
                } else if (ctx.assignType(convertVarTypeToFree(varType), convertToInstance(concreteFilterType))) {
                    if (isFunction(filterType)) {
                        filteredTypes.push(convertToInstance(unexpandedType));
                    } else {
                        filteredTypes.push(convertToInstance(filterType));
                    }
                } else {
                    const filterTypeInstance = convertToInstance(convertVarTypeToFree(concreteFilterType));
                    if (ctx.assignType(filterTypeInstance, varType)) {
                        filteredTypes.push(convertToInstance(varType));
                    } else {
                        if (isClassInstance(filterTypeInstance) && !ClassType.isFinal(filterTypeInstance)) {
                            const gradualFunc = FunctionType.createSynthesizedInstance(
                                '',
                                FunctionTypeFlags.GradualCallableForm
                            );
                            FunctionType.addDefaultParams(gradualFunc);

                            if (!ctx.assignType(gradualFunc, filterTypeInstance)) {
                                filteredTypes.push(convertToInstance(filterType));
                            }
                        }
                    }
                }
            }
        } else {
            if (
                filterTypes.every((filterType) => {
                    const concreteFilterType = ctx.makeTopLevelTypeVarsConcrete(filterType);

                    if (!isTypeIsCheck && isFilterTypeCallbackProtocol(concreteFilterType)) {
                        return false;
                    }

                    if (isFunction(concreteFilterType) && FunctionType.isGradualCallableForm(concreteFilterType)) {
                        return false;
                    }

                    const isSubtype = ctx.assignType(
                        convertToInstance(convertVarTypeToFree(concreteFilterType)),
                        varType
                    );
                    const isSupertype = ctx.assignType(
                        convertVarTypeToFree(varType),
                        convertToInstance(concreteFilterType)
                    );

                    return !isSubtype || isSupertype;
                })
            ) {
                filteredTypes.push(convertToInstance(varType));
            }
        }

        return filteredTypes;
    };

    const classListContainsNoneType = () =>
        filterTypes.some((t) => {
            if (isNoneTypeClass(t)) {
                return true;
            }
            return isInstantiableClass(t) && ClassType.isBuiltIn(t, 'NoneType');
        });

    const anyOrUnknownSubstitutions: Type[] = [];
    const anyOrUnknown: Type[] = [];

    const filteredType = ctx.mapSubtypesExpandTypeVars(
        expandedTypes,
        {
            expandCallback: (type) => {
                return ctx.expandPromotionTypes(errorNode, type);
            },
        },
        (subtype, unexpandedSubtype) => {
            const negativeFallback = getTypeCondition(subtype) ? subtype : unexpandedSubtype;

            if (isPositiveTest && isAnyOrUnknown(subtype)) {
                anyOrUnknownSubstitutions.push(
                    combineTypes(filterTypes.map((classType) => convertToInstance(classType)))
                );

                anyOrUnknown.push(subtype);
                return undefined;
            }

            if (isNoneInstance(subtype)) {
                return classListContainsNoneType() === isPositiveTest ? subtype : undefined;
            }

            if (isModule(subtype) || (isClassInstance(subtype) && ClassType.isBuiltIn(subtype, 'ModuleType'))) {
                if (isPositiveTest) {
                    const filteredTypes = filterTypes.filter((classType) => {
                        const concreteClassType = ctx.makeTopLevelTypeVarsConcrete(classType);
                        return isInstantiableClass(concreteClassType) && ClassType.isProtocolClass(concreteClassType);
                    });

                    if (filteredTypes.length > 0) {
                        return convertToInstance(combineTypes(filteredTypes));
                    }
                }
            }

            if (isClass(subtype)) {
                return combineTypes(
                    filterClassType(
                        unexpandedSubtype,
                        ClassType.cloneAsInstantiable(subtype),
                        getTypeCondition(subtype),
                        negativeFallback
                    )
                );
            }

            if (isFunctionOrOverloaded(subtype)) {
                return combineTypes(filterFunctionType(subtype, unexpandedSubtype));
            }

            return isPositiveTest ? undefined : negativeFallback;
        }
    );

    if (isNever(filteredType) && anyOrUnknownSubstitutions.length > 0) {
        return combineTypes(anyOrUnknownSubstitutions);
    }

    if (isNever(filteredType) && anyOrUnknown.length > 0) {
        return combineTypes(anyOrUnknown);
    }

    return filteredType;
}

function intersectSameClassType(type1: ClassType, type2: ClassType): ClassType | undefined {
    if (!isInstantiableClass(type1) || !isInstantiableClass(type2)) {
        return undefined;
    }

    if (!ClassType.isSameGenericClass(type1, type2)) {
        return undefined;
    }

    if (type1.priv?.literalValue !== undefined || type2.priv?.literalValue !== undefined) {
        return undefined;
    }

    if (ClassType.isBuiltIn(type1, 'tuple')) {
        return intersectTupleTypes(type1, type1);
    }

    return undefined;
}

function intersectTupleTypes(type1: ClassType, type2: ClassType) {
    if (!type2.priv.tupleTypeArgs || isTupleGradualForm(type2)) {
        return addConditionToType(type1, type2.props?.condition);
    }

    if (!type1.priv.tupleTypeArgs || isTupleGradualForm(type1)) {
        return addConditionToType(type2, type1.props?.condition);
    }

    return undefined;
}

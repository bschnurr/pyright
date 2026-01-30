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
    ClassType,
    combineTypes,
    isClass,
    isClassInstance,
    isFunctionOrOverloaded,
    isNever,
    isTypeSame,
    isUnion,
    isUnknown,
    Type,
    TypeBase,
    UnionType,
} from '../types';
import { getTypeCondition, isIncompleteUnknown, isLiteralType, mapSubtypes } from '../typeUtils';

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

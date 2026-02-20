// pureHelpers.ts
// Pure utility functions with no TypeEvaluator dependency.
// Shared by evaluatorCore.ts and specialFormCreation.ts.

import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { ParseNode } from '../../parser/parseNodes';
import { ClassType, isClassInstance, isInstantiableClass, isParamSpec, isTypeVar, isTypeVarTuple, Type, TypeVarType } from '../types';
import { isTupleClass } from '../typeUtils';

export function isTypeFormSupportedForNode(node: ParseNode) {
    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    return fileInfo.diagnosticRuleSet.enableExperimentalFeatures;
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

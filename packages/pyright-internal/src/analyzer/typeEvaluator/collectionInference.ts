// collectionInference.ts
// Collection type inference: dictionaries, lists, sets, comprehensions, strings.
// Extracted from evaluatorCore.ts for modularization.

import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { LocMessage } from '../../localization/localize';
import { ComprehensionNode, DictionaryNode, ExpressionNode, FormatStringNode, isExpressionNode, ListNode, ParseNode, ParseNodeType, SetNode, StringListNode, StringNode } from '../../parser/parseNodes';
import { StringTokenFlags } from '../../parser/tokenizerTypes';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import * as ParseTreeUtils from '../parseTreeUtils';
import { EvalFlags, maxInferredContainerDepth, maxSubtypesForInferredType, PrefetchedTypes, TypeEvaluator, TypeResult, TypeResultWithNode } from '../typeEvaluatorTypes';
import { AnyType, ClassType, combineTypes, isAnyOrUnknown, isClass, isClassInstance, isInstantiableClass, isTypeSame, NeverType, Type, TypeBase, TypedDictEntries, TypeVarType, UnknownType, Variance } from '../types';
import { areTypesSame, containsLiteralType, getContainerDepth, InferenceContext, isLiteralType, isTupleClass, makeInferenceContext, selfSpecializeClass, stripTypeForm, transformExpectedType, transformPossibleRecursiveTypeAlias } from '../typeUtils';
import { ConstraintTracker } from '../constraintTracker';
import { addConstraintsForExpectedType } from '../constraintSolver';
import { getTypedDictMembersForClass, assignToTypedDict } from '../typedDicts';
import { AssignTypeFlags } from '../typeEvaluatorTypes';
import { convertSpecialFormToRuntimeValueWithPrefetched, verifySetEntryOrDictKeyIsHashableWithEvaluator, cloneBuiltinObjectWithLiteralWithEvaluator, inferTypeArgFromExpectedEntryTypeWithEvaluator, evaluateComprehensionForIfWithEvaluator, solveAndApplyConstraintsWithEvaluator } from './evaluatorCore';
import { inferVarianceForClassWithEvaluator } from './typeVarHandling';
import { getTypeOfStringListAsTypeWithEvaluator, getTypeOfStringWithEvaluator } from './expressionEvaluation';
import { isTypeFormSupportedForNode } from './pureHelpers';
import { makeTupleObject } from '../tuples';

const maxEntriesToUseForInference = 64;
export function getTypeOfStringListWithEvaluator(
    evaluator: TypeEvaluator,
    node: StringListNode,
    flags: EvalFlags,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResult {
    let typeResult: TypeResult | undefined;

    if ((flags & EvalFlags.StrLiteralAsType) !== 0 && (flags & EvalFlags.TypeFormArg) === 0) {
        return getTypeOfStringListAsTypeWithEvaluator(evaluator, node, flags);
    }

    const isBytesNode = (node: StringNode | FormatStringNode) =>
        (node.d.token.flags & StringTokenFlags.Bytes) !== 0;

    const firstStrIndex = node.d.strings.findIndex((str) => !isBytesNode(str));
    const firstBytesIndex = node.d.strings.findIndex((str) => isBytesNode(str));
    if (firstStrIndex >= 0 && firstBytesIndex >= 0) {
        evaluator.addDiagnostic(
            DiagnosticRule.reportGeneralTypeIssues,
            LocMessage.mixingBytesAndStr(),
            node.d.strings[Math.max(firstBytesIndex, firstStrIndex)]
        );

        return { type: UnknownType.create() };
    }

    const isBytes = firstBytesIndex >= 0;
    let isLiteralString = true;
    let isIncomplete = false;
    let isTemplate = false;

    node.d.strings.forEach((expr) => {
        const typeResult = getTypeOfStringWithEvaluator(evaluator, expr, prefetched);

        if (typeResult.isIncomplete) {
            isIncomplete = true;
        }

        let isExprLiteralString = false;

        if (isClassInstance(typeResult.type)) {
            if (ClassType.isBuiltIn(typeResult.type, 'str') && typeResult.type.priv.literalValue !== undefined) {
                isExprLiteralString = true;
            } else if (ClassType.isBuiltIn(typeResult?.type, 'LiteralString')) {
                isExprLiteralString = true;
            }

            if (typeResult.type.shared.name === 'Template') {
                isTemplate = true;
            }
        }

        if (!isExprLiteralString) {
            isLiteralString = false;
        }
    });

    if (isTemplate) {
        const templateType =
            prefetched?.templateClass && isInstantiableClass(prefetched?.templateClass)
                ? ClassType.cloneAsInstance(prefetched.templateClass)
                : UnknownType.create();

        typeResult = { type: templateType, isIncomplete };
    } else if (node.d.strings.some((str) => str.nodeType === ParseNodeType.FormatString)) {
        if (isLiteralString) {
            const literalStringType = evaluator.getTypingType(node, 'LiteralString');
            if (literalStringType && isInstantiableClass(literalStringType)) {
                typeResult = { type: ClassType.cloneAsInstance(literalStringType) };
            }
        }

        if (!typeResult) {
            typeResult = {
                type: evaluator.getBuiltInObject(node, isBytes ? 'bytes' : 'str'),
                isIncomplete,
            };
        }
    } else {
        typeResult = {
            type: cloneBuiltinObjectWithLiteralWithEvaluator(
                evaluator,
                node,
                isBytes ? 'bytes' : 'str',
                node.d.strings.map((s) => s.d.value).join('')
            ),
            isIncomplete,
        };
    }

    if (
        node.d.strings.length !== 1 ||
        node.d.strings[0].nodeType !== ParseNodeType.String ||
        !isTypeFormSupportedForNode(node)
    ) {
        return typeResult;
    }

    const stringNode = node.d.strings[0];
    const tokenFlags = stringNode.d.token.flags;
    const disallowedTokenFlags =
        StringTokenFlags.Bytes |
        StringTokenFlags.Raw |
        StringTokenFlags.Format |
        StringTokenFlags.Template |
        StringTokenFlags.Triplicate;
    const maxTypeFormStringLength = 256;

    if (
        (tokenFlags & disallowedTokenFlags) !== 0 ||
        stringNode.d.token.escapedValue.length >= maxTypeFormStringLength
    ) {
        return typeResult;
    }

    const typeFormResult = getTypeOfStringListAsTypeWithEvaluator(evaluator, node, flags);
    if (typeFormResult.type.props?.typeForm) {
        typeResult.type = TypeBase.cloneWithTypeForm(typeResult.type, typeFormResult.type.props.typeForm);
    }

    return typeResult;
}

export function getTypeOfComprehensionWithEvaluator(
    evaluator: TypeEvaluator,
    node: ComprehensionNode,
    flags: EvalFlags,
    inferenceContext?: InferenceContext
): TypeResult {
    let isIncomplete = false;
    let typeErrors = false;

    let isAsync = node.d.forIfNodes.some((comp, index) => {
        if (comp.nodeType === ParseNodeType.ComprehensionFor && comp.d.isAsync) {
            return true;
        }
        return index > 0 && ParseTreeUtils.containsAwaitNode(comp);
    });
    let type: Type = UnknownType.create();

    if (ParseTreeUtils.containsAwaitNode(node.d.expr)) {
        isAsync = true;
    }

    const builtInIteratorType = evaluator.getTypingType(node, isAsync ? 'AsyncGenerator' : 'Generator');

    const expectedEntryType = getExpectedEntryTypeForIterableWithEvaluator(
        evaluator,
        node,
        builtInIteratorType,
        inferenceContext
    );
    const elementTypeResult = getElementTypeFromComprehensionWithEvaluator(
        evaluator,
        node,
        flags | EvalFlags.StripTupleLiterals,
        expectedEntryType
    );

    if (elementTypeResult.isIncomplete) {
        isIncomplete = true;
    }

    if (elementTypeResult.typeErrors) {
        typeErrors = true;
    }

    let elementType = elementTypeResult.type;
    if (!expectedEntryType || !containsLiteralType(expectedEntryType)) {
        elementType = evaluator.stripLiteralValue(elementType);
    }

    if (builtInIteratorType && isInstantiableClass(builtInIteratorType)) {
        type = ClassType.cloneAsInstance(
            ClassType.specialize(
                builtInIteratorType,
                isAsync ? [elementType, evaluator.getNoneType()] : [elementType, evaluator.getNoneType(), evaluator.getNoneType()]
            )
        );
    }

    return { type, isIncomplete, typeErrors };
}
export function getKeyAndValueTypesFromDictionaryWithEvaluator(
    evaluator: TypeEvaluator,
    node: DictionaryNode,
    flags: EvalFlags,
    keyTypes: TypeResultWithNode[],
    valueTypes: TypeResultWithNode[],
    forceStrictInference: boolean,
    isValueTypeInvariant: boolean,
    prefetched: Partial<PrefetchedTypes> | undefined,
    expectedKeyType?: Type,
    expectedValueType?: Type,
    expectedTypedDictEntries?: TypedDictEntries,
    expectedDiagAddendum?: DiagnosticAddendum
): TypeResult {
    let isIncomplete = false;
    let typeErrors = false;

    const keyFlags = flags & ~(EvalFlags.TypeExpression | EvalFlags.StrLiteralAsType | EvalFlags.InstantiableType);

    node.d.items.forEach((entryNode, index) => {
        let addUnknown = true;

        if (entryNode.nodeType === ParseNodeType.DictionaryKeyEntry) {
            const keyTypeResult = evaluator.getTypeOfExpression(
                entryNode.d.keyExpr,
                keyFlags | EvalFlags.StripTupleLiterals,
                makeInferenceContext(
                    expectedKeyType ?? (forceStrictInference ? NeverType.createNever() : undefined)
                )
            );

            if (keyTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (keyTypeResult.typeErrors) {
                typeErrors = true;
            }

            const keyType = keyTypeResult.type;

            if (!keyTypeResult.isIncomplete && !keyTypeResult.typeErrors) {
                verifySetEntryOrDictKeyIsHashableWithEvaluator(evaluator, entryNode.d.keyExpr, keyType, /* isDictKey */ true);
            }

            if (expectedDiagAddendum && keyTypeResult.expectedTypeDiagAddendum) {
                expectedDiagAddendum.addAddendum(keyTypeResult.expectedTypeDiagAddendum);
            }

            let valueTypeResult: TypeResult;
            let entryInferenceContext: InferenceContext | undefined;

            if (
                expectedTypedDictEntries &&
                isClassInstance(keyType) &&
                ClassType.isBuiltIn(keyType, 'str') &&
                isLiteralType(keyType) &&
                (expectedTypedDictEntries.knownItems.has(keyType.priv.literalValue as string) ||
                    expectedTypedDictEntries.extraItems)
            ) {
                let effectiveValueType =
                    expectedTypedDictEntries.knownItems.get(keyType.priv.literalValue as string)?.valueType ??
                    expectedTypedDictEntries.extraItems?.valueType;
                if (effectiveValueType) {
                    const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
                    effectiveValueType = transformExpectedType(effectiveValueType, liveTypeVarScopes, node.start);
                }
                entryInferenceContext = makeInferenceContext(effectiveValueType);
                valueTypeResult = evaluator.getTypeOfExpression(
                    entryNode.d.valueExpr,
                    flags | EvalFlags.StripTupleLiterals,
                    entryInferenceContext
                );
            } else {
                let effectiveValueType =
                    expectedValueType ?? (forceStrictInference ? NeverType.createNever() : undefined);
                if (effectiveValueType) {
                    const liveTypeVarScopes = ParseTreeUtils.getTypeVarScopesForNode(node);
                    effectiveValueType = transformExpectedType(effectiveValueType, liveTypeVarScopes, node.start);
                }
                entryInferenceContext = makeInferenceContext(effectiveValueType);
                valueTypeResult = evaluator.getTypeOfExpression(
                    entryNode.d.valueExpr,
                    flags | EvalFlags.StripTupleLiterals,
                    entryInferenceContext
                );
            }

            if (entryInferenceContext && !valueTypeResult.typeErrors) {
                const fromExpectedType = inferTypeArgFromExpectedEntryTypeWithEvaluator(
                    evaluator,
                    entryInferenceContext,
                    [valueTypeResult.type],
                    !isValueTypeInvariant
                );

                if (fromExpectedType) {
                    valueTypeResult = { ...valueTypeResult, type: fromExpectedType };
                }
            }

            if (expectedDiagAddendum && valueTypeResult.expectedTypeDiagAddendum) {
                expectedDiagAddendum.addAddendum(valueTypeResult.expectedTypeDiagAddendum);
            }

            const valueType = valueTypeResult.type;
            if (valueTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (valueTypeResult.typeErrors) {
                typeErrors = true;
            }

            if (forceStrictInference || index < maxEntriesToUseForInference) {
                if (isClass(keyType) && isLiteralType(keyType)) {
                    const existingIndex = keyTypes.findIndex((kt) => isTypeSame(keyType, kt.type));
                    if (existingIndex >= 0) {
                        keyTypes.splice(existingIndex, 1);
                        valueTypes.splice(existingIndex, 1);
                    }
                }

                keyTypes.push({ node: entryNode.d.keyExpr, type: keyType });
                valueTypes.push({ node: entryNode.d.valueExpr, type: valueType });
            }

            addUnknown = false;
        } else if (entryNode.nodeType === ParseNodeType.DictionaryExpandEntry) {
            let expectedType: Type | undefined;
            if (expectedKeyType && expectedValueType) {
                if (
                    prefetched?.supportsKeysAndGetItemClass &&
                    isInstantiableClass(prefetched.supportsKeysAndGetItemClass)
                ) {
                    expectedType = ClassType.cloneAsInstance(
                        ClassType.specialize(prefetched.supportsKeysAndGetItemClass, [
                            expectedKeyType,
                            expectedValueType,
                        ])
                    );
                }
            }

            const entryInferenceContext = makeInferenceContext(expectedType);
            let unexpandedTypeResult = evaluator.getTypeOfExpression(
                entryNode.d.expr,
                flags | EvalFlags.StripTupleLiterals,
                entryInferenceContext
            );

            if (entryInferenceContext && !unexpandedTypeResult.typeErrors) {
                const fromExpectedType = inferTypeArgFromExpectedEntryTypeWithEvaluator(
                    evaluator,
                    entryInferenceContext,
                    [unexpandedTypeResult.type],
                    !isValueTypeInvariant
                );

                if (fromExpectedType) {
                    unexpandedTypeResult = { ...unexpandedTypeResult, type: fromExpectedType };
                }
            }

            if (unexpandedTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (unexpandedTypeResult.typeErrors) {
                typeErrors = true;
            }

            const unexpandedType = unexpandedTypeResult.type;

            if (isAnyOrUnknown(unexpandedType)) {
                if (forceStrictInference || index < maxEntriesToUseForInference) {
                    keyTypes.push({ node: entryNode, type: unexpandedType });
                    valueTypes.push({ node: entryNode, type: unexpandedType });
                }
                addUnknown = false;
            } else if (isClassInstance(unexpandedType) && ClassType.isTypedDictClass(unexpandedType)) {
                if (prefetched?.strClass && isInstantiableClass(prefetched.strClass)) {
                    const strObject = ClassType.cloneAsInstance(prefetched.strClass);
                    const tdEntries = getTypedDictMembersForClass(
                        evaluator,
                        unexpandedType,
                        /* allowNarrowed */ true
                    );

                    tdEntries.knownItems.forEach((entry, name) => {
                        if (entry.isRequired || entry.isProvided) {
                            keyTypes.push({
                                node: entryNode,
                                type: ClassType.cloneWithLiteral(strObject, name),
                            });
                            valueTypes.push({ node: entryNode, type: entry.valueType });
                        }
                    });

                    if (!expectedTypedDictEntries) {
                        keyTypes.push({ node: entryNode, type: ClassType.cloneAsInstance(strObject) });
                        valueTypes.push({
                            node: entryNode,
                            type: tdEntries.extraItems?.valueType ?? evaluator.getObjectType(),
                        });
                    }

                    addUnknown = false;
                }
            } else if (
                prefetched?.supportsKeysAndGetItemClass &&
                isInstantiableClass(prefetched.supportsKeysAndGetItemClass)
            ) {
                const mappingConstraints = new ConstraintTracker();

                const supportsKeysAndGetItemClass = selfSpecializeClass(prefetched.supportsKeysAndGetItemClass);

                if (
                    evaluator.assignType(
                        ClassType.cloneAsInstance(supportsKeysAndGetItemClass),
                        unexpandedType,
                        /* diag */ undefined,
                        mappingConstraints,
                        AssignTypeFlags.RetainLiteralsForTypeVar
                    )
                ) {
                    const specializedMapping = evaluator.solveAndApplyConstraints(
                        supportsKeysAndGetItemClass,
                        mappingConstraints
                    ) as ClassType;
                    const typeArgs = specializedMapping.priv.typeArgs;
                    if (typeArgs && typeArgs.length >= 2) {
                        if (forceStrictInference || index < maxEntriesToUseForInference) {
                            keyTypes.push({ node: entryNode, type: typeArgs[0] });
                            valueTypes.push({ node: entryNode, type: typeArgs[1] });
                        }
                        addUnknown = false;
                    }
                } else {
                    evaluator.addDiagnostic(
                        DiagnosticRule.reportGeneralTypeIssues,
                        LocMessage.dictUnpackIsNotMapping(),
                        entryNode
                    );
                }
            }
        } else if (entryNode.nodeType === ParseNodeType.Comprehension) {
            const dictEntryTypeResult = getElementTypeFromComprehensionWithEvaluator(
                evaluator,
                entryNode,
                flags | EvalFlags.StripTupleLiterals,
                expectedValueType,
                expectedKeyType
            );
            const dictEntryType = dictEntryTypeResult.type;
            if (dictEntryTypeResult.isIncomplete) {
                isIncomplete = true;
            }

            if (dictEntryTypeResult.typeErrors) {
                typeErrors = true;
            }

            if (isClassInstance(dictEntryType) && isTupleClass(dictEntryType)) {
                const typeArgs = dictEntryType.priv.tupleTypeArgs?.map((t) => t.type);
                if (typeArgs && typeArgs.length === 2) {
                    if (forceStrictInference || index < maxEntriesToUseForInference) {
                        keyTypes.push({ node: entryNode, type: typeArgs[0] });
                        valueTypes.push({ node: entryNode, type: typeArgs[1] });
                    }
                    addUnknown = false;
                }
            }
        }

        if (addUnknown) {
            if (forceStrictInference || index < maxEntriesToUseForInference) {
                keyTypes.push({ node: entryNode, type: UnknownType.create() });
                valueTypes.push({ node: entryNode, type: UnknownType.create() });
            }
        }
    });

    return { type: AnyType.create(), isIncomplete, typeErrors };
}
export function getTypeOfDictionaryWithContextWithEvaluator(
    evaluator: TypeEvaluator,
    node: DictionaryNode,
    flags: EvalFlags,
    inferenceContext: InferenceContext,
    prefetched: Partial<PrefetchedTypes> | undefined,
    expectedDiagAddendum?: DiagnosticAddendum
): TypeResult | undefined {
    inferenceContext.expectedType = transformPossibleRecursiveTypeAlias(inferenceContext.expectedType);
    let concreteExpectedType = evaluator.makeTopLevelTypeVarsConcrete(inferenceContext.expectedType);

    if (!isClassInstance(concreteExpectedType)) {
        return undefined;
    }

    const keyTypes: TypeResultWithNode[] = [];
    const valueTypes: TypeResultWithNode[] = [];
    let isIncomplete = false;
    let typeErrors = false;

    if (ClassType.isTypedDictClass(concreteExpectedType)) {
        concreteExpectedType = TypeBase.cloneForCondition(concreteExpectedType, undefined);

        const expectedTypedDictEntries = getTypedDictMembersForClass(evaluator, concreteExpectedType);

        const keyValueTypeResult = getKeyAndValueTypesFromDictionaryWithEvaluator(
            evaluator,
            node,
            flags,
            keyTypes,
            valueTypes,
            /* forceStrictInference */ true,
            /* isValueTypeInvariant */ true,
            prefetched,
            /* expectedKeyType */ undefined,
            /* expectedValueType */ undefined,
            expectedTypedDictEntries,
            expectedDiagAddendum
        );

        if (keyValueTypeResult.isIncomplete) {
            isIncomplete = true;
        }

        if (keyValueTypeResult.typeErrors) {
            typeErrors = true;
        }

        const resultTypedDict = assignToTypedDict(
            evaluator,
            concreteExpectedType,
            keyTypes,
            valueTypes,
            expectedDiagAddendum?.isEmpty() ? expectedDiagAddendum : undefined
        );
        if (resultTypedDict) {
            return {
                type: resultTypedDict,
                isIncomplete,
            };
        }

        return undefined;
    }

    let expectedKeyType: Type;
    let expectedValueType: Type;

    if (isAnyOrUnknown(inferenceContext.expectedType)) {
        expectedKeyType = inferenceContext.expectedType;
        expectedValueType = inferenceContext.expectedType;
    } else {
        const builtInDict = evaluator.getBuiltInObject(node, 'dict');
        if (!isClassInstance(builtInDict)) {
            return undefined;
        }

        const dictConstraints = new ConstraintTracker();
        if (
            !addConstraintsForExpectedType(
                evaluator,
                builtInDict,
                inferenceContext.expectedType,
                dictConstraints,
                ParseTreeUtils.getTypeVarScopesForNode(node),
                node.start
            )
        ) {
            return undefined;
        }

        const specializedDict = evaluator.solveAndApplyConstraints(
            ClassType.cloneAsInstantiable(builtInDict),
            dictConstraints
        ) as ClassType;
        if (!specializedDict.priv.typeArgs || specializedDict.priv.typeArgs.length !== 2) {
            return undefined;
        }

        expectedKeyType = specializedDict.priv.typeArgs[0];
        expectedValueType = specializedDict.priv.typeArgs[1];
    }

    let isValueTypeInvariant = false;
    if (isClassInstance(inferenceContext.expectedType)) {
        if (inferenceContext.expectedType.shared.typeParams.length >= 2) {
            const valueTypeParam = inferenceContext.expectedType.shared.typeParams[1];
            if (TypeVarType.getVariance(valueTypeParam) === Variance.Invariant) {
                isValueTypeInvariant = true;
            }
        }
    }

    const keyValueResult = getKeyAndValueTypesFromDictionaryWithEvaluator(
        evaluator,
        node,
        flags,
        keyTypes,
        valueTypes,
        /* forceStrictInference */ true,
        isValueTypeInvariant,
        prefetched,
        expectedKeyType,
        expectedValueType,
        undefined,
        expectedDiagAddendum
    );

    if (keyValueResult.isIncomplete) {
        isIncomplete = true;
    }

    if (keyValueResult.typeErrors) {
        typeErrors = true;
    }

    const specializedKeyType = inferTypeArgFromExpectedEntryTypeWithEvaluator(
        evaluator,
        makeInferenceContext(expectedKeyType),
        keyTypes.map((result) => result.type),
        /* isNarrowable */ false
    );
    const specializedValueType = inferTypeArgFromExpectedEntryTypeWithEvaluator(
        evaluator,
        makeInferenceContext(expectedValueType),
        valueTypes.map((result) => result.type),
        !isValueTypeInvariant
    );
    if (!specializedKeyType || !specializedValueType) {
        return undefined;
    }

    const type = evaluator.getBuiltInObject(node, 'dict', [specializedKeyType, specializedValueType]);
    return { type, isIncomplete, typeErrors };
}

export function getTypeOfDictionaryInferredWithEvaluator(
    evaluator: TypeEvaluator,
    node: DictionaryNode,
    flags: EvalFlags,
    hasExpectedType: boolean,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResult {
    const fallbackType = hasExpectedType ? AnyType.create() : UnknownType.create();
    let keyType: Type = fallbackType;
    let valueType: Type = fallbackType;

    const keyTypeResults: TypeResultWithNode[] = [];
    const valueTypeResults: TypeResultWithNode[] = [];

    let isEmptyContainer = false;
    let isIncomplete = false;
    let typeErrors = false;

    const keyValueResult = getKeyAndValueTypesFromDictionaryWithEvaluator(
        evaluator,
        node,
        flags,
        keyTypeResults,
        valueTypeResults,
        /* forceStrictInference */ hasExpectedType,
        /* isValueTypeInvariant */ false,
        prefetched
    );

    if (keyValueResult.isIncomplete) {
        isIncomplete = true;
    }

    if (keyValueResult.typeErrors) {
        typeErrors = true;
    }

    const keyTypes = keyTypeResults.map((t) =>
        stripTypeForm(convertSpecialFormToRuntimeValueWithPrefetched(evaluator.stripLiteralValue(t.type), flags, prefetched, !hasExpectedType))
    );
    const valueTypes = valueTypeResults.map((t) =>
        stripTypeForm(convertSpecialFormToRuntimeValueWithPrefetched(evaluator.stripLiteralValue(t.type), flags, prefetched, !hasExpectedType))
    );

    if (keyTypes.length > 0) {
        if (AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.strictDictionaryInference || hasExpectedType) {
            keyType = combineTypes(keyTypes);
        } else {
            keyType = areTypesSame(keyTypes, { ignorePseudoGeneric: true }) ? keyTypes[0] : fallbackType;
        }
    } else {
        keyType = fallbackType;
    }

    if (valueTypes.length > 0) {
        if (AnalyzerNodeInfo.getFileInfo(node).diagnosticRuleSet.strictDictionaryInference || hasExpectedType) {
            valueType = combineTypes(valueTypes);
        } else {
            valueType = areTypesSame(valueTypes, { ignorePseudoGeneric: true }) ? valueTypes[0] : fallbackType;
        }
    } else {
        valueType = fallbackType;
        isEmptyContainer = true;
    }

    const dictClass = evaluator.getBuiltInType(node, 'dict');
    const type = isInstantiableClass(dictClass)
        ? ClassType.cloneAsInstance(
              ClassType.specialize(
                  dictClass,
                  [keyType, valueType],
                  /* isTypeArgExplicit */ true,
                  /* includeSubclasses */ undefined,
                  /* tupleTypeArgs */ undefined,
                  isEmptyContainer
              )
          )
        : UnknownType.create();

    if (isIncomplete) {
        if (getContainerDepth(type) > maxInferredContainerDepth) {
            return { type: UnknownType.create() };
        }
    }

    return { type, isIncomplete, typeErrors };
}

export function getElementTypeFromComprehensionWithEvaluator(
    evaluator: TypeEvaluator,
    node: ComprehensionNode,
    flags: EvalFlags,
    expectedValueOrElementType?: Type,
    expectedKeyType?: Type
): TypeResult {
    let isIncomplete = false;
    let typeErrors = false;

    for (const forIfNode of node.d.forIfNodes) {
        if (evaluateComprehensionForIfWithEvaluator(evaluator, forIfNode)) {
            isIncomplete = true;
        }
    }

    let type: Type = UnknownType.create();
    if (node.d.expr.nodeType === ParseNodeType.DictionaryKeyEntry) {
        const keyTypeResult = evaluator.getTypeOfExpression(
            node.d.expr.d.keyExpr,
            flags,
            makeInferenceContext(expectedKeyType)
        );
        if (keyTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        if (keyTypeResult.typeErrors) {
            typeErrors = true;
        }
        let keyType = keyTypeResult.type;
        if (!expectedKeyType || !containsLiteralType(expectedKeyType)) {
            keyType = evaluator.stripLiteralValue(keyType);
        }

        const valueTypeResult = evaluator.getTypeOfExpression(
            node.d.expr.d.valueExpr,
            flags,
            makeInferenceContext(expectedValueOrElementType)
        );
        if (valueTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        if (valueTypeResult.typeErrors) {
            typeErrors = true;
        }
        let valueType = valueTypeResult.type;
        if (!expectedValueOrElementType || !containsLiteralType(expectedValueOrElementType)) {
            valueType = evaluator.stripLiteralValue(valueType);
        }

        type = makeTupleObject(evaluator, [
            { type: keyType, isUnbounded: false },
            { type: valueType, isUnbounded: false },
        ]);
    } else if (node.d.expr.nodeType === ParseNodeType.DictionaryExpandEntry) {
        evaluator.getTypeOfExpression(node.d.expr.d.expr, flags, makeInferenceContext(expectedValueOrElementType));
    } else if (isExpressionNode(node)) {
        const exprTypeResult = evaluator.getTypeOfExpression(
            node.d.expr as ExpressionNode,
            flags,
            makeInferenceContext(expectedValueOrElementType)
        );
        if (exprTypeResult.isIncomplete) {
            isIncomplete = true;
        }
        if (exprTypeResult.typeErrors) {
            typeErrors = true;
        }
        type = exprTypeResult.type;
    }

    return { type, isIncomplete, typeErrors };
}

export function getTypeOfListOrSetWithContextWithEvaluator(
    evaluator: TypeEvaluator,
    node: ListNode | SetNode,
    flags: EvalFlags,
    inferenceContext: InferenceContext
): TypeResult | undefined {
    const builtInClassName = node.nodeType === ParseNodeType.List ? 'list' : 'set';
    inferenceContext.expectedType = transformPossibleRecursiveTypeAlias(inferenceContext.expectedType);

    let isIncomplete = false;
    let typeErrors = false;
    const verifyHashable = node.nodeType === ParseNodeType.Set;

    const expectedEntryType = getExpectedEntryTypeForIterableWithEvaluator(
        evaluator,
        node,
        evaluator.getBuiltInType(node, builtInClassName),
        inferenceContext
    );
    if (!expectedEntryType) {
        return undefined;
    }

    const entryTypes: Type[] = [];
    const expectedTypeDiagAddendum = new DiagnosticAddendum();
    node.d.items.forEach((entry) => {
        let entryTypeResult: TypeResult;

        if (entry.nodeType === ParseNodeType.Comprehension) {
            entryTypeResult = getElementTypeFromComprehensionWithEvaluator(
                evaluator,
                entry,
                flags | EvalFlags.StripTupleLiterals,
                expectedEntryType
            );
        } else {
            entryTypeResult = evaluator.getTypeOfExpression(
                entry,
                flags | EvalFlags.StripTupleLiterals,
                makeInferenceContext(expectedEntryType)
            );
        }

        entryTypes.push(entryTypeResult.type);

        if (entryTypeResult.isIncomplete) {
            isIncomplete = true;
        }

        if (entryTypeResult.typeErrors) {
            typeErrors = true;
        }

        if (entryTypeResult.expectedTypeDiagAddendum) {
            expectedTypeDiagAddendum.addAddendum(entryTypeResult.expectedTypeDiagAddendum);
        }

        if (verifyHashable && !entryTypeResult.isIncomplete && !entryTypeResult.typeErrors) {
            verifySetEntryOrDictKeyIsHashableWithEvaluator(evaluator, entry, entryTypeResult.type, /* isDictKey */ false);
        }
    });

    let isTypeInvariant = false;

    if (isClassInstance(inferenceContext.expectedType)) {
        inferVarianceForClassWithEvaluator(evaluator, inferenceContext.expectedType);

        if (
            inferenceContext.expectedType.shared.typeParams.some(
                (t) => TypeVarType.getVariance(t) === Variance.Invariant
            )
        ) {
            isTypeInvariant = true;
        }
    }

    const specializedEntryType = inferTypeArgFromExpectedEntryTypeWithEvaluator(
        evaluator,
        makeInferenceContext(expectedEntryType),
        entryTypes,
        !isTypeInvariant
    );
    if (!specializedEntryType) {
        return { type: UnknownType.create(), isIncomplete, typeErrors: true, expectedTypeDiagAddendum };
    }

    const type = evaluator.getBuiltInObject(node, builtInClassName, [specializedEntryType]);
    return { type, isIncomplete, typeErrors, expectedTypeDiagAddendum };
}

export function getTypeOfListOrSetInferredWithEvaluator(
    evaluator: TypeEvaluator,
    node: ListNode | SetNode,
    flags: EvalFlags,
    hasExpectedType: boolean,
    prefetched: Partial<PrefetchedTypes> | undefined
): TypeResult {
    const builtInClassName = node.nodeType === ParseNodeType.List ? 'list' : 'set';
    const verifyHashable = node.nodeType === ParseNodeType.Set;
    let isEmptyContainer = false;
    let isIncomplete = false;
    let typeErrors = false;

    let entryTypes: Type[] = [];
    node.d.items.forEach((entry, index) => {
        let entryTypeResult: TypeResult;

        if (entry.nodeType === ParseNodeType.Comprehension && !entry.d.isGenerator) {
            entryTypeResult = getElementTypeFromComprehensionWithEvaluator(
                evaluator,
                entry,
                flags | EvalFlags.StripTupleLiterals
            );
        } else {
            entryTypeResult = evaluator.getTypeOfExpression(entry, flags | EvalFlags.StripTupleLiterals);
        }

        entryTypeResult.type = stripTypeForm(
            convertSpecialFormToRuntimeValueWithPrefetched(entryTypeResult.type, flags, prefetched, !hasExpectedType)
        );

        if (entryTypeResult.isIncomplete) {
            isIncomplete = true;
        }

        if (entryTypeResult.typeErrors) {
            typeErrors = true;
        }

        if (hasExpectedType || index < maxEntriesToUseForInference) {
            entryTypes.push(entryTypeResult.type);
        }

        if (verifyHashable && !entryTypeResult.isIncomplete && !entryTypeResult.typeErrors) {
            verifySetEntryOrDictKeyIsHashableWithEvaluator(evaluator, entry, entryTypeResult.type, /* isDictKey */ false);
        }
    });

    entryTypes = entryTypes.map((t) => evaluator.stripLiteralValue(t));

    let inferredEntryType: Type = hasExpectedType ? AnyType.create() : UnknownType.create();
    if (entryTypes.length > 0) {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
        if (
            (builtInClassName === 'list' && fileInfo.diagnosticRuleSet.strictListInference) ||
            (builtInClassName === 'set' && fileInfo.diagnosticRuleSet.strictSetInference) ||
            hasExpectedType
        ) {
            inferredEntryType = combineTypes(entryTypes, { maxSubtypeCount: maxSubtypesForInferredType });
        } else {
            inferredEntryType = areTypesSame(entryTypes, { ignorePseudoGeneric: true })
                ? entryTypes[0]
                : inferredEntryType;
        }
    } else {
        isEmptyContainer = true;
    }

    const listOrSetClass = evaluator.getBuiltInType(node, builtInClassName);
    const type = isInstantiableClass(listOrSetClass)
        ? ClassType.cloneAsInstance(
              ClassType.specialize(
                  listOrSetClass,
                  [inferredEntryType],
                  /* isTypeArgExplicit */ true,
                  /* includeSubclasses */ undefined,
                  /* tupleTypeArgs */ undefined,
                  isEmptyContainer
              )
          )
        : UnknownType.create();

    if (isIncomplete) {
        if (getContainerDepth(type) > maxInferredContainerDepth) {
            return { type: UnknownType.create() };
        }
    }

    return { type, isIncomplete, typeErrors };
}
export function getExpectedEntryTypeForIterableWithEvaluator(
    evaluator: TypeEvaluator,
    node: ListNode | SetNode | ComprehensionNode,
    expectedClassType: Type | undefined,
    inferenceContext?: InferenceContext
): Type | undefined {
    if (!inferenceContext) {
        return undefined;
    }

    if (!expectedClassType || !isInstantiableClass(expectedClassType)) {
        return undefined;
    }

    if (isAnyOrUnknown(inferenceContext.expectedType)) {
        return inferenceContext.expectedType;
    }

    if (!isClassInstance(inferenceContext.expectedType)) {
        return undefined;
    }

    const constraints = new ConstraintTracker();
    if (
        !addConstraintsForExpectedType(
            evaluator,
            ClassType.cloneAsInstance(expectedClassType),
            inferenceContext.expectedType,
            constraints,
            ParseTreeUtils.getTypeVarScopesForNode(node),
            node.start
        )
    ) {
        return undefined;
    }

    const specializedListOrSet = solveAndApplyConstraintsWithEvaluator(
        evaluator,
        expectedClassType,
        constraints
    ) as ClassType;
    if (!specializedListOrSet.priv.typeArgs) {
        return undefined;
    }

    return specializedListOrSet.priv.typeArgs[0];
}

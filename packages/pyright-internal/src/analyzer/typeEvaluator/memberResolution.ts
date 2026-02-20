// memberResolution.ts
// Member access, symbol resolution, binding, and declaration info.
// Extracted from evaluatorCore.ts for modularization.

import { appendArray } from '../../common/collectionUtils';
import { assert } from '../../common/debug';
import { Diagnostic, DiagnosticAddendum } from '../../common/diagnostic';
import { DiagnosticRule } from '../../common/diagnosticRules';
import { LocAddendum, LocMessage } from '../../localization/localize';
import { Uri } from '../../common/uri/uri';
import { ArgCategory, ExpressionNode, FunctionNode, ImportAsNode, ImportFromAsNode, ImportFromNode, ImportNode, NameNode, ParseNode, ParseNodeType, StringNode } from '../../parser/parseNodes';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { isAnnotationEvaluationPostponed } from '../analyzerFileInfo';
import { CodeFlowEngine } from '../codeFlowEngine';
import { getBoundInitMethod } from '../constructors';
import { Declaration, DeclarationType, VariableDeclaration } from '../declaration';
import { getDeclarationsWithUsesLocalNameRemoved, synthesizeAliasDeclaration } from '../declarationUtils';
import * as ParseTreeUtils from '../parseTreeUtils';
import { Scope, ScopeType, SymbolWithScope } from '../scope';
import * as ScopeUtils from '../scopeUtils';
import { Symbol, SynthesizedTypeInfo, SymbolTable } from '../symbol';
import { getLastTypedDeclarationForSymbol } from '../symbolUtils';
import { AbstractSymbol, Arg, EvalFlags, EvaluatorUsage, MemberAccessTypeResult, PrefetchedTypes, Reachability, SymbolDeclInfo, TypeEvaluator, TypeResult } from '../typeEvaluatorTypes';
import { AnyType, ClassType, FunctionType, isAny, isAnyOrUnknown, isClass, isClassInstance, isFunction, isFunctionOrOverloaded, isInstantiableClass, isModule, isOverloaded, isTypeSame, isUnknown, ModuleType, OverloadedType, Type, TypeBase, TypeVarType, UnknownType, Variance } from '../types';
import { ClassMember, convertToInstantiable, doForEachSubtype, getDeclaredGeneratorReturnType, isEllipsisType, isInstantiableMetaclass, isNoneInstance, lookUpClassMember, lookUpObjectMember, makeFunctionTypeVarsBound, mapSignatures, MemberAccessFlags, specializeWithDefaultTypeArgs } from '../typeUtils';
import { getAbstractSymbolInfoWithEvaluator, getAliasFromImportNode, getDeclarationFromKeywordParamForFunction, getSymbolResolutionIndex, isClassWithAsymmetricAttributeAccessorWithEvaluator, isLegalTypeAliasExprForm, isSymbolValidTypeExpressionCheck, MutableSymbolResolutionStackEntryLike, partiallySpecializeBoundMethodWithEvaluator } from './evaluatorCore';

export function tryPushSymbolResolutionEntry(
    symbolResolutionStack: MutableSymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown
) {
    const index = getSymbolResolutionIndex(symbolResolutionStack, symbolId, declaration);
    if (index >= 0) {
        for (let i = index + 1; i < symbolResolutionStack.length; i++) {
            symbolResolutionStack[i].isResultValid = false;
        }
        return false;
    }

    symbolResolutionStack.push({
        symbolId,
        declaration,
        isResultValid: true,
    });
    return true;
}


export function popSymbolResolutionEntry<T extends MutableSymbolResolutionStackEntryLike>(symbolResolutionStack: T[]) {
    return symbolResolutionStack.pop();
}


export function setSymbolResolutionPartialType(
    symbolResolutionStack: MutableSymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown,
    partialType: unknown
) {
    const index = getSymbolResolutionIndex(symbolResolutionStack, symbolId, declaration);
    if (index >= 0) {
        symbolResolutionStack[index].partialType = partialType;
    }
}


export function getSymbolResolutionPartialType(
    symbolResolutionStack: readonly MutableSymbolResolutionStackEntryLike[],
    symbolId: number,
    declaration: unknown
): unknown | undefined {
    const index = getSymbolResolutionIndex(symbolResolutionStack, symbolId, declaration);
    if (index >= 0) {
        return symbolResolutionStack[index].partialType;
    }

    return undefined;
}


export function includesVariableTypeDeclCheck(decls: Declaration[]): boolean {
    return decls.some((decl) => {
        if (decl.type === DeclarationType.Variable) {
            const fileInfo = AnalyzerNodeInfo.getFileInfo(decl.node);
            if (!fileInfo.isTypingStubFile && !fileInfo.isTypingExtensionsStubFile) {
                return true;
            }
        }

        if (decl.type === DeclarationType.Param) {
            return true;
        }

        return false;
    });
}


export function isPossibleTypeAliasDeclCheck(decl: Declaration): boolean {
    if (decl.type !== DeclarationType.Variable || !decl.typeAliasName || decl.typeAnnotationNode) {
        return false;
    }

    if (decl.node.parent?.nodeType !== ParseNodeType.Assignment) {
        return false;
    }

    return isLegalTypeAliasExprForm(decl.node.parent.d.rightExpr, /* allowStrLiteral */ false);
}


export function getIndexAccessMagicMethodNameForUsage(usage: EvaluatorUsage): string {
    if (usage.method === 'get') {
        return '__getitem__';
    } else if (usage.method === 'set') {
        return '__setitem__';
    } else {
        assert(usage.method === 'del');
        return '__delitem__';
    }
}


export function synthesizeTypeAliasPlaceholderForName(nameNode: NameNode, isTypeAliasType: boolean = false): TypeVarType {
    const placeholder = TypeVarType.createInstantiable(`__type_alias_${nameNode.d.value}`);
    placeholder.shared.isSynthesized = true;
    const typeVarScopeId = ParseTreeUtils.getScopeIdForNode(nameNode);
    const fileInfo = AnalyzerNodeInfo.getFileInfo(nameNode);

    placeholder.shared.recursiveAlias = {
        name: nameNode.d.value,
        fullName: ParseTreeUtils.getClassFullName(nameNode, fileInfo.moduleName, nameNode.d.value),
        moduleName: fileInfo.moduleName,
        fileUri: fileInfo.fileUri,
        typeVarScopeId,
        isTypeAliasType,
        typeParams: undefined,
        computedVariance: undefined,
    };
    placeholder.priv.scopeId = typeVarScopeId;

    return placeholder;
}


export function isLegalImplicitTypeAliasTypeCheck(type: Type): boolean {
    if (isEllipsisType(type)) {
        return false;
    }

    if (isUnknown(type)) {
        if (type.props?.specialForm && ClassType.isBuiltIn(type.props.specialForm, 'UnionType')) {
            return true;
        }
        return false;
    }

    let isLegal = true;
    doForEachSubtype(type, (subtype) => {
        if (!TypeBase.isInstantiable(subtype) && !isNoneInstance(subtype)) {
            isLegal = false;
        }
    });

    return isLegal;
}


export function lookUpSymbolRecursiveWithFlowContext(
    node: ParseNode,
    name: string,
    honorCodeFlow: boolean,
    codeFlowEngine: CodeFlowEngine,
    isFlowPathBetweenNodesFn: (sourceNode: ParseNode, sinkNode: ParseNode) => boolean,
    preferGlobalScope = false
): SymbolWithScope | undefined {
    const scopeNodeInfo = ParseTreeUtils.getEvaluationScopeNode(node);
    const scope = AnalyzerNodeInfo.getScope(scopeNodeInfo.node);

    let symbolWithScope = scope?.lookUpSymbolRecursive(name, { useProxyScope: !!scopeNodeInfo.useProxyScope });
    const scopeType = scope?.type ?? ScopeType.Module;

    // Functions and list comprehensions don't allow access to implicitly
    // aliased symbols in outer scopes if they haven't yet been assigned
    // within the local scope.
    let scopeTypeHonorsCodeFlow = scopeType !== ScopeType.Function && scopeType !== ScopeType.Comprehension;

    // Type parameter scopes don't honor code flow.
    if (symbolWithScope?.scope.type === ScopeType.TypeParameter) {
        scopeTypeHonorsCodeFlow = false;
    }

    if (symbolWithScope && honorCodeFlow && scopeTypeHonorsCodeFlow) {
        // Filter the declarations based on flow reachability.
        const reachableDecl = symbolWithScope.symbol.getDeclarations().find((decl) => {
            if (decl.type !== DeclarationType.Alias && decl.type !== DeclarationType.Intrinsic) {
                // Determine if the declaration is in the same execution scope as the "usageNode" node.
                let usageScopeNode = ParseTreeUtils.getExecutionScopeNode(node);
                const declNode: ParseNode =
                    decl.type === DeclarationType.Class ||
                    decl.type === DeclarationType.Function ||
                    decl.type === DeclarationType.TypeAlias
                        ? decl.node.d.name
                        : decl.node;
                const declScopeNode = ParseTreeUtils.getExecutionScopeNode(declNode);

                // If this is a type parameter scope, it will be a proxy for its
                // containing scope, so we need to use that instead.
                const usageScope = AnalyzerNodeInfo.getScope(usageScopeNode);
                if (usageScope?.proxy) {
                    const typeParamScope = AnalyzerNodeInfo.getScope(usageScopeNode);
                    if (!typeParamScope?.symbolTable.has(name) && usageScopeNode.parent) {
                        usageScopeNode = ParseTreeUtils.getExecutionScopeNode(usageScopeNode.parent);
                    }
                }

                if (usageScopeNode === declScopeNode) {
                    if (!isFlowPathBetweenNodesFn(declNode, node)) {
                        // If there was no control flow path from the usage back
                        // to the source, see if the usage node is reachable by
                        // any path.
                        const flowNode = AnalyzerNodeInfo.getFlowNode(node);
                        const isReachable =
                            flowNode &&
                            codeFlowEngine.getFlowNodeReachability(
                                flowNode,
                                /* sourceFlowNode */ undefined,
                                /* ignoreNoReturn */ true
                            ) === Reachability.Reachable;
                        return !isReachable;
                    }
                }
            }
            return true;
        });

        // If none of the declarations are reachable from the current node,
        // search for the symbol in outer scopes.
        if (!reachableDecl) {
            if (symbolWithScope.scope.type !== ScopeType.Function) {
                let nextScopeToSearch = symbolWithScope.scope.parent;
                const isOutsideCallerModule =
                    symbolWithScope.isOutsideCallerModule || symbolWithScope.scope.type === ScopeType.Module;
                let isBeyondExecutionScope =
                    symbolWithScope.isBeyondExecutionScope || symbolWithScope.scope.isIndependentlyExecutable();

                if (symbolWithScope.scope.type === ScopeType.Class) {
                    // There is an odd documented behavior for classes in that
                    // symbol resolution skips to the global scope rather than
                    // the next scope in the chain.
                    const globalScopeResult = symbolWithScope.scope.getGlobalScope();
                    nextScopeToSearch = globalScopeResult.scope;
                    if (globalScopeResult.isBeyondExecutionScope) {
                        isBeyondExecutionScope = true;
                    }
                }

                if (nextScopeToSearch) {
                    symbolWithScope = nextScopeToSearch.lookUpSymbolRecursive(name, {
                        isOutsideCallerModule,
                        isBeyondExecutionScope,
                    });
                } else {
                    symbolWithScope = undefined;
                }
            } else {
                symbolWithScope = undefined;
            }
        }
    }

    // PEP 563 indicates that if a forward reference can be resolved in the module
    // scope (or, by implication, in the builtins scope), it should prefer that
    // resolution over local resolutions.
    if (symbolWithScope && preferGlobalScope) {
        let curSymbolWithScope: SymbolWithScope | undefined = symbolWithScope;
        while (
            curSymbolWithScope.scope.type !== ScopeType.Module &&
            curSymbolWithScope.scope.type !== ScopeType.Builtin &&
            curSymbolWithScope.scope.type !== ScopeType.TypeParameter &&
            curSymbolWithScope.scope.parent
        ) {
            curSymbolWithScope = curSymbolWithScope.scope.parent.lookUpSymbolRecursive(name, {
                isOutsideCallerModule: curSymbolWithScope.isOutsideCallerModule,
                isBeyondExecutionScope:
                    curSymbolWithScope.isBeyondExecutionScope ||
                    curSymbolWithScope.scope.isIndependentlyExecutable(),
            });
            if (!curSymbolWithScope) {
                break;
            }
        }

        if (
            curSymbolWithScope?.scope.type === ScopeType.Module ||
            curSymbolWithScope?.scope.type === ScopeType.Builtin
        ) {
            symbolWithScope = curSymbolWithScope;
        }
    }

    return symbolWithScope;
}


export function getDeclInfoForStringNodeWithEvaluator(
    node: StringNode,
    evaluator: TypeEvaluator
): SymbolDeclInfo | undefined {
    const decls: Declaration[] = [];
    const synthesizedTypes: SynthesizedTypeInfo[] = [];
    const expectedType = evaluator.getExpectedType(node)?.type;

    if (expectedType) {
        doForEachSubtype(expectedType, (subtype) => {
            // If the expected type is a TypedDict then the node is either a key expression
            // or a single entry in a set. We then need to check that the value of the node
            // is a valid entry in the TypedDict to avoid resolving declarations for
            // synthesized symbols such as 'get'.
            if (isClassInstance(subtype) && ClassType.isTypedDictClass(subtype)) {
                const entry = subtype.shared.typedDictEntries?.knownItems.get(node.d.value);
                if (entry) {
                    const symbol = lookUpObjectMember(subtype, node.d.value)?.symbol;

                    if (symbol) {
                        appendArray(decls, symbol.getDeclarations());

                        const synthTypeInfo = symbol.getSynthesizedType();
                        if (synthTypeInfo) {
                            synthesizedTypes.push(synthTypeInfo);
                        }
                    }
                }
            }
        });
    }

    return decls.length === 0 ? undefined : { decls, synthesizedTypes };
}


export function getDeclInfoForNameNodeWithEvaluator(
    node: NameNode,
    evaluator: TypeEvaluator,
    skipUnreachableCode = true
): SymbolDeclInfo | undefined {
    if (skipUnreachableCode && AnalyzerNodeInfo.isCodeUnreachable(node)) {
        return undefined;
    }

    const decls: Declaration[] = [];
    const synthesizedTypes: SynthesizedTypeInfo[] = [];

    // If the node is part of a "from X import Y as Z" statement and the node
    // is the "Y" (non-aliased) name, we need to look up the alias symbol
    // since the non-aliased name is not in the symbol table.
    const alias = getAliasFromImportNode(node);
    if (alias) {
        const scope = ScopeUtils.getScopeForNode(node);
        if (scope) {
            // Look up the alias symbol.
            const symbolInScope = scope.lookUpSymbolRecursive(alias.d.value);
            if (symbolInScope) {
                // The alias could have more decls that don't refer to this import. Filter
                // out the one(s) that specifically associated with this import statement.
                const declsForThisImport = symbolInScope.symbol.getDeclarations().filter((decl) => {
                    return decl.type === DeclarationType.Alias && decl.node === node.parent;
                });

                appendArray(decls, getDeclarationsWithUsesLocalNameRemoved(declsForThisImport));
            }
        }
    } else if (
        node.parent &&
        node.parent.nodeType === ParseNodeType.MemberAccess &&
        node === node.parent.d.member
    ) {
        let baseType = evaluator.getType(node.parent.d.leftExpr);
        if (baseType) {
            baseType = evaluator.makeTopLevelTypeVarsConcrete(baseType);
            const memberName = node.parent.d.member.d.value;
            doForEachSubtype(baseType, (subtype) => {
                let symbol: Symbol | undefined;

                subtype = evaluator.makeTopLevelTypeVarsConcrete(subtype);

                if (isInstantiableClass(subtype)) {
                    // Try to find a member that has a declared type. If so, that
                    // overrides any inferred types.
                    let member = lookUpClassMember(subtype, memberName, MemberAccessFlags.DeclaredTypesOnly);
                    if (!member) {
                        member = lookUpClassMember(subtype, memberName);
                    }

                    if (!member) {
                        const metaclass = subtype.shared.effectiveMetaclass;
                        if (metaclass && isInstantiableClass(metaclass)) {
                            member = lookUpClassMember(metaclass, memberName);
                        }
                    }

                    if (member) {
                        symbol = member.symbol;
                    }
                } else if (isClassInstance(subtype)) {
                    // Try to find a member that has a declared type. If so, that
                    // overrides any inferred types.
                    let member = lookUpObjectMember(subtype, memberName, MemberAccessFlags.DeclaredTypesOnly);
                    if (!member) {
                        member = lookUpObjectMember(subtype, memberName);
                    }
                    if (member) {
                        symbol = member.symbol;
                    }
                } else if (isModule(subtype)) {
                    symbol = ModuleType.getField(subtype, memberName);
                }

                if (symbol) {
                    // By default, report only the declarations that have type annotations.
                    // If there are none, then report all of the unannotated declarations,
                    // which includes every assignment of that symbol.
                    const typedDecls = symbol.getTypedDeclarations();
                    if (typedDecls.length > 0) {
                        appendArray(decls, typedDecls);
                    } else {
                        appendArray(decls, symbol.getDeclarations());
                    }

                    const synthTypeInfo = symbol.getSynthesizedType();
                    if (synthTypeInfo) {
                        synthesizedTypes.push(synthTypeInfo);
                    }
                }
            });
        }
    } else if (node.parent && node.parent.nodeType === ParseNodeType.ModuleName) {
        const namePartIndex = node.parent.d.nameParts.findIndex((part) => part === node);
        const importInfo = AnalyzerNodeInfo.getImportInfo(node.parent);
        if (
            namePartIndex >= 0 &&
            importInfo &&
            !importInfo.isNativeLib &&
            namePartIndex < importInfo.resolvedUris.length
        ) {
            if (importInfo.resolvedUris[namePartIndex]) {
                evaluator.evaluateTypesForStatement(node);

                // Synthesize an alias declaration for this name part. The only
                // time this case is used is for IDE services such as
                // the find all references, hover provider and etc.
                decls.push(synthesizeAliasDeclaration(importInfo.resolvedUris[namePartIndex]));
            }
        }
    } else if (node.parent && node.parent.nodeType === ParseNodeType.Argument && node === node.parent.d.name) {
        // The target node is the name in a keyword argument. We need to determine whether
        // the corresponding keyword parameter can be determined from the context.
        const argNode = node.parent;
        const paramName = node.d.value;
        if (argNode.parent?.nodeType === ParseNodeType.Call) {
            const baseType = evaluator.getType(argNode.parent.d.leftExpr);

            if (baseType) {
                if (isFunction(baseType) && baseType.shared.declaration) {
                    const paramDecl = getDeclarationFromKeywordParamForFunction(baseType, paramName);
                    if (paramDecl) {
                        decls.push(paramDecl);
                    }
                } else if (isOverloaded(baseType)) {
                    OverloadedType.getOverloads(baseType).forEach((f) => {
                        const paramDecl = getDeclarationFromKeywordParamForFunction(f, paramName);
                        if (paramDecl) {
                            decls.push(paramDecl);
                        }
                    });
                } else if (isInstantiableClass(baseType)) {
                    const initMethodType = getBoundInitMethod(
                        evaluator,
                        argNode.parent.d.leftExpr,
                        ClassType.cloneAsInstance(baseType)
                    )?.type;

                    if (initMethodType && isFunction(initMethodType)) {
                        const paramDecl = getDeclarationFromKeywordParamForFunction(initMethodType, paramName);
                        if (paramDecl) {
                            decls.push(paramDecl);
                        } else if (
                            ClassType.isDataClass(baseType) ||
                            ClassType.isTypedDictClass(baseType) ||
                            ClassType.hasNamedTupleEntry(baseType, paramName)
                        ) {
                            const lookupResults = lookUpClassMember(baseType, paramName);

                            if (lookupResults) {
                                appendArray(decls, lookupResults.symbol.getDeclarations());

                                const synthTypeInfo = lookupResults.symbol.getSynthesizedType();
                                if (synthTypeInfo) {
                                    synthesizedTypes.push(synthTypeInfo);
                                }
                            }
                        }
                    } else if (
                        ClassType.isDataClass(baseType) ||
                        ClassType.isTypedDictClass(baseType) ||
                        ClassType.hasNamedTupleEntry(baseType, paramName)
                    ) {
                        // Some synthesized callables (notably TypedDict "constructors") don't have a
                        // meaningful __init__ signature we can map keyword arguments to. In these cases,
                        // treat the keyword as referring to the class entry so IDE features like
                        // go-to-definition and rename can bind to the field declaration.
                        const lookupResults = lookUpClassMember(baseType, paramName);

                        if (lookupResults) {
                            appendArray(decls, lookupResults.symbol.getDeclarations());

                            const synthTypeInfo = lookupResults.symbol.getSynthesizedType();
                            if (synthTypeInfo) {
                                synthesizedTypes.push(synthTypeInfo);
                            }
                        }
                    }
                }
            }
        } else if (argNode.parent?.nodeType === ParseNodeType.Class) {
            const classTypeResult = evaluator.getTypeOfClass(argNode.parent);

            // Validate the init subclass args for this class so we can properly
            // evaluate its custom keyword parameters.
            if (classTypeResult) {
                evaluator.validateInitSubclassArgs(argNode.parent, classTypeResult.classType);
            }
        }
    } else {
        const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

        // Determine if this node is within a quoted type annotation.
        const isWithinTypeAnnotation = ParseTreeUtils.isWithinTypeAnnotation(
            node,
            !isAnnotationEvaluationPostponed(AnalyzerNodeInfo.getFileInfo(node))
        );

        // Determine if this is part of a "type" statement.
        const isWithinTypeAliasStatement = !!ParseTreeUtils.getParentNodeOfType(node, ParseNodeType.TypeAlias);
        const allowForwardReferences = isWithinTypeAnnotation || isWithinTypeAliasStatement || fileInfo.isStubFile;

        const symbolWithScope = evaluator.lookUpSymbolRecursive(
            node,
            node.d.value,
            !allowForwardReferences,
            isWithinTypeAnnotation
        );

        if (symbolWithScope) {
            appendArray(decls, symbolWithScope.symbol.getDeclarations());

            const synthTypeInfo = symbolWithScope.symbol.getSynthesizedType();
            if (synthTypeInfo) {
                synthesizedTypes.push(synthTypeInfo);
            }
        }
    }

    return { decls, synthesizedTypes };
}


export function getCallbackProtocolTypeWithEvaluator(
    objType: ClassType,
    prefetched: Partial<PrefetchedTypes> | undefined,
    evaluator: TypeEvaluator,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    if (!isClassInstance(objType) || !ClassType.isProtocolClass(objType)) {
        return undefined;
    }

    // Make sure that the protocol class doesn't define any fields that
    // a normal function wouldn't be compatible with.
    for (const mroClass of objType.shared.mro) {
        if (isClass(mroClass) && ClassType.isProtocolClass(mroClass)) {
            for (const field of ClassType.getSymbolTable(mroClass)) {
                const fieldName = field[0];
                const fieldSymbol = field[1];

                // We're expecting a __call__ method. We will also ignore a
                // __slots__ definition, which is (by convention) ignored for
                // protocol matching.
                if (fieldName === '__call__' || fieldName === '__slots__') {
                    continue;
                }

                if (fieldSymbol.isIgnoredForProtocolMatch()) {
                    continue;
                }

                let fieldIsPartOfFunction = false;

                if (prefetched?.functionClass && isClass(prefetched.functionClass)) {
                    if (ClassType.getSymbolTable(prefetched.functionClass).has(field[0])) {
                        fieldIsPartOfFunction = true;
                    }
                }

                if (!fieldIsPartOfFunction) {
                    return undefined;
                }
            }
        }
    }

    const callType = evaluator.getBoundMagicMethod(
        objType,
        '__call__',
        /* selfType */ undefined,
        /* errorNode */ undefined,
        /* diag */ undefined,
        recursionCount
    );

    if (!callType) {
        return undefined;
    }

    return makeFunctionTypeVarsBound(callType);
}


export function bindFunctionToClassOrObjectWithEvaluator(
    baseType: ClassType | undefined,
    memberType: FunctionType | OverloadedType,
    evaluator: TypeEvaluator,
    memberClass?: ClassType,
    treatConstructorAsClassMethod = false,
    selfType?: ClassType | TypeVarType,
    diag?: DiagnosticAddendum,
    recursionCount = 0
): FunctionType | OverloadedType | undefined {
    return mapSignatures(memberType, (functionType) => {
        // If the caller specified no base type, always strip the
        // first parameter. This is used in cases like constructors.
        if (!baseType) {
            return FunctionType.clone(functionType, /* stripFirstParam */ true);
        }

        // If the first parameter was already stripped, it has already been
        // bound. Don't attempt to rebind.
        if (functionType.priv.strippedFirstParamType) {
            return functionType;
        }

        if (FunctionType.isInstanceMethod(functionType)) {
            // If the baseType is a metaclass, don't specialize the function.
            if (isInstantiableMetaclass(baseType)) {
                return functionType;
            }

            const baseObj: ClassType = isClassInstance(baseType)
                ? baseType
                : ClassType.cloneAsInstance(specializeWithDefaultTypeArgs(baseType));

            let stripFirstParam = false;
            if (isClassInstance(baseType)) {
                stripFirstParam = true;
            } else if (memberClass && isInstantiableMetaclass(memberClass)) {
                stripFirstParam = true;
            }

            return partiallySpecializeBoundMethodWithEvaluator(
                baseType,
                functionType,
                diag,
                recursionCount,
                selfType ?? baseObj,
                evaluator,
                stripFirstParam
            );
        }

        if (
            FunctionType.isClassMethod(functionType) ||
            (treatConstructorAsClassMethod && FunctionType.isConstructorMethod(functionType))
        ) {
            const baseClass = isInstantiableClass(baseType) ? baseType : ClassType.cloneAsInstantiable(baseType);
            const clsType = selfType ? (convertToInstantiable(selfType) as ClassType | TypeVarType) : undefined;

            return partiallySpecializeBoundMethodWithEvaluator(
                baseClass,
                functionType,
                diag,
                recursionCount,
                clsType ?? baseClass,
                evaluator,
                /* stripFirstParam */ true
            );
        }

        if (FunctionType.isStaticMethod(functionType)) {
            const baseClass = isInstantiableClass(baseType) ? baseType : ClassType.cloneAsInstantiable(baseType);

            return partiallySpecializeBoundMethodWithEvaluator(
                baseClass,
                functionType,
                diag,
                recursionCount,
                /* firstParamType */ undefined,
                evaluator,
                /* stripFirstParam */ false
            );
        }

        return functionType;
    });
}


export function getAliasedSymbolTypeForNameWithEvaluator(
    evaluator: TypeEvaluator,
    node: ImportAsNode | ImportFromAsNode | ImportFromNode,
    name: string,
    evaluateUnknownImportsAsAny: boolean
): Type | undefined {
    const symbolWithScope = evaluator.lookUpSymbolRecursive(node, name, /* honorCodeFlow */ true);
    if (!symbolWithScope) {
        return undefined;
    }

    // Normally there will be at most one decl associated with the import node, but
    // there can be multiple in the case of the "from .X import X" statement. In such
    // case, we want to choose the last declaration.
    const filteredDecls = symbolWithScope.symbol
        .getDeclarations()
        .filter(
            (decl) => ParseTreeUtils.isNodeContainedWithin(node, decl.node) && decl.type === DeclarationType.Alias
        );
    let aliasDecl = filteredDecls.length > 0 ? filteredDecls[filteredDecls.length - 1] : undefined;

    // If we didn't find an exact match, look for any alias associated with
    // this symbol. In cases where we have multiple ImportAs nodes that share
    // the same first-part name (e.g. "import asyncio" and "import asyncio.tasks"),
    // we may not find the declaration associated with this node.
    if (!aliasDecl) {
        aliasDecl = symbolWithScope.symbol.getDeclarations().find((decl) => decl.type === DeclarationType.Alias);
    }

    if (!aliasDecl) {
        return undefined;
    }

    assert(aliasDecl.type === DeclarationType.Alias);

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);

    // Try to resolve the alias while honoring external visibility.
    const resolvedAliasInfo = evaluator.resolveAliasDeclarationWithInfo(aliasDecl, /* resolveLocalNames */ true, {
        allowExternallyHiddenAccess: fileInfo.isStubFile,
    });

    if (!resolvedAliasInfo) {
        return undefined;
    }

    if (!resolvedAliasInfo.declaration) {
        return evaluateUnknownImportsAsAny ? AnyType.create() : UnknownType.create();
    }

    if (node.nodeType === ParseNodeType.ImportFromAs) {
        if (resolvedAliasInfo.isPrivate) {
            evaluator.addDiagnostic(
                DiagnosticRule.reportPrivateUsage,
                LocMessage.privateUsedOutsideOfModule().format({
                    name: node.d.name.d.value,
                }),
                node.d.name
            );
        }

        if (resolvedAliasInfo.privatePyTypedImporter) {
            const diag = new DiagnosticAddendum();
            if (resolvedAliasInfo.privatePyTypedImported) {
                diag.addMessage(
                    LocAddendum.privateImportFromPyTypedSource().format({
                        module: resolvedAliasInfo.privatePyTypedImported,
                    })
                );
            }
            evaluator.addDiagnostic(
                DiagnosticRule.reportPrivateImportUsage,
                LocMessage.privateImportFromPyTypedModule().format({
                    name: node.d.name.d.value,
                    module: resolvedAliasInfo.privatePyTypedImporter,
                }) + diag.getString(),
                node.d.name
            );
        }
    }

    return evaluator.getInferredTypeOfDeclaration(symbolWithScope.symbol, aliasDecl);
}


export function isAsymmetricDescriptorClassWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType
): boolean {
    // If the value has already been cached in this type, return the cached value.
    if (classType.priv.isAsymmetricDescriptor !== undefined) {
        return classType.priv.isAsymmetricDescriptor;
    }

    let isAsymmetric = false;

    const getterSymbolResult = lookUpClassMember(classType, '__get__', MemberAccessFlags.SkipBaseClasses);
    const setterSymbolResult = lookUpClassMember(classType, '__set__', MemberAccessFlags.SkipBaseClasses);

    if (!getterSymbolResult || !setterSymbolResult) {
        isAsymmetric = false;
    } else {
        let getterType = evaluator.getTypeOfMember(getterSymbolResult);
        const setterType = evaluator.getTypeOfMember(setterSymbolResult);

        // If this is an overload, find the appropriate overload.
        if (isOverloaded(getterType)) {
            const getOverloads = OverloadedType.getOverloads(getterType).filter((overload) => {
                if (overload.shared.parameters.length < 2) {
                    return false;
                }
                const param1Type = FunctionType.getParamType(overload, 1);
                return !isNoneInstance(param1Type);
            });

            if (getOverloads.length === 1) {
                getterType = getOverloads[0];
            } else {
                isAsymmetric = true;
            }
        }

        // If this is an overload, find the appropriate overload.
        if (isOverloaded(setterType)) {
            isAsymmetric = true;
        }

        // If either the setter or getter is an overload (or some other non-function type),
        // conservatively assume that it's not asymmetric.
        if (isFunction(getterType) && isFunction(setterType)) {
            // If there's no declared return type on the getter, assume it's symmetric.
            if (setterType.shared.parameters.length >= 3 && getterType.shared.declaredReturnType) {
                const setterValueType = FunctionType.getParamType(setterType, 2);
                const getterReturnType = FunctionType.getEffectiveReturnType(getterType) ?? UnknownType.create();

                if (!isTypeSame(setterValueType, getterReturnType)) {
                    isAsymmetric = true;
                }
            }
        }
    }

    // Cache the value for next time.
    classType.priv.isAsymmetricDescriptor = isAsymmetric;
    return isAsymmetric;
}


export function isExplicitTypeAliasDeclarationWithEvaluator(
    evaluator: TypeEvaluator,
    decl: Declaration
): boolean {
    if (decl.type !== DeclarationType.Variable || !decl.typeAnnotationNode) {
        return false;
    }

    if (
        decl.typeAnnotationNode.nodeType !== ParseNodeType.Name &&
        decl.typeAnnotationNode.nodeType !== ParseNodeType.MemberAccess &&
        decl.typeAnnotationNode.nodeType !== ParseNodeType.StringList
    ) {
        return false;
    }

    const type = evaluator.getTypeOfAnnotation(decl.typeAnnotationNode, { varTypeAnnotation: true, allowClassVar: true });
    return isClassInstance(type) && ClassType.isBuiltIn(type, 'TypeAlias');
}


export function getDeclaredReturnTypeWithEvaluator(
    evaluator: TypeEvaluator,
    node: FunctionNode
): Type | undefined {
    const functionTypeInfo = evaluator.getTypeOfFunction(node);
    const returnType = functionTypeInfo?.functionType.shared.declaredReturnType;

    if (!returnType) {
        return undefined;
    }

    if (FunctionType.isGenerator(functionTypeInfo.functionType)) {
        return getDeclaredGeneratorReturnType(functionTypeInfo.functionType);
    }

    return returnType;
}


export function getAbstractSymbolsWithEvaluator(
    evaluator: TypeEvaluator,
    classType: ClassType
): AbstractSymbol[] {
    const symbolTable = new Map<string, AbstractSymbol>();

    ClassType.getReverseMro(classType).forEach((mroClass) => {
        if (isInstantiableClass(mroClass)) {
            ClassType.getSymbolTable(mroClass).forEach((symbol, symbolName) => {
                const abstractSymbolInfo = getAbstractSymbolInfoWithEvaluator(evaluator, mroClass, symbolName);

                if (abstractSymbolInfo) {
                    symbolTable.set(symbolName, abstractSymbolInfo);
                } else {
                    symbolTable.delete(symbolName);
                }
            });
        }
    });

    const symbolList: AbstractSymbol[] = [];
    symbolTable.forEach((method) => {
        symbolList.push(method);
    });

    return symbolList;
}


export function isDeclaredTypeAliasWithEvaluator(
    evaluator: TypeEvaluator,
    expression: ExpressionNode
): boolean {
    if (expression.nodeType === ParseNodeType.TypeAnnotation) {
        if (expression.d.valueExpr.nodeType === ParseNodeType.Name) {
            const symbolWithScope = evaluator.lookUpSymbolRecursive(
                expression,
                expression.d.valueExpr.d.value,
                /* honorCodeFlow */ false
            );
            if (symbolWithScope) {
                const symbol = symbolWithScope.symbol;
                return symbol.getDeclarations().find((decl) => evaluator.isExplicitTypeAliasDeclaration(decl)) !== undefined;
            }
        }
    }

    return false;
}


export function validateSymbolIsTypeExpressionWithEvaluator(
    evaluator: TypeEvaluator,
    node: ExpressionNode,
    type: Type,
    includesVarDecl: boolean
): Type {
    if (isSymbolValidTypeExpressionCheck(type, includesVarDecl)) {
        return type;
    }

    const fileInfo = AnalyzerNodeInfo.getFileInfo(node);
    if (fileInfo.isTypingStubFile) {
        return type;
    }

    evaluator.addDiagnostic(DiagnosticRule.reportInvalidTypeForm, LocMessage.typeAnnotationVariable(), node);
    return UnknownType.create();
}


export function bindMethodForMemberAccessWithEvaluator(
    evaluator: TypeEvaluator,
    type: Type,
    concreteType: FunctionType | OverloadedType,
    memberInfo: ClassMember | undefined,
    classType: ClassType,
    selfType: ClassType | TypeVarType | undefined,
    flags: MemberAccessFlags,
    memberName: string,
    usage: EvaluatorUsage,
    diag: DiagnosticAddendum | undefined,
    recursionCount = 0
): TypeResult {
    if (usage.method === 'set') {
        const impl = isFunction(concreteType) ? concreteType : OverloadedType.getImplementation(concreteType);

        if (impl && isFunction(impl) && FunctionType.isFinal(impl) && memberInfo && isClass(memberInfo.classType)) {
            diag?.addMessage(
                LocMessage.finalMethodOverride().format({
                    name: memberName,
                    className: memberInfo.classType.shared.name,
                })
            );

            return { type: UnknownType.create(), typeErrors: true };
        }
    }

    if (TypeBase.isInstance(classType)) {
        if (!memberInfo || memberInfo.isInstanceMember) {
            return { type: type };
        }
    }

    const boundType = evaluator.bindFunctionToClassOrObject(
        classType,
        concreteType,
        memberInfo && isInstantiableClass(memberInfo.classType) ? memberInfo.classType : undefined,
        (flags & MemberAccessFlags.TreatConstructorAsClassMethod) !== 0,
        selfType && isClass(selfType) ? ClassType.cloneIncludeSubclasses(selfType) : selfType,
        diag,
        recursionCount
    );

    return { type: boundType ?? UnknownType.create(), typeErrors: !boundType };
}


export function applyAttributeAccessOverrideWithEvaluator(
    evaluator: TypeEvaluator,
    errorNode: ExpressionNode,
    classType: ClassType,
    usage: EvaluatorUsage,
    memberName: string,
    prefetched: Partial<PrefetchedTypes> | undefined,
    selfType?: ClassType | TypeVarType
): MemberAccessTypeResult | undefined {
    const getAttributeAccessMember = (name: string) => {
        return evaluator.getTypeOfBoundMember(
            errorNode,
            classType,
            name,
            /* usage */ undefined,
            /* diag */ undefined,
            MemberAccessFlags.SkipInstanceMembers |
                MemberAccessFlags.SkipObjectBaseClass |
                MemberAccessFlags.SkipTypeBaseClass |
                MemberAccessFlags.SkipAttributeAccessOverride,
            selfType
        )?.type;
    };

    let accessMemberType: Type | undefined;
    if (usage.method === 'get') {
        accessMemberType = getAttributeAccessMember('__getattribute__') ?? getAttributeAccessMember('__getattr__');
    } else if (usage.method === 'set') {
        accessMemberType = getAttributeAccessMember('__setattr__');
    } else {
        assert(usage.method === 'del');
        accessMemberType = getAttributeAccessMember('__delattr__');
    }

    if (!accessMemberType) {
        return undefined;
    }

    const argList: Arg[] = [];

    argList.push({
        argCategory: ArgCategory.Simple,
        typeResult: {
            type:
                prefetched?.strClass && isInstantiableClass(prefetched.strClass)
                    ? ClassType.cloneWithLiteral(ClassType.cloneAsInstance(prefetched.strClass), memberName)
                    : AnyType.create(),
        },
    });

    if (usage.method === 'set') {
        argList.push({
            argCategory: ArgCategory.Simple,
            typeResult: {
                type: usage.setType?.type ?? UnknownType.create(),
                isIncomplete: !!usage.setType?.isIncomplete,
            },
        });
    }

    if (!isFunctionOrOverloaded(accessMemberType)) {
        if (isAnyOrUnknown(accessMemberType)) {
            return { type: accessMemberType };
        }

        return undefined;
    }

    const callResult = evaluator.validateCallArgs(
        errorNode,
        argList,
        { type: accessMemberType },
        /* constraints */ undefined,
        /* skipUnknownArgCheck */ true,
        /* inferenceContext */ undefined
    );

    let isAsymmetricAccessor = false;
    if (usage.method === 'set') {
        isAsymmetricAccessor = isClassWithAsymmetricAttributeAccessorWithEvaluator(evaluator, classType);
    }

    return {
        type: callResult.returnType ?? UnknownType.create(),
        typeErrors: callResult.argumentErrors,
        isAsymmetricAccessor,
    };
}



const maxSingleOverloadArgTypeExpansionCount = 64;

const maxEntriesToUseForInference = 64;



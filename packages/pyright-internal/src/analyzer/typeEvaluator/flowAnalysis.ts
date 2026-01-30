/*
 * flowAnalysis.ts
 *
 * This module provides evaluator-specific glue around Pyright's code flow engine.
 *
 * The heavy lifting for flow-based type narrowing lives in `codeFlowEngine.ts`.
 * The evaluator typically:
 *  1. Determines whether code flow is required for a reference expression.
 *  2. Obtains (or creates) a `CodeFlowAnalyzer` for the current execution scope.
 *     - Analyzers are cached per execution scope, and sometimes per "typeAtStart".
 *     - During return-type inference for a specific call site, a temporary analyzer
 *       may be used instead of the cached one.
 *  3. Asks the analyzer for the type at a specific flow node.
 *
 * This file is designed to avoid dependency cycles:
 * - It does not import `typeEvaluator.ts`.
 * - It relies on a small context object for closure-owned behavior (cache policy,
 *   cancellation/complexity gating, return-type inference context).
 */

import { isNever, isUnbound, UnboundType, UnknownType } from '../types';

import { ClassNode, ExecutionScopeNode, FunctionNode, LambdaNode, ParseNode } from '../../parser/parseNodes';
import * as AnalyzerNodeInfo from '../analyzerNodeInfo';
import { CodeFlowAnalyzer, FlowNodeTypeOptions, FlowNodeTypeResult } from '../codeFlowEngine';
import {
    CodeFlowReferenceExpressionNode,
    createKeyForReference,
    FlowNode,
    wildcardImportReferenceKey,
} from '../codeFlowTypes';
import * as ParseTreeUtils from '../parseTreeUtils';
import { Reachability, TypeResult } from '../typeEvaluatorTypes';

export interface CodeFlowAnalyzerCacheEntry {
    typeAtStart: TypeResult | undefined;
    codeFlowAnalyzer: CodeFlowAnalyzer;
}

export interface FlowAnalysisContext {
    checkCodeFlowTooComplex: (node: CodeFlowReferenceExpressionNode) => boolean;

    // These hooks are owned by the evaluator closure.
    isNodeInReturnTypeInferenceContext: (executionScopeNode: any) => boolean;
    getCodeFlowAnalyzerForReturnTypeInferenceContext: () => CodeFlowAnalyzer;
    getCodeFlowAnalyzerForNode: (node: any, typeAtStart: TypeResult | undefined) => CodeFlowAnalyzer;
}

export interface AnalyzerCacheContext {
    codeFlowAnalyzerCache: Map<number, CodeFlowAnalyzerCacheEntry[]>;
    createCodeFlowAnalyzer: () => CodeFlowAnalyzer;
    isTypeSame: (t1: any, t2: any) => boolean;
}

// Mirrors the evaluator's caching policy:
// - Cache a `CodeFlowAnalyzer` per execution scope node.
// - Optionally key by `typeAtStart` to support analysis that begins with a known type.
//
// This is a performance-sensitive path, but its behavior is pure (cache lookup + allocation),
// so it's a good early extraction candidate.
export function getCodeFlowAnalyzerForNode(
    ctx: AnalyzerCacheContext,
    node: { id: number },
    typeAtStart: TypeResult | undefined
): CodeFlowAnalyzer {
    let entries = ctx.codeFlowAnalyzerCache.get(node.id);

    if (entries) {
        const cachedEntry = entries.find((entry) => {
            if (!typeAtStart || !entry.typeAtStart) {
                return !typeAtStart && !entry.typeAtStart;
            }

            if (!typeAtStart.isIncomplete !== !entry.typeAtStart.isIncomplete) {
                return false;
            }

            return ctx.isTypeSame(typeAtStart.type, entry.typeAtStart.type);
        });

        if (cachedEntry) {
            return cachedEntry.codeFlowAnalyzer;
        }
    }

    const analyzer = ctx.createCodeFlowAnalyzer();
    if (entries) {
        entries.push({ typeAtStart, codeFlowAnalyzer: analyzer });
    } else {
        entries = [{ typeAtStart, codeFlowAnalyzer: analyzer }];
        ctx.codeFlowAnalyzerCache.set(node.id, entries);
    }

    return analyzer;
}

// Attempts to determine the type of the reference expression at a point in the code.
// If the code flow analysis has nothing to say about that expression, it returns an undefined type.
//
// Normally flow analysis starts from the reference node, but `startNode` can be specified
// to override this in a few special cases (functions and lambdas) to support analysis
// of captured variables.
export function getFlowTypeOfReference(
    ctx: FlowAnalysisContext,
    reference: CodeFlowReferenceExpressionNode,
    startNode?: ClassNode | FunctionNode | LambdaNode,
    options?: FlowNodeTypeOptions
): FlowNodeTypeResult {
    // Step 1: Determine whether code flow is needed for this reference.
    const referenceKey = createKeyForReference(reference);
    const executionNode = ParseTreeUtils.getExecutionScopeNode(startNode?.parent ?? reference);
    const codeFlowExpressions = AnalyzerNodeInfo.getCodeFlowExpressions(executionNode);

    if (
        !codeFlowExpressions ||
        (!codeFlowExpressions.has(referenceKey) && !codeFlowExpressions.has(wildcardImportReferenceKey))
    ) {
        return FlowNodeTypeResult.create(/* type */ undefined, /* isIncomplete */ false);
    }

    // Step 2: If code flow is too complex, we still return a conservative answer.
    // The evaluator uses this to avoid timeouts on pathologically complex control flow.
    if (ctx.checkCodeFlowTooComplex(reference)) {
        return FlowNodeTypeResult.create(
            /* type */ options?.typeAtStart && isUnbound(options.typeAtStart.type) ? UnknownType.create() : undefined,
            /* isIncomplete */ true
        );
    }

    // Step 3: Choose a CodeFlowAnalyzer.
    // - For ordinary evaluation, use the cached analyzer per execution scope.
    // - For return-type inference contexts, use a temporary analyzer scoped to that inference.
    let analyzer: CodeFlowAnalyzer;

    if (ctx.isNodeInReturnTypeInferenceContext(executionNode)) {
        analyzer = ctx.getCodeFlowAnalyzerForReturnTypeInferenceContext();
    } else {
        analyzer = ctx.getCodeFlowAnalyzerForNode(executionNode, options?.typeAtStart);
    }

    // Step 4: Ask the analyzer for the type at the flow node.
    const flowNode = AnalyzerNodeInfo.getFlowNode(startNode ?? reference);
    if (flowNode === undefined) {
        return FlowNodeTypeResult.create(/* type */ undefined, /* isIncomplete */ false);
    }

    // The analyzer performs backward traversal and applies narrowing rules as it walks.
    // It may return `undefined` if the flow analysis has no refinements.
    return analyzer.getTypeFromCodeFlow(flowNode!, reference, options);
}

export interface NeverNarrowingContext {
    checkCodeFlowTooComplex: (node: ParseNode) => boolean;
    getCodeFlowAnalyzerForNode: (node: ExecutionScopeNode, typeAtStart: TypeResult | undefined) => CodeFlowAnalyzer;
}

export interface ReachabilityContext extends NeverNarrowingContext {
    // Small adapter over `codeFlowEngine.getFlowNodeReachability`.
    getFlowNodeReachability: (sinkFlowNode: FlowNode, sourceFlowNode?: FlowNode) => Reachability;
}

export function getNodeReachability(ctx: ReachabilityContext, node: ParseNode, sourceNode?: ParseNode): Reachability {
    if (ctx.checkCodeFlowTooComplex(node)) {
        return Reachability.Reachable;
    }

    const flowNode = AnalyzerNodeInfo.getFlowNode(node);
    if (!flowNode) {
        if (node.parent) {
            return getNodeReachability(ctx, node.parent, sourceNode);
        }
        return Reachability.UnreachableStructural;
    }

    const sourceFlowNode = sourceNode ? AnalyzerNodeInfo.getFlowNode(sourceNode) : undefined;
    return ctx.getFlowNodeReachability(flowNode, sourceFlowNode);
}

export function isNodeReachable(ctx: ReachabilityContext, node: ParseNode, sourceNode?: ParseNode): boolean {
    return getNodeReachability(ctx, node, sourceNode) === Reachability.Reachable;
}

export function getAfterNodeReachability(ctx: ReachabilityContext, node: ParseNode): Reachability {
    const returnFlowNode = AnalyzerNodeInfo.getAfterFlowNode(node);
    if (!returnFlowNode) {
        return Reachability.UnreachableStructural;
    }

    if (ctx.checkCodeFlowTooComplex(node)) {
        return Reachability.Reachable;
    }

    const reachability = ctx.getFlowNodeReachability(returnFlowNode);
    if (reachability !== Reachability.Reachable) {
        return reachability;
    }

    const executionScopeNode = ParseTreeUtils.getExecutionScopeNode(node);
    if (!isFlowNodeReachableUsingNeverNarrowing(ctx, executionScopeNode, returnFlowNode)) {
        return Reachability.UnreachableByAnalysis;
    }

    return Reachability.Reachable;
}

export function isAfterNodeReachable(ctx: ReachabilityContext, node: ParseNode): boolean {
    return getAfterNodeReachability(ctx, node) === Reachability.Reachable;
}

// Although a flow node may be reachable structurally, it might become unreachable after applying
// "never narrowing". This is used as a secondary filter for certain reachability-based diagnostics.
//
// Conceptually:
// - Ask the flow analyzer for the type at this flow node.
// - Seed analysis with `Unbound` at the start so the analyzer uses conservative defaults.
// - If analysis concludes `Never`, the path is considered unreachable-by-analysis.
export function isFlowNodeReachableUsingNeverNarrowing(
    ctx: NeverNarrowingContext,
    node: ExecutionScopeNode,
    flowNode: FlowNode
) {
    const analyzer = ctx.getCodeFlowAnalyzerForNode(node, /* typeAtStart */ undefined);

    if (ctx.checkCodeFlowTooComplex(node)) {
        return true;
    }

    const codeFlowResult = analyzer.getTypeFromCodeFlow(flowNode, /* reference */ undefined, {
        typeAtStart: { type: UnboundType.create() },
    });

    return codeFlowResult.type !== undefined && !isNever(codeFlowResult.type);
}

export interface FlowPathContext {
    checkCodeFlowTooComplex: (node: ParseNode) => boolean;
    getFlowNodeReachability: (
        sinkFlowNode: FlowNode,
        sourceFlowNode: FlowNode,
        ignoreNoReturn: boolean
    ) => Reachability;
}

// Determines whether there is a code flow path from `sourceNode` to `sinkNode`.
//
// This is used by the evaluator for reachability filtering during name/symbol resolution.
export function isFlowPathBetweenNodes(
    ctx: FlowPathContext,
    sourceNode: ParseNode,
    sinkNode: ParseNode,
    allowSelf = true
) {
    if (ctx.checkCodeFlowTooComplex(sourceNode)) {
        return true;
    }

    const sourceFlowNode = AnalyzerNodeInfo.getFlowNode(sourceNode);
    const sinkFlowNode = AnalyzerNodeInfo.getFlowNode(sinkNode);
    if (!sourceFlowNode || !sinkFlowNode) {
        return false;
    }
    if (sourceFlowNode === sinkFlowNode) {
        return allowSelf;
    }

    return (
        ctx.getFlowNodeReachability(sinkFlowNode, sourceFlowNode, /* ignoreNoReturn */ true) === Reachability.Reachable
    );
}

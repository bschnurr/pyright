/*
 * childFields.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Ordered parse-node child fields used to generate direct child traversal.
 */

export type ChildFieldKind = 'single' | 'optional' | 'array' | 'optionalArray';

export interface ChildField {
    readonly kind: ChildFieldKind;
    readonly name: string;
}

export interface ChildFieldSpec {
    readonly nodeType: string;
    readonly nodeInterface: string;
    readonly fields: readonly ChildField[];
}

export const childFields = [
    {
        nodeType: 'Error',
        nodeInterface: 'ErrorNode',
        fields: [
            { kind: 'optional', name: 'child' },
            { kind: 'optionalArray', name: 'decorators' },
        ],
    },
    {
        nodeType: 'Argument',
        nodeInterface: 'ArgumentNode',
        fields: [
            { kind: 'optional', name: 'name' },
            { kind: 'single', name: 'valueExpr' },
        ],
    },
    {
        nodeType: 'Assert',
        nodeInterface: 'AssertNode',
        fields: [
            { kind: 'single', name: 'testExpr' },
            { kind: 'optional', name: 'exceptionExpr' },
        ],
    },
    {
        nodeType: 'AssignmentExpression',
        nodeInterface: 'AssignmentExpressionNode',
        fields: [
            { kind: 'single', name: 'name' },
            { kind: 'single', name: 'rightExpr' },
        ],
    },
    {
        nodeType: 'Assignment',
        nodeInterface: 'AssignmentNode',
        fields: [
            { kind: 'single', name: 'leftExpr' },
            { kind: 'single', name: 'rightExpr' },
            { kind: 'optional', name: 'annotationComment' },
        ],
    },
    {
        nodeType: 'AugmentedAssignment',
        nodeInterface: 'AugmentedAssignmentNode',
        fields: [
            { kind: 'single', name: 'leftExpr' },
            { kind: 'single', name: 'rightExpr' },
        ],
    },
    { nodeType: 'Await', nodeInterface: 'AwaitNode', fields: [{ kind: 'single', name: 'expr' }] },
    {
        nodeType: 'BinaryOperation',
        nodeInterface: 'BinaryOperationNode',
        fields: [
            { kind: 'single', name: 'leftExpr' },
            { kind: 'single', name: 'rightExpr' },
        ],
    },
    { nodeType: 'Break', nodeInterface: 'BreakNode', fields: [] },
    {
        nodeType: 'Call',
        nodeInterface: 'CallNode',
        fields: [
            { kind: 'single', name: 'leftExpr' },
            { kind: 'array', name: 'args' },
        ],
    },
    {
        nodeType: 'Case',
        nodeInterface: 'CaseNode',
        fields: [
            { kind: 'single', name: 'pattern' },
            { kind: 'optional', name: 'guardExpr' },
            { kind: 'single', name: 'suite' },
        ],
    },
    {
        nodeType: 'Class',
        nodeInterface: 'ClassNode',
        fields: [
            { kind: 'array', name: 'decorators' },
            { kind: 'single', name: 'name' },
            { kind: 'optional', name: 'typeParams' },
            { kind: 'array', name: 'arguments' },
            { kind: 'single', name: 'suite' },
        ],
    },
    {
        nodeType: 'Comprehension',
        nodeInterface: 'ComprehensionNode',
        fields: [
            { kind: 'single', name: 'expr' },
            { kind: 'array', name: 'forIfNodes' },
        ],
    },
    {
        nodeType: 'ComprehensionFor',
        nodeInterface: 'ComprehensionForNode',
        fields: [
            { kind: 'single', name: 'targetExpr' },
            { kind: 'single', name: 'iterableExpr' },
        ],
    },
    {
        nodeType: 'ComprehensionIf',
        nodeInterface: 'ComprehensionIfNode',
        fields: [{ kind: 'single', name: 'testExpr' }],
    },
    { nodeType: 'Constant', nodeInterface: 'ConstantNode', fields: [] },
    { nodeType: 'Continue', nodeInterface: 'ContinueNode', fields: [] },
    { nodeType: 'Decorator', nodeInterface: 'DecoratorNode', fields: [{ kind: 'single', name: 'expr' }] },
    { nodeType: 'Del', nodeInterface: 'DelNode', fields: [{ kind: 'array', name: 'targets' }] },
    { nodeType: 'Dictionary', nodeInterface: 'DictionaryNode', fields: [{ kind: 'array', name: 'items' }] },
    {
        nodeType: 'DictionaryExpandEntry',
        nodeInterface: 'DictionaryExpandEntryNode',
        fields: [{ kind: 'single', name: 'expr' }],
    },
    {
        nodeType: 'DictionaryKeyEntry',
        nodeInterface: 'DictionaryKeyEntryNode',
        fields: [
            { kind: 'single', name: 'keyExpr' },
            { kind: 'single', name: 'valueExpr' },
        ],
    },
    { nodeType: 'Ellipsis', nodeInterface: 'EllipsisNode', fields: [] },
    {
        nodeType: 'If',
        nodeInterface: 'IfNode',
        fields: [
            { kind: 'single', name: 'testExpr' },
            { kind: 'single', name: 'ifSuite' },
            { kind: 'optional', name: 'elseSuite' },
        ],
    },
    { nodeType: 'Import', nodeInterface: 'ImportNode', fields: [{ kind: 'array', name: 'list' }] },
    {
        nodeType: 'ImportAs',
        nodeInterface: 'ImportAsNode',
        fields: [
            { kind: 'single', name: 'module' },
            { kind: 'optional', name: 'alias' },
        ],
    },
    {
        nodeType: 'ImportFrom',
        nodeInterface: 'ImportFromNode',
        fields: [
            { kind: 'optional', name: 'module' },
            { kind: 'array', name: 'imports' },
        ],
    },
    {
        nodeType: 'ImportFromAs',
        nodeInterface: 'ImportFromAsNode',
        fields: [
            { kind: 'single', name: 'name' },
            { kind: 'optional', name: 'alias' },
        ],
    },
    {
        nodeType: 'Index',
        nodeInterface: 'IndexNode',
        fields: [
            { kind: 'single', name: 'leftExpr' },
            { kind: 'array', name: 'items' },
        ],
    },
    {
        nodeType: 'Except',
        nodeInterface: 'ExceptNode',
        fields: [
            { kind: 'optional', name: 'typeExpr' },
            { kind: 'optional', name: 'name' },
            { kind: 'single', name: 'exceptSuite' },
        ],
    },
    {
        nodeType: 'For',
        nodeInterface: 'ForNode',
        fields: [
            { kind: 'single', name: 'targetExpr' },
            { kind: 'single', name: 'iterableExpr' },
            { kind: 'single', name: 'forSuite' },
            { kind: 'optional', name: 'elseSuite' },
        ],
    },
    {
        nodeType: 'FormatString',
        nodeInterface: 'FormatStringNode',
        fields: [
            { kind: 'array', name: 'fieldExprs' },
            { kind: 'optionalArray', name: 'formatExprs' },
        ],
    },
    {
        nodeType: 'Function',
        nodeInterface: 'FunctionNode',
        fields: [
            { kind: 'array', name: 'decorators' },
            { kind: 'single', name: 'name' },
            { kind: 'optional', name: 'typeParams' },
            { kind: 'array', name: 'params' },
            { kind: 'optional', name: 'returnAnnotation' },
            { kind: 'optional', name: 'funcAnnotationComment' },
            { kind: 'single', name: 'suite' },
        ],
    },
    {
        nodeType: 'FunctionAnnotation',
        nodeInterface: 'FunctionAnnotationNode',
        fields: [
            { kind: 'array', name: 'paramAnnotations' },
            { kind: 'single', name: 'returnAnnotation' },
        ],
    },
    { nodeType: 'Global', nodeInterface: 'GlobalNode', fields: [{ kind: 'array', name: 'targets' }] },
    {
        nodeType: 'Lambda',
        nodeInterface: 'LambdaNode',
        fields: [
            { kind: 'array', name: 'params' },
            { kind: 'single', name: 'expr' },
        ],
    },
    { nodeType: 'List', nodeInterface: 'ListNode', fields: [{ kind: 'array', name: 'items' }] },
    {
        nodeType: 'Match',
        nodeInterface: 'MatchNode',
        fields: [
            { kind: 'single', name: 'expr' },
            { kind: 'array', name: 'cases' },
        ],
    },
    {
        nodeType: 'MemberAccess',
        nodeInterface: 'MemberAccessNode',
        fields: [
            { kind: 'single', name: 'leftExpr' },
            { kind: 'single', name: 'member' },
        ],
    },
    { nodeType: 'ModuleName', nodeInterface: 'ModuleNameNode', fields: [{ kind: 'array', name: 'nameParts' }] },
    { nodeType: 'Module', nodeInterface: 'ModuleNode', fields: [{ kind: 'array', name: 'statements' }] },
    { nodeType: 'Name', nodeInterface: 'NameNode', fields: [] },
    { nodeType: 'Nonlocal', nodeInterface: 'NonlocalNode', fields: [{ kind: 'array', name: 'targets' }] },
    { nodeType: 'Number', nodeInterface: 'NumberNode', fields: [] },
    {
        nodeType: 'Parameter',
        nodeInterface: 'ParameterNode',
        fields: [
            { kind: 'optional', name: 'name' },
            { kind: 'optional', name: 'annotation' },
            { kind: 'optional', name: 'annotationComment' },
            { kind: 'optional', name: 'defaultValue' },
        ],
    },
    { nodeType: 'Pass', nodeInterface: 'PassNode', fields: [] },
    {
        nodeType: 'PatternAs',
        nodeInterface: 'PatternAsNode',
        fields: [
            { kind: 'array', name: 'orPatterns' },
            { kind: 'optional', name: 'target' },
        ],
    },
    {
        nodeType: 'PatternClass',
        nodeInterface: 'PatternClassNode',
        fields: [
            { kind: 'single', name: 'className' },
            { kind: 'array', name: 'args' },
        ],
    },
    {
        nodeType: 'PatternClassArgument',
        nodeInterface: 'PatternClassArgumentNode',
        fields: [
            { kind: 'optional', name: 'name' },
            { kind: 'single', name: 'pattern' },
        ],
    },
    { nodeType: 'PatternCapture', nodeInterface: 'PatternCaptureNode', fields: [{ kind: 'single', name: 'target' }] },
    { nodeType: 'PatternLiteral', nodeInterface: 'PatternLiteralNode', fields: [{ kind: 'single', name: 'expr' }] },
    {
        nodeType: 'PatternMappingExpandEntry',
        nodeInterface: 'PatternMappingExpandEntryNode',
        fields: [{ kind: 'single', name: 'target' }],
    },
    {
        nodeType: 'PatternMappingKeyEntry',
        nodeInterface: 'PatternMappingKeyEntryNode',
        fields: [
            { kind: 'single', name: 'keyPattern' },
            { kind: 'single', name: 'valuePattern' },
        ],
    },
    { nodeType: 'PatternMapping', nodeInterface: 'PatternMappingNode', fields: [{ kind: 'array', name: 'entries' }] },
    { nodeType: 'PatternSequence', nodeInterface: 'PatternSequenceNode', fields: [{ kind: 'array', name: 'entries' }] },
    { nodeType: 'PatternValue', nodeInterface: 'PatternValueNode', fields: [{ kind: 'single', name: 'expr' }] },
    {
        nodeType: 'Raise',
        nodeInterface: 'RaiseNode',
        fields: [
            { kind: 'optional', name: 'expr' },
            { kind: 'optional', name: 'fromExpr' },
        ],
    },
    { nodeType: 'Return', nodeInterface: 'ReturnNode', fields: [{ kind: 'optional', name: 'expr' }] },
    { nodeType: 'Set', nodeInterface: 'SetNode', fields: [{ kind: 'array', name: 'items' }] },
    {
        nodeType: 'Slice',
        nodeInterface: 'SliceNode',
        fields: [
            { kind: 'optional', name: 'startValue' },
            { kind: 'optional', name: 'endValue' },
            { kind: 'optional', name: 'stepValue' },
        ],
    },
    { nodeType: 'StatementList', nodeInterface: 'StatementListNode', fields: [{ kind: 'array', name: 'statements' }] },
    {
        nodeType: 'StringList',
        nodeInterface: 'StringListNode',
        fields: [
            { kind: 'optional', name: 'annotation' },
            { kind: 'array', name: 'strings' },
        ],
    },
    { nodeType: 'String', nodeInterface: 'StringNode', fields: [] },
    { nodeType: 'Suite', nodeInterface: 'SuiteNode', fields: [{ kind: 'array', name: 'statements' }] },
    {
        nodeType: 'Ternary',
        nodeInterface: 'TernaryNode',
        fields: [
            { kind: 'single', name: 'ifExpr' },
            { kind: 'single', name: 'testExpr' },
            { kind: 'single', name: 'elseExpr' },
        ],
    },
    { nodeType: 'Tuple', nodeInterface: 'TupleNode', fields: [{ kind: 'array', name: 'items' }] },
    {
        nodeType: 'Try',
        nodeInterface: 'TryNode',
        fields: [
            { kind: 'single', name: 'trySuite' },
            { kind: 'array', name: 'exceptClauses' },
            { kind: 'optional', name: 'elseSuite' },
            { kind: 'optional', name: 'finallySuite' },
        ],
    },
    {
        nodeType: 'TypeAlias',
        nodeInterface: 'TypeAliasNode',
        fields: [
            { kind: 'single', name: 'name' },
            { kind: 'optional', name: 'typeParams' },
            { kind: 'single', name: 'expr' },
        ],
    },
    {
        nodeType: 'TypeAnnotation',
        nodeInterface: 'TypeAnnotationNode',
        fields: [
            { kind: 'single', name: 'valueExpr' },
            { kind: 'single', name: 'annotation' },
        ],
    },
    {
        nodeType: 'TypeParameter',
        nodeInterface: 'TypeParameterNode',
        fields: [
            { kind: 'single', name: 'name' },
            { kind: 'optional', name: 'boundExpr' },
            { kind: 'optional', name: 'defaultExpr' },
        ],
    },
    {
        nodeType: 'TypeParameterList',
        nodeInterface: 'TypeParameterListNode',
        fields: [{ kind: 'array', name: 'params' }],
    },
    { nodeType: 'UnaryOperation', nodeInterface: 'UnaryOperationNode', fields: [{ kind: 'single', name: 'expr' }] },
    { nodeType: 'Unpack', nodeInterface: 'UnpackNode', fields: [{ kind: 'single', name: 'expr' }] },
    {
        nodeType: 'While',
        nodeInterface: 'WhileNode',
        fields: [
            { kind: 'single', name: 'testExpr' },
            { kind: 'single', name: 'whileSuite' },
            { kind: 'optional', name: 'elseSuite' },
        ],
    },
    {
        nodeType: 'With',
        nodeInterface: 'WithNode',
        fields: [
            { kind: 'array', name: 'withItems' },
            { kind: 'single', name: 'suite' },
        ],
    },
    {
        nodeType: 'WithItem',
        nodeInterface: 'WithItemNode',
        fields: [
            { kind: 'single', name: 'expr' },
            { kind: 'optional', name: 'target' },
        ],
    },
    { nodeType: 'Yield', nodeInterface: 'YieldNode', fields: [{ kind: 'optional', name: 'expr' }] },
    { nodeType: 'YieldFrom', nodeInterface: 'YieldFromNode', fields: [{ kind: 'single', name: 'expr' }] },
] as const satisfies readonly ChildFieldSpec[];

/*
 * parser.test.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Unit tests for Python parser. These are very basic because
 * the parser gets lots of exercise in the type checker tests.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { findNodeByOffset, getFirstAncestorOrSelfOfKind } from '../analyzer/parseTreeUtils';
import { getChildNodes, ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { ExecutionEnvironment, getStandardDiagnosticRuleSet } from '../common/configOptions';
import { DiagnosticSink } from '../common/diagnosticSink';
import { pythonVersion3_13, pythonVersion3_14 } from '../common/pythonVersion';
import { TextRange } from '../common/textRange';
import { UriEx } from '../common/uri/uriUtils';
import { childFields } from '../parser/childFields';
import { forEachChild, walkChildren } from '../parser/generated/walkChildren';
import { ParseNode, ParseNodeType, StatementListNode } from '../parser/parseNodes';
import { getNodeAtMarker, parseAndGetTestState } from './harness/fourslash/testState';
import * as TestUtils from './testUtils';

class WalkChildrenCollector extends ParseTreeWalker {
    readonly children: ParseNode[] = [];

    override walk(node: ParseNode): void {
        this.children.push(node);
    }
}

function collectParseNodes(node: ParseNode): ParseNode[] {
    const nodes = [node];
    forEachChild(node, (child) => {
        if (child) {
            nodes.push(...collectParseNodes(child));
        }
    });

    return nodes;
}

function getParseNodeTypeNames(): string[] {
    const parseNodesPath = path.resolve(__dirname, '..', 'parser', 'parseNodes.ts');
    const parseNodesText = fs.readFileSync(parseNodesPath, 'utf8');
    const enumMatch = /export const enum ParseNodeType\s*{([\s\S]*?)\n}/.exec(parseNodesText);

    assert.ok(enumMatch);

    return enumMatch[1]
        .split('\n')
        .map((line) => line.split('//')[0].trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/,$/, '').trim());
}

function getParseNodeTypeName(nodeType: ParseNodeType): string {
    return getParseNodeTypeNames()[nodeType] ?? `<unknown ${nodeType}>`;
}

test('Empty', () => {
    const diagSink = new DiagnosticSink();
    const parserOutput = TestUtils.parseText('', diagSink).parserOutput;

    assert.equal(diagSink.fetchAndClear().length, 0);
    assert.equal(parserOutput.parseTree.d.statements.length, 0);
});

test('Parser1', () => {
    const diagSink = new DiagnosticSink();
    const parserOutput = TestUtils.parseSampleFile('parser1.py', diagSink).parserOutput;

    assert.equal(diagSink.fetchAndClear().length, 0);
    assert.equal(parserOutput.parseTree.d.statements.length, 4);
});

test('Parser2', () => {
    const diagSink = new DiagnosticSink();
    TestUtils.parseSampleFile('parser2.py', diagSink);
    assert.strictEqual(diagSink.getErrors().length, 0);
});

test('FStringEmptyTuple', () => {
    assert.doesNotThrow(() => {
        const diagSink = new DiagnosticSink();
        TestUtils.parseSampleFile('fstring6.py', diagSink);
    });
});

test('SuiteExpectedColon1', () => {
    const diagSink = new DiagnosticSink();
    TestUtils.parseSampleFile('suiteExpectedColon1.py', diagSink);
    assert.strictEqual(diagSink.getErrors().length, 1);
});

test('SuiteExpectedColon2', () => {
    const diagSink = new DiagnosticSink();
    TestUtils.parseSampleFile('suiteExpectedColon2.py', diagSink);
    assert.strictEqual(diagSink.getErrors().length, 1);
});

test('SuiteExpectedColon3', () => {
    const diagSink = new DiagnosticSink();
    TestUtils.parseSampleFile('suiteExpectedColon3.py', diagSink);
    assert.strictEqual(diagSink.getErrors().length, 1);
});

test('ExpressionWrappedInParens', () => {
    const diagSink = new DiagnosticSink();
    const parserOutput = TestUtils.parseText('(str)', diagSink).parserOutput;

    assert.equal(diagSink.fetchAndClear().length, 0);
    assert.equal(parserOutput.parseTree.d.statements.length, 1);
    assert.equal(parserOutput.parseTree.d.statements[0].nodeType, ParseNodeType.StatementList);

    const statementList = parserOutput.parseTree.d.statements[0] as StatementListNode;
    assert.equal(statementList.d.statements.length, 1);

    // length of node should include parens
    assert.equal(statementList.d.statements[0].nodeType, ParseNodeType.Name);
    assert.equal(statementList.d.statements[0].length, 5);
});

test('Generated child fields cover parse node types', () => {
    const childFieldNodeTypes = [...childFields.map((spec) => spec.nodeType)].sort();
    const parseNodeTypes = [...getParseNodeTypeNames()].sort();

    assert.deepStrictEqual(childFieldNodeTypes, parseNodeTypes);
});

test('Generated walkChildren preserves present-child order', () => {
    const code = `
from __future__ import annotations
from pkg import a as b, c
import os, sys as system

@decorator(1)
class C[T](Base[int]):
    x: int = 1
    """class doc"""

    async def method(self, value: list[int] = [1, 2]) -> str:
        global g
        nonlocal n
        assert value, "missing"
        del value[0]
        with manager() as target:
            await target.run()
        try:
            for item in value:
                if item > 0:
                    yield item
                else:
                    yield from other()
        except ValueError as ex:
            raise RuntimeError() from ex
        finally:
            pass
        return f"{value!r:{width}}"

type Alias[T] = list[T] | tuple[T, ...]

result = (lambda x=1: x + 1)(*[1], **{"y": 2})
items = {k: v for k, v in pairs if k in allowed}
sequence = [x async for x in agen() if x]
mapping = {"a": 1, **extra}
match result:
    case {"x": value, **rest} if value:
        pass
    case [first, *others] | C(first):
        pass
`;

    const diagSink = new DiagnosticSink();
    const parseResults = TestUtils.parseText(code, diagSink);
    const nodes = collectParseNodes(parseResults.parserOutput.parseTree);

    for (const node of nodes) {
        const expectedChildren = getChildNodes(node).filter((child): child is ParseNode => child !== undefined);
        const collector = new WalkChildrenCollector();
        walkChildren(collector, node);

        assert.deepStrictEqual(
            collector.children,
            expectedChildren,
            `Child order mismatch for ${getParseNodeTypeName(node.nodeType)}`
        );
    }
});

test('MaxParseDepth1', () => {
    const diagSink = new DiagnosticSink();
    TestUtils.parseSampleFile('maxParseDepth1.py', diagSink);
    assert.strictEqual(diagSink.getErrors().length, 1);
});

test('MaxParseDepth2', () => {
    const diagSink = new DiagnosticSink();
    TestUtils.parseSampleFile('maxParseDepth2.py', diagSink);
    assert.strictEqual(diagSink.getErrors().length, 4);
});

test('ModuleName range', () => {
    const code = `
//// from [|/*marker*/...|] import A
        `;

    const state = parseAndGetTestState(code).state;
    const expectedRange = state.getRangeByMarkerName('marker');
    const node = getNodeAtMarker(state);

    assert.strictEqual(node.start, expectedRange?.pos);
    assert.strictEqual(TextRange.getEnd(node), expectedRange?.end);
});

test('ParserRecovery1', () => {
    const diagSink = new DiagnosticSink();
    const parseResults = TestUtils.parseSampleFile('parserRecovery1.py', diagSink);

    const node = findNodeByOffset(parseResults.parserOutput.parseTree, parseResults.text.length - 2);
    const functionNode = getFirstAncestorOrSelfOfKind(node, ParseNodeType.Function);
    assert.equal(functionNode!.parent!.nodeType, ParseNodeType.Module);
});

test('ParserRecovery2', () => {
    const diagSink = new DiagnosticSink();
    const parseResults = TestUtils.parseSampleFile('parserRecovery2.py', diagSink);

    const node = findNodeByOffset(parseResults.parserOutput.parseTree, parseResults.text.length - 2);
    const functionNode = getFirstAncestorOrSelfOfKind(node, ParseNodeType.Function);
    assert.equal(functionNode!.parent!.nodeType, ParseNodeType.Suite);
});

test('ParserRecovery3', () => {
    const diagSink = new DiagnosticSink();
    const parseResults = TestUtils.parseSampleFile('parserRecovery3.py', diagSink);

    const node = findNodeByOffset(parseResults.parserOutput.parseTree, parseResults.text.length - 2);
    const functionNode = getFirstAncestorOrSelfOfKind(node, ParseNodeType.Function);
    assert.equal(functionNode!.parent!.nodeType, ParseNodeType.Module);
});

test('FinallyExit1', () => {
    const execEnvironment = new ExecutionEnvironment(
        'python',
        UriEx.file('.'),
        getStandardDiagnosticRuleSet(),
        /* defaultPythonVersion */ undefined,
        /* defaultPythonPlatform */ undefined,
        /* defaultExtraPaths */ undefined
    );

    const diagSink1 = new DiagnosticSink();
    execEnvironment.pythonVersion = pythonVersion3_13;
    TestUtils.parseSampleFile('finallyExit1.py', diagSink1, execEnvironment);
    assert.strictEqual(diagSink1.getErrors().length, 0);

    const diagSink2 = new DiagnosticSink();
    execEnvironment.pythonVersion = pythonVersion3_14;
    TestUtils.parseSampleFile('finallyExit1.py', diagSink2, execEnvironment);
    assert.strictEqual(diagSink2.getErrors().length, 5);
});

test('TrailingBackslashCRAtEOF', () => {
    // A file that ends with a line-continuation backslash followed by a CR
    // should produce a syntax error.
    const code = '"""Comment"""\n\n\\\r';

    const diagSink = new DiagnosticSink();
    TestUtils.parseText(code, diagSink);
    const errors = diagSink.getErrors();
    assert.strictEqual(errors.length > 0, true);
    assert.ok(errors.some((e) => e.message.includes('Unexpected EOF')));
});

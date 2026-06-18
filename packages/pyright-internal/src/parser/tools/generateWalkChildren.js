/*
 * generateWalkChildren.js
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * Generates parser/generated/walkChildren.ts from parser/childFields.ts.
 */

// @ts-check

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const prettierModuleName = 'prettier';
const prettier = /** @type {{ format: (text: string, options: object) => string }} */ (require(prettierModuleName));

const parserDir = path.resolve(__dirname, '..');
const childFieldsPath = path.join(parserDir, 'childFields.ts');
const outputPath = path.join(parserDir, 'generated', 'walkChildren.ts');

/**
 * @typedef {{ kind: 'single' | 'optional' | 'array' | 'optionalArray', name: string }} ChildField
 * @typedef {{ nodeType: string, nodeInterface: string, fields: readonly ChildField[] }} ChildFieldSpec
 */

/**
 * @returns {readonly ChildFieldSpec[]}
 */
function loadChildFields() {
    const sourceText = fs.readFileSync(childFieldsPath, 'utf8');
    const transpiled = ts.transpileModule(sourceText, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
        fileName: childFieldsPath,
    }).outputText;

    const sandbox = {
        exports: {},
        require,
    };
    vm.runInNewContext(transpiled, sandbox, { filename: childFieldsPath });

    const childFields = /** @type {{ childFields?: readonly ChildFieldSpec[] }} */ (sandbox.exports).childFields;
    if (!Array.isArray(childFields)) {
        throw new Error(`Unable to load childFields from ${childFieldsPath}`);
    }

    return childFields;
}

/**
 * @param {readonly ChildFieldSpec[]} childFields
 */
function validateChildFields(childFields) {
    const seen = new Set();
    for (const spec of childFields) {
        if (seen.has(spec.nodeType)) {
            throw new Error(`Duplicate child field spec for ${spec.nodeType}`);
        }
        seen.add(spec.nodeType);

        for (const field of spec.fields) {
            if (!['single', 'optional', 'array', 'optionalArray'].includes(field.kind)) {
                throw new Error(`Unknown child field kind "${field.kind}" for ${spec.nodeType}.${field.name}`);
            }
        }
    }
}

/**
 * @param {string} text
 * @returns {string}
 */
function indent(text) {
    return text
        .split('\n')
        .map((line) => (line ? `    ${line}` : line))
        .join('\n');
}

/**
 * @param {ChildField} field
 * @param {'callback' | 'walker'} mode
 */
function emitField(field, mode) {
    const visit = mode === 'callback' ? 'callback' : 'walker.walk';
    const value = `typedNode.d.${field.name}`;

    switch (field.kind) {
        case 'single':
            return `${visit}(${value});`;

        case 'optional':
            if (mode === 'callback') {
                return `${visit}(${value});`;
            }
            return `if (${value}) {\n    ${visit}(${value});\n}`;

        case 'array':
            return `for (let i = 0; i < ${value}.length; i++) {\n    ${visit}(${value}[i]);\n}`;

        case 'optionalArray':
            return `if (${value}) {\n    for (let i = 0; i < ${value}.length; i++) {\n        ${visit}(${value}[i]);\n    }\n}`;
    }
}

/**
 * @param {ChildField} field
 */
function emitCountField(field) {
    const value = `typedNode.d.${field.name}`;

    switch (field.kind) {
        case 'single':
        case 'optional':
            return 'count++;';

        case 'array':
            return `count += ${value}.length;`;

        case 'optionalArray':
            return `if (${value}) {\n    count += ${value}.length;\n}`;
    }
}

/**
 * @param {ChildField} field
 */
function emitGetAtField(field) {
    const value = `typedNode.d.${field.name}`;

    switch (field.kind) {
        case 'single':
        case 'optional':
            return `if (index === childIndex) {\n    return ${value};\n}\nchildIndex++;`;

        case 'array':
            return `if (index < childIndex + ${value}.length) {\n    return ${value}[index - childIndex];\n}\nchildIndex += ${value}.length;`;

        case 'optionalArray':
            return `if (${value}) {\n    if (index < childIndex + ${value}.length) {\n        return ${value}[index - childIndex];\n    }\n    childIndex += ${value}.length;\n}`;
    }
}

/**
 * @param {ChildFieldSpec} spec
 * @param {'callback' | 'walker'} mode
 */
function emitCase(spec, mode) {
    const body = spec.fields.map((field) => emitField(field, mode)).join('\n\n');
    const lines = [`case ParseNodeType.${spec.nodeType}: {`];

    if (body) {
        lines.push(`    const typedNode = node as ${spec.nodeInterface};`, '', indent(body));
    }

    lines.push('', '    return;', '}');
    return lines.join('\n');
}

/**
 * @param {ChildFieldSpec} spec
 */
function emitCountCase(spec) {
    if (!spec.fields.some((field) => field.kind === 'array' || field.kind === 'optionalArray')) {
        return [`case ParseNodeType.${spec.nodeType}: {`, `    return ${spec.fields.length};`, '}'].join('\n');
    }

    const body = spec.fields.map((field) => emitCountField(field)).join('\n\n');
    const lines = [`case ParseNodeType.${spec.nodeType}: {`];

    lines.push(
        `    const typedNode = node as ${spec.nodeInterface};`,
        '    let count = 0;',
        '',
        indent(body),
        '',
        '    return count;'
    );

    lines.push('}');
    return lines.join('\n');
}

/**
 * @param {ChildFieldSpec} spec
 */
function emitGetAtCase(spec) {
    const body = spec.fields.map((field) => emitGetAtField(field)).join('\n\n');
    const lines = [`case ParseNodeType.${spec.nodeType}: {`];

    if (body) {
        lines.push(
            `    const typedNode = node as ${spec.nodeInterface};`,
            '    let childIndex = 0;',
            '',
            indent(body),
            '',
            '    return undefined;'
        );
    } else {
        lines.push('    return undefined;');
    }

    lines.push('}');
    return lines.join('\n');
}

/**
 * @param {readonly ChildFieldSpec[]} childFields
 * @param {'callback' | 'walker'} mode
 */
function emitSwitch(childFields, mode) {
    return childFields.map((spec) => emitCase(spec, mode)).join('\n\n');
}

/**
 * @param {readonly ChildFieldSpec[]} childFields
 */
function emitCountSwitch(childFields) {
    return childFields.map((spec) => emitCountCase(spec)).join('\n\n');
}

/**
 * @param {readonly ChildFieldSpec[]} childFields
 */
function emitGetAtSwitch(childFields) {
    return childFields.map((spec) => emitGetAtCase(spec)).join('\n\n');
}

/**
 * @param {readonly ChildFieldSpec[]} childFields
 */
function emitGeneratedFile(childFields) {
    const imports = [...new Set(childFields.filter((spec) => spec.fields.length > 0).map((spec) => spec.nodeInterface))]
        .sort()
        .map((nodeInterface) => `    ${nodeInterface},`)
        .join('\n');

    return `/*
 * walkChildren.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 *
 * This file is generated by parser/tools/generateWalkChildren.js.
 * Do not edit this file directly.
 */

import {
${imports}
    ParseNode,
    ParseNodeType,
} from '../parseNodes';

export interface ParseTreeChildWalker {
    walk(node: ParseNode): void;
}

export function forEachChild(node: ParseNode, callback: (child: ParseNode | undefined) => void): void {
    switch (node.nodeType) {
${indent(emitSwitch(childFields, 'callback'))}
    }
}

export function getChildCount(node: ParseNode): number {
    switch (node.nodeType) {
${indent(emitCountSwitch(childFields))}
    }
}

export function getChildAt(node: ParseNode, index: number): ParseNode | undefined {
    switch (node.nodeType) {
${indent(emitGetAtSwitch(childFields))}
    }
}

export function walkChildren(walker: ParseTreeChildWalker, node: ParseNode): void {
    switch (node.nodeType) {
${indent(emitSwitch(childFields, 'walker'))}
    }
}
`;
}

/**
 * @param {string} text
 */
function formatGeneratedFile(text) {
    return prettier.format(text, {
        parser: 'typescript',
        printWidth: 120,
        tabWidth: 4,
        singleQuote: true,
    });
}

function main() {
    const childFields = loadChildFields();
    validateChildFields(childFields);

    const generatedText = formatGeneratedFile(emitGeneratedFile(childFields));
    if (process.argv.includes('--check')) {
        const currentText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
        if (currentText !== generatedText) {
            throw new Error(`${outputPath} is out of date. Run node ${path.relative(process.cwd(), __filename)}.`);
        }
        return;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, generatedText, 'utf8');
}

main();

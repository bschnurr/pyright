/*
 * resourceLifetimeTelemetry.test.ts
 *
 * Unit tests for internal analyzer resource lifetime telemetry.
 */

import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { InvalidationKind } from '../analyzer/editInvalidationClassifier';
import {
    ResourceLifetimeEventKind,
    ResourceLifetimeEventReason,
    ResourceLifetimeTelemetry,
    resourceLifetimeTelemetry,
} from '../analyzer/resourceLifetimeTelemetry';
import { TextRange } from '../common/textRange';
import { UriEx } from '../common/uri/uriUtils';
import { parseAndGetTestState } from './harness/fourslash/testState';

test('Resource lifetime telemetry records analysis and invalidation reasons', () => {
    resourceLifetimeTelemetry.reset();
    resourceLifetimeTelemetry.setEnabled(true);

    try {
        const code = `
// @filename: test.py
//// import helper
//// value = helper.get_value()

// @filename: helper.py
//// def get_value() -> int:
////     return 1
        `;

        const state = parseAndGetTestState(code, '/projectRoot').state;
        const program = state.workspace.service.test_program;
        while (program.analyze()) {
            // Process all queued items.
        }

        assert.ok(resourceLifetimeTelemetry.getCount(ResourceLifetimeEventKind.SourceFileParse) > 0);
        assert.ok(resourceLifetimeTelemetry.getCount(ResourceLifetimeEventKind.SourceFileBind) > 0);
        assert.ok(resourceLifetimeTelemetry.getCount(ResourceLifetimeEventKind.SourceFileCheck) > 0);
        assert.ok(resourceLifetimeTelemetry.getCount(ResourceLifetimeEventKind.ProgramEvaluatorCreated) > 0);

        const helperUri = UriEx.file('/projectRoot/helper.py');
        const testUri = UriEx.file('/projectRoot/test.py');
        state.workspace.service.updateOpenFileContents(helperUri, 2, 'def get_value() -> str:\n    return ""\n');
        while (program.analyze()) {
            // Process all queued items.
        }

        assert.ok(
            resourceLifetimeTelemetry
                .getEvents(ResourceLifetimeEventKind.SourceFileSetClientVersion)
                .some(
                    (event) =>
                        event.uri === helperUri.toString() && event.reason === ResourceLifetimeEventReason.TextChanged
                )
        );
        assert.ok(
            resourceLifetimeTelemetry
                .getEvents(ResourceLifetimeEventKind.SourceFileMarkDirtyAndDropSyntax)
                .some(
                    (event) =>
                        event.uri === helperUri.toString() && event.reason === ResourceLifetimeEventReason.TextChanged
                )
        );
        assert.ok(
            resourceLifetimeTelemetry
                .getEvents(ResourceLifetimeEventKind.SourceFileMarkReanalysisRequired)
                .some(
                    (event) =>
                        event.uri === testUri.toString() &&
                        event.reason === ResourceLifetimeEventReason.DependencyDirtied
                )
        );
        assert.ok(
            resourceLifetimeTelemetry
                .getEvents(ResourceLifetimeEventKind.ProgramEvaluatorDisposed)
                .some((event) => event.reason === ResourceLifetimeEventReason.TextChanged)
        );
    } finally {
        resourceLifetimeTelemetry.setEnabled(false);
        resourceLifetimeTelemetry.reset();
    }
});

test('Resource lifetime telemetry writes opt-in JSONL and summary files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyright-resource-lifetime-'));
    const eventsPath = join(tempDir, 'resource-lifetime-events.jsonl');
    const summaryPath = join(tempDir, 'resource-lifetime-summary.json');

    resourceLifetimeTelemetry.reset();
    resourceLifetimeTelemetry.configureFileOutput({
        eventsPath,
        summaryPath,
        includeUris: false,
        retainEvents: false,
    });

    resourceLifetimeTelemetry.setEnabled(true);

    try {
        resourceLifetimeTelemetry.record({
            kind: ResourceLifetimeEventKind.SourceFileSetClientVersion,
            reason: ResourceLifetimeEventReason.TextChanged,
            uri: 'file:///project/test.py',
        });
        resourceLifetimeTelemetry.record({
            kind: ResourceLifetimeEventKind.SourceFileIncrementalSyntaxReuse,
            reason: ResourceLifetimeEventReason.TextUnchanged,
            uri: 'file:///project/test.py',
            syntaxReused: true,
        });
        resourceLifetimeTelemetry.writeSummary();

        const eventLines = readFileSync(eventsPath, 'utf8')
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line));
        assert.strictEqual(eventLines.length, 2);
        assert.strictEqual(eventLines[0].kind, ResourceLifetimeEventKind.SourceFileSetClientVersion);
        assert.strictEqual(eventLines[0].reason, ResourceLifetimeEventReason.TextChanged);
        assert.strictEqual(eventLines[0].uri, undefined);
        assert.strictEqual(typeof eventLines[0].uriHash, 'string');
        assert.strictEqual(resourceLifetimeTelemetry.getEvents().length, 0);
        assert.strictEqual(resourceLifetimeTelemetry.getCount(ResourceLifetimeEventKind.SourceFileSetClientVersion), 1);

        const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
        assert.strictEqual(summary.totalEventCount, 2);
        assert.strictEqual(summary.retainedEventCount, 0);
        assert(
            summary.counts.some(
                (entry: { kind: string; reason: string; count: number }) =>
                    entry.kind === ResourceLifetimeEventKind.SourceFileIncrementalSyntaxReuse &&
                    entry.reason === ResourceLifetimeEventReason.TextUnchanged &&
                    entry.count === 1
            )
        );
    } finally {
        resourceLifetimeTelemetry.setEnabled(false);
        resourceLifetimeTelemetry.configureFileOutput(undefined);
        resourceLifetimeTelemetry.reset();
        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Resource lifetime telemetry can default file output to workspace root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pyright-resource-lifetime-workspace-'));
    const oldEnv = process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY;
    const oldSummaryEnv = process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_SUMMARY;
    const oldIncludeUrisEnv = process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_INCLUDE_URIS;

    process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY = 'workspace';
    delete process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_SUMMARY;
    delete process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_INCLUDE_URIS;

    const telemetry = new ResourceLifetimeTelemetry();
    telemetry.configureWorkspaceFileOutput(UriEx.file(tempDir));

    try {
        telemetry.record({
            kind: ResourceLifetimeEventKind.ProgramEvaluatorCreated,
            reason: ResourceLifetimeEventReason.Initial,
            evaluatorGeneration: 1,
        });
        telemetry.writeSummary();

        const eventsPath = join(tempDir, '.pyright', 'resource-lifetime-events.jsonl');
        const summaryPath = join(tempDir, '.pyright', 'resource-lifetime-summary.json');
        const eventLines = readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/);
        assert.strictEqual(eventLines.length, 1);

        const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
        assert.strictEqual(summary.totalEventCount, 1);
        assert.strictEqual(summary.counts[0].kind, ResourceLifetimeEventKind.ProgramEvaluatorCreated);
    } finally {
        telemetry.setEnabled(false);
        telemetry.configureFileOutput(undefined);
        if (oldEnv === undefined) {
            delete process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY;
        } else {
            process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY = oldEnv;
        }

        if (oldSummaryEnv === undefined) {
            delete process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_SUMMARY;
        } else {
            process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_SUMMARY = oldSummaryEnv;
        }

        if (oldIncludeUrisEnv === undefined) {
            delete process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_INCLUDE_URIS;
        } else {
            process.env.PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_INCLUDE_URIS = oldIncludeUrisEnv;
        }

        rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Resource lifetime telemetry records no-change incremental syntax reuse with changed range', () => {
    resourceLifetimeTelemetry.reset();
    resourceLifetimeTelemetry.setEnabled(true);

    try {
        const code = `
// @filename: test.py
//// value = 1
//// reveal_type(value)
        `;

        const state = parseAndGetTestState(code, '/projectRoot').state;
        const uri = UriEx.file('/projectRoot/test.py');
        const program = state.workspace.service.test_program;
        while (program.analyze()) {
            // Process all queued items.
        }

        const sourceFileInfo = program.getSourceFileInfo(uri);
        assert(sourceFileInfo);
        const oldParseGeneration = sourceFileInfo.sourceFile.getParseGeneration();
        const oldParserOutput = program.getParseResults(uri)!.parserOutput;
        const text = state.testFS.readFileSync(uri, 'utf8');

        state.workspace.service.updateOpenFileContents(uri, 2, text, undefined, {
            range: TextRange.create(0, 0),
            delta: 0,
        });

        assert.strictEqual(sourceFileInfo.sourceFile.getParseGeneration(), oldParseGeneration);
        assert.strictEqual(program.getParseResults(uri)!.parserOutput, oldParserOutput);

        const reuseEvent = resourceLifetimeTelemetry
            .getEvents(ResourceLifetimeEventKind.SourceFileIncrementalSyntaxReuse)
            .find(
                (event) =>
                    event.uri === uri.toString() &&
                    event.editInvalidationKind === InvalidationKind.NoChange &&
                    event.changedRangeLength === 0
            );
        assert(reuseEvent);
        assert.strictEqual(reuseEvent.reason, ResourceLifetimeEventReason.TextUnchanged);
        assert.strictEqual(reuseEvent.syntaxReused, true);
        assert.strictEqual(reuseEvent.changedRangeDelta, 0);
    } finally {
        resourceLifetimeTelemetry.setEnabled(false);
        resourceLifetimeTelemetry.reset();
    }
});

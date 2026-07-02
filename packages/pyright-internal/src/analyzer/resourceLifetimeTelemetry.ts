/*
 * resourceLifetimeTelemetry.ts
 *
 * Internal/test-facing counters and event traces for analyzer resource lifetime decisions.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { hashString } from '../common/stringUtils';
import { Uri } from '../common/uri/uri';

const telemetryEventsPathEnvVar = 'PYRIGHT_RESOURCE_LIFETIME_TELEMETRY';
const telemetrySummaryPathEnvVar = 'PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_SUMMARY';
const telemetryIncludeUrisEnvVar = 'PYRIGHT_RESOURCE_LIFETIME_TELEMETRY_INCLUDE_URIS';
const defaultTelemetryDirectory = '.pyright';
const defaultTelemetryEventsFileName = 'resource-lifetime-events.jsonl';
const defaultTelemetrySummaryFileName = 'resource-lifetime-summary.json';

export enum ResourceLifetimeEventKind {
    SourceFileSetClientVersion = 'sourceFile.setClientVersion',
    SourceFileMarkDirty = 'sourceFile.markDirty',
    SourceFileMarkDirtyAndDropSyntax = 'sourceFile.markDirtyAndDropSyntax',
    SourceFileMarkReanalysisRequired = 'sourceFile.markReanalysisRequired',
    SourceFileDropParseAndBindInfo = 'sourceFile.dropParseAndBindInfo',
    SourceFileReleaseClosedFileSyntax = 'sourceFile.releaseClosedFileSyntax',
    SourceFileIncrementalSyntaxReuse = 'sourceFile.incrementalSyntaxReuse',
    SourceFileParse = 'sourceFile.parse',
    SourceFileBind = 'sourceFile.bind',
    SourceFileCheck = 'sourceFile.check',
    ProgramMarkFilesDirty = 'program.markFilesDirty',
    ProgramMarkAllFilesDirty = 'program.markAllFilesDirty',
    ProgramEvaluatorCreated = 'program.evaluator.created',
    ProgramEvaluatorDisposed = 'program.evaluator.disposed',
    ImportResolverInvalidateCache = 'importResolver.invalidateCache',
}

export enum ResourceLifetimeEventReason {
    Unknown = 'unknown',
    Initial = 'initial',
    TextChanged = 'textChanged',
    TextUnchanged = 'textUnchanged',
    ClientClosed = 'clientClosed',
    DiskChanged = 'diskChanged',
    ForcedDirty = 'forcedDirty',
    DependencyDirtied = 'dependencyDirtied',
    ChainedFileChanged = 'chainedFileChanged',
    ConfigOrImportResolverChanged = 'configOrImportResolverChanged',
    CachePressure = 'cachePressure',
    FileRemoved = 'fileRemoved',
    ProgramDisposed = 'programDisposed',
    EditModeExited = 'editModeExited',
    CancellationInvalidatedTypeCache = 'cancellationInvalidatedTypeCache',
    AnalysisRequired = 'analysisRequired',
}

export interface ResourceLifetimeEvent {
    kind: ResourceLifetimeEventKind;
    reason?: ResourceLifetimeEventReason | undefined;
    uri?: string | undefined;
    evaluatorGeneration?: number | undefined;
    fileCount?: number | undefined;
    forceRebinding?: boolean | undefined;
    evenIfContentsAreSame?: boolean | undefined;
    editInvalidationKind?: string | undefined;
    syntaxReused?: boolean | undefined;
    changedRangeLength?: number | undefined;
    changedRangeDelta?: number | undefined;
}

export interface ResourceLifetimeTelemetryFileOptions {
    readonly eventsPath: string;
    readonly summaryPath?: string | undefined;
    readonly includeUris?: boolean | undefined;
    readonly retainEvents?: boolean | undefined;
}

interface ResourceLifetimeTelemetryFileState {
    readonly eventsPath: string;
    readonly summaryPath: string;
    readonly includeUris: boolean;
    readonly retainEvents: boolean;
}

interface ResourceLifetimeCount {
    readonly kind: ResourceLifetimeEventKind;
    readonly reason?: ResourceLifetimeEventReason | undefined;
    readonly count: number;
}

interface SerializedResourceLifetimeEvent extends Omit<ResourceLifetimeEvent, 'uri'> {
    readonly uri?: string | undefined;
    readonly uriHash?: string | undefined;
}

export class ResourceLifetimeTelemetry {
    private _enabled = false;
    private readonly _events: ResourceLifetimeEvent[] = [];
    private readonly _counts = new Map<string, number>();
    private _eventCount = 0;
    private _fileState: ResourceLifetimeTelemetryFileState | undefined;
    private _summaryRegistered = false;
    private _isWorkspaceOutputRequested = false;

    constructor() {
        this._configureFromEnvironment();
    }

    get isEnabled() {
        return this._enabled;
    }

    setEnabled(enabled: boolean) {
        this._enabled = enabled;
    }

    reset() {
        this._events.length = 0;
        this._counts.clear();
        this._eventCount = 0;
    }

    configureFileOutput(options: ResourceLifetimeTelemetryFileOptions | undefined) {
        if (!options) {
            this._fileState = undefined;
            return;
        }

        const summaryPath = options.summaryPath ?? `${options.eventsPath}.summary.json`;
        this._ensureParentDirectory(options.eventsPath);
        this._ensureParentDirectory(summaryPath);
        writeFileSync(options.eventsPath, '', 'utf8');

        this._fileState = {
            eventsPath: options.eventsPath,
            summaryPath,
            includeUris: options.includeUris ?? false,
            retainEvents: options.retainEvents ?? true,
        };
        this._registerSummaryWriter();
    }

    configureWorkspaceFileOutput(workspaceRoot: Uri) {
        if (!this._isWorkspaceOutputRequested || this._fileState) {
            return;
        }

        const telemetryDirectory = join(workspaceRoot.getFilePath(), defaultTelemetryDirectory);
        this.configureFileOutput({
            eventsPath: join(telemetryDirectory, defaultTelemetryEventsFileName),
            summaryPath: join(telemetryDirectory, defaultTelemetrySummaryFileName),
            includeUris: process.env[telemetryIncludeUrisEnvVar] === '1',
            retainEvents: false,
        });
        this.setEnabled(true);
    }

    writeSummary() {
        if (!this._fileState) {
            return;
        }

        writeFileSync(
            this._fileState.summaryPath,
            JSON.stringify(
                {
                    totalEventCount: this._eventCount,
                    retainedEventCount: this.getEvents().length,
                    counts: this.getCounts(),
                },
                undefined,
                2
            ) + '\n',
            'utf8'
        );
    }

    record(event: ResourceLifetimeEvent) {
        if (!this._enabled) {
            return;
        }

        if (!this._fileState || this._fileState.retainEvents) {
            this._events.push(event);
        }
        this._eventCount++;
        const countKey = this._getCountKey(event.kind, event.reason);
        this._counts.set(countKey, (this._counts.get(countKey) ?? 0) + 1);

        if (this._fileState) {
            appendFileSync(this._fileState.eventsPath, JSON.stringify(this._serializeEvent(event)) + '\n', 'utf8');
        }
    }

    getEvents(kind?: ResourceLifetimeEventKind): ResourceLifetimeEvent[] {
        return kind ? this._events.filter((event) => event.kind === kind) : [...this._events];
    }

    getCount(kind: ResourceLifetimeEventKind, reason?: ResourceLifetimeEventReason): number {
        if (reason === undefined) {
            return this.getCounts()
                .filter((entry) => entry.kind === kind)
                .reduce((total, entry) => total + entry.count, 0);
        }

        return this._counts.get(this._getCountKey(kind, reason)) ?? 0;
    }

    getCounts(): ResourceLifetimeCount[] {
        return [...this._counts.entries()]
            .map(([key, count]) => {
                const [kind, reason] = key.split(':', 2);
                return {
                    kind: kind as ResourceLifetimeEventKind,
                    reason: reason ? (reason as ResourceLifetimeEventReason) : undefined,
                    count,
                };
            })
            .sort((left, right) => {
                const kindCompare = left.kind.localeCompare(right.kind);
                if (kindCompare !== 0) {
                    return kindCompare;
                }

                return (left.reason ?? '').localeCompare(right.reason ?? '');
            });
    }

    private _getCountKey(kind: ResourceLifetimeEventKind, reason: ResourceLifetimeEventReason | undefined) {
        return `${kind}:${reason ?? ''}`;
    }

    private _configureFromEnvironment() {
        const eventsPath = process.env[telemetryEventsPathEnvVar]?.trim();
        if (!eventsPath) {
            return;
        }

        if (this._isWorkspaceOutputValue(eventsPath)) {
            this._isWorkspaceOutputRequested = true;
            return;
        }

        const summaryPath = process.env[telemetrySummaryPathEnvVar]?.trim() || undefined;
        const includeUris = process.env[telemetryIncludeUrisEnvVar] === '1';
        this.configureFileOutput({
            eventsPath,
            summaryPath,
            includeUris,
            retainEvents: false,
        });
        this.setEnabled(true);
    }

    private _serializeEvent(event: ResourceLifetimeEvent): SerializedResourceLifetimeEvent {
        if (!event.uri || this._fileState?.includeUris) {
            return event;
        }

        const { uri, ...rest } = event;
        return {
            ...rest,
            uriHash: hashString(uri).toString(),
        };
    }

    private _ensureParentDirectory(path: string) {
        mkdirSync(dirname(path), { recursive: true });
    }

    private _registerSummaryWriter() {
        if (this._summaryRegistered) {
            return;
        }

        this._summaryRegistered = true;
        process.once('exit', () => this.writeSummary());
    }

    private _isWorkspaceOutputValue(value: string) {
        const normalizedValue = value.toLocaleLowerCase();
        return normalizedValue === '1' || normalizedValue === 'true' || normalizedValue === 'workspace';
    }
}

export const resourceLifetimeTelemetry = new ResourceLifetimeTelemetry();

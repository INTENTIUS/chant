/** Subset of WorkerProfile fields used by `chant run`. */
export interface WorkerProfile {
  address: string;
  namespace: string;
  taskQueue: string;
  tls?: boolean | { serverNameOverride?: string };
  apiKey?: string | { env: string };
  autoStart?: boolean;
}

export interface TemporalClientModule {
  Connection: {
    connect(opts: Record<string, unknown>): Promise<unknown>;
  };
  Client: new (opts: Record<string, unknown>) => TemporalClientHandle;
}

export interface TemporalClientHandle {
  workflow: {
    start(workflowFn: unknown, opts: Record<string, unknown>): Promise<WorkflowHandleRaw>;
    getHandle(workflowId: string): WorkflowHandleRaw;
    list(opts?: Record<string, unknown>): AsyncIterable<WorkflowExecutionInfo>;
  };
}

export interface WorkflowHandleRaw {
  workflowId: string;
  firstExecutionRunId?: string;
  result(): Promise<unknown>;
  describe(): Promise<WorkflowExecutionDescription>;
  fetchHistory(): Promise<WorkflowHistoryRaw>;
  signal(signalName: string, ...args: unknown[]): Promise<void>;
  query<T = unknown>(queryName: string, ...args: unknown[]): Promise<T>;
  cancel(): Promise<void>;
}

export interface WorkflowExecutionDescription {
  workflowId: string;
  runId: string;
  status: { name: string };
  startTime: Date;
  closeTime?: Date;
  taskQueue: string;
  type: { name: string };
}

export interface WorkflowExecutionInfo {
  workflowId: string;
  runId: string;
  type: { name: string };
  status: { name: string };
  startTime: Date;
  closeTime?: Date;
}

export interface WorkflowHistoryRaw {
  events?: HistoryEvent[];
}

/**
 * `eventType` is the short PascalCase form (`"ActivityTaskScheduled"`, not
 * the wire enum's `"EVENT_TYPE_ACTIVITY_TASK_SCHEDULED"`) and `eventId`/
 * `scheduledEventId` are decimal strings — the shape {@link fetchNormalizedHistory}
 * produces, not `WorkflowHandleRaw.fetchHistory()`'s own raw return value.
 */
export interface HistoryEvent {
  eventId?: string;
  eventType?: string;
  eventTime?: Date;
  activityTaskCompletedEventAttributes?: { scheduledEventId?: string };
  activityTaskScheduledEventAttributes?: { activityId?: string; activityType?: { name?: string } };
  activityTaskFailedEventAttributes?: { scheduledEventId?: string; failure?: { message?: string } };
  workflowExecutionCompletedEventAttributes?: unknown;
  workflowExecutionFailedEventAttributes?: { failure?: { message?: string } };
}

/**
 * `WorkflowHandleRaw.fetchHistory()` returns the Temporal wire proto
 * untouched: `eventType` is the numeric enum, `eventId`/`scheduledEventId`
 * are `Long` instances, `eventTime` is a `{seconds, nanos}` protobuf
 * Timestamp — none of them comparable or constructible the way the rest of
 * this file (and run-report.ts, op-progress.ts) needs. The proto message's
 * own `toJSON()` is what turns enums into their string name and `Long`s into
 * decimal strings, so a JSON round-trip is the normalization step; only
 * `eventTime` then needs a further Timestamp-to-Date conversion.
 */
export async function fetchNormalizedHistory(handle: WorkflowHandleRaw): Promise<WorkflowHistoryRaw> {
  const raw = (await handle.fetchHistory()) as unknown as { events?: unknown[] };
  const events = JSON.parse(JSON.stringify(raw.events ?? [])) as Array<Record<string, unknown>>;
  return { events: events.map(normalizeHistoryEvent) };
}

/** `"EVENT_TYPE_ACTIVITY_TASK_SCHEDULED"` → `"ActivityTaskScheduled"`. A value that isn't ALL_CAPS_WITH_UNDERSCORES (e.g. already-short test fixture data) passes through unchanged, so normalizing twice is a no-op. */
function shortEventType(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (!/^[A-Z][A-Z0-9_]*$/.test(raw)) return raw;
  const stripped = raw.startsWith("EVENT_TYPE_") ? raw.slice("EVENT_TYPE_".length) : raw;
  return stripped
    .split("_")
    .filter(Boolean)
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join("");
}

/** Accepts a protobuf `{seconds, nanos}` Timestamp (its `seconds` a decimal string post-JSON-round-trip), an ISO string (already-normalized test fixture data, or the same value normalized twice), or a `Date`. */
function protoTimestampToDate(ts: unknown): Date | undefined {
  if (!ts) return undefined;
  if (ts instanceof Date) return ts;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof ts !== "object") return undefined;
  const seconds = Number((ts as { seconds?: unknown }).seconds);
  const nanos = Number((ts as { nanos?: unknown }).nanos ?? 0);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6));
}

/** `undefined`/`null` stays `undefined`; anything else (a decimal string post-JSON-round-trip, or a bare number/Long from an un-round-tripped test fixture) becomes a string — `scheduledEventId` is joined against `eventId` as a Map key, and a number `7` and a string `"7"` are different keys. */
function idString(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

function normalizeHistoryEvent(raw: Record<string, unknown>): HistoryEvent {
  const scheduled = raw.activityTaskScheduledEventAttributes as
    | { activityId?: unknown; activityType?: { name?: string } }
    | undefined;
  const completed = raw.activityTaskCompletedEventAttributes as { scheduledEventId?: unknown } | undefined;
  const failed = raw.activityTaskFailedEventAttributes as
    | { scheduledEventId?: unknown; failure?: { message?: string } }
    | undefined;

  return {
    eventId: idString(raw.eventId),
    eventType: shortEventType(raw.eventType),
    eventTime: protoTimestampToDate(raw.eventTime),
    ...(scheduled
      ? { activityTaskScheduledEventAttributes: { activityId: idString(scheduled.activityId), activityType: scheduled.activityType } }
      : {}),
    ...(completed
      ? { activityTaskCompletedEventAttributes: { scheduledEventId: idString(completed.scheduledEventId) } }
      : {}),
    ...(failed
      ? { activityTaskFailedEventAttributes: { scheduledEventId: idString(failed.scheduledEventId), failure: failed.failure } }
      : {}),
    workflowExecutionCompletedEventAttributes: raw.workflowExecutionCompletedEventAttributes,
    workflowExecutionFailedEventAttributes: raw.workflowExecutionFailedEventAttributes as HistoryEvent["workflowExecutionFailedEventAttributes"],
  };
}

/**
 * Dynamically import @temporalio/client from the user's project node_modules.
 * Fails with a helpful message if not installed.
 */
export async function loadTemporalClient(): Promise<TemporalClientModule> {
  try {
    // Use variable to prevent tsc from statically resolving the optional dep
    const mod = "@temporalio/client";
    return await import(mod) as unknown as TemporalClientModule;
  } catch {
    throw new Error(
      '@temporalio/client is not installed. Run: npm install @temporalio/client',
    );
  }
}

/**
 * Build a Temporal Connection.connect() options object from a worker profile.
 */
export function connectionOptions(profile: WorkerProfile): Record<string, unknown> {
  const apiKey =
    typeof profile.apiKey === "object" && profile.apiKey !== null
      ? process.env[(profile.apiKey as { env: string }).env]
      : (profile.apiKey as string | undefined);

  return {
    address: profile.address,
    ...(profile.tls && {
      tls: typeof profile.tls === "object" ? profile.tls : {},
      metadata: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    }),
  };
}

/**
 * Deterministic workflow ID for an Op — allows status/signal/cancel/log
 * without storing run IDs locally.
 */
export function resolveWorkflowId(opName: string): string {
  return `chant-op-${opName}`;
}

/**
 * Resolve a named profile from the chant config.
 * Falls back to defaultProfile then "local".
 */
export function resolveProfile(
  config: Record<string, unknown>,
  profileName?: string,
): WorkerProfile {
  // #1344 — the temporal lexicon declares this namespace and core validates it
  // at load, so this reads a checked value rather than asserting one.
  const temporal = (config as { temporal?: Record<string, unknown> }).temporal;
  if (!temporal?.profiles) {
    throw new Error(
      'No temporal.profiles found in chant.config.ts. Add a profile to use `chant run`.',
    );
  }
  const profiles = temporal.profiles as Record<string, WorkerProfile>;
  const name = profileName ?? (temporal.defaultProfile as string | undefined) ?? "local";
  const profile = profiles[name];
  if (!profile) {
    throw new Error(
      `Temporal profile "${name}" not found. Available: ${Object.keys(profiles).join(", ")}`,
    );
  }
  return profile;
}

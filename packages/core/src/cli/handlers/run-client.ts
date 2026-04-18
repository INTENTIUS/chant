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
  signal(signalName: string): Promise<void>;
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

export interface HistoryEvent {
  eventType?: string;
  eventTime?: Date;
  activityTaskCompletedEventAttributes?: { scheduledEventId?: string | number };
  activityTaskScheduledEventAttributes?: { activityId?: string; activityType?: { name?: string } };
  activityTaskFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionCompletedEventAttributes?: unknown;
  workflowExecutionFailedEventAttributes?: { failure?: { message?: string } };
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
  const temporal = config.temporal as Record<string, unknown> | undefined;
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

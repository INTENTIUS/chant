/**
 * mockTemporalClient — minimal Client surface for testing the chant run
 * handlers and any other code that depends on @temporalio/client without a
 * real cluster.
 *
 * Returned shape mirrors the subset used by run-client.ts: { client, profile,
 * config }-style access patterns plus client.workflow.{getHandle,start,list}
 * call recorders.
 */

export interface MockWorkflowDescription {
  workflowId: string;
  runId: string;
  status: { name: string };
  startTime: Date;
  closeTime?: Date;
  taskQueue: string;
  type: { name: string };
}

export interface MockHistoryEvent {
  eventType?: string;
  eventTime?: Date;
  activityTaskScheduledEventAttributes?: {
    activityId?: string;
    activityType?: { name?: string };
  };
  activityTaskCompletedEventAttributes?: { scheduledEventId?: string | number };
  activityTaskFailedEventAttributes?: { failure?: { message?: string } };
}

export interface MockWorkflowSummary {
  workflowId: string;
  runId: string;
  type: { name: string };
  status: { name: string };
  startTime: Date;
  closeTime?: Date;
}

export interface MockTemporalClientOptions {
  /** Map of workflowId -> description for getHandle(...).describe() */
  describeByWorkflowId?: Record<string, MockWorkflowDescription>;
  /** Map of workflowId -> history events for getHandle(...).fetchHistory() */
  historyByWorkflowId?: Record<string, MockHistoryEvent[]>;
  /** Workflows returned by client.workflow.list() */
  list?: MockWorkflowSummary[];
  /** If set, getHandle().describe() throws this error (simulates not-found / no cluster) */
  describeError?: Error;
}

export interface RecordedCalls {
  startCalls: Array<{ workflowFn: unknown; opts: Record<string, unknown> }>;
  signalCalls: Array<{ workflowId: string; signalName: string }>;
  cancelCalls: Array<{ workflowId: string }>;
}

export interface MockTemporalClient {
  client: {
    workflow: {
      start(workflowFn: unknown, opts: Record<string, unknown>): Promise<{
        workflowId: string;
        firstExecutionRunId?: string;
        result(): Promise<unknown>;
        describe(): Promise<MockWorkflowDescription>;
        fetchHistory(): Promise<{ events?: MockHistoryEvent[] }>;
        signal(signalName: string): Promise<void>;
        cancel(): Promise<void>;
      }>;
      getHandle(workflowId: string): {
        workflowId: string;
        describe(): Promise<MockWorkflowDescription>;
        fetchHistory(): Promise<{ events?: MockHistoryEvent[] }>;
        signal(signalName: string): Promise<void>;
        cancel(): Promise<void>;
        result(): Promise<unknown>;
      };
      list(opts?: Record<string, unknown>): AsyncIterable<MockWorkflowSummary>;
    };
  };
  /** Records of calls made through the client — useful for assertions. */
  calls: RecordedCalls;
}

export function createMockTemporalClient(opts: MockTemporalClientOptions = {}): MockTemporalClient {
  const calls: RecordedCalls = { startCalls: [], signalCalls: [], cancelCalls: [] };

  const makeHandle = (workflowId: string) => ({
    workflowId,
    async describe(): Promise<MockWorkflowDescription> {
      if (opts.describeError) throw opts.describeError;
      const desc = opts.describeByWorkflowId?.[workflowId];
      if (!desc) {
        throw new Error(`Workflow not found: ${workflowId}`);
      }
      return desc;
    },
    async fetchHistory(): Promise<{ events?: MockHistoryEvent[] }> {
      return { events: opts.historyByWorkflowId?.[workflowId] ?? [] };
    },
    async signal(signalName: string): Promise<void> {
      calls.signalCalls.push({ workflowId, signalName });
    },
    async cancel(): Promise<void> {
      calls.cancelCalls.push({ workflowId });
    },
    async result(): Promise<unknown> {
      return undefined;
    },
  });

  return {
    client: {
      workflow: {
        async start(workflowFn: unknown, startOpts: Record<string, unknown>) {
          calls.startCalls.push({ workflowFn, opts: startOpts });
          const workflowId = String(startOpts.workflowId ?? "mock-wf");
          return {
            workflowId,
            firstExecutionRunId: "mock-run-id",
            ...makeHandle(workflowId),
          };
        },
        getHandle(workflowId: string) {
          return makeHandle(workflowId);
        },
        list(_listOpts?: Record<string, unknown>): AsyncIterable<MockWorkflowSummary> {
          const items = opts.list ?? [];
          return (async function* () {
            for (const item of items) yield item;
          })();
        },
      },
    },
    calls,
  };
}

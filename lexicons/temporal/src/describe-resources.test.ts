import { describe, test, expect, vi, beforeEach } from "vitest";

const loadChantConfigMock = vi.fn();
const loadTemporalClientMock = vi.fn();
const resolveProfileMock = vi.fn();

vi.mock("@intentius/chant/config", () => ({
  loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args),
}));

vi.mock("@intentius/chant/cli/handlers/run-client", () => ({
  loadTemporalClient: () => loadTemporalClientMock(),
  connectionOptions: (profile: { address: string }) => ({ address: profile.address }),
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
}));

const { describeResources } = await import("./describe-resources");

interface FakeNamespace {
  name: string;
  state?: number;
  description?: string;
  retentionSeconds?: number;
  isGlobal?: boolean;
}

interface FakeSchedule {
  scheduleId: string;
  workflowType?: string;
  cronExpressions?: string[];
  paused?: boolean;
}

function fakeConnection(opts: {
  namespaces: FakeNamespace[];
  searchAttributesByNs?: Record<string, Record<string, number>>;
  schedulesByNs?: Record<string, FakeSchedule[]>;
  searchAttrThrows?: Set<string>;
  scheduleThrows?: Set<string>;
}) {
  const close = vi.fn(async () => {});
  return {
    workflowService: {
      listNamespaces: vi.fn(async () => ({
        namespaces: opts.namespaces.map((n) => ({
          namespaceInfo: {
            name: n.name,
            state: n.state ?? 1,
            description: n.description,
          },
          config: n.retentionSeconds
            ? { workflowExecutionRetentionTtl: { seconds: n.retentionSeconds } }
            : null,
          isGlobalNamespace: n.isGlobal ?? false,
        })),
        nextPageToken: null,
      })),
    },
    operatorService: {
      listSearchAttributes: vi.fn(async ({ namespace }: { namespace: string }) => {
        if (opts.searchAttrThrows?.has(namespace)) {
          throw new Error(`stubbed search-attribute failure for ${namespace}`);
        }
        return { customAttributes: opts.searchAttributesByNs?.[namespace] ?? {} };
      }),
    },
    close,
  };
}

function fakeClient(opts: {
  schedulesByNs?: Record<string, FakeSchedule[]>;
  scheduleThrows?: Set<string>;
}) {
  return {
    scheduleClient: {
      list: ({ namespace }: { namespace?: string }) => {
        const schedules = opts.schedulesByNs?.[namespace ?? ""] ?? [];
        const shouldThrow = !!namespace && opts.scheduleThrows?.has(namespace);
        return (async function* () {
          if (shouldThrow) throw new Error(`stubbed schedule list failure for ${namespace}`);
          for (const s of schedules) {
            yield {
              scheduleId: s.scheduleId,
              spec: s.cronExpressions ? { cronExpressions: s.cronExpressions } : null,
              action: s.workflowType ? { type: "startWorkflow", workflowType: s.workflowType } : null,
              state: s.paused ? { paused: true } : null,
            };
          }
        })();
      },
    },
  };
}

function setupClientMock(connection: unknown, client: unknown) {
  loadTemporalClientMock.mockResolvedValue({
    Connection: { connect: vi.fn(async () => connection) },
    Client: vi.fn(() => client) as unknown as new () => unknown,
  });
}

describe("describeResources", () => {
  beforeEach(() => {
    loadChantConfigMock.mockReset();
    loadTemporalClientMock.mockReset();
    resolveProfileMock.mockReset();

    loadChantConfigMock.mockResolvedValue({ config: { temporal: { profiles: { dev: { address: "localhost:7233", namespace: "default", taskQueue: "q" } } } } });
    resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
  });

  test("emits one row per namespace + search-attr + schedule", async () => {
    const connection = fakeConnection({
      namespaces: [{ name: "default" }, { name: "prod" }],
      searchAttributesByNs: {
        default: { Project: 2 },
        prod: { Phase: 1 },
      },
      schedulesByNs: {
        default: [{ scheduleId: "daily-report", workflowType: "reportWf", cronExpressions: ["0 8 * * *"] }],
        prod: [{ scheduleId: "weekly-backup", workflowType: "backupWf", paused: true }],
      },
    });
    const client = fakeClient({
      schedulesByNs: {
        default: [{ scheduleId: "daily-report", workflowType: "reportWf", cronExpressions: ["0 8 * * *"] }],
        prod: [{ scheduleId: "weekly-backup", workflowType: "backupWf", paused: true }],
      },
    });
    setupClientMock(connection, client);

    const result = await describeResources({ environment: "dev", buildOutput: "", entityNames: [] });

    expect(Object.keys(result).sort()).toEqual([
      "namespace/default",
      "namespace/prod",
      "schedule/default/daily-report",
      "schedule/prod/weekly-backup",
      "searchAttribute/default/Project",
      "searchAttribute/prod/Phase",
    ]);
  });

  test("populates the resource metadata shape correctly", async () => {
    const connection = fakeConnection({
      namespaces: [{ name: "prod", description: "Prod namespace", retentionSeconds: 604800, isGlobal: true }],
      searchAttributesByNs: { prod: { Project: 2 } },
      schedulesByNs: {},
    });
    const client = fakeClient({
      schedulesByNs: {
        prod: [{ scheduleId: "daily-report", workflowType: "reportWf", cronExpressions: ["0 8 * * *"] }],
      },
    });
    setupClientMock(connection, client);

    const result = await describeResources({ environment: "prod", buildOutput: "", entityNames: [] });

    expect(result["namespace/prod"]).toEqual({
      type: "Temporal::Namespace",
      physicalId: "prod",
      status: "REGISTERED",
      attributes: {
        description: "Prod namespace",
        isGlobalNamespace: true,
        retentionSeconds: 604800,
      },
    });
    expect(result["searchAttribute/prod/Project"]).toEqual({
      type: "Temporal::SearchAttribute",
      physicalId: "prod/Project",
      status: "REGISTERED",
      attributes: { valueType: "Keyword", namespace: "prod" },
    });
    expect(result["schedule/prod/daily-report"]).toEqual({
      type: "Temporal::Schedule",
      physicalId: "prod/daily-report",
      status: "ACTIVE",
      attributes: {
        namespace: "prod",
        workflowType: "reportWf",
        cronExpressions: ["0 8 * * *"],
      },
    });
  });

  test("connection failure propagates with a clear error", async () => {
    loadTemporalClientMock.mockResolvedValue({
      Connection: { connect: vi.fn(async () => { throw new Error("UNAVAILABLE: connect ECONNREFUSED 127.0.0.1:7233"); }) },
      Client: vi.fn() as unknown as new () => unknown,
    });

    await expect(describeResources({ environment: "dev", buildOutput: "", entityNames: [] }))
      .rejects.toThrow(/UNAVAILABLE/);
  });

  test("empty cluster returns empty record without throwing", async () => {
    const connection = fakeConnection({ namespaces: [] });
    const client = fakeClient({});
    setupClientMock(connection, client);

    const result = await describeResources({ environment: "dev", buildOutput: "", entityNames: [] });

    expect(result).toEqual({});
  });

  test("per-namespace failures are warn-soft and don't abort other namespaces", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = fakeConnection({
      namespaces: [{ name: "broken" }, { name: "ok" }],
      searchAttributesByNs: { ok: { Project: 2 } },
      searchAttrThrows: new Set(["broken"]),
    });
    const client = fakeClient({
      schedulesByNs: {
        ok: [{ scheduleId: "daily-report", workflowType: "reportWf" }],
      },
      scheduleThrows: new Set(["broken"]),
    });
    setupClientMock(connection, client);

    const result = await describeResources({ environment: "dev", buildOutput: "", entityNames: [] });

    // Both namespaces present
    expect(result["namespace/broken"]).toBeDefined();
    expect(result["namespace/ok"]).toBeDefined();
    // ok's children present
    expect(result["searchAttribute/ok/Project"]).toBeDefined();
    expect(result["schedule/ok/daily-report"]).toBeDefined();
    // broken's children skipped
    expect(Object.keys(result).filter((k) => k.includes("/broken/"))).toEqual([]);
    // Warnings emitted
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

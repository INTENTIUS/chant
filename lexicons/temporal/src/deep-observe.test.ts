/**
 * Temporal deep observation (#1088) — the temporal row of the deep-observe
 * contract (#1014).
 *
 * Same seam the thin path's tests replace (`@intentius/chant/config` +
 * `@intentius/chant/cli/handlers/run-client`), so nothing here opens a socket
 * or reads `temporal.profiles` from a real chant.config.ts.
 */
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

const { temporalPlugin } = await import("./plugin");
const {
  observeResourcesDeepTemporal,
  temporalDeepNormalizationHooks,
  parseDurationSeconds,
  formatDurationSeconds,
  reconcileDuration,
} = await import("./deep-observe");
const { deepDiffForLexicon } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

interface FakeNamespace {
  name: string;
  description?: string;
  ownerEmail?: string;
  retentionSeconds?: number;
  isGlobal?: boolean;
  historyArchivalState?: number;
  historyArchivalUri?: string;
  visibilityArchivalState?: number;
  visibilityArchivalUri?: string;
}

function fakeConnection(opts: {
  namespaces: FakeNamespace[];
  searchAttributesByNs?: Record<string, Record<string, number>>;
  searchAttrThrows?: Set<string>;
}) {
  const close = vi.fn(async () => {});
  return {
    workflowService: {
      listNamespaces: vi.fn(async () => ({
        namespaces: opts.namespaces.map((n) => ({
          namespaceInfo: { name: n.name, state: 1, description: n.description, ownerEmail: n.ownerEmail },
          config: {
            ...(n.retentionSeconds ? { workflowExecutionRetentionTtl: { seconds: n.retentionSeconds } } : {}),
            ...(n.historyArchivalState !== undefined ? { historyArchivalState: n.historyArchivalState } : {}),
            ...(n.historyArchivalUri !== undefined ? { historyArchivalUri: n.historyArchivalUri } : {}),
            ...(n.visibilityArchivalState !== undefined ? { visibilityArchivalState: n.visibilityArchivalState } : {}),
            ...(n.visibilityArchivalUri !== undefined ? { visibilityArchivalUri: n.visibilityArchivalUri } : {}),
          },
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

/**
 * Both the connection and the schedule client in one mock, like the real
 * plugin sees them. `scheduleDescriptions` is keyed by scheduleId — the shape
 * `getHandle(id).describe()` resolves to, or an `Error` to reject with.
 */
function setupClientMock(connection: unknown, scheduleDescriptions: Record<string, () => unknown> = {}): void {
  loadTemporalClientMock.mockResolvedValue({
    Connection: { connect: vi.fn(async () => connection) },
    Client: vi.fn(() => ({
      scheduleClient: {
        getHandle: (scheduleId: string) => ({
          describe: async () => {
            const fixture = scheduleDescriptions[scheduleId];
            if (!fixture) throw new Error(`no fixture wired for schedule "${scheduleId}"`);
            const value = fixture();
            if (value instanceof Error) throw value;
            return value;
          },
        }),
      },
    })),
  });
}

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));

beforeEach(() => {
  loadChantConfigMock.mockReset();
  loadTemporalClientMock.mockReset();
  resolveProfileMock.mockReset();

  loadChantConfigMock.mockResolvedValue({
    config: { temporal: { profiles: { prod: { address: "localhost:7233", namespace: "default", taskQueue: "q" } } } },
  });
  resolveProfileMock.mockReturnValue({ address: "localhost:7233", namespace: "default", taskQueue: "q" });
});

describe("duration reconciliation", () => {
  test("parses simple and combined duration strings to seconds", () => {
    expect(parseDurationSeconds("7d")).toBe(7 * 86400);
    expect(parseDurationSeconds("720h")).toBe(720 * 3600);
    expect(parseDurationSeconds("1h30m")).toBe(3600 + 30 * 60);
    expect(parseDurationSeconds("2592000s")).toBe(2592000);
    expect(parseDurationSeconds("90")).toBe(90);
    expect(parseDurationSeconds("")).toBeUndefined();
    expect(parseDurationSeconds("not a duration")).toBeUndefined();
  });

  test("formats seconds as the largest whole unit", () => {
    expect(formatDurationSeconds(7 * 86400)).toBe("7d");
    expect(formatDurationSeconds(3600)).toBe("1h");
    expect(formatDurationSeconds(90)).toBe("90s"); // not evenly divisible by 60
    expect(formatDurationSeconds(0)).toBe("0s");
  });

  test("echoes the declared string back when it parses to the same number of seconds", () => {
    expect(reconcileDuration("30d", 30 * 86400)).toBe("30d");
    expect(reconcileDuration("720h", 30 * 86400)).toBe("720h");
    expect(reconcileDuration("2592000s", 30 * 86400)).toBe("2592000s");
  });

  test("reformats to a canonical string when the value genuinely differs", () => {
    expect(reconcileDuration("30d", 3 * 86400)).toBe("3d");
    expect(reconcileDuration(undefined, 7 * 86400)).toBe("7d");
  });
});

describe("the temporal noise rules", () => {
  test("subtracts namespace defaults only where source is silent about the property", () => {
    const declaredNothing = normalizeDeepProperties(
      { name: "prod", retention: "7d", description: "", ownerEmail: "", isGlobalNamespace: false, historyArchivalState: "Disabled", historyArchivalUri: "", visibilityArchivalState: "Disabled", visibilityArchivalUri: "" },
      { entityType: "Temporal::Namespace", side: "live", hooks: temporalDeepNormalizationHooks, counterpartPaths: new Set(["name"]) },
    );
    expect(declaredNothing).toEqual({ name: "prod" });

    const declaredRetention = normalizeDeepProperties(
      { name: "prod", retention: "7d", description: "" },
      { entityType: "Temporal::Namespace", side: "live", hooks: temporalDeepNormalizationHooks, counterpartPaths: new Set(["name", "retention"]) },
    );
    expect(declaredRetention).toEqual({ name: "prod", retention: "7d" });
  });

  test("a one-sided pass never subtracts defaults — the reader has no declared tree yet", () => {
    const out = normalizeDeepProperties(
      { name: "prod", retention: "7d" },
      { entityType: "Temporal::Namespace", side: "live", hooks: temporalDeepNormalizationHooks },
    );
    expect(out).toEqual({ name: "prod", retention: "7d" });
  });

  test("subtracts schedule policy/state defaults only where source is silent", () => {
    const out = normalizeDeepProperties(
      { scheduleId: "s", policies: { overlap: "Skip", pauseOnFailure: false }, state: { paused: false, note: "" } },
      {
        entityType: "Temporal::Schedule",
        side: "live",
        hooks: temporalDeepNormalizationHooks,
        counterpartPaths: new Set(["scheduleId", "policies", "policies.overlap"]),
      },
    );
    // `state` disappears as a whole wrapper (nobody declared it at all); only
    // `pauseOnFailure` drops out of `policies` — `overlap` stays because the
    // declared side has it.
    expect(out).toEqual({ scheduleId: "s", policies: { overlap: "Skip" } });
  });

  test("a schedule's declared `state` keeps whatever isn't at rest", () => {
    const out = normalizeDeepProperties(
      { state: { paused: true, note: "" } },
      { entityType: "Temporal::Schedule", side: "live", hooks: temporalDeepNormalizationHooks, counterpartPaths: new Set<string>() },
    );
    // `paused: true` is not the default, so the wrapper survives — only the
    // still-default `note` leaf drops out of it.
    expect(out).toEqual({ state: { paused: true } });
  });

  test("canonicalizes cronExpressions and nonRetryableErrorTypes as sets", () => {
    const out = normalizeDeepProperties(
      {
        spec: { cronExpressions: ["0 9 * * *", "0 2 * * *"] },
        action: { workflowRetryPolicy: { nonRetryableErrorTypes: ["ZodError", "AbortError"] } },
      },
      { entityType: "Temporal::Schedule", side: "live", hooks: temporalDeepNormalizationHooks },
    );
    expect((out.spec as { cronExpressions: string[] }).cronExpressions).toEqual(["0 2 * * *", "0 9 * * *"]);
    expect((out.action as { workflowRetryPolicy: { nonRetryableErrorTypes: string[] } }).workflowRetryPolicy.nonRetryableErrorTypes).toEqual([
      "AbortError",
      "ZodError",
    ]);
  });

  test("leaves action.args in source order — a positional call, not a set", () => {
    const out = normalizeDeepProperties(
      { action: { args: ["z", "a", "m"] } },
      { entityType: "Temporal::Schedule", side: "live", hooks: temporalDeepNormalizationHooks },
    );
    expect((out.action as { args: string[] }).args).toEqual(["z", "a", "m"]);
  });
});

describe("observeResourcesDeepTemporal", () => {
  test("reads a namespace through the same profile-resolution seam as describeResources", async () => {
    setupClientMock(fakeConnection({ namespaces: [{ name: "prod", retentionSeconds: 30 * 86400, description: "Prod namespace" }] }));

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["prodNs"],
        entities: entities({ prodNs: { entityType: "Temporal::Namespace", props: { name: "prod", retention: "30d", description: "Prod namespace" } } }),
      }),
    );

    // The reader itself has no declared tree to consult (`counterpart` is
    // "unknown" here, not "absent"), so nothing is default-subtracted yet —
    // that only happens on the second, declared-aware pass `diffDeepObservation`
    // runs (see "a one-sided pass never subtracts defaults" below).
    expect(result.resources.prodNs).toEqual({
      type: "Temporal::Namespace",
      physicalId: "prod",
      properties: {
        name: "prod",
        retention: "30d",
        description: "Prod namespace",
        ownerEmail: "",
        isGlobalNamespace: false,
        historyArchivalState: "Disabled",
        historyArchivalUri: "",
        visibilityArchivalState: "Disabled",
        visibilityArchivalUri: "",
      },
    });
    expect(loadChantConfigMock).toHaveBeenCalled();
    expect(resolveProfileMock).toHaveBeenCalledWith(expect.objectContaining({ temporal: expect.anything() }), "prod");
  });

  test("a namespace not yet deployed is a real absence — no properties, no holes", async () => {
    setupClientMock(fakeConnection({ namespaces: [] }));

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["prodNs"],
        entities: entities({ prodNs: { entityType: "Temporal::Namespace", props: { name: "prod" } } }),
      }),
    );

    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("reads a search attribute and matches it back to its declared entity", async () => {
    setupClientMock(fakeConnection({ namespaces: [{ name: "prod" }], searchAttributesByNs: { prod: { Project: 2 } } }));

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["projectAttr"],
        entities: entities({ projectAttr: { entityType: "Temporal::SearchAttribute", props: { name: "Project", type: "Keyword", namespace: "prod" } } }),
      }),
    );

    expect(result.resources.projectAttr).toEqual({
      type: "Temporal::SearchAttribute",
      physicalId: "prod/Project",
      properties: { name: "Project", type: "Keyword", namespace: "prod" },
    });
  });

  test("a namespace whose search attributes could not be listed is read-failed, per entity", async () => {
    setupClientMock(fakeConnection({ namespaces: [{ name: "staging" }], searchAttrThrows: new Set(["staging"]) }));

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["stagingAttr"],
        entities: entities({ stagingAttr: { entityType: "Temporal::SearchAttribute", props: { name: "Phase", namespace: "staging" } } }),
      }),
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved.stagingAttr.reason).toBe("read-failed");
  });

  test("reads a schedule through getHandle(...).describe(), not the thin list() summary", async () => {
    setupClientMock(fakeConnection({ namespaces: [] }), {
      "daily-report": () => ({
        schedule: {
          spec: { cronExpressions: ["0 8 * * *"] },
          action: { workflowType: "reportWf", taskQueue: "reports" },
          policies: { overlap: "Skip", pauseOnFailure: false },
          state: { paused: false, note: "" },
        },
      }),
    });

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["dailyReport"],
        entities: entities({
          dailyReport: {
            entityType: "Temporal::Schedule",
            props: { scheduleId: "daily-report", namespace: "prod", spec: { cronExpressions: ["0 8 * * *"] }, action: { workflowType: "reportWf", taskQueue: "reports" }, policies: { overlap: "Skip" } },
          },
        }),
      }),
    );

    // Same one-sided caveat as the namespace test above: `policies.pauseOnFailure`
    // and `state` are still here because the reader has no declared tree yet.
    expect(result.resources.dailyReport).toEqual({
      type: "Temporal::Schedule",
      physicalId: "prod/daily-report",
      properties: {
        scheduleId: "daily-report",
        namespace: "prod",
        spec: { cronExpressions: ["0 8 * * *"] },
        action: { workflowType: "reportWf", taskQueue: "reports" },
        policies: { overlap: "Skip", pauseOnFailure: false },
        state: { paused: false, note: "" },
      },
    });
  });

  test("a schedule that was never created is an absence, not a hole", async () => {
    setupClientMock(fakeConnection({ namespaces: [] }), {
      "daily-report": () => new Error("schedule not found: daily-report"),
    });

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["dailyReport"],
        entities: entities({ dailyReport: { entityType: "Temporal::Schedule", props: { scheduleId: "daily-report", namespace: "prod" } } }),
      }),
    );

    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("a schedule describe() failure that isn't not-found is a hole, not an absence", async () => {
    setupClientMock(fakeConnection({ namespaces: [] }), {
      "weekly-backup": () => new Error("UNAVAILABLE: connection reset"),
    });

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["weeklyBackup"],
        entities: entities({ weeklyBackup: { entityType: "Temporal::Schedule", props: { scheduleId: "weekly-backup", namespace: "prod" } } }),
      }),
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved.weeklyBackup.reason).toBe("read-failed");
  });

  test("a type with no deep reader is unsupported-kind, never absent", async () => {
    setupClientMock(fakeConnection({ namespaces: [] }));

    const result = normalizeDeepObservation(
      await observeResourcesDeepTemporal({
        environment: "prod",
        entityNames: ["server"],
        entities: entities({ server: { entityType: "Temporal::Server", props: {} } }),
      }),
    );

    expect(result.resources).toEqual({});
    expect(result.unobserved.server.reason).toBe("unsupported-kind");
  });
});

/**
 * The acceptance test for #1088: the real plugin, a mutated live cluster, a
 * baseline, and exactly the genuine drift — same shape as the AWS reference's
 * end-to-end test (lexicons/aws/src/deep-observe.test.ts).
 */
describe("end to end: declared + mutated live + baseline (#1088)", () => {
  const declared = entities({
    // Declared with a 30-day retention and a description nobody has touched.
    prodNs: {
      entityType: "Temporal::Namespace",
      props: { name: "prod", retention: "30d", description: "Prod namespace" },
    },
    projectAttr: {
      entityType: "Temporal::SearchAttribute",
      props: { name: "Project", type: "Keyword", namespace: "prod" },
    },
    dailyReport: {
      entityType: "Temporal::Schedule",
      props: {
        scheduleId: "daily-report",
        namespace: "prod",
        spec: { cronExpressions: ["0 8 * * *"] },
        action: { workflowType: "reportWf", taskQueue: "reports" },
        policies: { overlap: "Skip" },
      },
    },
    // The deep read of this one fails outright.
    weeklyBackup: {
      entityType: "Temporal::Schedule",
      props: { scheduleId: "weekly-backup", namespace: "prod", spec: { cronExpressions: ["0 3 * * SUN"] }, action: { workflowType: "backupWf", taskQueue: "backup" } },
    },
    // No deep reader for the server resource kind.
    server: { entityType: "Temporal::Server", props: {} },
  });

  const wireMocks = (): void => {
    setupClientMock(
      fakeConnection({
        namespaces: [
          {
            name: "prod",
            // GENUINE: retention shortened from 30d to 3d via tctl.
            retentionSeconds: 3 * 86400,
            // NOISE-once-accepted: description edited out of band, accepted below.
            description: "Production namespace (ops-renamed)",
            // NOISE: defaults nobody declared.
            ownerEmail: "",
            isGlobal: false,
            historyArchivalState: 1,
            historyArchivalUri: "",
            visibilityArchivalState: 1,
            visibilityArchivalUri: "",
          },
        ],
        searchAttributesByNs: { prod: { Project: 2 } },
      }),
      {
        "daily-report": () => ({
          schedule: {
            spec: { cronExpressions: ["0 8 * * *"] },
            // GENUINE: the task queue changed out of band.
            action: { workflowType: "reportWf", taskQueue: "reports-v2" },
            // NOISE: defaults nobody declared.
            policies: { overlap: "Skip", pauseOnFailure: false },
            state: { paused: false, note: "" },
          },
        }),
        "weekly-backup": () => new Error("An error occurred: UNAVAILABLE"),
      },
    );
  };

  const baseline = {
    prodNs: {
      type: "Temporal::Namespace",
      accepted: [{ path: "description", value: "Production namespace (ops-renamed)" }],
    },
  };

  test("exactly the genuine drift surfaces; defaults and the accepted description do not", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(temporalPlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
      baseline,
    });

    const prodNsDrift = result.drifted.find((d) => d.name === "prodNs");
    expect(prodNsDrift?.changes).toEqual([{ path: "retention", kind: "changed", declared: "30d", live: "3d" }]);

    const dailyReportDrift = result.drifted.find((d) => d.name === "dailyReport");
    expect(dailyReportDrift?.changes).toEqual([{ path: "action.taskQueue", kind: "changed", declared: "reports", live: "reports-v2" }]);

    expect(result.unchanged).toEqual(["projectAttr"]);

    expect(result.accepted.map((e) => e.name)).toEqual(["prodNs"]);
    expect(result.accepted[0].changes.map((c) => c.path)).toEqual(["description"]);

    expect(result.unobserved).toEqual([
      { name: "server", type: "Temporal::Server", reason: "unsupported-kind", detail: "no deep reader for Temporal::Server" },
      {
        name: "weeklyBackup",
        type: "Temporal::Schedule",
        reason: "read-failed",
        detail: 'schedule describe failed for "weekly-backup" in namespace "prod": An error occurred: UNAVAILABLE',
      },
    ]);
  });

  test("without the baseline the description edit is drift, and accepting it is what silences it", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(temporalPlugin, { environment: "prod", buildOutput: "", entities: declared });
    const prodNsDrift = result.drifted.find((d) => d.name === "prodNs");
    expect(prodNsDrift?.changes.map((c) => c.path).sort()).toEqual(["description", "retention"]);
    expect(result.accepted).toEqual([]);
  });

  test("an accepted value that later changes is drift again, with all three axes", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(temporalPlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
      baseline: { prodNs: { accepted: [{ path: "description", value: "someone else's rename" }] } },
    });
    const change = result.drifted.find((d) => d.name === "prodNs")?.changes.find((c) => c.path === "description");
    expect(change).toEqual({
      path: "description",
      kind: "changed",
      declared: "Prod namespace",
      live: "Production namespace (ops-renamed)",
      baseline: "someone else's rename",
    });
  });

  test("a whole-lexicon failure is a hole for every declared entity, not a clean report", async () => {
    loadTemporalClientMock.mockResolvedValue({
      Connection: { connect: vi.fn(async () => { throw new Error("UNAVAILABLE: connect ECONNREFUSED 127.0.0.1:7233"); }) },
      Client: vi.fn() as unknown as new () => unknown,
    });
    const result = await deepDiffForLexicon(temporalPlugin, { environment: "prod", buildOutput: "", entities: declared });
    expect(result.drifted).toEqual([]);
    expect(result.unobserved.map((u) => u.name).sort()).toEqual(["dailyReport", "prodNs", "projectAttr", "server", "weeklyBackup"]);
    expect(new Set(result.unobserved.map((u) => u.reason))).toEqual(new Set(["read-failed"]));
  });
});

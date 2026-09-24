/**
 * `chant components promote` (#2530), `rollback` (#2531) and `redeploy`
 * (#2604), with the ledger, discovery and the
 * capability registry replaced by fakes.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { CapabilityRegistry, type DeployContext } from "../../components/capability";
import type { DriverComponent } from "../../components/driver";
import type { ReleaseRecord } from "../../lifecycle/release-ledger";
import type { ParsedArgs } from "../registry";

const appendReleaseRecordMock = vi.fn();
const readReleaseLedgerMock = vi.fn();
const pushLifecycleMock = vi.fn();
const resolveTargetsMock = vi.fn();
const ran: string[] = [];
let publishedDigest = "sha256:api";
let failApplyFor: string | undefined;

vi.mock("../../lifecycle/git", () => ({
  getHeadCommit: async () => "abc123",
  fetchLifecycle: async () => true,
  pushLifecycle: (...args: unknown[]) => pushLifecycleMock(...args),
}));

vi.mock("../../lifecycle/release-ledger", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-ledger")>("../../lifecycle/release-ledger");
  return {
    ...actual,
    appendReleaseRecord: (...args: unknown[]) => appendReleaseRecordMock(...args),
    readReleaseLedger: (...args: unknown[]) => readReleaseLedgerMock(...args),
  };
});

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});

vi.mock("../../components/cli-support", () => ({
  resolveComponentTargets: (...args: unknown[]) => resolveTargetsMock(...args),
}));

vi.mock("../../components/fan-out-support", () => ({
  fanOutRegistry: async () => {
    const registry = new CapabilityRegistry();
    const step = (kind: string, output: (ctx: DeployContext) => unknown) =>
      registry.register({ kind, async run(ctx: DeployContext) { ran.push(`${ctx.env}:${kind}`); return output(ctx); } } as never);
    step("docker-build", () => ({ digest: "sha256:rebuilt" }));
    step("publish-image", () => ({ digest: publishedDigest, uri: `reg/api@${publishedDigest}` }));
    step("apply", (ctx) => {
      if (ctx.component === failApplyFor) throw new Error("apply failed");
      return {};
    });
    return registry;
  },
}));

// Gates read an in-memory ledger rather than the git branch.
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  const port = actual.memoryGateLedgerPort();
  return { ...actual, gitGateLedgerPort: () => port };
});

// The run handler pulls in every runtime; the promote needs only its exit code.
vi.mock("./run", () => ({ GATED_EXIT_CODE: 3 }));

const { runComponentsPromote, runComponentsRollback, runComponentsRedeploy } = await import("./promote");

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Build", steps: [{ kind: "docker-build", context: ".", into: "api.tar" }] },
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
    { phase: "Apply", steps: [{ kind: "apply", imageRef: "@Publish.digest" }] },
  ],
};

const staging: ReleaseRecord = {
  version: 1,
  component: "api",
  env: "staging",
  digest: "sha256:api",
  gitSha: "abc123",
  runId: "run-7",
  timestamp: "2026-01-02T00:00:00.000Z",
  actor: "ci",
};

function args(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "components",
    path: "promote",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    migrateFrom: "staging",
    migrateTo: "prod",
    actor: "bob",
    runId: "run-9",
    ...overrides,
  } as ParsedArgs;
}

const ctx = (a: Partial<ParsedArgs>) => ({ args: args(a), plugins: [] }) as never;

let errors: string[];
let logs: string[];

beforeEach(() => {
  ran.length = 0;
  publishedDigest = "sha256:api";
  failApplyFor = undefined;
  errors = [];
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...m: unknown[]) => { logs.push(m.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  appendReleaseRecordMock.mockReset().mockImplementation(async (input: object) => ({ commit: "c0ffee0", record: { version: 1, ...input } }));
  readReleaseLedgerMock.mockReset().mockResolvedValue({ records: [staging], malformed: 0 });
  pushLifecycleMock.mockReset().mockResolvedValue(undefined);
  resolveTargetsMock.mockReset().mockResolvedValue({ success: true, targets: [api] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chant components promote", () => {
  test("--from and --to are required", async () => {
    expect(await runComponentsPromote(ctx({ migrateTo: undefined }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--from <env> and --to <env> are required/);
  });

  test("deploys the staging digest to prod without building, and records the promotion", async () => {
    expect(await runComponentsPromote(ctx({}))).toBe(0);
    expect(readReleaseLedgerMock).toHaveBeenCalledWith("staging");
    expect(ran).toEqual(["prod:publish-image", "prod:apply"]);
    expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({
      component: "api",
      env: "prod",
      digest: "sha256:api",
      gitSha: "abc123",
      runId: "run-9",
      actor: "bob",
      promotedFrom: { env: "staging", runId: "run-7", timestamp: "2026-01-02T00:00:00.000Z" },
    });
    expect(pushLifecycleMock).toHaveBeenCalledTimes(1);
  });

  test("a digest missing from the source ledger fails clearly and deploys nothing", async () => {
    expect(await runComponentsPromote(ctx({ component: "api", digest: "sha256:unknown" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/sha256:unknown is not recorded for "api" in "staging"/);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("--dry-run prints the plan and deploys nothing", async () => {
    expect(await runComponentsPromote(ctx({ dryRun: true, json: true }))).toBe(0);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    const plan = JSON.parse(logs.join("\n"));
    expect(plan.items).toEqual([expect.objectContaining({ component: "api", digest: "sha256:api", notRun: ["docker-build"] })]);
  });

  test("a publish that does not match the recorded digest fails and records nothing", async () => {
    publishedDigest = "sha256:other";
    expect(await runComponentsPromote(ctx({}))).toBe(1);
    expect(ran).toEqual(["prod:publish-image"]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("a gate in the composition stops the promote with exit 3 and records nothing", async () => {
    const gated: DriverComponent = {
      ...api,
      deploy: [...api.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply" }] }],
    };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [gated] });
    expect(await runComponentsPromote(ctx({}))).toBe(3);
    expect(ran).not.toContain("prod:apply");
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/chant approve api prod-release/);
  });

  test("a component that deployed is recorded even when another one failed", async () => {
    const web: DriverComponent = { ...api, name: "web" };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [api, web] });
    readReleaseLedgerMock.mockResolvedValue({ records: [staging, { ...staging, component: "web" }], malformed: 0 });
    failApplyFor = "web";
    expect(await runComponentsPromote(ctx({}))).toBe(1);
    expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ component: "api", env: "prod" });
  });

  test("a component with no publish step is refused before anything runs", async () => {
    resolveTargetsMock.mockResolvedValue({
      success: true,
      targets: [{ name: "api", deploy: [{ phase: "Apply", steps: [{ kind: "apply" }] }] }],
    });
    expect(await runComponentsPromote(ctx({}))).toBe(1);
    expect(errors.join("\n")).toMatch(/no publish step/);
    expect(ran).toEqual([]);
  });
});

describe("chant components rollback", () => {
  const prod = (digest: string, timestamp: string, runId: string): ReleaseRecord =>
    ({ ...staging, env: "prod", digest, timestamp, runId });

  beforeEach(() => {
    readReleaseLedgerMock.mockResolvedValue({
      records: [prod("sha256:old", "2026-01-01T00:00:00.000Z", "run-1"), prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2")],
      malformed: 0,
    });
  });

  const rb = (a: Partial<ParsedArgs>) => ctx({ migrateFrom: undefined, migrateTo: undefined, path: "rollback", extraPositional: "prod", component: "api", ...a });

  test("an environment and --component are required", async () => {
    expect(await runComponentsRollback(rb({ component: undefined }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--component <name> are required/);
  });

  test("redeploys the previous release from its recorded digest and records what it restored", async () => {
    expect(await runComponentsRollback(rb({}))).toBe(0);
    expect(readReleaseLedgerMock).toHaveBeenCalledWith("prod");
    // Neither a build nor a publish: the environment already has the artifact.
    expect(ran).toEqual(["prod:apply"]);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({
      component: "api",
      env: "prod",
      digest: "sha256:old",
      restores: { env: "prod", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z" },
    });
    expect(appendReleaseRecordMock.mock.calls[0][0]).not.toHaveProperty("promotedFrom");
  });

  test("a digest the environment never recorded fails clearly", async () => {
    expect(await runComponentsRollback(rb({ digest: "sha256:elsewhere" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/sha256:elsewhere is not recorded for "api" in "prod"/);
    expect(ran).toEqual([]);
  });

  test("the environment's gate applies to a rollback", async () => {
    const gated: DriverComponent = {
      ...api,
      name: "api",
      deploy: [...api.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "gate", gate: "rollback-ok" }, { kind: "apply" }] }],
    };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [gated] });
    expect(await runComponentsRollback(rb({}))).toBe(3);
    expect(ran).not.toContain("prod:apply");
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/chant approve api rollback-ok/);
  });
});

describe("chant components redeploy", () => {
  const prod = (digest: string, timestamp: string, runId: string): ReleaseRecord =>
    ({ ...staging, env: "prod", digest, timestamp, runId });

  beforeEach(() => {
    readReleaseLedgerMock.mockResolvedValue({
      records: [prod("sha256:old", "2026-01-01T00:00:00.000Z", "run-1"), prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2")],
      malformed: 0,
    });
  });

  const rd = (a: Partial<ParsedArgs>) => ctx({ migrateFrom: undefined, migrateTo: undefined, path: "redeploy", extraPositional: "prod", component: "api", ...a });

  test("an environment and --component are required", async () => {
    expect(await runComponentsRedeploy(rd({ extraPositional: undefined }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--component <name> are required/);
    expect(errors.join("\n")).toMatch(/chant components redeploy <env>/);
  });

  test("redeploys the current release from its recorded digest and records it", async () => {
    expect(await runComponentsRedeploy(rd({}))).toBe(0);
    expect(readReleaseLedgerMock).toHaveBeenCalledWith("prod");
    // Neither a build nor a publish: the environment already has the artifact.
    expect(ran).toEqual(["prod:apply"]);
    expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
    const written = appendReleaseRecordMock.mock.calls[0][0];
    expect(written).toMatchObject({
      component: "api",
      env: "prod",
      digest: "sha256:new",
      runId: "run-9",
      actor: "bob",
      redeploys: { env: "prod", runId: "run-2", timestamp: "2026-01-02T00:00:00.000Z" },
    });
    expect(written).not.toHaveProperty("restores");
    expect(written).not.toHaveProperty("promotedFrom");
    expect(pushLifecycleMock).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).toMatch(/Redeployed .*api.* in prod at sha256:new/);
  });

  test("the same digest rollback refuses is the one redeploy accepts", async () => {
    expect(await runComponentsRollback(rd({ path: "rollback", digest: "sha256:new" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/already the current release/);
    expect(await runComponentsRedeploy(rd({ digest: "sha256:new" }))).toBe(0);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ digest: "sha256:new" });
  });

  test("a --digest other than the current one is refused before anything runs", async () => {
    expect(await runComponentsRedeploy(rd({ digest: "sha256:old" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/sha256:old is not the current release/);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("--dry-run prints the plan and deploys nothing", async () => {
    expect(await runComponentsRedeploy(rd({ dryRun: true, json: true }))).toBe(0);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    const plan = JSON.parse(logs.join("\n"));
    expect(plan).toMatchObject({ from: "prod", to: "prod" });
    expect(plan.items).toEqual([expect.objectContaining({ component: "api", digest: "sha256:new", notRun: ["docker-build", "publish-image"] })]);
  });

  test("the environment's gate applies to a redeploy", async () => {
    const gated: DriverComponent = {
      ...api,
      deploy: [...api.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "gate", gate: "redeploy-ok" }, { kind: "apply" }] }],
    };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [gated] });
    expect(await runComponentsRedeploy(rd({}))).toBe(3);
    expect(ran).not.toContain("prod:apply");
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/chant approve api redeploy-ok/);
    expect(errors.join("\n")).toMatch(/then run the same redeploy again/);
  });

  test("a failed redeploy records nothing and exits 1", async () => {
    failApplyFor = "api";
    expect(await runComponentsRedeploy(rd({}))).toBe(1);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toMatch(/redeploy failed at "api"/);
  });
});

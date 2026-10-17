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
import { makeRelease } from "../../lifecycle/release-store";
import { contentDigest } from "../../content-digest";

const appendReleaseRecordMock = vi.fn();
const readReleaseLedgerMock = vi.fn();
const pushLifecycleMock = vi.fn();
const resolveTargetsMock = vi.fn();
const ran: string[] = [];
const stepInputs: Array<{ kind: string; input: unknown }> = [];
let releaseFixture: { release: import("../../lifecycle/release-store").Release; label: string | null } | null = null;
let storedTemplate: string | null = null;
const writtenTemplates: unknown[] = [];
let configEnvironments: unknown[] | undefined;
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
  return { ...actual, loadChantConfig: async () => ({ config: configEnvironments ? { environments: configEnvironments } : {} }) };
});

vi.mock("../../components/cli-support", () => ({
  isComponentList: (selector: string) => selector.includes(","),
  resolveComponentTargets: (...args: unknown[]) => resolveTargetsMock(...args),
}));

vi.mock("../../components/fan-out-support", () => ({
  fanOutRegistry: async () => {
    const registry = new CapabilityRegistry();
    const step = (kind: string, output: (ctx: DeployContext) => unknown) =>
      registry.register({ kind, async run(ctx: DeployContext, input: unknown) { ran.push(`${ctx.env}:${kind}`); stepInputs.push({ kind, input }); return output(ctx); } } as never);
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
  return { ...actual, gitGateLedgerPort: () => port, gateIsSealed: async (gate: string) => sealedGates.has(gate) };
});
const sealedGates = new Set<string>();

// #4026: the release store holds one release and one template's bytes.
vi.mock("../../lifecycle/release-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-store")>("../../lifecycle/release-store");
  return {
    ...actual,
    resolveRelease: async (ref: string) => (releaseFixture && (ref === releaseFixture.label || ref === releaseFixture.release.releaseDigest) ? releaseFixture : null),
    readReleaseTemplate: async () => storedTemplate,
  };
});
vi.mock("../../components/release-promote", async () => {
  const actual = await vi.importActual<typeof import("../../components/release-promote")>("../../components/release-promote");
  return { ...actual, writePinnedTemplates: (_dir: string, files: unknown[]) => writtenTemplates.push(...files) };
});

// The run handler pulls in every runtime; the promote needs only its exit code.
vi.mock("./run", () => ({ GATED_EXIT_CODE: 3 }));

const { runComponentsPromote, runComponentsRollback, runComponentsRedeploy } = await import("./promote");
const { checkRunEventLines, stepTrail } = await import("../../workspace/__fixtures__/run-event-check");

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
  sealedGates.clear();
  ran.length = 0;
  stepInputs.length = 0;
  writtenTemplates.length = 0;
  releaseFixture = null;
  storedTemplate = null;
  configEnvironments = undefined;
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
  test("--to is required", async () => {
    expect(await runComponentsPromote(ctx({ migrateTo: undefined }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--to <env> is required/);
  });

  test("--from is required when the member declares no environments, and nothing is refused", async () => {
    expect(await runComponentsPromote(ctx({ migrateFrom: undefined }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--from <env> is required: this member declares no environments/);
    errors.length = 0;
    expect(await runComponentsPromote(ctx({ migrateFrom: "dev", migrateTo: "prod" }))).toBe(0);
  });

  test("the declared order defaults --from to the previous environment (#4030)", async () => {
    configEnvironments = ["dev", { name: "staging", canary: true }, "prod"];
    expect(await runComponentsPromote(ctx({ migrateFrom: undefined }))).toBe(0);
    expect(readReleaseLedgerMock).toHaveBeenCalledWith("staging");
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ env: "prod", promotedFrom: { env: "staging" } });
  });

  test("a promotion that skips an environment is refused with a code and a fix, and deploys nothing (#4030)", async () => {
    configEnvironments = ["dev", "staging", "prod"];
    expect(await runComponentsPromote(ctx({ migrateFrom: "dev", migrateTo: "prod" }))).toBe(1);
    const out = errors.join("\n");
    expect(out).toMatch(/promoting dev to prod skips staging/);
    expect(out).toMatch(/\[promote-skips-environment\]/);
    expect(out).toMatch(/--allow-skip/);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("--allow-skip promotes past a declared environment (#4030)", async () => {
    configEnvironments = ["dev", "staging", "prod"];
    readReleaseLedgerMock.mockResolvedValue({ records: [{ ...staging, env: "dev" }], malformed: 0 });
    expect(await runComponentsPromote(ctx({ migrateFrom: "dev", migrateTo: "prod", allowSkip: true }))).toBe(0);
    expect(readReleaseLedgerMock).toHaveBeenCalledWith("dev");
    expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
  });

  test("the first environment of the order has nothing to default --from to (#4030)", async () => {
    configEnvironments = ["dev", "staging", "prod"];
    expect(await runComponentsPromote(ctx({ migrateFrom: undefined, migrateTo: "dev" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/\[promote-no-previous-environment\]/);
    errors.length = 0;
    expect(await runComponentsPromote(ctx({ migrateFrom: undefined, migrateTo: "qa" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/\[promote-to-not-in-order\]/);
    expect(ran).toEqual([]);
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
    expect(errors.join("\n")).not.toContain("--sign");
  });

  test("a sealed gate's approve line carries --sign (#3521)", async () => {
    sealedGates.add("prod-release");
    const gated: DriverComponent = {
      ...api,
      deploy: [...api.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply" }] }],
    };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [gated] });
    expect(await runComponentsPromote(ctx({}))).toBe(3);
    expect(errors.join("\n")).toMatch(/approve : chant approve api prod-release.* --sign/);
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

  test("--digest <component>=<digest> promotes the pinned release, not the latest one (#2602)", async () => {
    const web: DriverComponent = { ...api, name: "web" };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [api, web] });
    // Another pipeline recorded sha256:newer after this one recorded sha256:api.
    readReleaseLedgerMock.mockResolvedValue({
      records: [staging, { ...staging, digest: "sha256:newer", timestamp: "2026-01-03T00:00:00.000Z", runId: "run-8" }, { ...staging, component: "web" }],
      malformed: 0,
    });
    expect(await runComponentsPromote(ctx({ digests: ["api=sha256:api"] }))).toBe(0);
    expect(appendReleaseRecordMock).toHaveBeenCalledTimes(1);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({
      component: "api",
      env: "prod",
      digest: "sha256:api",
      promotedFrom: { env: "staging", runId: "run-7" },
    });
  });

  test("an empty pinned digest fails and deploys nothing (#2602)", async () => {
    expect(await runComponentsPromote(ctx({ digests: ["api="] }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--digest api= names no digest/);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("a bare --digest without --component is refused", async () => {
    expect(await runComponentsPromote(ctx({ digest: "sha256:api", digests: ["sha256:api"] }))).toBe(1);
    expect(errors.join("\n")).toMatch(/needs --component/);
    expect(ran).toEqual([]);
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

describe("chant components promote --release (#4026)", () => {
  const prodTemplate = `{"env":"prod"}\n`;
  const withTemplate: DriverComponent = {
    ...api,
    deploy: [...api.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "apply", template: "dist/api.template.json", imageRef: "@Publish.digest" }] }],
  };
  const release = makeRelease({
    member: null,
    commit: "abc123".padEnd(40, "0"),
    artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: "sha256:api" }],
    targets: [
      { env: "staging", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"staging"}\n`) }], params: [] },
      { env: "prod", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(prodTemplate) }], params: [] },
    ],
  });

  beforeEach(() => {
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [withTemplate] });
    releaseFixture = { release, label: "v1.0.0" };
    storedTemplate = prodTemplate;
  });

  test("deploys the template the release recorded for --to, and names the release on the record", async () => {
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
    expect(ran).toEqual(["prod:publish-image", "prod:apply"]);
    const prodPath = `.chant/release-templates/${release.targets.find((t) => t.env === "prod")!.templates[0].digest.replace(/:/g, "_")}/api.template.json`;
    expect(stepInputs.find((s) => s.kind === "apply")?.input).toMatchObject({ template: prodPath });
    expect(writtenTemplates).toEqual([{ path: prodPath, content: prodTemplate }]);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ env: "prod", digest: "sha256:api", releaseDigest: release.releaseDigest });
  });

  test("refuses a template whose digest differs from the target's, and deploys nothing", async () => {
    storedTemplate = `{"env":"prod","edited":true}\n`;
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/hashes to sha256:[0-9a-f]{64}, but the release's target for "prod" records/);
    expect(errors.join("\n")).toMatch(/nothing was deployed/);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("refuses a release it can't find, and one with no target for --to", async () => {
    expect(await runComponentsPromote(ctx({ release: "v9" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/no release is labelled or digested "v9"/);
    errors.length = 0;
    expect(await runComponentsPromote(ctx({ release: "v1.0.0", migrateTo: "qa" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/has no target for "qa"/);
    expect(ran).toEqual([]);
  });

  test("a promote without --release reads the checkout's template as before", async () => {
    expect(await runComponentsPromote(ctx({}))).toBe(0);
    expect(stepInputs.find((s) => s.kind === "apply")?.input).toMatchObject({ template: "dist/api.template.json" });
    expect(appendReleaseRecordMock.mock.calls[0][0].releaseDigest).toBeUndefined();
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

  test("a comma list is refused: rollback acts on one component (#3950)", async () => {
    expect(await runComponentsRollback(rb({ component: "api,web" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--component takes one component name, not a list/);
    expect(ran).toEqual([]);
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

describe("--events-json on promote, rollback and redeploy (#4041)", () => {
  const prod = (digest: string, timestamp: string, runId: string): ReleaseRecord =>
    ({ ...staging, env: "prod", digest, timestamp, runId });
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
  });

  /** The stream's events, checked, and the release record's run id beside them. */
  // Only the stream's lines: anything else a module writes to stdout is not this test's.
  const streamed = () => checkRunEventLines(out.filter((l) => l.startsWith('{"$schema"')));

  test("promote streams the deploy as a component run named by the release record's run id", async () => {
    expect(await runComponentsPromote(ctx({ eventsJson: true }))).toBe(0);
    const events = streamed();
    expect(events[0]).toMatchObject({ type: "run-start", kind: "component", name: "promote api in prod", runId: "run-9", waves: [["api"]] });
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ runId: "run-9" });
    expect(stepTrail(events)).toEqual([
      ["step-start", "publish-image"], ["step-settle", "publish-image", "ok"],
      ["step-start", "apply"], ["step-settle", "apply", "ok"],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "ok" });
  });

  test("rollback streams a gated run: the gate's step settles gated, and the run with it", async () => {
    readReleaseLedgerMock.mockResolvedValue({
      records: [prod("sha256:old", "2026-01-01T00:00:00.000Z", "run-1"), prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2")],
      malformed: 0,
    });
    const gated: DriverComponent = {
      ...api,
      deploy: [...api.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "gate", gate: "rollback-ok" }, { kind: "apply" }] }],
    };
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [gated] });
    expect(await runComponentsRollback(ctx({ migrateFrom: undefined, migrateTo: undefined, path: "rollback", extraPositional: "prod", component: "api", eventsJson: true }))).toBe(3);
    const events = streamed();
    expect(events[0]).toMatchObject({ name: "rollback api in prod" });
    // A rollback deploys the recorded digest in place of the publish step.
    expect(stepTrail(events)).toEqual([
      ["step-start", "recorded-digest"], ["step-settle", "recorded-digest", "ok"],
      ["step-start", "gate:rollback-ok"], ["gate-waiting", "gate:rollback-ok"], ["step-settle", "gate:rollback-ok", "gated"],
      ["step-settle", "apply", "skipped:not-run"],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "gated" });
  });

  test("redeploy streams a failed run with the failing step's error", async () => {
    readReleaseLedgerMock.mockResolvedValue({
      records: [prod("sha256:old", "2026-01-01T00:00:00.000Z", "run-1"), prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2")],
      malformed: 0,
    });
    failApplyFor = "api";
    expect(await runComponentsRedeploy(ctx({ migrateFrom: undefined, migrateTo: undefined, path: "redeploy", extraPositional: "prod", component: "api", eventsJson: true }))).toBe(1);
    const events = streamed();
    expect(events[0]).toMatchObject({ name: "redeploy api in prod" });
    expect(events.find((e) => e.type === "step-settle" && e.status === "failed")).toMatchObject({ step: "apply", error: "apply failed" });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed" });
  });

  test("--events-json beside --progress-json is refused before anything deploys", async () => {
    expect(await runComponentsPromote(ctx({ eventsJson: true, progressJson: true }))).toBe(1);
    expect(errors.join("\n")).toMatch(/--events-json and --progress-json both stream to stdout/);
    expect(ran).toEqual([]);
    expect(out.filter((l) => l.startsWith('{"$schema"'))).toEqual([]);
  });
});

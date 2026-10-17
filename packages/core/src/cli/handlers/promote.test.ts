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
    // #4045: a planner whose member is provisional.
    registry.register({
      kind: "plan-provisional",
      async run() { return {}; },
      async plan() {
        return {
          member: "estate",
          planDigest: "sha256:" + "3".repeat(64),
          changeSet: { member: { member: "estate", lexicon: "terraform", planner: "terraform", status: "planned", planDigest: "sha256:" + "3".repeat(64), provisional: true, holes: [] }, entries: [] },
        };
      },
    } as never);
    return registry;
  },
}));

// Gates read an in-memory ledger rather than the git branch.
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  const port = actual.memoryGateLedgerPort();
  return { ...actual, gitGateLedgerPort: () => releaseGatePort ?? port, gateIsSealed: async (gate: string) => sealedGates.has(gate) };
});
const sealedGates = new Set<string>();
/** #4045: a fresh ledger per release gate test, so their approvals don't carry between tests. */
let releaseGatePort: ReturnType<typeof import("../../op/gate").memoryGateLedgerPort> | null = null;

// #4045: stored change sets live in memory, keyed by digest.
const storedChangeSets = new Map<string, import("../../change-set").ChangeSetDocument>();
let storeFails = false;
vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async ({ doc }: { doc: import("../../change-set").ChangeSetDocument }) => {
    if (storeFails) throw new Error("the branch is read-only");
    const written = !storedChangeSets.has(doc.digest);
    storedChangeSets.set(doc.digest, doc);
    return { digest: doc.digest, written };
  },
}));
vi.mock("../../lifecycle/change-set-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/change-set-store")>("../../lifecycle/change-set-store");
  return {
    ...actual,
    readStoredChangeSet: async (digest: string) => {
      const doc = storedChangeSets.get(digest);
      return doc ? actual.parseStoredChangeSet(JSON.stringify(doc), digest) : { status: "missing" };
    },
  };
});
const knownReleases = new Map<string, import("../../lifecycle/release-store").Release>();
const removedTemplates: unknown[] = [];

// #4026: the release store holds one release and one template's bytes.
vi.mock("../../lifecycle/release-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-store")>("../../lifecycle/release-store");
  return {
    ...actual,
    resolveRelease: async (ref: string) => (releaseFixture && (ref === releaseFixture.label || ref === releaseFixture.release.releaseDigest) ? releaseFixture : null),
    readReleaseTemplate: async () => storedTemplate,
    readRelease: async (digest: string) => knownReleases.get(digest) ?? null,
  };
});
vi.mock("../../components/release-promote", async () => {
  const actual = await vi.importActual<typeof import("../../components/release-promote")>("../../components/release-promote");
  return {
    ...actual,
    writePinnedTemplates: (_dir: string, files: unknown[]) => writtenTemplates.push(...files),
    removePinnedTemplates: (_dir: string, files: unknown[]) => removedTemplates.push(...files),
  };
});

// #4033: the revoked commits come from a map, not from this checkout's tags.
const revokedCommits = new Map<string, import("../../lifecycle/release-revocation").ReleaseRevocation>();
vi.mock("../../lifecycle/release-revocation", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-revocation")>("../../lifecycle/release-revocation");
  return { ...actual, readRevokedCommits: async () => revokedCommits };
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
  releaseGatePort = null;
  storedChangeSets.clear();
  storeFails = false;
  knownReleases.clear();
  revokedCommits.clear();
  removedTemplates.length = 0;
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

describe("chant components promote --release binds its gate (#4045)", () => {
  const prodTemplate = `{"env":"prod"}\n`;
  const stagingTemplate = `{"env":"staging"}\n`;
  const gated: DriverComponent = {
    ...api,
    deploy: [
      ...api.deploy.slice(0, 2),
      { phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
    ],
  };
  const releaseAt = (commit: string) =>
    makeRelease({
      member: null,
      commit: commit.padEnd(40, "0"),
      artifactDigests: [{ component: "api", kind: "image", path: "api.tar", digest: "sha256:api" }],
      targets: [
        { env: "staging", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(stagingTemplate) }], params: [] },
        { env: "prod", templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(prodTemplate) }], params: [] },
      ],
    });
  const r1 = releaseAt("abc123");
  const r2 = releaseAt("def456");
  const dev: ReleaseRecord = { ...staging, env: "dev" };
  let ledgers: Record<string, ReleaseRecord[]>;

  beforeEach(async () => {
    const { memoryGateLedgerPort } = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
    releaseGatePort = memoryGateLedgerPort();
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [gated] });
    releaseFixture = { release: r1, label: "v1.0.0" };
    storedTemplate = prodTemplate;
    knownReleases.set(r1.releaseDigest, r1);
    knownReleases.set(r2.releaseDigest, r2);
    ledgers = { dev: [dev], staging: [staging], prod: [] };
    readReleaseLedgerMock.mockImplementation(async (env: string) => ({ records: ledgers[env] ?? [], malformed: 0 }));
  });

  const onlyStored = () => [...storedChangeSets.values()];

  test("a non-empty change set stops at a release gate that binds the release, the environment and the stored document", async () => {
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
    expect(ran).not.toContain("prod:apply");
    const [doc] = onlyStored();
    expect(doc).toMatchObject({ releaseDigest: r1.releaseDigest, environment: "prod" });
    expect(doc.entries[0]).toMatchObject({ address: "api", action: "create" });
    expect(releaseGatePort!.appended).toEqual([
      expect.objectContaining({ op: "release", gate: "prod-release", environment: "prod", planDigest: doc.digest, releaseDigest: r1.releaseDigest }),
    ]);
    expect(errors.join("\n")).toMatch(/chant approve release prod-release --env prod/);
    expect(errors.join("\n")).toMatch(/release gate: change set jcs1-sha256:[0-9a-f]{64} for "prod", 1 entry/);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
    expect(removedTemplates).toHaveLength(1);
  });

  test("an approval of that release passes the gate, and the deploy record names the release and the gate's resolution", async () => {
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
    const pending = releaseGatePort!.appended[0];
    await releaseGatePort!.appendResolution!({
      op: "release", gate: "prod-release", resolvedBy: "alice", timestamp: new Date(Date.now() + 1000).toISOString(),
      planDigest: pending.planDigest, environment: "prod", releaseDigest: r1.releaseDigest,
    });
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
    expect(ran).toContain("prod:apply");
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({
      releaseDigest: r1.releaseDigest,
      approver: "alice",
      admission: { op: "release", gate: "prod-release" },
    });
  });

  test("a release cut from a revoked commit is refused before anything runs, so its pending gate never passes (#4033)", async () => {
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
    const pending = releaseGatePort!.appended[0];
    await releaseGatePort!.appendResolution!({
      op: "release", gate: "prod-release", resolvedBy: "alice", timestamp: new Date(Date.now() + 1000).toISOString(),
      planDigest: pending.planDigest, environment: "prod", releaseDigest: r1.releaseDigest,
    });
    // The commit went red after the approval: a run from chant runs (#4044) names its run in opRun, with id null.
    revokedCommits.set(r1.commit, {
      commit: r1.commit,
      tag: `ci/revoked/${r1.commit}`,
      tagged: "2026-10-16T12:00:00.000Z",
      phase: "e2e",
      run: { name: "smoke", id: null, conclusion: "failure", url: null, opRun: { id: "r-12", env: "staging", signer: "runner:ci" } },
      signer: "runner:ci",
    });
    ran.length = 0;
    errors.length = 0;
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(1);
    const said = errors.join("\n");
    expect(said).toMatch(/release v1\.0\.0 was cut from commit abc123000000, which ci\/revoked\/abc1230{34} revokes \(phase e2e failed in smoke \(Op run r-12 in staging\)\)/);
    expect(said).toMatch(/\[release-revoked\]/);
    expect(said).toMatch(/chant ci last-green/);
    expect(ran).toEqual([]);
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("an approval for one release can't be used by another", async () => {
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
    const pending = releaseGatePort!.appended[0];
    await releaseGatePort!.appendResolution!({
      op: "release", gate: "prod-release", resolvedBy: "alice", timestamp: new Date(Date.now() + 1000).toISOString(),
      planDigest: pending.planDigest, environment: "prod", releaseDigest: r1.releaseDigest,
    });
    releaseFixture = { release: r2, label: "v1.0.1" };
    ran.length = 0;
    expect(await runComponentsPromote(ctx({ release: "v1.0.1" }))).toBe(3);
    expect(ran).not.toContain("prod:apply");
    expect(releaseGatePort!.appended.at(-1)).toMatchObject({ releaseDigest: r2.releaseDigest });
    expect(appendReleaseRecordMock).not.toHaveBeenCalled();
  });

  test("an approval for one environment can't be used for another", async () => {
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
    const pending = releaseGatePort!.appended[0];
    await releaseGatePort!.appendResolution!({
      op: "release", gate: "prod-release", resolvedBy: "alice", timestamp: new Date(Date.now() + 1000).toISOString(),
      planDigest: pending.planDigest, environment: "prod", releaseDigest: r1.releaseDigest,
    });
    storedTemplate = stagingTemplate;
    ran.length = 0;
    expect(await runComponentsPromote(ctx({ release: "v1.0.0", migrateFrom: "dev", migrateTo: "staging" }))).toBe(3);
    expect(ran).not.toContain("staging:apply");
    expect(releaseGatePort!.appended.at(-1)).toMatchObject({ environment: "staging", releaseDigest: r1.releaseDigest });
  });

  test("an empty change set passes without an approval: the promote writes an empty resolution and a deploy record naming the release", async () => {
    ledgers.prod = [{ ...staging, env: "prod", releaseDigest: r1.releaseDigest, timestamp: "2026-01-03T00:00:00.000Z" }];
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
    expect(ran).toContain("prod:apply");
    const [doc] = onlyStored();
    expect(doc.entries).toEqual([]);
    expect(releaseGatePort!.appended).toEqual([]);
    expect(releaseGatePort!.resolved).toEqual([
      expect.objectContaining({ op: "release", gate: "prod-release", resolvedBy: "bob", empty: true, planDigest: doc.digest, environment: "prod", releaseDigest: r1.releaseDigest }),
    ]);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ env: "prod", releaseDigest: r1.releaseDigest, approver: "bob", admission: { op: "release", gate: "prod-release" } });
    expect(errors.join("\n")).toMatch(/empty: its gates pass without an approval/);
    // Run again: the pass stands, and no second line is written.
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
    expect(releaseGatePort!.resolved).toHaveLength(1);
  });

  test("an empty pass counts only once the stored document reads back empty", async () => {
    ledgers.prod = [{ ...staging, env: "prod", releaseDigest: r1.releaseDigest, timestamp: "2026-01-03T00:00:00.000Z" }];
    storeFails = true;
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
    expect(errors.join("\n")).toMatch(/could not store the change set/);
    expect(ran).not.toContain("prod:apply");
  });

  test("a change set with a provisional member is refused before anything deploys", async () => {
    resolveTargetsMock.mockResolvedValue({
      success: true,
      targets: [{ ...gated, deploy: [...gated.deploy, { phase: "Plan", steps: [{ kind: "plan-provisional" }] }] }],
    });
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(1);
    expect(errors.join("\n")).toMatch(/provisional members \(estate\)/);
    expect(ran).toEqual([]);
  });

  test("a release promote whose compositions declare no gate binds nothing and stores no change set", async () => {
    resolveTargetsMock.mockResolvedValue({ success: true, targets: [{ ...gated, deploy: [...gated.deploy.slice(0, 2), { phase: "Apply", steps: [{ kind: "apply", template: "dist/api.template.json" }] }] }] });
    expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
    expect(storedChangeSets.size).toBe(0);
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

  test("copies the release off the record it restores, and writes none for a record of no release (#4043)", async () => {
    const RELEASE = `jcs1-sha256:${"b".repeat(64)}`;
    readReleaseLedgerMock.mockResolvedValue({
      records: [{ ...prod("sha256:old", "2026-01-01T00:00:00.000Z", "run-1"), releaseDigest: RELEASE }, prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2")],
      malformed: 0,
    });
    expect(await runComponentsRollback(rb({}))).toBe(0);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ digest: "sha256:old", releaseDigest: RELEASE });

    appendReleaseRecordMock.mockClear();
    readReleaseLedgerMock.mockResolvedValue({
      records: [prod("sha256:old", "2026-01-01T00:00:00.000Z", "run-1"), prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2")],
      malformed: 0,
    });
    expect(await runComponentsRollback(rb({}))).toBe(0);
    expect(appendReleaseRecordMock.mock.calls[0][0]).not.toHaveProperty("releaseDigest");
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

  test("copies the release off the record it redeploys (#4043)", async () => {
    const RELEASE = `jcs1-sha256:${"b".repeat(64)}`;
    readReleaseLedgerMock.mockResolvedValue({
      records: [{ ...prod("sha256:new", "2026-01-02T00:00:00.000Z", "run-2"), releaseDigest: RELEASE }],
      malformed: 0,
    });
    expect(await runComponentsRedeploy(rd({}))).toBe(0);
    expect(appendReleaseRecordMock.mock.calls[0][0]).toMatchObject({ digest: "sha256:new", releaseDigest: RELEASE, redeploys: { runId: "run-2" } });
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

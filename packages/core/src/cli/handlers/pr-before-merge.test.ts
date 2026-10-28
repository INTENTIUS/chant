/**
 * `chant components pr-apply --before-merge` (#4301, ws-106): the workflow
 * read at base and the four requires checks, asked of a fake GitHub before
 * any of the head's code loads, then the pull request's own gate, and the
 * apply locks under ci.locks. Git, the change signal, the derivation and the
 * gate ledger are fakes, as in pr.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

/** The security groups pr-apply reads from the declaration (#4168); none unless a test sets them. */
let groups: string[] = [];
vi.mock("../../workspace/security", async (original) => ({
  ...(await original<typeof import("../../workspace/security")>()),
  securityGroupsAt: () => new Set(groups),
}));

/** The ci.hooks pr-plan and pr-apply read at base (#4288); none unless a test sets them. */
let hooksAtBase: Record<string, unknown> = {};
vi.mock("../../components/pr-hooks", async (original) => ({
  ...(await original<typeof import("../../components/pr-hooks")>()),
  prLoopHooksAt: (_cwd: string, base: string) => ({ hooks: hooksAtBase, base }),
}));
/** `ci.locks` pr-apply reads at base (#4293), and the locks other pull requests hold; none unless a test sets them. */
let locksMode: "apply" | "plan" | null = null;
let heldLocks: (gate: string, targets: readonly string[], pr: number | null) => Promise<unknown[]> = async () => [];
vi.mock("../../workspace/ci-locks", () => ({ ciLocksAt: () => locksMode }));
let taken: unknown[] = [];
vi.mock("../../lifecycle/target-lock", async (original) => ({
  ...(await original<typeof import("../../lifecycle/target-lock")>()),
  heldTargetLocks: (gate: string, targets: readonly string[], pr: number | null) => heldLocks(gate, targets, pr),
  takeTargetLocks: async (gate: string, targets: readonly string[], holder: unknown) => {
    taken.push({ gate, targets, holder });
    return { ok: true, taken: [...targets].sort(), released: [], expired: [], pushed: false };
  },
}));
/** The ci.workflow pr-apply --before-merge reads at base (#4301). */
let workflowAtBase: string | null = "apply-before-merge";
vi.mock("../../workspace/ci-workflow-at", () => ({ ciWorkflowAt: () => workflowAtBase }));
/** Whether the head's code was loaded: the config read and the derivation. */
let loaded: string[] = [];

/** What ci.policy at base says (#4294): no policy unless a test sets a verdict. The engine itself is gate-policy.test.ts's. */
let policyVerdict: import("../../gate-policy").GatePolicyVerdict | undefined;
vi.mock("../../components/pr-policy", async (original) => ({
  ...(await original<typeof import("../../components/pr-policy")>()),
  prLoopPolicyAt: (_cwd: string, base: string) => ({ base }),
  runPrPolicy: () => policyVerdict,
}));
vi.mock("../../override-gate", async (original) => ({
  ...(await original<typeof import("../../override-gate")>()),
  overridersAt: (_repo: string, base: string) => ({ base, path: ".chant/overriders", active: true, principals: ["github:carol"] }),
}));

vi.mock("../../components/changed-files", () => ({
  resolveCommit: async () => HEAD,
  resolveMergeBase: async () => BASE,
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => { loaded.push("config"); return { config: {} }; } };
});

vi.mock("./fan-out", () => ({
  resolveChangedUnits: async () => ({ units: { changed: ["net"], indeterminate: [] } }),
}));

// #4022: pr-apply stores the change set its gate binds on chant/lifecycle and
// pushes it. These tests run in the chant checkout, so the store is replaced:
// it must never write or push the real repository's lifecycle branch.
vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr.test must not push chant/lifecycle"); }, pushLifecycleRebasing: async () => { throw new Error("pr.test must not push chant/lifecycle"); } };
});

vi.mock("./run", () => ({
  GATED_EXIT_CODE: 3,
  autoReleaseRun: (id: string) => ({ runId: id, runOrigin: { forge: "local" } }),
  recordAutoReleasesForRun: async () => [],
}));

let gateLedger: ReturnType<typeof import("../../op/gate").memoryGateLedgerPort>;
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => gateLedger, gateIsSealed: async () => false };
});

const failing = new Set<string>();
/** The error a root's apply throws, in place of applying (#3997). */
const refusal = new Map<string, Error>();
/** Called as a component's apply starts, before it can fail. */
let onRun: (root: string) => void = () => {};
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string }) {
      const planDigest = computePlanDigest("fake-root", { root: input.root });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: { member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] }, entries: [] },
      };
    },
    async outputs() {
      return {};
    },
    async run(_ctx: DeployContext, input: { root: string }) {
      onRun(input.root);
      if (refusal.has(input.root)) throw refusal.get(input.root);
      if (failing.has(input.root)) throw new Error(`${input.root} failed`);
      return { outputs: {} };
    },
  } as never);
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => (loaded.push("derive"), {
      success: true,
      components: ESTATE,
      plan: planFanOut({ components: ESTATE, changed: ["net"] }),
      signal: { changed: ["net"], indeterminate: [], unclaimed: [] },
    }),
  };
});

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name }] }],
});
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];

const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");

let dir: string;
let out: string[];
let errors: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, pr: 12, forge: "github", beforeMerge: true, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-before-merge-"));
  taken = [];
  workflowAtBase = "apply-before-merge";
  loaded = [];
  out = [];
  errors = [];
  failing.clear();
  refusal.clear();
  onRun = () => {};
  groups = [];
  hooksAtBase = {};
  locksMode = null;
  heldLocks = async () => [];
  policyVerdict = undefined;
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** The digest pr-plan printed, read back from its report. */
async function plannedDigest(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;
}

/** Pull request 12 on a fake GitHub, its head HEAD unless `over` says otherwise. */
function serveGithub(over: { head?: string; reviews?: unknown[]; mergeable?: boolean | null; behind?: number; statuses?: unknown[] } = {}): void {
  const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
  vi.stubEnv("GITHUB_TOKEN", "t0k");
  vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
  vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
  vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
    const { pathname } = new URL(url);
    if (init.method !== "GET") return ok({ id: 1 });
    const pull = "/repos/acme/infra/pulls/12";
    if (pathname === pull) return ok({ number: 12, state: "open", user: { login: "carol" }, head: { ref: "f", sha: over.head ?? HEAD }, base: { ref: "main" }, mergeable: over.mergeable === undefined ? true : over.mergeable, mergeable_state: "clean" });
    if (pathname === `${pull}/reviews`) return ok(over.reviews ?? [{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD }]);
    if (pathname === `${pull}/commits`) return ok([{ author: { login: "carol" }, committer: { login: "carol" } }]);
    if (pathname === `/repos/acme/infra/compare/main...${HEAD}`) return ok({ behind_by: over.behind ?? 0 });
    if (pathname === `/repos/acme/infra/commits/${HEAD}/status`) return ok({ statuses: over.statuses ?? [{ context: "chant/plan", state: "success" }, { context: "chant/apply", state: "failure" }] });
    if (pathname === `/repos/acme/infra/commits/${HEAD}/check-runs`) return ok({ check_runs: [] });
    return ok([]);
  });
}

const applyReport = async () => {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8")) as Record<string, unknown> & { beforeMerge?: { requires: Array<{ name: string; passed: boolean; reason: string }> } };
};

describe("pr-apply --before-merge (#4301)", () => {
  test("without apply-before-merge at base it refuses before-merge-off, and none of the head's code loads", async () => {
    workflowAtBase = "trunk-curated";
    serveGithub();
    expect(await runComponentsPrApply(ctx({}))).toBe(1);
    const report = await applyReport();
    expect(report).toMatchObject({ stage: "apply", pr: 12, status: "refused", refusal: "before-merge-off", beforeMerge: { requires: [] } });
    expect(report.message).toContain("sets ci.workflow to trunk-curated");
    expect(loaded).toEqual([]);
  });

  test("an unmet require refuses requires-unmet with each check in the report, and none of the head's code loads", async () => {
    serveGithub({ behind: 2, reviews: [{ user: { login: "carol" }, state: "APPROVED", commit_id: HEAD }] });
    expect(await runComponentsPrApply(ctx({}))).toBe(3);
    const report = await applyReport();
    expect(report).toMatchObject({ status: "refused", refusal: "requires-unmet" });
    expect(report.beforeMerge!.requires.map((r) => [r.name, r.passed])).toEqual([["approved", false], ["mergeable", true], ["undiverged", false], ["checks", true]]);
    expect(report.message).toContain("undiverged: aaaaaaaa is 2 commits behind main");
    expect(loaded).toEqual([]);
  });

  test("it needs --pr and --forge, and takes no --green", async () => {
    expect(await runComponentsPrApply(ctx({ pr: undefined }))).toBe(1);
    expect(await runComponentsPrApply(ctx({ forge: undefined }))).toBe(1);
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(1);
    expect(loaded).toEqual([]);
  });

  test("all four passed: the pull request's own gate decides, and an unapproved plan applies nothing", async () => {
    serveGithub();
    expect(await runComponentsPrApply(ctx({}))).toBe(3);
    const report = await applyReport();
    expect(report).toMatchObject({ status: "refused", refusal: "not-approved", op: "pr-12" });
    expect(report.beforeMerge!.requires.every((r) => r.passed)).toBe(true);
  });

  test("approved: it applies at the head, and under ci.locks holds apply locks on what it reaches", async () => {
    serveGithub();
    await runComponentsPrPlan(ctx({ beforeMerge: false, forge: undefined, noStatus: true }));
    const { readFile } = await import("node:fs/promises");
    const digest = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;
    gateLedger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:bob", timestamp: new Date().toISOString(), planDigest: digest }],
    });
    locksMode = "apply";
    const ran: string[] = [];
    onRun = (r) => void ran.push(r);
    expect(await runComponentsPrApply(ctx({}))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    // #4552: the lock targets go to the lock file sorted (lockTargetsOf).
    expect(taken).toEqual([{ gate: "pr-apply", targets: ["app", "net"], holder: expect.objectContaining({ pr: 12, stage: "apply", head: HEAD }) }]);
    expect(await applyReport()).toMatchObject({ status: "applied", beforeMerge: { requires: expect.any(Array) } });
  });
});

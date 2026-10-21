/**
 * `chant components pr-record` (#4168 step 1): the record stage a merge
 * runs unless apply on merge is opted in. It plans the merged commit,
 * decides the pull request's gate without writing to the ledger, writes the
 * merge record and the report, and applies nothing. Git, the change signal,
 * the derivation and the gate ledger are fakes, as in pr.test.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";
import { prStatusState } from "../../pr-loop";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

vi.mock("../../components/changed-files", () => ({
  resolveCommit: async () => HEAD,
  resolveMergeBase: async () => BASE,
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
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
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr.test must not push chant/lifecycle"); } };
});

// #4168: the record job writes the merge record on chant/lifecycle. Captured here, never written.
const written: Array<Record<string, unknown>> = [];
vi.mock("../../lifecycle/merge-record", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/merge-record")>("../../lifecycle/merge-record");
  return { ...actual, writeMergeRecord: async (r: Record<string, unknown>) => (written.push(r), { commit: null, written: false }) };
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
    deriveFanOut: async () => ({
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
const { runComponentsPrPlan, runComponentsPrRecord } = await import("./pr");
const { checkRunEventLines, stepTrail } = await import("../../workspace/__fixtures__/run-event-check");

let dir: string;
let errors: string[];
let applied: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-record", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-record-"));
  errors = [];
  applied = [];
  written.length = 0;
  failing.clear();
  refusal.clear();
  onRun = (r) => applied.push(r);
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const report = (stage: string) => JSON.parse(readFileSync(join(dir, `pr-${stage}.json`), "utf8")) as Record<string, unknown> & { approval: { status: string }; digest: string };
const approve = (digest: string) =>
  (gateLedger = memoryGateLedgerPort({
    resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: digest }],
  }));

describe("pr-record (#4168)", () => {
  test("an unapproved merge is recorded, exits 0, writes nothing to the gate ledger and applies nothing", async () => {
    expect(await runComponentsPrRecord(ctx({ pr: 12 }))).toBe(0);
    const r = report("record");
    expect(r).toMatchObject({ stage: "record", status: "recorded", pr: 12, head: HEAD, base: BASE, approval: { status: "pending" } });
    expect(gateLedger.appended).toEqual([]);
    expect(applied).toEqual([]);
    expect(written).toEqual([
      expect.objectContaining({ commit: HEAD, base: BASE, env: "prod", source: { kind: "pull-request", pr: 12 }, op: "pr-12", gate: "pr-apply", digest: r.digest, plan: "unapproved", approvedBy: [], components: ["net", "app"] }),
    ]);
    expect(prStatusState(r as never)).toBe("success");
  });

  test("the plan a reviewer approved is recorded as approved, by whom", async () => {
    await runComponentsPrPlan(ctx({ pr: 12 }));
    approve(report("plan").digest);
    expect(await runComponentsPrRecord(ctx({ pr: 12 }))).toBe(0);
    expect(report("record").approval).toEqual({ status: "approved", approvedBy: ["github:alice"] });
    expect(written[0]).toMatchObject({ plan: "approved", approvedBy: ["github:alice"] });
    expect(applied).toEqual([]);
  });

  test("a plan that moved since its approval is recorded, exits 0, and its status fails (decision 1)", async () => {
    const other = `jcs1-sha256:${"9".repeat(64)}`;
    approve(other);
    expect(await runComponentsPrRecord(ctx({ pr: 12 }))).toBe(0);
    const r = report("record");
    expect(r.approval).toEqual({ status: "changed", approved: other });
    expect(String(r.message)).toMatch(/The merge stands and nothing was applied/);
    expect(prStatusState(r as never)).toBe("failure");
    expect(written[0]).toMatchObject({ plan: "changed", approvedDigest: other, approvedBy: [] });
    expect(applied).toEqual([]);
  });

  test("with no pull request the record names none and reads no gate", async () => {
    approve(`jcs1-sha256:${"9".repeat(64)}`);
    expect(await runComponentsPrRecord(ctx({}))).toBe(0);
    expect(report("record")).toMatchObject({ pr: null, op: "pr-unknown", approval: { status: "pending" } });
    expect(written[0]).toMatchObject({ source: { kind: "direct-push" }, op: null, plan: "unapproved" });
  });

  test("a member that fails to plan is recorded as plan-failed and exits 1", async () => {
    const plan = vi.spyOn(await import("../../components/pr-run"), "planPrSet");
    plan.mockImplementationOnce(async (input) => ({ ...(await (await vi.importActual<typeof import("../../components/pr-run")>("../../components/pr-run")).planPrSet(input)), failed: true }));
    expect(await runComponentsPrRecord(ctx({ pr: 12 }))).toBe(1);
    expect(report("record")).toMatchObject({ status: "plan-failed" });
    expect(written[0]).toMatchObject({ plan: "plan-failed" });
  });
});

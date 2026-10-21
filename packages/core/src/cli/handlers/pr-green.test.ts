/**
 * `chant components pr-apply --green` (#4168 step 9): apply on merge applies
 * a green commit, under the approved plans of the merges since the last
 * applied one when they cover it, and otherwise at a gate of its own on the
 * combined digest. Git, the green target, the derivation and the gate ledger
 * are fakes; the planning, the coverage and the apply are the real ones.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ChangeSetDocument } from "../../change-set";
import type { GreenApplyRecord } from "../../lifecycle/green-apply";
import type { GreenTargetResult } from "../../components/green-cover";
import type { ParsedArgs } from "../registry";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

vi.mock("../../workspace/security", async (original) => ({
  ...(await original<typeof import("../../workspace/security")>()),
  securityGroupsAt: () => new Set<string>(),
}));
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
// Nothing here may write or push the real repository's chant/lifecycle.
vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => ({}) };
});
const applied: GreenApplyRecord[] = [];
vi.mock("../../lifecycle/green-apply", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/green-apply")>("../../lifecycle/green-apply");
  return { ...actual, writeGreenApply: async (r: GreenApplyRecord) => (applied.push(r), "ledger-commit") };
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

let target: GreenTargetResult;
let asked: Array<{ base?: string }> = [];
vi.mock("../../components/green-cover", async () => {
  const actual = await vi.importActual<typeof import("../../components/green-cover")>("../../components/green-cover");
  return { ...actual, resolveGreenTarget: async (req: { base?: string }) => (asked.push(req), target) };
});

/** What each root's plan writes, so a test can move it. */
const values = new Map<string, string>();
const ran: string[] = [];
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string }) {
      const value = values.get(input.root) ?? "1";
      const planDigest = computePlanDigest("fake-root", { root: input.root, value });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: {
          member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] },
          entries: [{ member: input.root, lexicon: "terraform", planner: "tofu", address: `${input.root}.main`, type: "fake", action: "update", attributes: [{ path: "value", after: value }] }],
        },
      };
    },
    async outputs() {
      return {};
    },
    async run(_ctx: DeployContext, input: { root: string }) {
      ran.push(input.root);
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
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");
const { composeChangeSet } = await import("../../change-set");

let dir: string;
let errors: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-green-"));
  errors = [];
  applied.length = 0;
  ran.length = 0;
  values.clear();
  asked = [];
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The change set a pull request's plan made with the values set now. */
async function planned(): Promise<ChangeSetDocument> {
  await runComponentsPrPlan(ctx({ pr: 12, path: "pr-plan" }));
  return JSON.parse(await readFile(join(dir, "change-set.json"), "utf8")) as ChangeSetDocument;
}

const greenTarget = (approved: Array<{ doc: ChangeSetDocument; pr: number; approvedBy: string[] }>): GreenTargetResult => ({
  status: "target",
  target: {
    commit: HEAD,
    base: BASE,
    baseFrom: "applied",
    merges: [BASE.replace(/b/g, "c"), HEAD],
    prs: approved.map((m) => m.pr),
    approved: approved.map((m, i) => ({ commit: i === approved.length - 1 ? HEAD : BASE.replace(/b/g, "c"), ...m })),
  },
});
const OP = `green-${HEAD.slice(0, 12)}`;

describe("pr-apply --green (#4168 step 9)", () => {
  test("the merges' approved plans cover the plan at the green commit: it applies under them, with no gate, and records the commit applied", async () => {
    const doc = await planned();
    target = greenTarget([{ doc, pr: 12, approvedBy: ["github:alice"] }]);
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    expect(gateLedger.appended).toEqual([]);
    expect(applied).toEqual([expect.objectContaining({ env: "prod", commit: HEAD, base: BASE, approval: "merges", approvedBy: ["github:alice"], digest: doc.digest })]);
    const report = JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8"));
    expect(report).toMatchObject({ op: OP, pr: null, status: "applied", approval: { status: "approved", approvedBy: ["github:alice"] } });
  });

  test("two merges, each approving one member, cover the plan together (the case one pull request's apply stopped at plan-changed)", async () => {
    values.set("app", "1");
    const first = await planned();
    values.set("app", "2");
    const both = await planned();
    // #13 touched app alone, so its plan holds app alone.
    const second = composeChangeSet([{ member: both.members.find((m) => m.member === "app")!, entries: both.entries.filter((e) => e.member === "app") }]);
    // #12 approved net and app at 1; #13 approved app at 2; the green commit plans net at 1 and app at 2.
    target = greenTarget([
      { doc: first, pr: 12, approvedBy: ["github:alice"] },
      { doc: second, pr: 13, approvedBy: ["github:bob"] },
    ]);
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    expect(applied[0]).toMatchObject({ approval: "merges", approvedBy: ["github:alice", "github:bob"] });
  });

  test("a plan the merges did not approve waits at the green commit's own gate on the combined digest, then applies once that is approved", async () => {
    const doc = await planned();
    values.set("net", "9");
    target = greenTarget([{ doc, pr: 12, approvedBy: ["github:alice"] }]);
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(3);
    expect(ran).toEqual([]);
    expect(applied).toEqual([]);
    const refused = JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8"));
    expect(refused).toMatchObject({ op: OP, status: "refused", refusal: "not-approved" });
    expect(refused.message).toContain("do not cover it: net now writes net.main.value to a different value than the approved plan (checked against #12)");
    expect(refused.message).toContain(`chant approve ${OP} pr-apply --plan ${refused.digest}`);

    gateLedger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: OP, gate: "pr-apply", resolvedBy: "github:carol", timestamp: new Date().toISOString(), planDigest: refused.digest }],
    });
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    expect(applied[0]).toMatchObject({ approval: "gate", approvedBy: ["github:carol"], digest: refused.digest });
  });

  test("the green commit last applied is nothing to do, and --green takes no --pr", async () => {
    target = { status: "applied", commit: HEAD };
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(0);
    expect(ran).toEqual([]);
    expect(errors.join("\n")).toContain("is the green commit last applied to prod");
    expect(await runComponentsPrApply(ctx({ green: true, pr: 12 }))).toBe(1);
    target = { status: "error", message: "abc is not a green commit", hint: "check it out" };
    expect(await runComponentsPrApply(ctx({ green: true }))).toBe(1);
    expect(errors.join("\n")).toContain("abc is not a green commit");
    // --base reaches the target as the first apply's fallback.
    expect(asked.at(-1)).toMatchObject({ base: "main" });
  });
});

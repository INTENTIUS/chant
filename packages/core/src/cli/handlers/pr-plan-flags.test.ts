/**
 * `pr-plan --refresh` and `--target-dependents` (#4627): each reaches the
 * planned members' capability plans through `DeployContext`, the digest
 * binds it, `--target-dependents` needs a target, a member whose capability
 * cannot honour one is refused by name before anything plans, and pr-apply
 * takes neither. The setup is pr-plan-targets.test.ts's. Written for the
 * ci-products post-merge pass.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

vi.mock("../../workspace/security", async (original) => ({
  ...(await original<typeof import("../../workspace/security")>()),
  securityGroupsAt: () => new Set<string>(),
}));
vi.mock("../../components/pr-hooks", async (original) => ({
  ...(await original<typeof import("../../components/pr-hooks")>()),
  prLoopHooksAt: (_cwd: string, base: string) => ({ hooks: {}, base }),
}));
vi.mock("../../workspace/ci-locks", () => ({ ciLocksAt: () => null }));
vi.mock("../../components/pr-policy", async (original) => ({
  ...(await original<typeof import("../../components/pr-policy")>()),
  prLoopPolicyAt: (_cwd: string, base: string) => ({ base }),
  runPrPolicy: () => undefined,
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
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr-plan-flags.test must not push chant/lifecycle"); } };
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

/** The targets each member's plan was asked for. */
const asked = new Map<string, string[] | undefined>();
/** The plan flags each member's plan was asked for (#4627). */
const flagsAsked = new Map<string, { refresh: boolean; targetDependents: boolean }>();
let estate: DriverComponent[] = [];
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  const plan = (kind: string) => async (ctx: DeployContext, input: { root: string }) => {
    asked.set(input.root, ctx.targets);
    flagsAsked.set(input.root, { refresh: ctx.refresh === true, targetDependents: ctx.targetDependents === true });
    const planDigest = computePlanDigest(kind, { root: input.root });
    return {
      member: input.root,
      planDigest,
      artifact: { planDigest },
      ...(ctx.targets ? { targets: ctx.targets } : {}),
      changeSet: { member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] }, entries: [] },
    };
  };
  registry.register({ kind: "narrowing-root", targets: "accept", planFlags: { refresh: "accept", targetDependents: "accept" }, plan: plan("narrowing-root"), async outputs() { return {}; }, async run() { return { outputs: {} }; } } as never);
  registry.register({ kind: "whole-root", targets: "accept", planFlags: { refresh: "accept", targetDependents: { refuse: "a whole-root has no flag for dependents" } }, plan: plan("whole-root"), async outputs() { return {}; }, async run() { return { outputs: {} }; } } as never);
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => ({
      success: true,
      components: estate,
      plan: planFanOut({ components: estate, changed: estate.map((c) => c.name) }),
      signal: { changed: estate.map((c) => c.name), indeterminate: [], unclaimed: [] },
    }),
  };
});

const root = (name: string, kind = "narrowing-root"): DriverComponent => ({ name, dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind, root: name }] }] });

const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");

let dir: string;
let errors: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-plan", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, pr: 12, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-targets-"));
  errors = [];
  asked.clear();
  flagsAsked.clear();
  estate = [root("net"), root("app")];
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const digest = async (): Promise<string> => JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;

describe("pr-plan --refresh and --target-dependents (#4627)", () => {
  test("--refresh reaches every plan, and the digest binds it", async () => {
    expect(await runComponentsPrPlan(ctx({}))).toBe(0);
    const plain = await digest();
    expect(await runComponentsPrPlan(ctx({ refresh: true }))).toBe(0);
    expect(flagsAsked.get("net")).toEqual({ refresh: true, targetDependents: false });
    expect(await digest()).not.toBe(plain);
  });

  test("--target-dependents reaches the targeted members' plans, and moves the digest", async () => {
    expect(await runComponentsPrPlan(ctx({ targets: ["net:module.vpc"] }))).toBe(0);
    const narrowed = await digest();
    expect(await runComponentsPrPlan(ctx({ targets: ["net:module.vpc"], targetDependents: true }))).toBe(0);
    expect(flagsAsked.get("net")).toEqual({ refresh: false, targetDependents: true });
    expect(flagsAsked.get("app")).toEqual({ refresh: false, targetDependents: false });
    expect(await digest()).not.toBe(narrowed);
  });

  test("--target-dependents without a target is refused", async () => {
    expect(await runComponentsPrPlan(ctx({ targetDependents: true }))).toBe(1);
    expect(flagsAsked.size).toBe(0);
    expect(errors.join("\n")).toMatch(/widens a --target/);
  });

  test("a member whose capability cannot widen is refused by name, before anything plans", async () => {
    estate = [root("net"), root("db", "whole-root")];
    expect(await runComponentsPrPlan(ctx({ targets: ["aws_s3_bucket.logs"], targetDependents: true }))).toBe(1);
    expect(flagsAsked.size).toBe(0);
    expect(errors.join("\n")).toMatch(/whole-root refuses --target-dependents: a whole-root has no flag for dependents/);
  });

  test("pr-apply takes neither", async () => {
    expect(await runComponentsPrApply(ctx({ path: "pr-apply", refresh: true }))).toBe(1);
    expect(errors.join("\n")).toMatch(/takes no --refresh/);
  });
});

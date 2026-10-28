/**
 * `chant components pr-plan --target` (#4620): each address reaches the
 * planned members' capability plans as `DeployContext.targets`, the digest
 * binds them, and a member whose capability cannot narrow is refused by name
 * before anything plans. pr-apply takes no --target. Git, the change signal,
 * the derivation and the gate ledger are fakes, as in pr.test.ts.
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
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr-plan-targets.test must not push chant/lifecycle"); } };
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
let estate: DriverComponent[] = [];
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  const plan = (kind: string) => async (ctx: DeployContext, input: { root: string }) => {
    asked.set(input.root, ctx.targets);
    const planDigest = computePlanDigest(kind, { root: input.root });
    return {
      member: input.root,
      planDigest,
      artifact: { planDigest },
      ...(ctx.targets ? { targets: ctx.targets } : {}),
      changeSet: { member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] }, entries: [] },
    };
  };
  registry.register({ kind: "narrowing-root", targets: "accept", plan: plan("narrowing-root"), async outputs() { return {}; }, async run() { return { outputs: {} }; } } as never);
  registry.register({ kind: "whole-root", targets: { refuse: "a whole-root applies its root at once" }, plan: plan("whole-root"), async outputs() { return {}; }, async run() { return { outputs: {} }; } } as never);
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

describe("pr-plan --target", () => {
  test("a bare address reaches every planned member's plan, and the digest binds it", async () => {
    expect(await runComponentsPrPlan(ctx({}))).toBe(0);
    const whole = await digest();
    expect(asked.get("net")).toBeUndefined();
    expect(await runComponentsPrPlan(ctx({ targets: ["aws_s3_bucket.logs"] }))).toBe(0);
    expect(asked.get("net")).toEqual(["aws_s3_bucket.logs"]);
    expect(asked.get("app")).toEqual(["aws_s3_bucket.logs"]);
    expect(await digest()).not.toBe(whole);
  });

  test("<member>:<address> narrows that member alone", async () => {
    expect(await runComponentsPrPlan(ctx({ targets: ["net:module.vpc", "net:aws_route.a"] }))).toBe(0);
    expect(asked.get("net")).toEqual(["aws_route.a", "module.vpc"]);
    expect(asked.get("app")).toBeUndefined();
  });

  test("a member whose capability cannot narrow is refused by name, before anything plans", async () => {
    estate = [root("net"), root("db", "whole-root")];
    expect(await runComponentsPrPlan(ctx({ targets: ["aws_s3_bucket.logs"] }))).toBe(1);
    expect(asked.size).toBe(0);
    expect(errors.join("\n")).toMatch(/component "db": whole-root refuses targets: a whole-root applies its root at once/);
  });

  test("a prefix that names no component is part of a bare address", async () => {
    estate = [root("net")];
    expect(await runComponentsPrPlan(ctx({ targets: ["app:x"] }))).toBe(0);
    expect(asked.get("net")).toEqual(["app:x"]);
  });

  test("pr-apply takes no --target", async () => {
    expect(await runComponentsPrApply(ctx({ path: "pr-apply", targets: ["net:x"] }))).toBe(1);
    expect(errors.join("\n")).toMatch(/takes no --target/);
  });
});

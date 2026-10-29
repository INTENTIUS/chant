/**
 * `chant components pr-apply --wave-gate` (#4003): the pull request's plan
 * and approval, then a gate per wave on merge. Wave 1 applies under the pull
 * request's approval; wave 2 is planned against what wave 1 applied, and
 * applies under that approval when the approved plan covers it, or waits at
 * `<gate>-wave-2` when it moved. Git, the change signal, the derivation and
 * the gate ledger are fakes; the planning, the coverage check and the apply
 * are the real ones. Since #4588 each wave runs on op waves through the
 * component plan-wave and apply-wave steps, in pr-apply's own process.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";
import type { PrReport } from "../../pr-loop";

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

// pr-apply stores the change set a gate binds on chant/lifecycle (#4022); never in the real repository.
vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr-waves.test must not push chant/lifecycle"); }, pushLifecycleRebasing: async () => { throw new Error("pr-waves.test must not push chant/lifecycle"); } };
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

/** The outputs each root exposes on the estate: what `outputs` reads and `run` writes. */
const deployed: Record<string, Record<string, unknown>> = {};
/** The roots that applied, in order. */
let ran: string[] = [];
/**
 * Whether a root's plan says the `cidr` it will expose (#3999), as
 * terraform's `planned_values` does. Off, every output of a root the change
 * plans is known only after apply.
 */
let predicts = true;
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  /** A root whose one resource writes its `cidr` input: the plan says so, so a moved input moves the entry. */
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string; cidr?: string }) {
      const cidr = input.cidr ?? null;
      const planDigest = computePlanDigest("fake-root", { root: input.root, cidr });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest, cidr },
        ...(predicts ? { outputs: { known: { cidr }, unknown: [] } } : {}),
        changeSet: {
          member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] },
          entries: [
            {
              member: input.root,
              lexicon: "terraform",
              planner: "tofu",
              address: `${input.root}.main`,
              type: "fake_resource",
              action: "update",
              attributes: [{ path: "cidr", before: deployed[input.root]?.cidr ?? null, after: cidr }],
            },
          ],
        },
      };
    },
    async outputs(_ctx: DeployContext, input: { root: string }) {
      return deployed[input.root] ?? {};
    },
    // Applies the plan it is handed, as a planned root does, else what its input says now.
    async run(ctx: DeployContext, input: { root: string; cidr?: string }) {
      ran.push(input.root);
      const planned = (ctx as { plans?: Record<string, { cidr: string | null }> }).plans?.[input.root];
      deployed[input.root] = { cidr: planned ? planned.cidr : (input.cidr ?? null) };
      return { outputs: deployed[input.root] };
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

/** `net` writes the cidr the change sets; `app` reads it from `net`'s outputs. */
const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: "net", cidr: "10.0.0.0/16" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: "app", cidr: { stackOutput: { stack: "net", name: "cidr" } } }] }] },
];
const netStep = ESTATE[0]!.deploy[0]!.steps[0] as Record<string, unknown>;

const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");
const { checkRunEventLines } = await import("../../workspace/__fixtures__/run-event-check");

let dir: string;
let record: string;
let errors: string[];
let out: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, ...a } as ParsedArgs, plugins: [] }) as never;
/** One wave's job, as the generated pipeline runs it. */
const wave = (k?: number, a: Partial<ParsedArgs> = {}) => ctx({ pr: 12, waveGate: "release", resume: record, ...(k !== undefined ? { wave: k } : {}), ...a });

const resolution = (gate: string, planDigest: string, by = "github:alice") => ({
  version: 1 as const,
  kind: "resolution" as const,
  op: "pr-12",
  gate,
  resolvedBy: by,
  timestamp: new Date().toISOString(),
  planDigest,
});

const report = async (): Promise<PrReport> => JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8")) as PrReport;
const note = async (): Promise<string> => readFile(join(dir, "pr-note.md"), "utf8");

/** Plan pull request 12, as its plan job does, and approve its digest as alice. */
async function planAndApprove(): Promise<string> {
  expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
  const digest = (JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")) as PrReport).digest;
  gateLedger = memoryGateLedgerPort({ resolutions: [resolution("pr-apply", digest)] });
  errors = [];
  return digest;
}

const home = process.cwd();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-waves-"));
  // pr-apply runs each wave's op waves in its working directory (#4588), so the job's .chant/op-waves lands in the scratch dir.
  process.chdir(dir);
  record = join(dir, "resume", "pr-apply.json");
  errors = [];
  ran = [];
  predicts = true;
  for (const k of Object.keys(deployed)) delete deployed[k];
  deployed.net = { cidr: "10.0.0.0/16" };
  deployed.app = { cidr: "10.0.0.0/16" };
  netStep.cidr = "10.0.0.0/16";
  gateLedger = memoryGateLedgerPort();
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
  vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.map(String).join(" ")); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(home);
  await rm(dir, { recursive: true, force: true });
});

describe("pr-apply --wave-gate: wave 2's plan matches the pull request's", () => {
  test("wave 1 and then wave 2 apply under the pull request's approval, each in its own job", async () => {
    const digest = await planAndApprove();

    expect(await runComponentsPrApply(wave(1))).toBe(0);
    expect(ran).toEqual(["net"]);
    const first = await report();
    expect(first).toMatchObject({ status: "wave-applied", waveGate: "release", digest, approval: { status: "approved", approvedBy: ["github:alice"] } });
    expect(first.waves).toEqual([
      { wave: 1, components: ["net"], status: "applied", approval: "pull-request", gate: "pr-apply", digest, approvedBy: ["github:alice"] },
    ]);
    expect(first.members.map((m) => [m.member, m.status])).toEqual([["app", "planned"], ["net", "applied"]]);

    expect(await runComponentsPrApply(wave(2))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    const second = await report();
    expect(second.status).toBe("applied");
    expect(second.waves!.map((w) => [w.wave, w.status, w.approval, w.gate])).toEqual([
      [1, "applied", "pull-request", "pr-apply"],
      [2, "applied", "pull-request", "pr-apply"],
    ]);
    expect(second.members.every((m) => m.status === "applied")).toBe(true);
    // No wave gate was asked for: nothing waits on release-wave-2.
    expect(gateLedger.appended.filter((r) => r.gate.startsWith("release-wave"))).toEqual([]);
    expect(await note()).toContain("| 2 | `app` | applied | the pull request's `pr-apply` by `github:alice` |");
  });

  test("a job past the change's last wave finds nothing left and exits 0", async () => {
    await planAndApprove();
    expect(await runComponentsPrApply(wave(1))).toBe(0);
    expect(await runComponentsPrApply(wave(2))).toBe(0);
    ran = [];
    expect(await runComponentsPrApply(wave(3))).toBe(0);
    expect(ran).toEqual([]);
    expect((await report()).status).toBe("applied");
  });
});

describe("pr-apply --wave-gate: wave 2's plan differs from the pull request's", () => {
  /**
   * The change moves net's cidr, which app reads, and net's plan cannot say
   * it (#3999): the pull request planned app without it.
   */
  async function movedChange(): Promise<string> {
    predicts = false;
    netStep.cidr = "10.1.0.0/16";
    const digest = await planAndApprove();
    expect(await runComponentsPrApply(wave(1))).toBe(0);
    expect(deployed.net).toEqual({ cidr: "10.1.0.0/16" });
    return digest;
  }

  test("wave 2 waits at release-wave-2 with nothing applied and exits 3; the report and the note say why and how to approve", async () => {
    const digest = await movedChange();
    expect(await runComponentsPrApply(wave(2))).toBe(3);
    expect(ran).toEqual(["net"]);
    const r = await report();
    expect(r).toMatchObject({ status: "refused", refusal: "wave-not-approved", digest });
    const w2 = r.waves!.find((w) => w.wave === 2)!;
    expect(w2).toMatchObject({ status: "waiting", approval: "wave", gate: "release-wave-2", components: ["app"] });
    expect(w2.digest).not.toBe(digest);
    expect(w2.moved).toEqual(["app now writes app.main.cidr to a different value than the approved plan"]);
    expect(r.members.find((m) => m.member === "app")?.unknownInputs).toEqual(["net.cidr"]);
    // The wave's own gate is pending under the pull request's op, bound to its new plan.
    expect(gateLedger.appended).toEqual([expect.objectContaining({ kind: "pending", op: "pr-12", gate: "release-wave-2", planDigest: w2.digest })]);
    expect(existsSync(join(dir, "change-set-wave-2.json"))).toBe(true);
    expect(r.message).toContain(`chant approve pr-12 release-wave-2 --plan ${w2.digest}`);
    const text = await note();
    expect(text).toContain("Wave 2 waits at its gate `release-wave-2`; nothing in it applied.");
    expect(text).toContain("| 1 | `net` | applied | the pull request's `pr-apply` by `github:alice` |");
    expect(text).toContain("| 2 | `app` | waiting | its own `release-wave-2`, not approved yet |");
  });

  test("--events-json: wave 2's job settles wave 1 already-applied, then its own gate waits, on one schema-valid stream", async () => {
    await movedChange();
    out = [];
    expect(await runComponentsPrApply(wave(2, { eventsJson: true }))).toBe(3);
    const events = checkRunEventLines(out);
    expect(events[0]).toMatchObject({ type: "run-start", waves: [["net"], ["app"]] });
    expect(events.find((e) => e.type === "component-settle")).toMatchObject({ component: "net", wave: 1, status: "already-applied" });
    expect(events.find((e) => e.type === "gate-resolved")).toMatchObject({ op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice" });
    expect(events.find((e) => e.type === "gate-waiting")).toMatchObject({ op: "pr-12", gate: "release-wave-2" });
    expect(events.some((e) => e.type === "wave-start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "gated" });
  });

  test("an approval of wave 2's new plan releases it: the re-run applies it under that approval", async () => {
    const digest = await movedChange();
    expect(await runComponentsPrApply(wave(2))).toBe(3);
    const w2 = (await report()).waves!.find((w) => w.wave === 2)!;
    gateLedger = memoryGateLedgerPort({ resolutions: [resolution("pr-apply", digest), resolution("release-wave-2", w2.digest, "github:bob")] });

    out = [];
    expect(await runComponentsPrApply(wave(2, { eventsJson: true }))).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    expect(deployed.app).toEqual({ cidr: "10.1.0.0/16" });
    // The one wave's fan-out carries the derivation's wave number in the stream and the log.
    const events = checkRunEventLines(out);
    expect(events.filter((e) => e.type === "wave-start")).toEqual([expect.objectContaining({ wave: 2, components: ["app"] })]);
    expect(events.find((e) => e.type === "component-settle" && e.component === "app")).toMatchObject({ wave: 2, status: "ok" });
    expect(errors.some((e) => /wave 2\/2: app/.test(e))).toBe(true);
    const r = await report();
    expect(r.status).toBe("applied");
    expect(r.waves!.map((w) => [w.wave, w.approval, w.gate, w.approvedBy])).toEqual([
      [1, "pull-request", "pr-apply", ["github:alice"]],
      [2, "wave", "release-wave-2", ["github:bob"]],
    ]);
    expect(await note()).toContain("| 2 | `app` | applied | its own `release-wave-2` by `github:bob` |");
  });

  test("an approval of wave 2's gate for another plan is refused as wave-plan-changed, naming both digests", async () => {
    const digest = await movedChange();
    const stale = "jcs1-sha256:" + "0".repeat(64);
    gateLedger = memoryGateLedgerPort({ resolutions: [resolution("pr-apply", digest), resolution("release-wave-2", stale, "github:bob")] });
    expect(await runComponentsPrApply(wave(2))).toBe(4);
    expect(ran).toEqual(["net"]);
    const r = await report();
    expect(r).toMatchObject({ status: "refused", refusal: "wave-plan-changed" });
    expect(r.waves!.find((w) => w.wave === 2)).toMatchObject({ status: "waiting", approved: stale });
    expect(r.message).toContain(`approved: ${stale}; planned now: ${r.waves![1]!.digest}`);
  });

  test("without --wave the waves run in order in one job, which stops at wave 2's gate and finishes once it is approved", async () => {
    predicts = false;
    netStep.cidr = "10.1.0.0/16";
    const digest = await planAndApprove();
    expect(await runComponentsPrApply(wave())).toBe(3);
    expect(ran).toEqual(["net"]);
    const w2 = (await report()).waves!.find((w) => w.wave === 2)!;
    gateLedger = memoryGateLedgerPort({ resolutions: [resolution("pr-apply", digest), resolution("release-wave-2", w2.digest, "github:bob")] });
    expect(await runComponentsPrApply(wave())).toBe(0);
    expect(ran).toEqual(["net", "app"]);
    expect((await report()).status).toBe("applied");
  });

  test("without --wave-gate the same change holds app back and plans it again at pr-apply-round-2 once net applied (#3999)", async () => {
    predicts = false;
    netStep.cidr = "10.1.0.0/16";
    await planAndApprove();
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
    expect(ran).toEqual(["net"]);
    expect(deployed.app).toEqual({ cidr: "10.0.0.0/16" });
    const r = await report();
    expect(r.status).toBe("waiting");
    expect(r.rounds?.map((x) => [x.gate, x.components, x.status])).toEqual([["pr-apply-round-2", ["app"], "waiting"]]);
    expect(r.members.find((m) => m.member === "app")).toMatchObject({ status: "waiting", round: 2 });
  });
});

describe("a moved output a plan can say (#3999)", () => {
  test("pr-plan plans app against the cidr net's plan says, so wave 2 applies under the pull request's approval", async () => {
    netStep.cidr = "10.1.0.0/16";
    const digest = await planAndApprove();
    const plan = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")) as PrReport;
    expect(plan.plannedOutputs).toEqual({ net: ["cidr"] });
    expect(await runComponentsPrApply(wave(1))).toBe(0);
    expect(await runComponentsPrApply(wave(2))).toBe(0);
    expect(deployed.app).toEqual({ cidr: "10.1.0.0/16" });
    const r = await report();
    expect(r.waves!.map((w) => [w.wave, w.approval, w.digest])).toEqual([
      [1, "pull-request", digest],
      [2, "pull-request", digest],
    ]);
    expect(gateLedger.appended.filter((x) => x.gate.startsWith("release-wave"))).toEqual([]);
  });

  test("without --wave-gate the same change applies app against the new cidr under the one approval", async () => {
    netStep.cidr = "10.1.0.0/16";
    await planAndApprove();
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(0);
    expect(deployed.app).toEqual({ cidr: "10.1.0.0/16" });
    expect((await report()).rounds).toBeUndefined();
  });
});

describe("pr-plan --wave-gate", () => {
  test("the plan's report names the wave gate and its note says later waves may stop at their own gate", async () => {
    expect(await runComponentsPrPlan(ctx({ pr: 12, waveGate: "release" }))).toBe(0);
    const plan = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")) as PrReport;
    expect(plan.waveGate).toBe("release");
    expect(plan.waves).toBeUndefined();
    expect(await readFile(join(dir, "pr-note.md"), "utf8")).toContain("stops at its own gate, `release-wave-<k>`, for approval.");
    expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
    expect(await readFile(join(dir, "pr-note.md"), "utf8")).not.toContain("planned again");
  });
});

describe("pr-apply --wave-gate refuses", () => {
  test("wave 1 without the pull request's approval: not-approved, exit 3, nothing applied", async () => {
    expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
    expect(await runComponentsPrApply(wave(1))).toBe(3);
    expect(ran).toEqual([]);
    expect(await report()).toMatchObject({ status: "refused", refusal: "not-approved" });
  });

  test("wave 2 before wave 1 applied, or with no record of it: earlier-wave, exit 1, nothing planned or applied", async () => {
    await planAndApprove();
    expect(await runComponentsPrApply(wave(2))).toBe(1);
    expect(ran).toEqual([]);
    const r = await report();
    expect(r).toMatchObject({ status: "refused", refusal: "earlier-wave" });
    expect(r.message).toContain("Wave 2 cannot run yet: wave 1 has not applied (net)");
    expect(gateLedger.appended).toEqual([]);
  });

  test("a record whose pull-request approval was withdrawn does not carry, so wave 2 refuses", async () => {
    await planAndApprove();
    expect(await runComponentsPrApply(wave(1))).toBe(0);
    gateLedger = memoryGateLedgerPort();
    expect(await runComponentsPrApply(wave(2))).toBe(1);
    expect(errors.some((e) => e.includes("no approval stands for the plan it applied"))).toBe(true);
    expect(await report()).toMatchObject({ status: "refused", refusal: "earlier-wave" });
    expect(ran).toEqual(["net"]);
  });

  test("--wave without --wave-gate", async () => {
    expect(await runComponentsPrApply(ctx({ pr: 12, wave: 1 }))).toBe(1);
    expect(errors.some((e) => e.includes("--wave runs one wave of a --wave-gate apply"))).toBe(true);
  });

  describe("--require-review on the wave's own approval (#4000)", () => {
    const ENV = { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t0k", GITHUB_API_URL: "https://api.github.test", GITHUB_SERVER_URL: "https://github.com" };
    beforeEach(() => {
      for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
      // Pull request 12: carol wrote it, alice and carol approved it.
      const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
      vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
        const { pathname } = new URL(url);
        if (init.method !== "GET") return ok({ id: 1 });
        const pull = "/repos/acme/infra/pulls/12";
        if (pathname === `${pull}/reviews`) return ok([{ user: { login: "alice" }, state: "APPROVED" }, { user: { login: "carol" }, state: "APPROVED" }]);
        if (pathname === pull) return ok({ number: 12, user: { login: "carol" } });
        if (pathname === `${pull}/commits`) return ok([{ author: { login: "carol" }, committer: { login: "carol" } }]);
        return ok([]);
      });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    test("the author approves wave 2's moved plan: refused as author-approved, and wave 2 still waits", async () => {
      predicts = false;
      netStep.cidr = "10.1.0.0/16";
      const digest = await planAndApprove();
      const review = { forge: "github", requireReview: true };
      expect(await runComponentsPrApply(wave(1, review))).toBe(0);
      expect(await runComponentsPrApply(wave(2, review))).toBe(3);
      const w2 = (await report()).waves!.find((w) => w.wave === 2)!;
      gateLedger = memoryGateLedgerPort({ resolutions: [resolution("pr-apply", digest), resolution("release-wave-2", w2.digest, "github:carol")] });
      expect(await runComponentsPrApply(wave(2, review))).toBe(3);
      const r = await report();
      expect(r).toMatchObject({ status: "refused", refusal: "author-approved" });
      expect(r.message).toContain("Wave 2's plan is approved by github:carol, who wrote #12");
      expect(r.waves!.find((w) => w.wave === 2)).toMatchObject({ status: "waiting" });
      expect(ran).toEqual(["net"]);
    });
  });
});

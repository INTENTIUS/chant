/**
 * `chant components pr-apply --wave-gate` (#4291): a failed member blocks
 * only the members that depend on it. `db` fails in wave 1; `app` reads
 * `net` and still applies in wave 2, and `web` reads `db` and is blocked.
 * The note lists the blocked set. Git, the change signal, the derivation and
 * the gate ledger are fakes, as in `pr-waves.test.ts`; the planning, the
 * coverage check and the apply are the real ones.
 *
 * Kept fast (#4502): the readers pr-plan and pr-apply run against the
 * declaration at base (hooks, policy, security groups, ci.locks, new
 * migrations) each start git processes in this checkout, so they read as a
 * declaration that sets none of them. The pull request is planned once for
 * the file, since every test starts from the same estate and so the same
 * digest; each test approves that digest on its own ledger.
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
  resolveChangedUnits: async () => ({ units: { changed: ["net", "db"], indeterminate: [] } }),
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
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr-waves.test must not push chant/lifecycle"); } };
});

// The declaration at base sets no hooks, policy, security group or lock, and the change adds no migration (#4502).
vi.mock("../../components/pr-hooks", async () => {
  const actual = await vi.importActual<typeof import("../../components/pr-hooks")>("../../components/pr-hooks");
  return { ...actual, prLoopHooksAt: (_cwd: string, base: string) => ({ hooks: {}, base }) };
});
vi.mock("../../components/pr-policy", async () => {
  const actual = await vi.importActual<typeof import("../../components/pr-policy")>("../../components/pr-policy");
  return { ...actual, prLoopPolicyAt: (_cwd: string, base: string) => ({ base }) };
});
vi.mock("../../workspace/security", async () => {
  const actual = await vi.importActual<typeof import("../../workspace/security")>("../../workspace/security");
  return { ...actual, securityGroupsAt: () => new Set() };
});
vi.mock("../../workspace/ci-locks", async () => {
  const actual = await vi.importActual<typeof import("../../workspace/ci-locks")>("../../workspace/ci-locks");
  return { ...actual, ciLocksAt: () => null };
});
vi.mock("../../workspace/new-migrations", async () => {
  const actual = await vi.importActual<typeof import("../../workspace/new-migrations")>("../../workspace/new-migrations");
  return { ...actual, newMigrationFilesBetween: async () => [] };
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
/** Roots whose apply fails. */
const failing = new Set<string>();
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
      if (failing.has(input.root)) throw new Error(`${input.root} failed`);
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
      plan: planFanOut({ components: ESTATE, changed: ["net", "db"] }),
      signal: { changed: ["net", "db"], indeterminate: [], unclaimed: [] },
    }),
  };
});

/** Wave 1: `net` and `db`. Wave 2: `app` reads `net`, `web` reads `db`. */
const fixed = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name, cidr: "10.0.0.0/16" }] }],
});
const ESTATE: DriverComponent[] = [
  fixed("net"),
  fixed("db"),
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: "app", cidr: { stackOutput: { stack: "net", name: "cidr" } } }] }] },
  fixed("web", ["db"]),
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

/** The digest of pull request 12's plan, planned by the first test that asks: every test starts from the same estate (#4502). */
let plannedDigest: string | undefined;

/** Plan pull request 12, as its plan job does, and approve its digest as alice. */
async function planAndApprove(): Promise<string> {
  if (plannedDigest === undefined) {
    expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
    plannedDigest = (JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")) as PrReport).digest;
  }
  const digest = plannedDigest;
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
  failing.clear();
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

describe("pr-apply --wave-gate: a failed member blocks only its dependents (#4291)", () => {
  test("wave 1 fails db and applies net; wave 2's job still runs, applies app and blocks web by db", async () => {
    await planAndApprove();
    failing.add("db");

    expect(await runComponentsPrApply(wave(1))).toBe(1);
    expect(ran).toEqual(["net"]);

    expect(await runComponentsPrApply(wave(2))).toBe(1);
    expect(ran).toEqual(["net", "app"]);
    const r = await report();
    expect(r.status).toBe("failed");
    expect(Object.fromEntries(r.members.map((m) => [m.member, [m.status, m.blockedBy]]))).toEqual({
      net: ["applied", undefined],
      db: ["failed", undefined],
      app: ["applied", undefined],
      web: ["blocked", "db"],
    });
    const text = await note();
    expect(text).toContain("| `web` | web | blocked by `db` |");
    expect(text).toContain("Blocked, so not applied: `web` (blocked by `db`).");
    expect(errors.some((e) => /wave 2: web \(blocked by db\), so not planned or applied/.test(e))).toBe(true);
  });

  test("re-run once db is fixed: wave 1 applies db, and wave 2 applies web", async () => {
    await planAndApprove();
    failing.add("db");
    expect(await runComponentsPrApply(wave(1))).toBe(1);
    expect(await runComponentsPrApply(wave(2))).toBe(1);

    failing.clear();
    expect(await runComponentsPrApply(wave(1))).toBe(0);
    expect(await runComponentsPrApply(wave(2))).toBe(0);
    expect(ran).toEqual(["net", "app", "db", "web"]);
    expect((await report()).status).toBe("applied");
  });

  test("without --wave the waves run in one job: app applies after db failed, web is blocked, exit 1", async () => {
    await planAndApprove();
    failing.add("db");
    expect(await runComponentsPrApply(wave())).toBe(1);
    expect(ran).toEqual(["net", "app"]);
    const r = await report();
    expect(r.members.find((m) => m.member === "web")).toMatchObject({ status: "blocked", blockedBy: "db" });
    expect(r.message).toContain("Blocked: web (blocked by db).");
  });
});

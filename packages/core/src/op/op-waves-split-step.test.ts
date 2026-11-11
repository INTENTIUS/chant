/**
 * #4992: the four jobs of a split wave take a `step` spec and a hook that
 * holds the wave on another gate.
 *
 * - A step spec plans in the plan job's process, and the saved plan keeps
 *   its step plans. The gate job leases the rows they change before it
 *   spends the approval and names the lease in the decision; the applying
 *   job plans its runs again through the step, applies each whose digest
 *   the decision holds and writes nothing to the ledger; the record job
 *   writes the run and release records and lets go of the rows.
 * - A hook in the plan or apply job that holds the wave on another gate
 *   reads that gate with no write token: while it waits, the gate job (a
 *   plan job's hold) or the record job (an apply job's) records its pending
 *   fact. A hold that asks chant to record the gate fails in those jobs
 *   once approved, since its approval is spent before the hook runs again.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opWaveOutcomeDir, opWaveRecordPath, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveDecision, type OpWaveExec, type OpWaveRunPort, type OpWaveSavedPlan, type OpWaveShowAtBase } from "./op-waves-run";
import { opWaveRunRecordFileName, opWaveSavedPlanPath } from "./op-waves-split";
import type { OpWaveReleasePort, OpWaveReleaseRequest } from "./op-waves-release";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import { leaseLockRows, readLockRows } from "../lifecycle/resource-lock";
import { CHANT_EXIT } from "../exit-codes";
import type { OpRunRecordInput } from "./runtime";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare remote and `n` clones of it, each a writer of chant/lifecycle. */
function writers(n: number): string[] {
  const remote = tmp("split-step-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("split-step-seed-");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "seed@chant.dev");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "# t\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  return Array.from({ length: n }, (_, i) => {
    const c = tmp(`split-step-clone-${i}-`);
    git(c, "clone", "-q", remote, ".");
    git(c, "config", "user.email", `w${i}@chant.dev`);
    git(c, "config", "user.name", `Writer ${i}`);
    git(c, "config", "commit.gpgsign", "false");
    return c;
  });
}

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const alive = async () => "alive" as const;
const ROW = "root network aws_s3_bucket.network";

/** A root on the resource grain: one row per root; `planned` says which digest the next plan gives. */
function rootCapability(): { registry: CapabilityRegistry; ran: string[]; plans: { count: number; digest: string } } {
  const ran: string[] = [];
  const plans = { count: 0, digest: digest("1") };
  const part = (member: string): ChangeSetPart => ({
    member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: plans.digest, holes: [] },
    entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action: "create" } as ChangeSetPart["entries"][number]],
  });
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-root",
    async plan(_ctx, input) {
      plans.count++;
      const root = String(input.root);
      return { member: root, planDigest: plans.digest, artifact: { root, engineFile: `/tmp/${root}.tfplan` }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return { applied: input.root };
    },
    defaultLockGrain: () => "resource",
    lockRows: (input) => [{ key: `root ${String(input.root)} aws_s3_bucket.${String(input.root)}`, target: String(input.root), address: `aws_s3_bucket.${String(input.root)}` }],
  };
  return { registry: new CapabilityRegistry().register(cap), ran, plans };
}

const stepSpec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "fake-root", root: "{target}" },
  waves: [{ name: "dev", runs: [{ target: "network" }], gate: "never" }],
};
const stepShow: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(stepSpec) });

/** The rows another writer reads on the remote. */
async function rowsSeenBy(cwd: string): Promise<Record<string, string>> {
  return (await readLockRows("pr-apply", { cwd })).rows;
}

describe("a split wave with a step (#4992)", () => {
  test("plan, gate, apply and record: the gate job leases the rows, the applying job plans again and writes nothing, the record job lets go", async () => {
    const [other, job] = writers(2) as [string, string];
    const { registry, ran, plans } = rootCapability();
    const records: OpRunRecordInput[] = [];
    const releases: OpWaveReleaseRequest[] = [];
    const releasePort: OpWaveReleasePort = { record: async (r) => (releases.push(...r), r.map((q) => ({ recorded: true as const, env: q.env, component: q.component, digest: q.planDigest }))) };
    const noWrites: OpWaveRunPort = { append: async () => Promise.reject(new Error("this job writes no run record to the ledger")) };
    const noReleases: OpWaveReleasePort = { record: async () => Promise.reject(new Error("this job writes no release record")) };
    const gates = memoryGateLedgerPort();
    const base = { spec: stepSpec, specFile: "waves.json", wave: 1, cwd: job, show: stepShow, gates, capabilities: registry, lockLiveness: alive, log: () => {} };

    const planned = await runOpWave({ ...base, phase: "plan", runs: noWrites, releases: noReleases });
    expect(planned.exitCode).toBe(CHANT_EXIT.done);
    const saved = JSON.parse(readFileSync(join(job, opWaveSavedPlanPath(stepSpec, 1)), "utf-8")) as OpWaveSavedPlan;
    // The saved plan keeps the step plan with its rows, and leaves the engine's artifact in the plan job.
    expect(saved.steps).toEqual([expect.objectContaining({ target: "network", planDigest: digest("1"), lock: expect.objectContaining({ grain: "resource" }) })]);
    expect(JSON.stringify(saved.steps)).not.toContain("tfplan");
    expect(await rowsSeenBy(other)).toEqual({});

    const gated = await runOpWave({ ...base, phase: "gate" });
    expect(gated.exitCode).toBe(CHANT_EXIT.done);
    const decision = JSON.parse(readFileSync(join(job, opWaveRecordPath(stepSpec, 1)), "utf-8")) as OpWaveDecision;
    expect(decision.lease).toMatchObject({ gate: "pr-apply", keys: [ROW] });
    const holder = decision.lease!.run;
    expect(await rowsSeenBy(other)).toEqual({ [ROW]: holder });
    // The gate plans nothing.
    expect(plans.count).toBe(1);

    const applied = await runOpWave({ ...base, phase: "apply", runs: noWrites });
    expect(applied).toMatchObject({ exitCode: 0, applied: ["network"] });
    expect(ran).toEqual(["network"]);
    // It planned its run again through the step, and left the rows to the record job.
    expect(plans.count).toBe(2);
    expect(await rowsSeenBy(other)).toEqual({ [ROW]: holder });
    const file = JSON.parse(readFileSync(join(job, opWaveOutcomeDir(stepSpec), opWaveRunRecordFileName(1)), "utf-8")) as { handoff?: { releases?: OpWaveReleaseRequest[] } };
    expect(file.handoff?.releases).toEqual([expect.objectContaining({ env: "dev", component: "network", target: "network", planDigest: digest("1") })]);

    const recorded = await runOpWave({ ...base, phase: "record", gates: undefined, runs: { append: async (r) => void records.push(r) }, releases: releasePort });
    expect(recorded).toMatchObject({ exitCode: 0, applied: ["network"] });
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("handoff");
    expect(releases.map((r) => r.target)).toEqual(["network"]);
    expect(await rowsSeenBy(other)).toEqual({});
  });

  test("a row another run holds ends the wave in the gate job, held, before anything applies; a plan that moved since the gate is not applied", async () => {
    const [other, job] = writers(2) as [string, string];
    const taken = await leaseLockRows("pr-apply", [{ key: ROW, target: "network", address: "aws_s3_bucket.network" }], { cwd: other, alive, holder: { run: "71", at: new Date().toISOString() } });
    expect(taken.ok).toBe(true);
    const { registry, ran, plans } = rootCapability();
    const base = { spec: stepSpec, specFile: "waves.json", wave: 1, cwd: job, show: stepShow, gates: memoryGateLedgerPort(), capabilities: registry, lockLiveness: alive, releases: false as const, log: () => {} };
    await runOpWave({ ...base, phase: "plan" });
    const held = await runOpWave({ ...base, phase: "gate" });
    expect(held).toMatchObject({ exitCode: CHANT_EXIT.held, outcome: { outcome: "held", holder: { run: "71" } } });
    expect(existsSync(join(job, opWaveRecordPath(stepSpec, 1)))).toBe(true);
    expect((JSON.parse(readFileSync(join(job, opWaveRecordPath(stepSpec, 1)), "utf-8")) as OpWaveDecision).lease).toBeUndefined();
    if (taken.ok) await taken.lease.release();

    const gated = await runOpWave({ ...base, phase: "gate" });
    expect(gated.exitCode).toBe(CHANT_EXIT.done);
    plans.digest = digest("9");
    const moved = await runOpWave({ ...base, phase: "apply" });
    expect(moved).toMatchObject({ exitCode: CHANT_EXIT.moved, applied: [], moved: ["network"] });
    expect(ran).toEqual([]);
    // The record job lets go of the rows whatever the applying job did.
    expect((await runOpWave({ ...base, phase: "record", gates: undefined, runs: { append: async () => {} } })).exitCode).toBe(CHANT_EXIT.moved);
    expect(await rowsSeenBy(other)).toEqual({});
  });
});

/** A command spec whose hooks, read at base, hold the wave on `tf-migrate / split-queues`. */
function holdHarness(moment: "plan" | "apply", request: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), "split-hold-"));
  dirs.push(cwd);
  const migrate = { name: "migrate", command: ["migrate", "{runs}"], onFailure: "approve" as const };
  const spec: OpWavesSpec = {
    name: "migrations",
    op: "migrate",
    plan: ["tool", "plan", "{target}", "--out", "{plan}"],
    apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
    hooks: { before: { [moment]: [migrate] } },
    waves: [{ name: "staging", runs: [{ target: "staging" }], gate: "never" }],
  };
  const calls: string[] = [];
  const reruns: Array<Record<string, string>> = [];
  const exec: OpWaveExec = (argv, dir, env = {}) => {
    calls.push(argv.join(" "));
    if (argv[0] === "tool" && argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest("a") }));
    if (argv[0] !== "migrate") return 0;
    if (env.CHANT_HOLD_APPROVED) {
      reruns.push(env);
      return 0;
    }
    writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: "split-queues", digest: digest("m"), description: "move the queues", ...request }));
    return 3;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  const approval = { version: 1 as const, op: "tf-migrate", gate: "split-queues", resolvedBy: "alice", timestamp: "2026-11-10T00:00:00Z", planDigest: digest("m") };
  return { cwd, calls, reruns, approval, base: { spec, specFile: "waves.json", wave: 1, cwd, exec, show, log: () => {} } };
}

describe("a hold on another gate in a split wave (#4992)", () => {
  const noWrites: OpWaveRunPort = { append: async () => Promise.reject(new Error("this job writes no run record to the ledger")) };

  test("a plan job's hold is recorded by the gate job, and the wave goes on once that gate is approved", async () => {
    const h = holdHarness("plan", { attachment: '{"proof":1}', pending: { members: [] } });
    const gates = memoryGateLedgerPort();
    const planned = await runOpWave({ ...h.base, phase: "plan", gates, runs: noWrites });
    expect(planned.exitCode).toBe(CHANT_EXIT.waiting);
    // The plan job wrote nothing to the ledger: no pending fact, no request file.
    expect(gates.appended).toEqual([]);
    expect(gates.attachments.size).toBe(0);
    const saved = JSON.parse(readFileSync(join(h.cwd, opWaveSavedPlanPath(h.base.spec, 1)), "utf-8")) as OpWaveSavedPlan;
    expect(saved.end?.decision?.heldOn).toMatchObject({ op: "tf-migrate", gate: "split-queues", status: "waiting", deferred: { input: { op: "tf-migrate", gate: "split-queues", planDigest: digest("m") } } });

    const records: OpRunRecordInput[] = [];
    const gated = await runOpWave({ ...h.base, phase: "gate", gates, runs: { append: async (r) => void records.push(r) } });
    expect(gated).toMatchObject({ exitCode: CHANT_EXIT.waiting, decision: { status: "waiting", heldOn: { op: "tf-migrate", gate: "split-queues", recorded: true } } });
    expect(gates.appended).toEqual([expect.objectContaining({ op: "tf-migrate", gate: "split-queues", planDigest: digest("m"), description: "move the queues", heldBy: { hook: "migrate", moment: "before-plan" } })]);
    expect(gates.attachments.get(`tf-migrate/${digest("m")}`)).toBe('{"proof":1}');
    const decision = JSON.parse(readFileSync(join(h.cwd, opWaveRecordPath(h.base.spec, 1)), "utf-8")) as OpWaveDecision;
    expect(decision.heldOn).toMatchObject({ op: "tf-migrate", gate: "split-queues", recorded: true });
    expect(decision.heldOn).not.toHaveProperty("deferred");
    expect(records.map((r) => r.status)).toEqual(["gated"]);

    // Approved: the plan job reads the approval with no token, the hook runs again, and the wave plans.
    const approved = memoryGateLedgerPort({ resolutions: [h.approval] });
    const again = await runOpWave({ ...h.base, phase: "plan", gates: approved, runs: noWrites });
    expect(again.exitCode).toBe(CHANT_EXIT.done);
    expect(JSON.parse(h.reruns[0]!.CHANT_HOLD_APPROVED!)).toMatchObject({ op: "tf-migrate", gate: "split-queues", approvedBy: "alice" });
    expect(h.calls).toContain("tool plan staging --out .chant/op-waves/migrations/wave-1/staging.plan.json");
    expect(approved.appended).toEqual([]);
  });

  test("an approved hold that asks chant to record its gate fails in the plan job, which cannot spend it", async () => {
    const h = holdHarness("plan", { record: true });
    const approved = memoryGateLedgerPort({ resolutions: [h.approval] });
    const lines: string[] = [];
    const planned = await runOpWave({ ...h.base, phase: "plan", gates: approved, runs: noWrites, log: (l) => lines.push(l) });
    expect(planned.exitCode).toBe(CHANT_EXIT.failed);
    expect(h.reruns).toEqual([]);
    expect(approved.applied).toEqual([]);
    expect(lines.join("\n")).toContain("this plan job of a split wave holds no write token, so it cannot spend it");
  });

  test("an applying job's hold is recorded by the record job, and the wave waits", async () => {
    const h = holdHarness("apply", { pending: { members: [] } });
    const gates = memoryGateLedgerPort();
    await runOpWave({ ...h.base, phase: "plan", gates, runs: noWrites });
    expect((await runOpWave({ ...h.base, phase: "gate", gates })).exitCode).toBe(CHANT_EXIT.done);
    const applied = await runOpWave({ ...h.base, phase: "apply", gates, runs: noWrites });
    expect(applied.exitCode).toBe(CHANT_EXIT.waiting);
    expect(h.calls.some((c) => c.startsWith("tool apply"))).toBe(false);
    expect(gates.appended).toEqual([]);
    const file = JSON.parse(readFileSync(join(h.cwd, opWaveOutcomeDir(h.base.spec), opWaveRunRecordFileName(1)), "utf-8")) as { handoff?: { heldOn?: { deferred?: unknown } } };
    expect(file.handoff?.heldOn?.deferred).toBeDefined();

    const recorded = await runOpWave({ ...h.base, phase: "record", gates, runs: { append: async () => {} } });
    expect(recorded.exitCode).toBe(CHANT_EXIT.waiting);
    expect(gates.appended).toEqual([expect.objectContaining({ op: "tf-migrate", gate: "split-queues", planDigest: digest("m"), heldBy: { hook: "migrate", moment: "before-apply" } })]);
  });
});

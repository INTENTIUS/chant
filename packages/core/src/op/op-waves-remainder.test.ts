/**
 * #5047: the record of an apply under an approval is chant's own. Under
 * `approvals.remainder` (with `approvals.spend`, both read at base) the
 * applied line names each change the approved plans make, the job that
 * applies the whole wave (a split wave's record job) writes how the apply
 * ended, and a wave run again at the same commit applies the rest of a
 * stopped apply under its approval when its plans make only changes that
 * apply did not finish. A wave that plans no change closes a stopped
 * apply; `approvals.spendStanding` spends an approval of the digest a wave
 * its gate let through applies.
 */
import { afterAll, describe, expect, test, vi } from "vitest";
import { OP_WAVES_RESUME_ENV } from "./op-waves-split-resume";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOpWavesSpec, opWaveOutcomeDir, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveRunPort, type OpWaveShowAtBase } from "./op-waves-run";
import { opWaveRunRecordFileName } from "./op-waves-split";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import { CHANT_EXIT } from "../exit-codes";
import {
  OP_WAVES_REMAINDER_FLOOR,
  OP_WAVES_REMAINDER_PARITY_FLOOR,
  OP_WAVE_REMAINDER_FOLLOWS,
  opWaveApprovedChanges,
  opWaveCoverRemainder,
  opWaveStoppedApply,
  opWaveUnfinishedApply,
  type AppliedGateChange,
} from "./op-waves-remainder";
import type { AppliedGateRecord, FinishedGateRecord } from "../lifecycle/gate-applied";
import { OP_WAVE_COST_MEMBER } from "./op-waves-capability-spec";

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

/** A clone of a bare remote, a writer of chant/lifecycle (the resource grain's rows live there). */
function writer(): string {
  const remote = tmp("remainder-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const c = tmp("remainder-clone-");
  git(c, "init", "-q", "-b", "main");
  git(c, "config", "user.email", "w@chant.dev");
  git(c, "config", "user.name", "Writer");
  git(c, "config", "commit.gpgsign", "false");
  writeFileSync(join(c, "README.md"), "# t\n");
  git(c, "add", "README.md");
  git(c, "commit", "-q", "-m", "init");
  git(c, "remote", "add", "origin", remote);
  git(c, "push", "-q", "origin", "main");
  return c;
}

const alive = async () => "alive" as const;
const HEAD = "c".repeat(40);

/**
 * A root whose engine records each resource as its apply returns (the
 * resource grain): its plan makes the resources not done yet, each with its
 * digest. `stopAfter` has the next apply record that many resources and
 * then fail, as a killed apply leaves its records.
 */
function engine() {
  const want: Record<string, string> = { "aws_s3_bucket.a": `sha256:${"a".repeat(64)}`, "aws_s3_bucket.b": `sha256:${"b".repeat(64)}` };
  const done = new Set<string>();
  const ran: string[][] = [];
  const at = { stopAfter: undefined as number | undefined };
  const remaining = (): Record<string, string> => Object.fromEntries(Object.entries(want).filter(([k]) => !done.has(k)));
  const planDigest = (r: Record<string, string>): string => `sha256:${Buffer.from(JSON.stringify(r)).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-cdf",
    async plan(_ctx, input) {
      const root = String(input.root);
      const r = remaining();
      const entries = Object.keys(r).map((address) => ({ member: root, address, type: "aws_s3_bucket", action: "create" }));
      return {
        member: root,
        planDigest: planDigest(r),
        artifact: { root, r },
        resourceDigests: r,
        changeSet: { member: { member: root, lexicon: "terraform", planner: "chant", status: "planned", planDigest: planDigest(r), holes: [] }, entries } as never,
      };
    },
    async run(_ctx, input) {
      const r = Object.keys(remaining());
      const stop = at.stopAfter;
      at.stopAfter = undefined;
      const now: string[] = [];
      for (const [i, address] of r.entries()) {
        if (stop !== undefined && i >= stop) {
          ran.push(now);
          throw new Error(`${String(input.root)}: the apply stopped`);
        }
        done.add(address);
        now.push(address);
      }
      ran.push(now);
      return { applied: input.root };
    },
    defaultLockGrain: () => "resource",
    // On the resource grain with no rows to hold, so the test leases nothing on chant/lifecycle.
    lockRows: () => [],
  };
  return { registry: new CapabilityRegistry().register(cap), want, done, ran, at };
}

const spec = (approvals: Record<string, boolean>, gate: "always" | "never" = "always"): OpWavesSpec => ({
  name: "roots",
  op: "tf-apply",
  step: { kind: "fake-cdf", root: "{target}" },
  approvals,
  waves: [{ name: "dev", runs: [{ target: "network" }], gate }],
});
const showOf = (s: OpWavesSpec): OpWaveShowAtBase => () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });

let shared: string | undefined;

function harness(approvals: Record<string, boolean>, gate: "always" | "never" = "always") {
  const s = spec(approvals, gate);
  const cdf = engine();
  const gates = memoryGateLedgerPort();
  const lines: string[] = [];
  // One writer for the file: each wave lets go of its rows when it ends, and the tests run one at a time.
  shared ??= writer();
  const base = { spec: s, specFile: "waves.json", wave: 1, cwd: shared, show: showOf(s), gates, capabilities: cdf.registry, lockLiveness: alive, releases: false as const, runs: { append: async () => {} } as OpWaveRunPort, head: HEAD, log: (l: string) => void lines.push(l) };
  const approve = async (digest: string) => void (await gates.appendResolution!({ op: "roots", gate: "roots-wave-1", resolvedBy: "alice", timestamp: new Date(Date.now() + 5).toISOString(), planDigest: digest }));
  return { s, cdf, gates, base, lines, approve };
}

describe("the stopped-apply record (#5047)", () => {
  test("the pure rules: changes on the resource grain, the stopped apply at this commit, the rest of it", () => {
    const grains = new Map([["network", { lock: { grain: "resource" } }], ["dns", { lock: { grain: "target" } }]]);
    expect(opWaveApprovedChanges([{ member: "network", resources: { b: "2", a: "1" } }, { member: "dns", empty: true }], grains)).toEqual([
      { target: "network", address: "a", digest: "1" },
      { target: "network", address: "b", digest: "2" },
    ]);
    // A changing run on another grain, or without resource digests, cannot resume.
    expect(opWaveApprovedChanges([{ member: "dns", resources: { x: "1" } }], grains)).toBeUndefined();
    expect(opWaveApprovedChanges([{ member: "network" }], grains)).toBeUndefined();

    const approved: AppliedGateChange[] = [{ target: "network", address: "a", digest: "1" }, { target: "network", address: "b", digest: "2" }];
    expect(opWaveCoverRemainder(approved, [approved[1]!])).toEqual({ covered: true, remaining: [approved[1]], done: [approved[0]] });
    expect(opWaveCoverRemainder(approved, [{ ...approved[1]!, digest: "9" }])).toMatchObject({ covered: false, why: "network b is a change the approved plans did not make" });
    expect(opWaveCoverRemainder(approved, [approved[1]!], { now: [{ member: "(cost)", planDigest: "c" }] })).toMatchObject({ covered: false });
    expect(opWaveCoverRemainder(approved, [approved[1]!], { now: [{ member: "(cost)", planDigest: "c" }], approved: [{ member: "(cost)", planDigest: "c" }] })).toMatchObject({ covered: true });

    const line = (at: string, commit: string, changes?: AppliedGateChange[]): AppliedGateRecord => ({ version: 1, kind: "applied", op: "roots", gate: "g", planDigest: `d-${at}`, approvedAt: "2026-11-01T00:00:00Z", approvedBy: "alice", timestamp: at, commit, ...(changes ? { changes } : {}) });
    const first = line("2026-11-02T00:00:00Z", HEAD, approved);
    const fin = (l: AppliedGateRecord, result: "applied" | "failed"): FinishedGateRecord => ({ version: 1, kind: "finished", op: "roots", gate: "g", planDigest: l.planDigest, applied: l.timestamp, result, timestamp: "2026-11-03T00:00:00Z" });
    expect(opWaveStoppedApply([first], [], "g", HEAD)).toBe(first);
    expect(opWaveStoppedApply([first], [fin(first, "failed")], "g", HEAD)).toBe(first);
    expect(opWaveStoppedApply([first], [fin(first, "applied")], "g", HEAD)).toBeUndefined();
    expect(opWaveStoppedApply([first], [], "g", "d".repeat(40))).toBeUndefined();
    // A newer apply of the gate at another commit leaves nothing to take up.
    expect(opWaveStoppedApply([first, line("2026-11-04T00:00:00Z", "d".repeat(40), approved)], [], "g", HEAD)).toBeUndefined();
    expect(opWaveUnfinishedApply([first], [], "g")).toBe(first);
    expect(opWaveUnfinishedApply([first], [fin(first, "failed")], "g")).toBeUndefined();
    expect(OP_WAVES_REMAINDER_FLOOR).toBe("0.124.94");
  });

  test("#5056: the cost member's digest follows from the plans, so the rest covers it moved; any other extra still has to match", () => {
    const approved: AppliedGateChange[] = [{ target: "network", address: "a", digest: "1" }, { target: "network", address: "b", digest: "2" }];
    const cost = (d: string) => ({ member: OP_WAVE_COST_MEMBER, planDigest: d });
    expect(OP_WAVE_REMAINDER_FOLLOWS).toEqual(["(monthly cost)"]);
    // Part of the wave applied, so the rest costs less: the cost member moved, and every change is an approved one.
    expect(opWaveCoverRemainder(approved, [approved[1]!], { now: [cost("sha256:less")], approved: [cost("sha256:all")] })).toEqual({ covered: true, remaining: [approved[1]], done: [approved[0]] });
    expect(opWaveCoverRemainder(approved, [approved[1]!], { now: [cost("sha256:less")] })).toMatchObject({ covered: true });
    // A change is still compared, and another extra still has to be the approved one.
    expect(opWaveCoverRemainder(approved, [{ ...approved[1]!, digest: "9" }], { now: [cost("sha256:less")], approved: [cost("sha256:all")] })).toMatchObject({ covered: false });
    expect(opWaveCoverRemainder(approved, [approved[1]!], { now: [cost("sha256:less"), { member: "migrate:m1", planDigest: "m" }], approved: [cost("sha256:all")] })).toMatchObject({ covered: false, why: "migrate:m1 is not as the approved set held it" });
    expect(OP_WAVES_REMAINDER_PARITY_FLOOR).toBe("0.124.94");
  });

  test("the spec takes approvals.remainder and approvals.spendStanding beside approvals.spend alone", () => {
    expect(() => assertOpWavesSpec(spec({ spend: true, remainder: true, spendStanding: true }))).not.toThrow();
    expect(() => assertOpWavesSpec(spec({ remainder: true }))).toThrow(/approvals.remainder works on the lines approvals.spend writes/);
    expect(() => assertOpWavesSpec(spec({ spend: true, spendStanding: "yes" } as never))).toThrow(/approvals.spendStanding must be true or false/);
  });

  test("a wave run again at the same commit applies the rest of its stopped apply under the approval, and says how it ended", async () => {
    const { cdf, gates, base, approve } = harness({ spend: true, remainder: true });
    const waited = await runOpWave(base);
    expect(waited.exitCode).toBe(CHANT_EXIT.waiting);
    await approve(waited.decision!.digest);
    // The apply stops after one of its two resources.
    cdf.at.stopAfter = 1;
    const stopped = await runOpWave(base);
    expect(stopped.exitCode).toBe(CHANT_EXIT.failed);
    expect(gates.applied).toHaveLength(1);
    expect(gates.applied[0]).toMatchObject({
      planDigest: waited.decision!.digest,
      approvedBy: "alice",
      commit: HEAD,
      changes: [
        { target: "network", address: "aws_s3_bucket.a", digest: cdf.want["aws_s3_bucket.a"] },
        { target: "network", address: "aws_s3_bucket.b", digest: cdf.want["aws_s3_bucket.b"] },
      ],
    });
    expect(gates.finished).toEqual([expect.objectContaining({ planDigest: waited.decision!.digest, applied: gates.applied[0]!.timestamp, result: "failed" })]);

    const rest = await runOpWave(base);
    expect(rest.exitCode).toBe(0);
    expect(rest.decision).toMatchObject({ status: "approved", approvedBy: "alice", resumes: { planDigest: waited.decision!.digest, appliedAt: gates.applied[0]!.timestamp } });
    expect(rest.decision!.digest).not.toBe(waited.decision!.digest);
    expect(cdf.ran.at(-1)).toEqual(["aws_s3_bucket.b"]);
    // It applied under the stopped apply's line: no applied line of its own, and that line's finished line says applied.
    expect(gates.applied).toHaveLength(1);
    expect(gates.finished.at(-1)).toMatchObject({ planDigest: waited.decision!.digest, applied: gates.applied[0]!.timestamp, result: "applied" });
    // Nothing is left: the wave plans no change and applies nothing again.
    const after = await runOpWave(base);
    expect(after.exitCode).toBe(0);
    expect(gates.finished).toHaveLength(2);
  });

  test("another commit, or a change the approved plans did not make, waits for an approval of its own", async () => {
    const { cdf, gates, base, approve, lines } = harness({ spend: true, remainder: true });
    const waited = await runOpWave(base);
    await approve(waited.decision!.digest);
    cdf.at.stopAfter = 1;
    await runOpWave(base);
    expect((await runOpWave({ ...base, head: "d".repeat(40) })).exitCode).toBe(CHANT_EXIT.waiting);
    cdf.want["aws_s3_bucket.b"] = `sha256:${"9".repeat(64)}`;
    expect((await runOpWave(base)).exitCode).toBe(CHANT_EXIT.waiting);
    expect(lines.some((l) => l.includes("aws_s3_bucket.b is a change the approved plans did not make, so these plans need an approval of their own"))).toBe(true);
    expect(cdf.ran.at(-1)).toEqual(["aws_s3_bucket.a"]);
    expect(gates.applied).toHaveLength(1);
  });

  test("without approvals.remainder the applied line names no changes, nothing finishes, and the rest waits", async () => {
    const { cdf, gates, base, approve } = harness({ spend: true });
    const waited = await runOpWave(base);
    await approve(waited.decision!.digest);
    cdf.at.stopAfter = 1;
    await runOpWave(base);
    expect(gates.applied).toHaveLength(1);
    expect(gates.applied[0]).not.toHaveProperty("changes");
    expect(gates.applied[0]).not.toHaveProperty("commit");
    expect(gates.finished).toEqual([]);
    expect((await runOpWave(base)).exitCode).toBe(CHANT_EXIT.waiting);
  });

  test("a wave that plans no change closes a stopped apply as applied", async () => {
    const { cdf, gates, base, approve } = harness({ spend: true, remainder: true });
    const waited = await runOpWave(base);
    await approve(waited.decision!.digest);
    cdf.at.stopAfter = 1;
    await runOpWave(base);
    // The killed apply wrote no finished line; something else applied the rest.
    gates.finished.length = 0;
    cdf.done.add("aws_s3_bucket.b");
    expect((await runOpWave(base)).exitCode).toBe(0);
    expect(gates.finished).toEqual([expect.objectContaining({ planDigest: waited.decision!.digest, applied: gates.applied[0]!.timestamp, result: "applied" })]);
  });

  test("approvals.spendStanding: a wave its gate lets through spends the approval of its digest that stands", async () => {
    // The digest the plans give, as an earlier wait's approval names it.
    const digest = (await runOpWave(harness({ spend: true }).base)).decision!.digest;
    const standing = harness({ spend: true, spendStanding: true }, "never");
    await standing.approve(digest);
    expect((await runOpWave(standing.base)).exitCode).toBe(0);
    expect(standing.gates.applied).toEqual([expect.objectContaining({ gate: "roots-wave-1", planDigest: digest, approvedBy: "alice" })]);
    // Off by default.
    const plain = harness({ spend: true }, "never");
    await plain.approve(digest);
    expect((await runOpWave(plain.base)).exitCode).toBe(0);
    expect(plain.gates.applied).toEqual([]);
  });

  test("a split wave: the gate job records the changes, the record job says how the apply ended, and the applying job run again applies the rest", async () => {
    const { cdf, gates, base, approve } = harness({ spend: true, remainder: true });
    await runOpWave({ ...base, phase: "plan" });
    const waited = await runOpWave({ ...base, phase: "gate" });
    expect(waited.exitCode).toBe(CHANT_EXIT.waiting);
    await approve(waited.decision!.digest);
    await runOpWave({ ...base, phase: "plan" });
    expect((await runOpWave({ ...base, phase: "gate" })).exitCode).toBe(CHANT_EXIT.done);
    expect(gates.applied).toEqual([expect.objectContaining({ commit: HEAD, changes: expect.arrayContaining([expect.objectContaining({ address: "aws_s3_bucket.b" })]) })]);
    // The applying job is killed after one resource: it leaves no run record, and the record job writes no finished line.
    cdf.at.stopAfter = 1;
    await runOpWave({ ...base, phase: "apply" });
    unlinkSync(join(base.cwd, opWaveOutcomeDir(base.spec), opWaveRunRecordFileName(1)));
    expect((await runOpWave({ ...base, phase: "record" })).exitCode).toBe(CHANT_EXIT.failed);
    expect(gates.finished).toEqual([]);
    // GitHub re-runs the failed applying and record jobs: the applying job's plan moved, to the rest of the decision's changes.
    const again = await runOpWave({ ...base, phase: "apply" });
    expect(again).toMatchObject({ exitCode: 0, applied: ["network"], moved: [] });
    expect(cdf.ran.at(-1)).toEqual(["aws_s3_bucket.b"]);
    expect((await runOpWave({ ...base, phase: "record" })).exitCode).toBe(0);
    expect(gates.finished).toEqual([expect.objectContaining({ planDigest: waited.decision!.digest, applied: gates.applied[0]!.timestamp, result: "applied" })]);
  });

  test("#5052: on GitLab the gate job's line names the applying and record jobs; a new run of the same commit (Forgejo's resume) applies the rest", async () => {
    vi.stubEnv("GITLAB_CI", "true");
    vi.stubEnv("CI_API_V4_URL", "https://gl/api/v4");
    vi.stubEnv("CI_PROJECT_ID", "7");
    vi.stubEnv("CI_PIPELINE_ID", "100");
    vi.stubEnv("CI_JOB_ID", "555");
    vi.stubEnv("CI_JOB_NAME", "wave-1-dev-gate");
    vi.stubEnv(OP_WAVES_RESUME_ENV, JSON.stringify({ apply: ["wave-1-dev"], record: "wave-1-dev-record" }));
    try {
      const { cdf, gates, base, approve } = harness({ spend: true, remainder: true });
      await runOpWave({ ...base, phase: "plan" });
      const waited = await runOpWave({ ...base, phase: "gate" });
      await approve(waited.decision!.digest);
      await runOpWave({ ...base, phase: "plan" });
      expect((await runOpWave({ ...base, phase: "gate" })).exitCode).toBe(CHANT_EXIT.done);
      expect(gates.applied[0]!.resume).toMatchObject({ forge: "gitlab", run: "100", job: "555", retry: { apply: ["wave-1-dev"], record: "wave-1-dev-record" } });
      cdf.at.stopAfter = 1;
      await runOpWave({ ...base, phase: "apply" });
      unlinkSync(join(base.cwd, opWaveOutcomeDir(base.spec), opWaveRunRecordFileName(1)));
      expect((await runOpWave({ ...base, phase: "record" })).exitCode).toBe(CHANT_EXIT.failed);
      // A new run at the same commit, from its plan job: the gate job takes up the stopped apply, and writes no line of its own.
      await runOpWave({ ...base, phase: "plan" });
      const gate = await runOpWave({ ...base, phase: "gate" });
      expect(gate.exitCode).toBe(CHANT_EXIT.done);
      expect(gate.decision?.resumes).toMatchObject({ planDigest: waited.decision!.digest, appliedAt: gates.applied[0]!.timestamp });
      expect(gates.applied).toHaveLength(1);
      expect(await runOpWave({ ...base, phase: "apply" })).toMatchObject({ exitCode: 0, applied: ["network"] });
      expect(cdf.ran.at(-1)).toEqual(["aws_s3_bucket.b"]);
      expect((await runOpWave({ ...base, phase: "record" })).exitCode).toBe(0);
      expect(gates.finished).toEqual([expect.objectContaining({ planDigest: waited.decision!.digest, applied: gates.applied[0]!.timestamp, result: "applied" })]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

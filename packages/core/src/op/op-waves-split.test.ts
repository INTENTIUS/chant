/**
 * #4987: a split wave's four jobs. The plan job plans and saves the plan
 * and writes nothing to the ledger; the gate job decides the gate on the
 * saved plan, refusing one whose plan files give another digest; the apply
 * job applies the saved plans the decision holds and leaves its run record
 * in a file; the record job writes it to the run ledger.
 */
import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opWaveJobs, opWaveOutcomeDir, opWaveRecordPath, type OpWavesSpec } from "./op-waves";
import { opWavePlanPath, runOpWave, type OpWaveExec, type OpWaveRunPort, type OpWaveSavedPlan, type OpWaveShowAtBase } from "./op-waves-run";
import { assertOpWavesSplit, opWaveRunRecordFileName, opWaveSavedPlanPath, opWaveSplitJobs, opWaveSplitLastJobs } from "./op-waves-split";
import { memoryGateLedgerPort } from "./gate";
import { waveSetDigest } from "../gated-waves";
import { CHANT_EXIT } from "../exit-codes";
import type { OpRunRecordInput } from "./runtime";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "staging", runs: [{ target: "staging" }], gate: "on-destructive" },
    { name: "prod", runs: [{ target: "t1" }, { target: "t2" }, { target: "t3" }], shares: 2, gate: "never" },
  ],
};
const digest = (n: string) => `sha256:${n.repeat(64)}`;

function harness(plans: Record<string, { planDigest: string; destructive?: boolean }>) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-split-"));
  const calls: string[] = [];
  const planExit: { code: number } = { code: 0 };
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") {
      if (planExit.code !== 0) return planExit.code;
      writeFileSync(join(dir, argv[4]!), JSON.stringify(plans[argv[2]!]));
    }
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  const records: OpRunRecordInput[] = [];
  const runs: OpWaveRunPort = { append: async (r) => void records.push(r) };
  const noRuns: OpWaveRunPort = {
    append: async () => {
      throw new Error("this job writes no run record to the ledger");
    },
  };
  const base = { spec, specFile: "waves.json", cwd, exec, show, log: () => {} };
  return { cwd, calls, exec, show, records, runs, noRuns, planExit, base, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("the split jobs of a before-merge pipeline (#4987)", () => {
  test("each wave is a plan, a gate, its applying jobs and a record job", () => {
    const split = opWaveSplitJobs(spec, opWaveJobs(spec, "waves.json", { beforeMerge: true }));
    expect(split.map((j) => [j.jobName, j.phase, j.runsChange, j.needs])).toEqual([
      ["wave-1-staging-plan", "plan", true, []],
      ["wave-1-staging-gate", "gate", false, ["wave-1-staging-plan"]],
      ["wave-1-staging", "apply", true, ["wave-1-staging-gate"]],
      ["wave-1-staging-record", "record", false, ["wave-1-staging", "wave-1-staging-gate"]],
      ["wave-2-prod-plan", "plan", true, ["wave-1-staging-record"]],
      ["wave-2-prod-gate", "gate", false, ["wave-2-prod-plan"]],
      ["wave-2-prod-share-1", "apply", true, ["wave-2-prod-gate"]],
      ["wave-2-prod-share-2", "apply", true, ["wave-2-prod-gate"]],
      ["wave-2-prod-record", "record", false, ["wave-2-prod-share-1", "wave-2-prod-share-2", "wave-2-prod-gate"]],
    ]);
    // The deciding job's --decide gives way to the phase; a share keeps its slice.
    expect(split[4]!.command.join(" ")).toBe('chant run wave --spec waves.json --wave 2 --base "${CHANT_WAVES_BASE:-HEAD^1}" --phase plan');
    expect(split[7]!.command.join(" ")).toBe('chant run wave --spec waves.json --wave 2 --base "${CHANT_WAVES_BASE:-HEAD^1}" --share 2 --phase apply');
    // The wave's own applying job writes an outcome file of its own, never the gate job's.
    expect(split[2]!.outcome).toBe(".chant/op-waves/migrations/outcomes/outcome-wave-1-apply.json");
    expect(split[1]!.outcome).toBe(".chant/op-waves/migrations/outcomes/outcome-wave-1.json");
    expect(opWaveSplitLastJobs(spec)).toEqual(["wave-2-prod-record"]);
  });

  test("a step spec splits (#4992); a rest wave cannot", () => {
    expect(() => assertOpWavesSplit({ ...spec, step: { kind: "terraform-apply", root: "{target}" } } as OpWavesSpec)).not.toThrow();
    expect(() => assertOpWavesSplit({ ...spec, waves: [{ ...spec.waves[1]!, rest: true }] })).toThrow('wave "prod" has `rest`');
  });
});

describe("a split wave's phases (#4987)", () => {
  const set = waveSetDigest([{ member: "staging", planDigest: digest("a") }]);
  const approval = { version: 1 as const, op: "migrations", gate: "migrations-wave-1", resolvedBy: "alice", timestamp: "2026-11-10T00:00:00Z", planDigest: set };

  test("plan, gate, apply and record: only the gate and record jobs write the ledger", async () => {
    const h = harness({ staging: { planDigest: digest("a"), destructive: true } });
    const gates = memoryGateLedgerPort({ resolutions: [approval] });

    const planned = await runOpWave({ ...h.base, wave: 1, phase: "plan", gates, runs: h.noRuns });
    expect(planned.exitCode).toBe(CHANT_EXIT.done);
    expect(gates.appended).toEqual([]);
    const saved = JSON.parse(readFileSync(join(h.cwd, opWaveSavedPlanPath(spec, 1)), "utf-8")) as OpWaveSavedPlan;
    expect(saved).toMatchObject({ version: 1, op: "migrations", wave: 1, name: "staging", digest: set, members: [{ member: "staging", planDigest: digest("a"), destructive: true }] });
    // The plan job decides nothing, so it writes no decision and no outcome.
    expect(existsSync(join(h.cwd, opWaveRecordPath(spec, 1)))).toBe(false);
    expect(existsSync(join(h.cwd, opWaveOutcomeDir(spec)))).toBe(false);
    expect(h.calls).toEqual(["tool plan staging --out .chant/op-waves/migrations/wave-1/staging.plan.json"]);

    const gated = await runOpWave({ ...h.base, wave: 1, phase: "gate", gates });
    expect(gated).toMatchObject({ exitCode: 0, applied: [], decision: { status: "approved", approvedBy: "alice", digest: set } });
    // The gate plans nothing again.
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(h.cwd, opWaveOutcomeDir(spec), "outcome-wave-1.json"), "utf-8")).members).toEqual({ staging: { status: "decided" } });

    const before = gates.appended.length;
    const applied = await runOpWave({ ...h.base, wave: 1, phase: "apply", gates, runs: h.noRuns });
    expect(applied).toMatchObject({ exitCode: 0, applied: ["staging"] });
    expect(gates.appended.length).toBe(before);
    expect(h.calls.at(-1)).toBe("tool apply staging --plan .chant/op-waves/migrations/wave-1/staging.plan.json");
    const recordFile = join(h.cwd, opWaveOutcomeDir(spec), opWaveRunRecordFileName(1));
    expect(JSON.parse(readFileSync(recordFile, "utf-8"))).toMatchObject({ op: "migrations", wave: { number: 1, applied: ["staging"], exitCode: 0 } });
    expect(JSON.parse(readFileSync(join(h.cwd, opWaveOutcomeDir(spec), "outcome-wave-1-apply.json"), "utf-8")).members).toEqual({ staging: { status: "applied" } });

    const recorded = await runOpWave({ ...h.base, wave: 1, phase: "record", runs: h.runs });
    expect(recorded).toMatchObject({ exitCode: 0, applied: ["staging"] });
    expect(h.records).toHaveLength(1);
    expect(h.records[0]!.wave).toMatchObject({ number: 1, applied: ["staging"] });
    h.done();
  });

  test("without an approval the gate job records the pending fact and waits; the apply job applies nothing", async () => {
    const h = harness({ staging: { planDigest: digest("a"), destructive: true } });
    const gates = memoryGateLedgerPort();
    await runOpWave({ ...h.base, wave: 1, phase: "plan", gates, runs: h.noRuns });
    const gated = await runOpWave({ ...h.base, wave: 1, phase: "gate", gates });
    expect(gated.exitCode).toBe(CHANT_EXIT.waiting);
    expect(gates.appended.map((p) => p.planDigest)).toEqual([set]);
    const applied = await runOpWave({ ...h.base, wave: 1, phase: "apply", gates, runs: h.noRuns });
    expect(applied.exitCode).toBe(CHANT_EXIT.waiting);
    expect(h.calls.filter((c) => c.startsWith("tool apply"))).toEqual([]);
    h.done();
  });

  test("the gate job refuses a saved plan its plan files do not give, and the apply job a plan file that moved after the gate", async () => {
    const h = harness({ staging: { planDigest: digest("a") } });
    const gates = memoryGateLedgerPort();
    await runOpWave({ ...h.base, wave: 1, phase: "plan", gates, runs: h.noRuns });
    const planFile = join(h.cwd, opWavePlanPath(spec, 1, "staging"));
    writeFileSync(planFile, JSON.stringify({ planDigest: digest("e") }));
    const refused = await runOpWave({ ...h.base, wave: 1, phase: "gate", gates });
    expect(refused).toMatchObject({ exitCode: CHANT_EXIT.moved, moved: ["staging"] });
    expect(gates.appended).toEqual([]);
    expect(existsSync(join(h.cwd, opWaveRecordPath(spec, 1)))).toBe(false);

    writeFileSync(planFile, JSON.stringify({ planDigest: digest("a") }));
    expect((await runOpWave({ ...h.base, wave: 1, phase: "gate", gates })).exitCode).toBe(0);
    writeFileSync(planFile, JSON.stringify({ planDigest: digest("f") }));
    const moved = await runOpWave({ ...h.base, wave: 1, phase: "apply", gates, runs: h.noRuns });
    expect(moved).toMatchObject({ exitCode: CHANT_EXIT.moved, applied: [], moved: ["staging"] });
    expect(h.calls.filter((c) => c.startsWith("tool apply"))).toEqual([]);
    h.done();
  });

  test("a plan that fails ends the wave in the plan job; the gate job records that end and decides nothing", async () => {
    const h = harness({ staging: { planDigest: digest("a") } });
    h.planExit.code = 1;
    const gates = memoryGateLedgerPort();
    await expect(runOpWave({ ...h.base, wave: 1, phase: "plan", gates, runs: h.noRuns })).rejects.toThrow("planning staging exited 1");
    const saved = JSON.parse(readFileSync(join(h.cwd, opWaveSavedPlanPath(spec, 1)), "utf-8")) as OpWaveSavedPlan;
    expect(saved.end).toMatchObject({ exitCode: 1 });
    const gated = await runOpWave({ ...h.base, wave: 1, phase: "gate", gates, runs: h.runs });
    expect(gated.exitCode).toBe(1);
    expect(gates.appended).toEqual([]);
    // Its run record says how the wave ended, from the gate job, which holds the token.
    expect(h.records.map((r) => r.status)).toEqual(["fail"]);
    h.done();
  });

  test("a wide wave's shares apply their slices of the saved plan, and the record job ends as they did", async () => {
    const h = harness({ t1: { planDigest: digest("1") }, t2: { planDigest: digest("2") }, t3: { planDigest: digest("3") } });
    const gates = memoryGateLedgerPort();
    await runOpWave({ ...h.base, wave: 2, phase: "plan", gates, runs: h.noRuns });
    expect((await runOpWave({ ...h.base, wave: 2, phase: "gate", gates })).decision).toMatchObject({ status: "not-required" });
    writeFileSync(join(h.cwd, opWavePlanPath(spec, 2, "t3")), JSON.stringify({ planDigest: digest("9") }));
    expect(await runOpWave({ ...h.base, wave: 2, phase: "apply", share: 1, gates, runs: h.noRuns })).toMatchObject({ exitCode: 0, applied: ["t1", "t2"] });
    expect(await runOpWave({ ...h.base, wave: 2, phase: "apply", share: 2, gates, runs: h.noRuns })).toMatchObject({ exitCode: CHANT_EXIT.moved, moved: ["t3"] });
    const recorded = await runOpWave({ ...h.base, wave: 2, phase: "record", runs: h.runs });
    expect(recorded).toMatchObject({ exitCode: CHANT_EXIT.moved, applied: ["t1", "t2"], moved: ["t3"] });
    expect(h.records.map((r) => r.wave?.share)).toEqual([1, 2]);
    // No applying job left a record for wave 1: the record job says so and fails.
    expect((await runOpWave({ ...h.base, wave: 1, phase: "record", runs: h.runs })).exitCode).toBe(CHANT_EXIT.failed);
    h.done();
  });

  test("a phase that cannot run is refused", async () => {
    const h = harness({});
    await expect(runOpWave({ ...h.base, wave: 2, phase: "plan", share: 1 })).rejects.toThrow("--share names an applying job; the plan job covers the whole wave");
    await expect(runOpWave({ ...h.base, wave: 1, phase: "gate" })).rejects.toThrow("found no saved plan");
    await expect(runOpWave({ ...h.base, wave: 1, phase: "sideways" as never })).rejects.toThrow("the phase is one of plan, gate, apply, record");
    h.done();
  });
});

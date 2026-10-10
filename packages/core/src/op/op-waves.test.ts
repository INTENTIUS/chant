import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opWaveJobs, opWaveShare, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { waveSetDigest } from "../gated-waves";

const spec: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "staging", runs: [{ target: "staging" }], gate: "on-destructive" },
    { name: "prod", runs: [{ target: "t3" }, { target: "t1" }, { target: "t2" }], shares: 2 },
  ],
};

describe("opWaveJobs", () => {
  test("one job per wave, a deciding job and share jobs for a wide one, each wave needing the last", () => {
    const jobs = opWaveJobs(spec, "waves.json");
    expect(jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["wave-1-dev", []],
      ["wave-2-staging", ["wave-1-dev"]],
      ["wave-3-prod-decide", ["wave-2-staging"]],
      ["wave-3-prod-share-1", ["wave-3-prod-decide"]],
      ["wave-3-prod-share-2", ["wave-3-prod-decide"]],
    ]);
    expect(jobs[2]!.command.join(" ")).toBe("chant run wave --spec waves.json --wave 3 --decide");
    expect(jobs[4]!.command.join(" ")).toBe("chant run wave --spec waves.json --wave 3 --share 2");
  });

  test("shares slice the runs by target", () => {
    const runs = spec.waves[2]!.runs;
    expect(opWaveShare(runs, 1, 2).map((r) => r.target)).toEqual(["t1", "t2"]);
    expect(opWaveShare(runs, 2, 2).map((r) => r.target)).toEqual(["t3"]);
  });
});

describe("runOpWave", () => {
  function harness(plans: Record<string, { planDigest: string; destructive?: boolean }>, policyAtBase: string | null) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-"));
    const calls: string[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      calls.push(argv.join(" "));
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify(plans[argv[2]!]));
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: policyAtBase });
    return { cwd, calls, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const digest = (n: string) => `sha256:${n.repeat(64)}`;

  test("the policy comes from the base commit: a change that sets staging to never still waits", async () => {
    const h = harness({ staging: { planDigest: digest("a"), destructive: true } }, JSON.stringify(spec));
    const loosened = { ...spec, waves: spec.waves.map((w) => ({ ...w, gate: "never" as const })) };
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec: loosened, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(result.exitCode).toBe(3);
    expect(result.decision).toMatchObject({ policy: "on-destructive", policySource: "base", status: "waiting", gate: "migrations-wave-2" });
    expect(gates.appended[0]!.planDigest).toBe(waveSetDigest([{ member: "staging", planDigest: digest("a") }]));
    expect(h.calls.some((c) => c.startsWith("tool apply"))).toBe(false);
    h.done();
  });

  test("an approval of the set digest lets the wave apply; a non-destructive plan needs none", async () => {
    const h = harness({ staging: { planDigest: digest("a"), destructive: true } }, JSON.stringify(spec));
    const set = waveSetDigest([{ member: "staging", planDigest: digest("a") }]);
    const gates = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "migrations", gate: "migrations-wave-2", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set }],
    });
    const approved = await runOpWave({ spec, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(approved).toMatchObject({ exitCode: 0, applied: ["staging"], decision: { status: "approved", approvedBy: "alice" } });
    h.done();

    const quiet = harness({ staging: { planDigest: digest("c") } }, JSON.stringify(spec));
    const free = await runOpWave({ spec, specFile: "waves.json", wave: 2, cwd: quiet.cwd, exec: quiet.exec, show: quiet.show, gates: memoryGateLedgerPort() });
    expect(free).toMatchObject({ exitCode: 0, applied: ["staging"], decision: { status: "not-required" } });
    quiet.done();
  });

  test("a share refuses a run whose plan moved since the decision", async () => {
    const plans: Record<string, { planDigest: string }> = { t1: { planDigest: digest("1") }, t2: { planDigest: digest("2") }, t3: { planDigest: digest("3") } };
    const h = harness(plans, JSON.stringify({ ...spec, waves: spec.waves.map((w) => ({ ...w, gate: "never" })) }));
    const decided = await runOpWave({ spec, specFile: "waves.json", wave: 3, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(decided).toMatchObject({ exitCode: 0, applied: [], decision: { status: "not-required" } });
    plans.t2 = { planDigest: digest("9") };
    const share = await runOpWave({ spec, specFile: "waves.json", wave: 3, share: 1, cwd: h.cwd, exec: h.exec, show: h.show });
    expect(share).toMatchObject({ exitCode: 4, applied: ["t1"], moved: ["t2"] });
    h.done();
  });
});

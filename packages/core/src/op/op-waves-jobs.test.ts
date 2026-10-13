/**
 * A runner per wave and job groups per wave (#3914): the spec checks, the
 * jobs a wave with `jobs` becomes, and `chant run wave --group` applying one
 * group's runs under the deciding job's one decision.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, opWaveGroupRuns, opWaveJobs, opWaveRunMatches, type OpWave, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveRunsFile, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { opWaveNotifyFields } from "./op-waves-notify";
import { parseArgs } from "../cli/parse-args";
import { waveSetDigest } from "../gated-waves";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

const grouped: OpWave = {
  name: "apply",
  runs: [{ target: "live/dev/a" }, { target: "live/prod/a" }, { target: "live/prod/b" }, { target: "live/prod/c" }],
  jobs: [
    { name: "dev", runs: ["live/dev/*"], runner: ["self-hosted", "dev"], environment: { name: "dev" }, idTokens: { TG_TOKEN: "dev.example" } },
    { name: "prod", runs: ["live/prod/**"], shares: 2, runner: "prod", idTokens: { TG_TOKEN: "prod.example" } },
  ],
};

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  runner: "plan",
  waves: [{ name: "first", runs: [{ target: "live/dev/z" }], gate: "never" }, { ...grouped, gate: "always" }, { name: "last", runs: [{ target: "live/x" }], gate: "never" }],
};

describe("the spec (#3914)", () => {
  test("runner and jobs are checked, and name the wave and the field", () => {
    expect(() => assertOpWavesSpec(spec)).not.toThrow();
    const wave = (w: Partial<OpWave>): OpWavesSpec => ({ ...spec, waves: [{ ...grouped, ...w }] });
    const group = (g: Record<string, unknown>): OpWavesSpec => wave({ jobs: [{ ...grouped.jobs![0]!, ...g }, grouped.jobs![1]!] as OpWave["jobs"] });
    expect(() => assertOpWavesSpec(wave({ jobs: [{ name: "all", runs: ["live/**"] }, { name: "prod", runs: ["live/prod/*"] }] }))).toThrow(/wave "apply" jobs: run "live\/prod\/a" is in job groups "all" and "prod"/);
    expect(() => assertOpWavesSpec(wave({ jobs: [{ name: "prod", runs: ["live/prod/*"] }] }))).toThrow(/wave "apply" jobs: run "live\/dev\/a" is in no job group/);
    expect(() => assertOpWavesSpec(wave({ jobs: [] }))).toThrow(/wave "apply" jobs must be a non-empty list/);
    expect(() => assertOpWavesSpec(wave({ shares: 2 }))).toThrow(/wave "apply" has jobs and shares/);
    expect(() => assertOpWavesSpec(group({ name: "decide" }))).toThrow(/jobs\[0\] \(decide\) is named like the wave's own jobs/);
    expect(() => assertOpWavesSpec(group({ name: "prod" }))).toThrow(/names job group "prod" twice/);
    expect(() => assertOpWavesSpec(group({ runs: [] }))).toThrow(/jobs\[0\] \(dev\) runs must be a non-empty list/);
    expect(() => assertOpWavesSpec(group({ shares: 0 }))).toThrow(/jobs\[0\] \(dev\) has shares 0/);
    expect(() => assertOpWavesSpec(group({ env: {} }))).toThrow(/jobs\[0\] \(dev\)\.env is not a setting/);
    expect(() => assertOpWavesSpec(group({ idTokens: { "1X": "aud" } }))).toThrow(/jobs\[0\] \(dev\) idTokens names "1X"/);
    expect(() => assertOpWavesSpec(group({ idTokens: { X: "" } }))).toThrow(/idTokens\.X must be an audience/);
    expect(() => assertOpWavesSpec(group({ runner: [] }))).toThrow(/jobs\[0\] \(dev\) runner must be a runner label/);
    expect(() => assertOpWavesSpec(group({ runner: { group: "apply", label: "x" } }))).toThrow(/runner\.label is not a setting/);
    expect(() => assertOpWavesSpec(group({ runner: { group: "apply", labels: ["linux"] } }))).not.toThrow();
    expect(() => assertOpWavesSpec({ ...spec, runner: "" })).toThrow(/Op waves "tf-apply": runner must be a runner label/);
    expect(() => assertOpWavesSpec(wave({ runner: 3 as unknown as string }))).toThrow(/wave "apply" runner must be/);
    expect(() => assertOpWavesSpec(wave({ idTokens: {} }))).toThrow(/wave "apply" idTokens must be/);
    const discovering: OpWavesSpec = { ...spec, plan: undefined, planWave: ["tg", "{runs}", "{plans}"], waves: [{ ...grouped, runs: [], discover: true, rest: true }] };
    expect(() => assertOpWavesSpec(discovering)).toThrow(/wave "apply" has jobs and rest/);
    expect(() => assertOpWavesSpec({ ...discovering, waves: [{ ...grouped, runs: [], discover: true }] })).not.toThrow();
  });

  test("a group's runs are targets or patterns: * within a segment, ** across", () => {
    expect(opWaveRunMatches("live/prod/a", "live/prod/a")).toBe(true);
    expect(opWaveRunMatches("live/*/a", "live/prod/a")).toBe(true);
    expect(opWaveRunMatches("live/*", "live/prod/a")).toBe(false);
    expect(opWaveRunMatches("live/**", "live/prod/a")).toBe(true);
    expect(opWaveRunMatches("live.prod", "live-prod")).toBe(false);
    expect(opWaveGroupRuns(grouped.jobs![1]!, grouped.runs).map((r) => r.target)).toEqual(["live/prod/a", "live/prod/b", "live/prod/c"]);
  });

  test("a wave with jobs is a deciding job and a job per group, or per share of a group; the next wave needs them all", () => {
    const jobs = opWaveJobs(spec, "waves.json");
    expect(jobs.map((j) => [j.jobName, j.kind, j.group, j.share, j.needs])).toEqual([
      ["wave-1-first", "wave", undefined, undefined, []],
      ["wave-2-apply-decide", "decide", undefined, undefined, ["wave-1-first"]],
      ["wave-2-apply-dev", "share", "dev", undefined, ["wave-2-apply-decide"]],
      ["wave-2-apply-prod-share-1", "share", "prod", 1, ["wave-2-apply-decide"]],
      ["wave-2-apply-prod-share-2", "share", "prod", 2, ["wave-2-apply-decide"]],
      ["wave-3-last", "wave", undefined, undefined, ["wave-2-apply-dev", "wave-2-apply-prod-share-1", "wave-2-apply-prod-share-2"]],
    ]);
    expect(jobs[2]!.command.join(" ")).toBe("chant run wave --spec waves.json --wave 2 --group dev");
    expect(jobs[4]!.command.join(" ")).toBe("chant run wave --spec waves.json --wave 2 --group prod --share 2");
    expect(jobs[2]!.record).toBe(".chant/op-waves/tf-apply/wave-2.json");
  });
});

describe("chant run wave --group (#3914)", () => {
  function harness(plans: Record<string, { planDigest: string; destructive?: boolean }>, atBase: OpWavesSpec = spec) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-3914-"));
    const calls: string[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      calls.push(argv.join(" "));
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify(plans[argv[2]!]));
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(atBase) });
    return { cwd, calls, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const plans = () => ({
    "live/dev/a": { planDigest: digest("1") },
    "live/prod/a": { planDigest: digest("2") },
    "live/prod/b": { planDigest: digest("3") },
    "live/prod/c": { planDigest: digest("4") },
  });
  const setDigest = (p: Record<string, { planDigest: string }>) => waveSetDigest(Object.entries(p).map(([member, { planDigest }]) => ({ member, planDigest })));

  test("one approval of the wave's digest lets every group's job apply its own runs, and nothing else", async () => {
    const p = plans();
    const h = harness(p);
    const gates = memoryGateLedgerPort();
    const opts = { spec, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, log: () => {} };
    expect(await runOpWave({ ...opts, decide: true })).toMatchObject({ exitCode: 3, applied: [], decision: { status: "waiting", gate: "tf-apply-wave-2" } });
    // Before the approval, every group's job waits and applies nothing.
    expect(await runOpWave({ ...opts, group: "dev" })).toMatchObject({ exitCode: 3, applied: [] });
    expect(await runOpWave({ ...opts, group: "prod", share: 1 })).toMatchObject({ exitCode: 3, applied: [] });
    expect(h.calls.some((c) => c.startsWith("tool apply"))).toBe(false);

    const approved = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "tf-apply", gate: "tf-apply-wave-2", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: setDigest(p) }],
    });
    expect(await runOpWave({ ...opts, gates: approved, decide: true })).toMatchObject({ exitCode: 0, applied: [], decision: { status: "approved", approvedBy: "alice" } });
    expect(await runOpWave({ ...opts, group: "dev" })).toMatchObject({ exitCode: 0, applied: ["live/dev/a"] });
    expect(await runOpWave({ ...opts, group: "prod", share: 1 })).toMatchObject({ exitCode: 0, applied: ["live/prod/a", "live/prod/b"] });
    expect(await runOpWave({ ...opts, group: "prod", share: 2 })).toMatchObject({ exitCode: 0, applied: ["live/prod/c"] });
    h.done();
  });

  test("a group's job refuses a run whose plan moved since the decision (exit 4), as a share does", async () => {
    const p = plans();
    const never: OpWavesSpec = { ...spec, waves: spec.waves.map((w) => ({ ...w, gate: "never" as const })) };
    const h = harness(p, never);
    const opts = { spec: never, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} };
    expect(await runOpWave({ ...opts, decide: true })).toMatchObject({ exitCode: 0, decision: { status: "not-required" } });
    p["live/prod/b"] = { planDigest: digest("9") };
    expect(await runOpWave({ ...opts, group: "prod", share: 1 })).toMatchObject({ exitCode: 4, applied: ["live/prod/a"], moved: ["live/prod/b"] });
    h.done();
  });

  test("a group's job needs its deciding job, a group the wave has, and --group with --share on a grouped wave", async () => {
    const h = harness(plans());
    const opts = { spec, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} };
    await expect(runOpWave({ ...opts, group: "dev" })).rejects.toThrow(/job group "dev" of wave 2 \(apply\) found no decision/);
    await expect(runOpWave({ ...opts, group: "eu" })).rejects.toThrow(/has the job groups dev, prod; there is no group "eu"/);
    await expect(runOpWave({ ...opts, share: 1 })).rejects.toThrow(/is split into job groups; name the group a share belongs to with --group/);
    await expect(runOpWave({ ...opts, group: "dev", share: 2 })).rejects.toThrow(/job group "dev" of wave 2 \(apply\) has 1 share; there is no share 2/);
    h.done();
  });

  describe("a discovering wave", () => {
    const tg: OpWavesSpec = {
      name: "tf-apply",
      op: "tf-apply",
      planWave: ["tg", "plan", "{runs}", "{plans}"],
      applyWave: ["tg", "apply", "{runs}"],
      waves: [{ name: "layer", runs: [], discover: true, gate: "never", jobs: [{ name: "dev", runs: ["dev/**"] }, { name: "prod", runs: ["prod/**"] }] }],
    };
    function discover(found: Record<string, { planDigest: string }>) {
      const cwd = mkdtempSync(join(tmpdir(), "op-waves-3914d-"));
      const applied: string[][] = [];
      const exec: OpWaveExec = (argv, dir) => {
        const runs = JSON.parse(readFileSync(join(dir, argv[2]!), "utf-8")) as OpWaveRunsFile;
        if (argv[1] === "plan") {
          const entries = runs.discover ? Object.entries(found).map(([target, p]) => ({ target, ...p })) : runs.runs.map((r) => ({ target: r.target, ...found[r.target] }));
          writeFileSync(join(dir, argv[3]!), JSON.stringify({ runs: entries }));
        }
        if (argv[1] === "apply") applied.push(runs.runs.map((r) => r.target));
        return 0;
      };
      const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(tg) });
      const opts = { spec: tg, specFile: "waves.json", wave: 1, cwd, exec, show, gates: memoryGateLedgerPort(), log: () => {} };
      return { opts, applied, done: () => rmSync(cwd, { recursive: true, force: true }) };
    }

    test("each group's job applies the runs found that it holds; a group that holds none applies nothing", async () => {
      const d = discover({ "dev/a": { planDigest: digest("1") }, "dev/b": { planDigest: digest("2") } });
      expect(await runOpWave({ ...d.opts, decide: true })).toMatchObject({ exitCode: 0, applied: [] });
      expect(await runOpWave({ ...d.opts, group: "dev" })).toMatchObject({ exitCode: 0, applied: ["dev/a", "dev/b"] });
      expect(await runOpWave({ ...d.opts, group: "prod" })).toMatchObject({ exitCode: 0, applied: [] });
      expect(d.applied).toEqual([["dev/a", "dev/b"]]);
      d.done();
    });

    test("a run found in no group fails the deciding job, which names it, before the gate", async () => {
      const d = discover({ "dev/a": { planDigest: digest("1") }, "stage/a": { planDigest: digest("2") } });
      const lines: string[] = [];
      const result = await runOpWave({ ...d.opts, decide: true, log: (l) => lines.push(l) });
      expect(result.exitCode).toBe(1);
      expect(lines.join("\n")).toMatch(/wave "layer" jobs: run "stage\/a" is in no job group/);
      d.done();
    });
  });
});

describe("a job group's notify (#3914)", () => {
  const notifying: OpWavesSpec = { ...spec, notify: { webhook: "CHANT_WEBHOOK", key: "CHANT_WEBHOOK_KEY" } };
  const decision = { wave: 2, name: "apply", op: "tf-apply", gate: "tf-apply-wave-2", digest: digest("a"), members: [] } as never;
  test("a group's wait was announced by its deciding job; a moved run names the group", () => {
    const waiting = { exitCode: 3, applied: [], failed: [], moved: [], hooks: [], decision };
    expect(opWaveNotifyFields(notifying, 2, { result: waiting }, { group: "prod", share: 1 })).toBeUndefined();
    expect(opWaveNotifyFields(notifying, 2, { result: waiting })).toMatchObject({ event: "waiting" });
    const moved = { exitCode: 4, applied: [], failed: [], moved: ["live/prod/b"], hooks: [], decision };
    expect(opWaveNotifyFields(notifying, 2, { result: moved }, { group: "prod", share: 1 })!.summary).toBe("wave 2 (apply) of tf-apply, share 1 of job group prod, refused 1 run whose plan moved since the wave was decided");
    expect(opWaveNotifyFields(notifying, 2, { result: moved }, { group: "dev" })!.summary).toBe("wave 2 (apply) of tf-apply, job group dev, refused 1 run whose plan moved since the wave was decided");
    expect(opWaveNotifyFields(notifying, 2, { result: moved }, { share: 2 })!.summary).toBe("wave 2 (apply) of tf-apply, share 2, refused 1 run whose plan moved since the wave was decided");
  });
});

test("chant run wave parses --group <name> (#3914)", () => {
  expect(parseArgs(["run", "wave", "--spec", "w.json", "--wave", "2", "--group", "prod", "--share", "1"])).toMatchObject({ wave: 2, group: "prod", share: 1 });
  expect(() => parseArgs(["run", "wave", "--group"])).toThrow(/--group needs a job group's name/);
});

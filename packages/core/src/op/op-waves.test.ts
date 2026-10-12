import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, opWaveJobs, opWaveShare, type OpWavesSpec } from "./op-waves";
import {
  opWaveHooksAtBase,
  readOpWaveHooksFile,
  recordOpWaveHeadPlans,
  runOpWave,
  runOpWaveApplyHooks,
  type OpWaveDecision,
  type OpWaveExec,
  type OpWaveHooksFile,
  type OpWaveRunsFile,
  type OpWaveShowAtBase,
} from "./op-waves-run";
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

describe("wave-level commands and hooks in the spec (#3762)", () => {
  const base = { name: "w", op: "migrate", waves: [{ name: "dev", runs: [{ target: "a" }] }] };
  test("a spec without them is unchanged, and the new fields are checked", () => {
    expect(() => assertOpWavesSpec({ ...base, plan: ["p", "{plan}"] })).not.toThrow();
    expect(() => assertOpWavesSpec({ ...base, planWave: ["p", "{runs}", "{plans}"], applyWave: ["a", "{runs}"] })).not.toThrow();
    expect(() => assertOpWavesSpec({ ...base, plan: ["p", "{plan}"], planWave: ["p", "{plans}"] })).toThrow(/both `plan` and `planWave`/);
    expect(() => assertOpWavesSpec({ ...base, planWave: ["p", "{runs}"] })).toThrow(/never names \{plans\}/);
    expect(() => assertOpWavesSpec({ ...base, planWave: ["p", "{plans}"], apply: ["a"], applyWave: ["a", "{runs}"] })).toThrow(/both `apply` and `applyWave`/);
    expect(() => assertOpWavesSpec(base as OpWavesSpec)).toThrow(/give `plan` or `planWave`/);
    const hooked = (hooks: unknown): OpWavesSpec => ({ ...base, plan: ["p", "{plan}"], hooks: hooks as OpWavesSpec["hooks"] });
    expect(() => assertOpWavesSpec(hooked({ before: { plan: [{ command: ["check", "{runs}"], onFailure: "approve" }] }, after: { apply: [{ command: ["smoke", "{target}"], perRun: true }] } }))).not.toThrow();
    expect(() => assertOpWavesSpec(hooked({ after: { apply: [{ command: ["smoke"], onFailure: "approve" }] } }))).toThrow(/nothing left to hold/);
    expect(() => assertOpWavesSpec(hooked({ before: { init: [{ command: ["x"] }] } }))).toThrow(/hooks.before.init is not a stage/);
    expect(() => assertOpWavesSpec(hooked({ during: {} }))).toThrow(/hooks.during is not a moment/);
    expect(() => assertOpWavesSpec(hooked({ after: { plan: [{ command: ["x", "{plan}"] }] } }))).toThrow(/runs once for the wave/);
    expect(() => assertOpWavesSpec(hooked({ before: { plan: [{ command: ["x", "{plan}"], perRun: true }] } }))).toThrow(/no \{plan\} yet/);
    expect(() => assertOpWavesSpec(hooked({ before: { plan: [{ command: ["x"], onFailure: "warn" }] } }))).toThrow(/onFailure "warn"/);
    expect(() => assertOpWavesSpec({ ...base, plan: ["p", "{plan}"], waves: [{ name: "dev", runs: [{ target: "a" }], hooks: { before: { apply: [{ command: [] }] } } }] })).toThrow(/wave "dev".*argv/);
  });
});

describe("runOpWave with wave-level commands (#3762)", () => {
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const waveSpec: OpWavesSpec = {
    name: "roots",
    op: "tf",
    planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
    applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
    waves: [
      { name: "net", runs: [{ target: "vpc" }, { target: "dns" }], gate: "on-destructive" },
      { name: "apps", runs: [{ target: "a1" }, { target: "a2" }, { target: "a3" }], gate: "never", shares: 2 },
    ],
  };
  function harness(plans: Record<string, { planDigest: string; destructive?: boolean; empty?: boolean }>, atBase: OpWavesSpec | null = waveSpec) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-wave-"));
    const calls: string[] = [];
    const applied: OpWaveRunsFile[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      calls.push(argv.join(" "));
      const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ runs: runs.runs.map((r) => ({ target: r.target, ...plans[r.target] })) }));
      if (argv[1] === "apply") applied.push(runs);
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: atBase === null ? null : JSON.stringify(atBase) });
    return { cwd, calls, applied, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  test("one call plans the wave; the digest and the gate are those of per-run plans; the apply gets the approved set", async () => {
    const plans = { vpc: { planDigest: digest("1"), destructive: true }, dns: { planDigest: digest("2") } };
    const h = harness(plans);
    const set = waveSetDigest([{ member: "vpc", planDigest: digest("1") }, { member: "dns", planDigest: digest("2") }]);
    const waiting = await runOpWave({ spec: waveSpec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(waiting).toMatchObject({ exitCode: 3, decision: { digest: set, status: "waiting", policy: "on-destructive" } });
    expect(h.calls).toEqual([`tg plan net .chant/op-waves/roots/wave-1/runs.json .chant/op-waves/roots/wave-1/plans.json`]);
    // Each run's plan file is written too, so a per-run apply or hook reads {plan} either way.
    expect(JSON.parse(readFileSync(join(h.cwd, ".chant/op-waves/roots/wave-1/vpc.plan.json"), "utf-8"))).toEqual({ planDigest: digest("1"), destructive: true });

    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "roots", gate: "roots-wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set }] });
    const approved = await runOpWave({ spec: waveSpec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(approved).toMatchObject({ exitCode: 0, applied: ["vpc", "dns"], decision: { status: "approved", approvedBy: "alice" } });
    expect(h.applied).toEqual([
      {
        wave: "net",
        number: 1,
        digest: set,
        runs: [
          { target: "vpc", op: "tf", planDigest: digest("1"), destructive: true },
          { target: "dns", op: "tf", planDigest: digest("2") },
        ],
      },
    ]);
    h.done();
  });

  test("a plans file that misses a run, or plans one it was not asked to, is refused", async () => {
    const h = harness({ vpc: { planDigest: digest("1") } });
    await expect(runOpWave({ spec: waveSpec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() })).rejects.toThrow(/no planDigest for dns|no plan for dns/);
    h.done();
    const extra = harness({});
    const exec: OpWaveExec = (argv, dir) => (writeFileSync(join(dir, argv[4]!), JSON.stringify([{ target: "vpc", planDigest: digest("1") }, { target: "dns", planDigest: digest("2") }, { target: "zzz", planDigest: digest("3") }])), 0);
    await expect(runOpWave({ spec: waveSpec, specFile: "waves.json", wave: 1, cwd: extra.cwd, exec, show: extra.show, gates: memoryGateLedgerPort() })).rejects.toThrow(/"zzz", which is not a run/);
    extra.done();
  });

  test("shares keep working: each share plans its slice in one call and applies only the runs whose plan did not move", async () => {
    const plans: Record<string, { planDigest: string }> = { a1: { planDigest: digest("1") }, a2: { planDigest: digest("2") }, a3: { planDigest: digest("3") } };
    const h = harness(plans);
    const decided = await runOpWave({ spec: waveSpec, specFile: "waves.json", wave: 2, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(decided).toMatchObject({ exitCode: 0, applied: [], decision: { status: "not-required" } });
    plans.a2 = { planDigest: digest("9") };
    const share = await runOpWave({ spec: waveSpec, specFile: "waves.json", wave: 2, share: 1, cwd: h.cwd, exec: h.exec, show: h.show });
    expect(share).toMatchObject({ exitCode: 4, applied: ["a1"], moved: ["a2"] });
    expect(h.applied.at(-1)!.runs.map((r) => r.target)).toEqual(["a1"]);
    h.done();
  });

  test("--record-plans plans each wave with one call", async () => {
    const h = harness({ vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2") }, a1: { planDigest: digest("1") }, a2: { planDigest: digest("2") }, a3: { planDigest: digest("3") } });
    const plans = await recordOpWaveHeadPlans({ spec: waveSpec, cwd: h.cwd, exec: h.exec, head: "c".repeat(40), now: "t", write: async () => {} });
    expect(plans.waves[0]!.digest).toBe(waveSetDigest([{ member: "vpc", planDigest: digest("1") }, { member: "dns", planDigest: digest("2") }]));
    expect(h.calls.filter((c) => c.startsWith("tg plan"))).toHaveLength(2);
    h.done();
  });
});

describe("runOpWave hooks (#3762)", () => {
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const hooked: OpWavesSpec = {
    name: "migrations",
    op: "migrate",
    plan: ["tool", "plan", "{target}", "{plan}"],
    apply: ["tool", "apply", "{target}", "{plan}"],
    hooks: { before: { plan: [{ name: "lint", command: ["hook", "lint", "{runs}"] }] } },
    waves: [
      {
        name: "prod",
        runs: [{ target: "t1" }, { target: "t2" }],
        gate: "never",
        hooks: {
          after: { plan: [{ name: "check", command: ["hook", "check", "{target}", "{plan}"], perRun: true, onFailure: "approve" }], apply: [{ name: "smoke", command: ["hook", "smoke", "{wave}"] }] },
          before: { apply: [{ name: "backup", command: ["hook", "backup", "{runs}"] }] },
        },
      },
    ],
  };
  function harness(atBase: OpWavesSpec | null, fails: string[] = []) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-hooks-"));
    const calls: Array<{ argv: string; env?: Record<string, string> }> = [];
    const exec: OpWaveExec = (argv, dir, env) => {
      calls.push({ argv: argv.join(" "), ...(env ? { env } : {}) });
      if (argv[1] === "plan") writeFileSync(join(dir, argv[3]!), JSON.stringify({ planDigest: digest(argv[2] === "t1" ? "1" : "2") }));
      return fails.some((f) => argv.join(" ").startsWith(f)) ? 1 : 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: atBase === null ? null : JSON.stringify(atBase) });
    return { cwd, calls, exec, show, argv: () => calls.map((c) => c.argv), done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const set = waveSetDigest([{ member: "t1", planDigest: digest("1") }, { member: "t2", planDigest: digest("2") }]);

  test("hooks run around the plan and the apply, per run with {target}, {plan} and the CHANT_ variables", async () => {
    const h = harness(hooked);
    const result = await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(result).toMatchObject({ exitCode: 0, applied: ["t1", "t2"], decision: { status: "not-required" } });
    expect(h.argv()).toEqual([
      "hook lint .chant/op-waves/migrations/wave-1/runs.json",
      "tool plan t1 .chant/op-waves/migrations/wave-1/t1.plan.json",
      "tool plan t2 .chant/op-waves/migrations/wave-1/t2.plan.json",
      "hook check t1 .chant/op-waves/migrations/wave-1/t1.plan.json",
      "hook check t2 .chant/op-waves/migrations/wave-1/t2.plan.json",
      "hook backup .chant/op-waves/migrations/wave-1/runs.json",
      "tool apply t1 .chant/op-waves/migrations/wave-1/t1.plan.json",
      "tool apply t2 .chant/op-waves/migrations/wave-1/t2.plan.json",
      "hook smoke prod",
    ]);
    expect(h.calls[3]!.env).toMatchObject({ CHANT_OP_WAVES: "migrations", CHANT_WAVE: "prod", CHANT_WAVE_NUMBER: "1", CHANT_HOOK: "after-plan", CHANT_TARGET: "t1", CHANT_PLAN: ".chant/op-waves/migrations/wave-1/t1.plan.json" });
    expect(result.hooks.map((o) => `${o.moment} ${o.name}${o.target ? ` ${o.target}` : ""} ${o.outcome}`)).toEqual([
      "before-plan lint passed",
      "after-plan check t1 passed",
      "after-plan check t2 passed",
      "before-apply backup passed",
      "after-apply smoke passed",
    ]);
    h.done();
  });

  test("hooks are read at base: a change cannot add a hook its own apply runs, nor remove one", async () => {
    const added = harness({ ...hooked, hooks: undefined, waves: hooked.waves.map((w) => ({ ...w, hooks: undefined })) });
    const logs: string[] = [];
    await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: added.cwd, exec: added.exec, show: added.show, gates: memoryGateLedgerPort(), log: (l) => logs.push(l) });
    expect(added.argv().filter((c) => c.startsWith("hook"))).toEqual([]);
    expect(logs.some((l) => l.includes("this change's differ; the ones at base run"))).toBe(true);
    added.done();

    const removed = harness(hooked);
    const bare = { ...hooked, hooks: undefined, waves: hooked.waves.map((w) => ({ ...w, hooks: undefined })) };
    await runOpWave({ spec: bare, specFile: "waves.json", wave: 1, cwd: removed.cwd, exec: removed.exec, show: removed.show, gates: memoryGateLedgerPort() });
    expect(removed.argv().filter((c) => c.startsWith("hook"))).toHaveLength(5);
    removed.done();

    const absent = harness(null);
    await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: absent.cwd, exec: absent.exec, show: absent.show, gates: memoryGateLedgerPort() });
    expect(absent.argv().filter((c) => c.startsWith("hook"))).toEqual([]);
    absent.done();
  });

  test("an approve hook that fails holds a `never` wave until its set digest is approved", async () => {
    const h = harness(hooked, ["hook check t2"]);
    const gates = memoryGateLedgerPort();
    const held = await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(held).toMatchObject({ exitCode: 3, applied: [], decision: { policy: "never", status: "waiting", digest: set, heldBy: ["after-plan hook check (t2)"] } });
    expect(gates.appended[0]!.planDigest).toBe(set);
    expect(h.argv().some((c) => c.startsWith("tool apply") || c.startsWith("hook backup"))).toBe(false);
    h.done();

    const again = harness(hooked, ["hook check t2"]);
    const approved = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "migrations", gate: "migrations-wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set }] });
    const applied = await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: again.cwd, exec: again.exec, show: again.show, gates: approved });
    expect(applied).toMatchObject({ exitCode: 0, applied: ["t1", "t2"], decision: { status: "approved", approvedBy: "alice" } });
    again.done();
  });

  test("a failing hook fails the wave: before the plan nothing is planned, after the apply the wave exits 1", async () => {
    const early = harness(hooked, ["hook lint"]);
    const r1 = await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: early.cwd, exec: early.exec, show: early.show, gates: memoryGateLedgerPort() });
    expect(r1).toMatchObject({ exitCode: 1, applied: [] });
    expect(early.argv()).toEqual(["hook lint .chant/op-waves/migrations/wave-1/runs.json"]);
    early.done();

    const late = harness(hooked, ["hook smoke"]);
    const r2 = await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: late.cwd, exec: late.exec, show: late.show, gates: memoryGateLedgerPort() });
    expect(r2).toMatchObject({ exitCode: 1, applied: ["t1", "t2"] });
    late.done();
  });

  test("an approve hook before the apply holds a wave the policy let through", async () => {
    const spec: OpWavesSpec = { ...hooked, hooks: undefined, waves: [{ ...hooked.waves[0]!, hooks: { before: { apply: [{ name: "drain", command: ["hook", "drain"], onFailure: "approve" }] } } }] };
    const h = harness(spec, ["hook drain"]);
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(result).toMatchObject({ exitCode: 3, applied: [], decision: { status: "waiting", heldBy: ["before-apply hook drain"] } });
    expect(gates.appended[0]!.planDigest).toBe(set);
    h.done();
  });

  test("hooks at base that no runner can run hold the wave and none run", async () => {
    const broken = { ...hooked, hooks: { before: { plan: [{ command: "lint" }] } } } as unknown as OpWavesSpec;
    const h = harness(broken);
    const result = await runOpWave({ spec: hooked, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(result.exitCode).toBe(3);
    expect(result.decision!.heldBy![0]).toMatch(/the hooks at base cannot be run/);
    expect(h.argv().filter((c) => c.startsWith("hook"))).toEqual([]);
    h.done();
  });

  test("a wide wave's shares run the hooks their deciding job read at base", async () => {
    const wide: OpWavesSpec = { ...hooked, waves: [{ ...hooked.waves[0]!, shares: 2 }] };
    const h = harness(wide);
    await runOpWave({ spec: { ...wide, hooks: undefined }, specFile: "waves.json", wave: 1, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    const before = h.calls.length;
    const share = await runOpWave({ spec: { ...wide, hooks: undefined }, specFile: "waves.json", wave: 1, share: 2, cwd: h.cwd, exec: h.exec, show: h.show });
    expect(share).toMatchObject({ exitCode: 0, applied: ["t2"] });
    expect(h.argv().slice(before)).toEqual([
      "hook lint .chant/op-waves/migrations/wave-1/runs.json",
      "tool plan t2 .chant/op-waves/migrations/wave-1/t2.plan.json",
      "hook check t2 .chant/op-waves/migrations/wave-1/t2.plan.json",
      "hook backup .chant/op-waves/migrations/wave-1/runs.json",
      "tool apply t2 .chant/op-waves/migrations/wave-1/t2.plan.json",
      "hook smoke prod",
    ]);
    h.done();
  });

  test("a hold in a share job waits unless the wave was approved", async () => {
    const wide: OpWavesSpec = { ...hooked, waves: [{ ...hooked.waves[0]!, shares: 2 }] };
    const h = harness(wide);
    await runOpWave({ spec: wide, specFile: "waves.json", wave: 1, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    const failing: OpWaveExec = (argv, dir, env) => (h.exec(argv, dir, env), argv.join(" ").startsWith("hook check") ? 1 : 0);
    const gates = memoryGateLedgerPort();
    const share = await runOpWave({ spec: wide, specFile: "waves.json", wave: 1, share: 1, cwd: h.cwd, exec: failing, show: h.show, gates });
    expect(share).toMatchObject({ exitCode: 3, applied: [] });
    expect(gates.appended[0]!.planDigest).toBe(set);
    h.done();
  });
});

describe("spent approvals (#3784)", () => {
  const spending: OpWavesSpec = { ...spec, approvals: { spend: true } };
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const set = waveSetDigest([{ member: "staging", planDigest: digest("a") }]);
  const approval = { version: 1 as const, op: "migrations", gate: "migrations-wave-2", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set };
  function harness(atBase: OpWavesSpec | null) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-spend-"));
    const calls: string[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      calls.push(argv.join(" "));
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest(argv[2] === "staging" ? "a" : "b"), destructive: true }));
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: atBase === null ? null : JSON.stringify(atBase) });
    return { cwd, calls, exec, show, applies: () => calls.filter((c) => c.startsWith("tool apply")).length, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  test("the spec checks approvals", () => {
    expect(() => assertOpWavesSpec({ ...spec, approvals: { spend: "yes" } } as unknown as OpWavesSpec)).toThrow(/approvals.spend must be true or false/);
    expect(() => assertOpWavesSpec({ ...spec, approvals: { burn: true } } as unknown as OpWavesSpec)).toThrow(/approvals.burn is not a setting/);
    expect(() => assertOpWavesSpec(spending)).not.toThrow();
  });

  test("with spend at base, an approval passes the same wave once: the second run waits for a new approval", async () => {
    const h = harness(spending);
    const gates = memoryGateLedgerPort({ resolutions: [approval] });
    const now = "2026-10-11T00:00:00Z";
    const first = await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, now });
    expect(first).toMatchObject({ exitCode: 0, applied: ["staging"], decision: { status: "approved", approvedBy: "alice", approvedAt: approval.timestamp, spend: "base", spentAt: now } });
    expect(gates.applied).toEqual([
      { version: 1, kind: "applied", op: "migrations", gate: "migrations-wave-2", planDigest: set, approvedAt: approval.timestamp, approvedBy: "alice", timestamp: now, wave: { number: 2, name: "staging" } },
    ]);

    const logs: string[] = [];
    const second = await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T01:00:00Z", log: (l) => logs.push(l) });
    expect(second).toMatchObject({ exitCode: 3, applied: [], decision: { status: "waiting" } });
    expect(h.applies()).toBe(1);
    expect(logs.some((l) => /the approval of .* by alice at 2026-10-10T00:00:00Z is spent/.test(l))).toBe(true);
    expect(gates.appended.at(-1)!.planDigest).toBe(set);

    // A new approval of the same digest passes it once more, and is spent in turn.
    await gates.appendResolution!({ op: "migrations", gate: "migrations-wave-2", resolvedBy: "bob", timestamp: "2026-10-11T02:00:00Z", planDigest: set });
    const third = await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T03:00:00Z" });
    expect(third).toMatchObject({ exitCode: 0, decision: { approvedBy: "bob" } });
    expect(gates.applied).toHaveLength(2);
    h.done();
  });

  test("without spend at base, the approval passes the digest every time, and only a change that adds spend records it", async () => {
    const off = harness(spec);
    const gates = memoryGateLedgerPort({ resolutions: [approval] });
    for (const now of ["2026-10-11T00:00:00Z", "2026-10-11T01:00:00Z"]) {
      expect(await runOpWave({ spec, specFile: "waves.json", wave: 2, cwd: off.cwd, exec: off.exec, show: off.show, gates, now })).toMatchObject({ exitCode: 0 });
    }
    expect(gates.applied).toEqual([]);
    off.done();

    // The change turns spend on: this apply is recorded, and the rule holds from the next decision at base.
    const adding = harness(spec);
    const added = await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: adding.cwd, exec: adding.exec, show: adding.show, gates, now: "2026-10-11T02:00:00Z" });
    expect(added).toMatchObject({ exitCode: 0, decision: { spend: "change" } });
    expect(gates.applied).toHaveLength(1);
    adding.done();
    const next = harness(spending);
    expect(await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: next.cwd, exec: next.exec, show: next.show, gates, now: "2026-10-11T03:00:00Z" })).toMatchObject({ exitCode: 3 });
    next.done();
  });

  test("a change cannot turn spend off for its own apply", async () => {
    const h = harness(spending);
    const gates = memoryGateLedgerPort({ resolutions: [approval] });
    await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T00:00:00Z" });
    const again = await runOpWave({ spec, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T01:00:00Z" });
    expect(again.exitCode).toBe(3);
    h.done();
  });

  test("a spent approval of another digest does not refuse; the wave waits for its own", async () => {
    const h = harness(spending);
    const other = { ...approval, planDigest: "sha256:" + "f".repeat(64) };
    const gates = memoryGateLedgerPort({
      resolutions: [other],
      applied: [{ version: 1, kind: "applied", op: "migrations", gate: "migrations-wave-2", planDigest: other.planDigest, approvedAt: other.timestamp, approvedBy: "alice", timestamp: "2026-10-10T01:00:00Z" }],
    });
    const result = await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T00:00:00Z" });
    expect(result).toMatchObject({ exitCode: 3, decision: { status: "waiting" } });
    h.done();
  });

  test("a wide wave's deciding job spends the approval once, before its shares apply", async () => {
    const wide: OpWavesSpec = { ...spending, waves: spending.waves.map((w) => (w.name === "prod" ? { ...w, gate: "always" as const } : w)) };
    const h = harness(wide);
    const prodSet = waveSetDigest(["t1", "t2", "t3"].map((t) => ({ member: t, planDigest: digest("b") })));
    const gates = memoryGateLedgerPort({ resolutions: [{ ...approval, gate: "migrations-wave-3", planDigest: prodSet }] });
    const decided = await runOpWave({ spec: wide, specFile: "waves.json", wave: 3, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T00:00:00Z" });
    expect(decided).toMatchObject({ exitCode: 0, decision: { status: "approved", spentAt: "2026-10-11T00:00:00Z" } });
    expect(gates.applied).toHaveLength(1);
    for (const share of [1, 2]) {
      expect(await runOpWave({ spec: wide, specFile: "waves.json", wave: 3, share, cwd: h.cwd, exec: h.exec, show: h.show, gates })).toMatchObject({ exitCode: 0 });
    }
    expect(gates.applied).toHaveLength(1);
    expect(h.applies()).toBe(3);
    h.done();
  });

  test("a wave that cannot record the approval applies nothing", async () => {
    const h = harness(spending);
    const gates = { ...memoryGateLedgerPort({ resolutions: [approval] }), appendApplied: undefined };
    const result = await runOpWave({ spec: spending, specFile: "waves.json", wave: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(result).toMatchObject({ exitCode: 1, applied: [] });
    expect(h.applies()).toBe(0);
    h.done();
  });
});

describe("apply-stage hooks run by the apply, under its lock (#3804)", () => {
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const spec: OpWavesSpec = {
    name: "migrations",
    op: "migrate",
    plan: ["tool", "plan", "{target}", "{plan}"],
    apply: ["tool", "apply", "{target}", "{plan}"],
    hooks: { apply: { runBy: "apply" }, before: { plan: [{ name: "lint", command: ["hook", "lint"] }] } },
    waves: [
      {
        name: "prod",
        runs: [{ target: "t1" }],
        gate: "never",
        hooks: {
          before: { apply: [{ name: "lag", command: ["hook", "lag", "{target}"], perRun: true, onFailure: "approve" }] },
          after: { apply: [{ name: "smoke", command: ["hook", "smoke", "{wave}"] }] },
        },
      },
    ],
  };

  /**
   * A job whose apply command is a product that takes its lock and runs the
   * hooks it was handed, as SQL Yodeler's apply would. `obey: false` is an
   * apply that ignores the hooks file.
   */
  function harness(atBase: OpWavesSpec | null, opts: { fails?: string[]; obey?: boolean } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-by-apply-"));
    const calls: string[] = [];
    const files: OpWaveHooksFile[] = [];
    const inner: OpWaveExec = (argv) => {
      calls.push(`  ${argv.join(" ")}`);
      return (opts.fails ?? []).some((f) => argv.join(" ").startsWith(f)) ? 1 : 0;
    };
    const exec: OpWaveExec = (argv, dir, env) => {
      calls.push(argv.join(" "));
      if (argv[1] === "plan") writeFileSync(join(dir, argv[3]!), JSON.stringify({ planDigest: digest("1") }));
      if (argv[1] === "apply") {
        const file = readOpWaveHooksFile(env?.CHANT_HOOKS, dir)!;
        files.push(file);
        if (opts.obey === false) return 0;
        calls.push("  lock");
        const before = runOpWaveApplyHooks(file, "before-apply", { cwd: dir, exec: inner, log: () => {} });
        if (!before.proceed) return before.held.length > 0 ? 3 : 4;
        calls.push("  migrate");
        const after = runOpWaveApplyHooks(file, "after-apply", { cwd: dir, exec: inner, log: () => {} });
        return after.proceed ? 0 : 1;
      }
      return (opts.fails ?? []).some((f) => argv.join(" ").startsWith(f)) ? 1 : 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: atBase === null ? null : JSON.stringify(atBase) });
    const record = () => JSON.parse(readFileSync(join(cwd, ".chant/op-waves/migrations/wave-1.json"), "utf-8")) as OpWaveDecision;
    return { cwd, calls, files, exec, show, record, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const set = waveSetDigest([{ member: "t1", planDigest: digest("1") }]);

  test("the spec checks hooks.apply.runBy and keeps the rest as it was", () => {
    const base = { name: "w", op: "o", plan: ["p", "{plan}"], waves: [{ name: "dev", runs: [{ target: "a" }] }] };
    expect(() => assertOpWavesSpec({ ...base, hooks: { apply: { runBy: "apply" } } })).not.toThrow();
    expect(() => assertOpWavesSpec({ ...base, hooks: { apply: { runBy: "later" } } } as unknown as OpWavesSpec)).toThrow(/hooks.apply.runBy is "later"/);
    expect(() => assertOpWavesSpec({ ...base, hooks: { apply: [{ command: ["x"] }] } } as unknown as OpWavesSpec)).toThrow(/hooks.apply must be/);
  });

  test("chant hands the apply-stage hooks to the apply, which runs them under its lock; the outcomes come back", async () => {
    const h = harness(spec);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(result).toMatchObject({ exitCode: 0, applied: ["t1"], decision: { applyHooksRunBy: "apply" } });
    expect(h.calls).toEqual([
      "hook lint",
      "tool plan t1 .chant/op-waves/migrations/wave-1/t1.plan.json",
      "tool apply t1 .chant/op-waves/migrations/wave-1/t1.plan.json",
      "  lock",
      "  hook lag t1",
      "  migrate",
      "  hook smoke prod",
    ]);
    // The apply sees the outcomes of the hooks chant ran before it, and the hooks it runs itself.
    expect(h.files[0]).toMatchObject({ runBy: "apply", approved: false, digest: set, outcomes: [{ moment: "before-plan", name: "lint", outcome: "passed" }] });
    expect(Object.keys(h.files[0]!.hooks)).toEqual(["before-apply", "after-apply"]);
    expect(result.hooks.map((o) => `${o.moment} ${o.name} ${o.outcome}`)).toEqual(["before-plan lint passed", "before-apply lag passed", "after-apply smoke passed"]);
    expect(h.record().outcomes).toHaveLength(3);
    h.done();
  });

  test("a hold inside the apply applies nothing and waits; with an approval of the digest the apply is called again and goes on", async () => {
    const h = harness(spec, { fails: ["hook lag"] });
    const waiting = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(waiting).toMatchObject({ exitCode: 3, applied: [], decision: { status: "waiting", heldBy: ["before-apply hook lag (t1)"] } });
    expect(h.calls).not.toContain("  migrate");
    h.done();

    const again = harness(spec, { fails: ["hook lag"] });
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "migrations", gate: "migrations-wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set }] });
    const applied = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: again.cwd, exec: again.exec, show: again.show, gates });
    expect(applied).toMatchObject({ exitCode: 0, applied: ["t1"], decision: { status: "approved", approvedBy: "alice" } });
    expect(again.calls.filter((c) => c === "  lock")).toHaveLength(2);
    expect(again.calls.filter((c) => c === "  migrate")).toHaveLength(1);
    // The second call knows the approval stands, and which hook held the wave.
    expect(again.files[1]).toMatchObject({ approved: true, heldBy: ["before-apply hook lag (t1)"] });
    expect(applied.hooks.filter((o) => o.name === "lag").map((o) => o.outcome)).toEqual(["held", "held"]);
    again.done();
  });

  test("an after-apply failure inside the apply counts the run applied and fails the wave", async () => {
    const h = harness(spec, { fails: ["hook smoke"] });
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(result).toMatchObject({ exitCode: 1, applied: ["t1"], failed: [] });
    expect(result.hooks.at(-1)).toMatchObject({ moment: "after-apply", name: "smoke", outcome: "failed" });
    h.done();
  });

  test("an apply that ignores the hooks it was handed fails the wave", async () => {
    const h = harness(spec, { obey: false });
    const logs: string[] = [];
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: (l) => logs.push(l) });
    expect(result).toMatchObject({ exitCode: 1, applied: ["t1"] });
    expect(logs.join("\n")).toMatch(/without running its before-apply and after-apply hooks/);
    h.done();
  });

  test("runBy is read at base: a change that sets it still has chant run the hooks, and the apply gets its outcomes", async () => {
    const atBase: OpWavesSpec = { ...spec, hooks: { before: spec.hooks!.before } };
    const h = harness(atBase);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} });
    expect(result.exitCode).toBe(0);
    expect(h.calls.slice(0, 4)).toEqual(["hook lint", "tool plan t1 .chant/op-waves/migrations/wave-1/t1.plan.json", "hook lag t1", "tool apply t1 .chant/op-waves/migrations/wave-1/t1.plan.json"]);
    expect(h.files[0]).toMatchObject({ runBy: "chant", hooks: {} });
    expect(h.files[0]!.outcomes.map((o) => o.name)).toEqual(["lint", "lag"]);
    h.done();
  });

  test("an apply that skips both moments for an empty run exits the wave ok, and the skip is recorded (#3811)", async () => {
    const h = harness(spec);
    const exec: OpWaveExec = (argv, dir, env) => {
      if (argv[1] === "plan") writeFileSync(join(dir, argv[3]!), JSON.stringify({ planDigest: digest("1") }));
      if (argv[1] === "apply") {
        const file = readOpWaveHooksFile(env?.CHANT_HOOKS, dir)!;
        runOpWaveApplyHooks(file, "before-apply", { cwd: dir, skip: "nothing to apply", log: () => {} });
        runOpWaveApplyHooks(file, "after-apply", { cwd: dir, skip: "nothing to apply", log: () => {} });
      }
      return 0;
    };
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} });
    expect(result).toMatchObject({ exitCode: 0, applied: ["t1"] });
    const skipped = [
      { moment: "before-apply", name: "skip", exit: 0, outcome: "skipped", reason: "nothing to apply" },
      { moment: "after-apply", name: "skip", exit: 0, outcome: "skipped", reason: "nothing to apply" },
    ];
    expect(result.hooks.filter((o) => o.outcome === "skipped")).toEqual(skipped);
    expect(h.record().outcomes).toEqual(expect.arrayContaining(skipped));
    h.done();
  });

  test("a skip with no reason is refused", () => {
    const h = harness(spec);
    writeFileSync(join(h.cwd, "waves.json"), JSON.stringify(spec));
    const file = opWaveHooksAtBase({ specFile: "waves.json", wave: "prod", cwd: h.cwd, show: h.show });
    expect(() => runOpWaveApplyHooks(file, "before-apply", { cwd: h.cwd, skip: "  ", log: () => {} })).toThrow(/needs a reason/);
    h.done();
  });

  test("an apply outside the waves reads the same hooks at base and runs them itself; a hold stops it", () => {
    const h = harness(spec);
    writeFileSync(join(h.cwd, "waves.json"), JSON.stringify({ ...spec, hooks: undefined, waves: [{ ...spec.waves[0]!, hooks: undefined }] }));
    const file = opWaveHooksAtBase({ specFile: "waves.json", wave: "prod", cwd: h.cwd, show: h.show, base: "HEAD^1" });
    expect(file).toMatchObject({ opWaves: "migrations", wave: "prod", number: 1, approved: false, runBy: "apply", runs: [{ target: "t1", op: "migrate" }] });
    expect(Object.keys(file.hooks)).toEqual(["before-plan", "before-apply", "after-apply"]);
    const ran: string[] = [];
    const exec: OpWaveExec = (argv) => (ran.push(argv.join(" ")), argv[1] === "lag" ? 1 : 0);
    const before = runOpWaveApplyHooks(file, "before-apply", { cwd: h.cwd, exec, log: () => {} });
    expect(before).toMatchObject({ proceed: false, held: ["before-apply hook lag (t1)"], outcomes: [{ name: "lag", target: "t1", exit: 1, outcome: "held" }] });
    expect(runOpWaveApplyHooks(file, "after-plan", { cwd: h.cwd, exec, log: () => {} })).toMatchObject({ proceed: true, outcomes: [] });
    expect(ran).toEqual(["hook lag t1"]);
    const absent = opWaveHooksAtBase({ specFile: "waves.json", wave: "prod", cwd: h.cwd, show: () => ({ sha: "c".repeat(40), text: null }) });
    expect(absent.hooks).toEqual({});
    h.done();
  });
});

describe("a product's wave gate moved onto the waves (#3821)", () => {
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const tg: OpWavesSpec = {
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    digest: { over: "changing" },
    planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
    applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
    waves: [{ name: "net", runs: [{ target: "vpc" }, { target: "dns" }, { target: "nat" }] }],
  };
  function harness(plans: Record<string, { planDigest: string; empty?: boolean }>, extra: Record<string, unknown> = {}, atBase: OpWavesSpec = tg) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-3821-"));
    const calls: string[] = [];
    const exec: OpWaveExec = (argv, dir) => {
      calls.push(argv.join(" "));
      const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ runs: runs.runs.map((r) => ({ target: r.target, ...plans[r.target] })), ...extra }));
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(atBase) });
    return { cwd, calls, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  test("the spec checks gateName, digest and neverOverMcp", () => {
    expect(() => assertOpWavesSpec(tg)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...tg, gateName: "wave" })).toThrow(/pattern with \{k\}/);
    expect(() => assertOpWavesSpec({ ...tg, gateName: "{op}-{k}" })).toThrow(/names \{op\}/);
    expect(() => assertOpWavesSpec({ ...tg, digest: { over: "some" as "all" } })).toThrow(/digest.over/);
    expect(() => assertOpWavesSpec({ ...tg, neverOverMcp: "yes" as unknown as boolean })).toThrow(/neverOverMcp/);
  });

  test("the gate keeps the product's name, and the digest covers only the runs that change something", async () => {
    const plans = { vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2"), empty: true }, nat: { planDigest: digest("3") } };
    const h = harness(plans);
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    const changing = waveSetDigest([{ member: "vpc", planDigest: digest("1") }, { member: "nat", planDigest: digest("3") }]);
    expect(result).toMatchObject({ exitCode: 3, decision: { gate: "wave-1", digest: changing, digestOver: "changing", status: "waiting" } });
    expect(gates.appended[0]).toMatchObject({ op: "tf-apply", gate: "wave-1", planDigest: changing });
    h.done();
  });

  test("an approval a product recorded for its gate and digest before the move lets the wave apply", async () => {
    const plans = { vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2"), empty: true }, nat: { planDigest: digest("3") } };
    const h = harness(plans);
    const changing = waveSetDigest([{ member: "vpc", planDigest: digest("1") }, { member: "nat", planDigest: digest("3") }]);
    const gates = memoryGateLedgerPort({
      pending: [{ version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: "2026-10-10T00:00:00Z", expiresAt: "2026-10-12T00:00:00Z", planDigest: changing, neverOverMcp: true }],
      resolutions: [{ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: "2026-10-10T01:00:00Z", planDigest: changing }],
    });
    const result = await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-10T02:00:00Z" });
    expect(result).toMatchObject({ exitCode: 0, decision: { status: "approved", approvedBy: "alice" } });
    expect(gates.appended).toEqual([]);
    h.done();
  });

  test("a wave whose runs are all empty digests every run, as before", async () => {
    const plans = { vpc: { planDigest: digest("1"), empty: true }, dns: { planDigest: digest("2"), empty: true }, nat: { planDigest: digest("3"), empty: true } };
    const h = harness(plans);
    const result = await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    const all = waveSetDigest(["vpc", "dns", "nat"].map((t, i) => ({ member: t, planDigest: digest(String(i + 1)) })));
    expect(result).toMatchObject({ exitCode: 0, decision: { digest: all, status: "not-required" } });
    h.done();
  });

  test("the plans file's pending fields and the spec's neverOverMcp land on the pending fact; chant's own fields are refused", async () => {
    const plans = { vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2") }, nat: { planDigest: digest("3") } };
    const members = [{ member: "vpc", planDigest: digest("1") }];
    const h = harness(plans, { pending: { commit: "c".repeat(40), members, description: "wave 1 of 3: vpc, dns, nat" } });
    // neverOverMcp at base counts even when the change drops it.
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: () => ({ sha: "b".repeat(40), text: JSON.stringify({ ...tg, neverOverMcp: true }) }), gates });
    expect(result.exitCode).toBe(3);
    expect(gates.appended[0]).toMatchObject({ commit: "c".repeat(40), members, description: "wave 1 of 3: vpc, dns, nat", neverOverMcp: true, gate: "wave-1", op: "tf-apply" });
    h.done();

    const bad = harness(plans, { pending: { gate: "other" } });
    await expect(runOpWave({ spec: tg, specFile: "waves.json", wave: 1, cwd: bad.cwd, exec: bad.exec, show: bad.show, gates: memoryGateLedgerPort() })).rejects.toThrow(/sets gate, which chant writes itself/);
    bad.done();
  });

  test("a spec without the new fields names its gates and digests as before", async () => {
    const plain: OpWavesSpec = { ...tg, gateName: undefined, digest: undefined, name: "roots" };
    const plans = { vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2"), empty: true }, nat: { planDigest: digest("3") } };
    const h = harness(plans, {}, plain);
    const gates = memoryGateLedgerPort();
    const result = await runOpWave({ spec: plain, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    const all = waveSetDigest(["vpc", "dns", "nat"].map((t, i) => ({ member: t, planDigest: digest(String(i + 1)) })));
    expect(result.decision).toMatchObject({ gate: "roots-wave-1", digest: all });
    expect(result.decision).not.toHaveProperty("digestOver");
    expect(gates.appended[0]).not.toHaveProperty("neverOverMcp");
    h.done();
  });
});

describe("gates and holds a product's wave needs (#3821)", () => {
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const tg: OpWavesSpec = {
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
    applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
    hooks: { after: { gate: [{ name: "report", command: ["tg", "report", "{runs}"] }] } },
    waves: [{ name: "net", runs: [{ target: "vpc" }, { target: "dns" }], gate: "always" }],
  };
  type Plan = { planDigest: string; empty?: boolean; denied?: { rules: string[] } };
  function harness(plans: Record<string, Plan>, opts: { extra?: Record<string, unknown>; atBase?: OpWavesSpec; hook?: (argv: string[], env: Record<string, string>, dir: string) => number } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-3821b-"));
    const calls: string[] = [];
    const envs: Array<Record<string, string>> = [];
    const exec: OpWaveExec = (argv, dir, env = {}) => {
      calls.push(argv.join(" "));
      envs.push(env);
      if (argv[0] !== "tg") return opts.hook?.(argv, env, dir) ?? 0;
      if (argv[1] === "report") return opts.hook?.(argv, env, dir) ?? 0;
      const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
      if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ runs: runs.runs.map((r) => ({ target: r.target, ...plans[r.target] })), ...(opts.extra ?? {}) }));
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(opts.atBase ?? tg) });
    return { cwd, calls, envs, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const run = (h: ReturnType<typeof harness>, gates = memoryGateLedgerPort(), spec: OpWavesSpec = tg, log: (m: string) => void = () => {}) =>
    runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T00:00:00.000Z", log });

  test("the spec checks after.gate hooks and override", () => {
    expect(() => assertOpWavesSpec(tg)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...tg, hooks: { before: { gate: [{ command: ["x"] }] } } as OpWavesSpec["hooks"] })).toThrow(/runs after the gate/);
    expect(() => assertOpWavesSpec({ ...tg, hooks: { after: { gate: [{ command: ["x"], onFailure: "approve" }] } } })).toThrow(/already decided/);
    expect(() => assertOpWavesSpec({ ...tg, override: { overriders: "" } })).toThrow(/override.overriders/);
    expect(() => assertOpWavesSpec({ ...tg, override: { who: "x" } as OpWavesSpec["override"] })).toThrow(/override.who/);
  });

  test("the after-gate hook runs when the wave waits, with the decision in its environment", async () => {
    const h = harness({ vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2") } });
    const result = await run(h);
    expect(result.exitCode).toBe(3);
    const at = h.calls.indexOf(`tg report .chant/op-waves/tf-apply/wave-1/runs.json`);
    expect(at).toBeGreaterThan(0);
    const env = h.envs[at]!;
    expect(env).toMatchObject({ CHANT_HOOK: "after-gate", CHANT_GATE_STATUS: "waiting", CHANT_GATE_OP: "tf-apply", CHANT_GATE: "wave-1", CHANT_GATE_DIGEST: result.decision!.digest, CHANT_GATE_RECORDED: "true", CHANT_GATE_WAITING_SINCE: "2026-10-11T00:00:00.000Z" });
    expect(env.CHANT_GATE_APPROVE).toBe(`chant approve tf-apply wave-1 --plan ${result.decision!.digest}`);
    const record = JSON.parse(readFileSync(join(h.cwd, env.CHANT_DECISION!), "utf-8")) as OpWaveDecision;
    expect(record).toMatchObject({ status: "waiting", recorded: true, pendingFact: { gate: "wave-1", planDigest: result.decision!.digest } });
    expect(h.calls.some((c) => c.startsWith("tg apply"))).toBe(false);
    h.done();
  });

  test("the after-gate hook names the approval of another digest; a failing one stops a wave that would apply, and not a waiting one", async () => {
    const h = harness({ vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2") } }, { hook: () => 1 });
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: digest("9") }] });
    const waiting = await run(h, gates);
    expect(waiting.exitCode).toBe(3);
    expect(waiting.decision).toMatchObject({ mismatch: { approved: digest("9"), resolvedBy: "alice" } });
    h.done();

    const open = harness({ vpc: { planDigest: digest("1"), empty: true }, dns: { planDigest: digest("2"), empty: true } }, { hook: () => 1 });
    const stopped = await run(open);
    expect(stopped).toMatchObject({ exitCode: 1, decision: { status: "not-required" } });
    expect(open.calls.some((c) => c.startsWith("tg apply"))).toBe(false);
    open.done();
  });

  test("a run the policy denied refuses the wave (exit 7) and records a denial an override answers", async () => {
    const h = harness({ vpc: { planDigest: digest("1"), denied: { rules: ["no-public-s3"] } }, dns: { planDigest: digest("2") } });
    const gates = memoryGateLedgerPort();
    const result = await run(h, gates);
    expect(result).toMatchObject({ exitCode: 7, decision: { status: "refused", refused: { reason: "policy", runs: ["vpc"] } } });
    expect(gates.appended).toHaveLength(1);
    expect(gates.appended[0]).toMatchObject({ op: "policy-override", gate: "vpc", plan: digest("1"), rules: ["no-public-s3"], members: [{ member: "vpc", planDigest: digest("1") }] });
    expect(h.envs.find((e) => e.CHANT_HOOK === "after-gate")).toMatchObject({ CHANT_GATE_STATUS: "refused" });
    expect(h.calls.some((c) => c.startsWith("tg apply"))).toBe(false);
    const { opWaveNotifyFields } = await import("./op-waves-notify");
    expect(opWaveNotifyFields(tg, 1, { result })).toMatchObject({ event: "refused", status: "denied", targets: ["vpc"] });
    h.done();
  });

  test("an override by a listed overrider lets the denied run through, and is spent before the apply", async () => {
    const { overrideDigest } = await import("../override-gate");
    const od = overrideDigest("vpc", digest("1"), ["no-public-s3"]);
    const h = harness({ vpc: { planDigest: digest("1"), denied: { rules: ["no-public-s3"] } }, dns: { planDigest: digest("2"), empty: true } }, { extra: { overriders: ["github:carol"] }, atBase: { ...tg, waves: [{ ...tg.waves[0]!, gate: "never" }] } });
    const gates = memoryGateLedgerPort({
      resolutions: [{ version: 1, op: "policy-override", gate: "vpc", resolvedBy: "github:carol", timestamp: "2026-10-10T00:00:00Z", planDigest: od, note: "the bucket is the public docs site" }],
    });
    const result = await run(h, gates);
    expect(result).toMatchObject({ exitCode: 0, applied: ["vpc", "dns"] });
    expect(result.decision!.members.find((m) => m.member === "vpc")).toMatchObject({ override: { by: "github:carol", digest: od } });
    expect(gates.applied).toEqual([expect.objectContaining({ op: "policy-override", gate: "vpc", planDigest: od, approvedBy: "github:carol" })]);
    h.done();

    // Somebody the list does not name does not count.
    const other = harness({ vpc: { planDigest: digest("1"), denied: { rules: ["no-public-s3"] } }, dns: { planDigest: digest("2") } }, { extra: { overriders: ["github:dave"] } });
    expect((await run(other, memoryGateLedgerPort({ resolutions: [{ version: 1, op: "policy-override", gate: "vpc", resolvedBy: "github:carol", timestamp: "2026-10-10T00:00:00Z", planDigest: od, note: "ok" }] }))).exitCode).toBe(7);
    other.done();
  });

  test("a plans file's overridersSource names the list in the refusal and the decision record (#3848)", async () => {
    const mk = (extra: Record<string, unknown>) => harness({ vpc: { planDigest: digest("1"), denied: { rules: ["no-public-s3"] } }, dns: { planDigest: digest("2") } }, { extra });
    const logs: string[] = [];
    const h = mk({ overriders: ["github:dave"], overridersSource: "policy.override in terragucci.yml" });
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "policy-override", gate: "vpc", resolvedBy: "github:carol", timestamp: "2026-10-10T00:00:00Z", planDigest: (await import("../override-gate")).overrideDigest("vpc", digest("1"), ["no-public-s3"]), note: "ok" }] });
    const result = await run(h, gates, tg, (m) => logs.push(m));
    expect(result.decision!.refused).toMatchObject({ reason: "policy", overridersSource: "policy.override in terragucci.yml" });
    expect(logs.join("\n")).toContain("github:carol is not listed in policy.override in terragucci.yml at base");
    h.done();
    const d = mk({ overriders: ["github:dave"] });
    const r2 = await run(d, memoryGateLedgerPort());
    expect(r2.decision!.refused).not.toHaveProperty("overridersSource");
    d.done();
  });

  test("a hook holds the wave on another gate: it waits on that gate's digest, then runs again once approved", async () => {
    const migrate = { name: "migrate", command: ["migrate", "{runs}"], onFailure: "approve" as const };
    const spec: OpWavesSpec = { ...tg, hooks: { before: { plan: [migrate] }, after: tg.hooks!.after } };
    const hook = (argv: string[], env: Record<string, string>, dir: string) => {
      if (argv[0] !== "migrate") return 0;
      if (env.CHANT_HOLD_APPROVED) return 0;
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: "split-queues", digest: digest("m"), pending: { members: [] } }));
      return 3;
    };
    const h = harness({ vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2") } }, { hook, atBase: spec });
    const gates = memoryGateLedgerPort();
    const waiting = await run(h, gates, spec);
    expect(waiting).toMatchObject({ exitCode: 3, decision: { status: "waiting", heldOn: { op: "tf-migrate", gate: "split-queues", digest: digest("m"), status: "waiting" } } });
    expect(waiting.decision!.approve).toBe(`chant approve tf-migrate split-queues --plan ${digest("m")}`);
    expect(gates.appended[0]).toMatchObject({ op: "tf-migrate", gate: "split-queues", planDigest: digest("m"), members: [] });
    expect(h.calls.some((c) => c.startsWith("tg plan"))).toBe(false);
    expect(h.envs.find((e) => e.CHANT_HOOK === "after-gate")).toMatchObject({ CHANT_GATE_STATUS: "waiting", CHANT_GATE_OP: "tf-migrate", CHANT_GATE: "split-queues" });
    h.done();

    const again = harness({ vpc: { planDigest: digest("1"), empty: true }, dns: { planDigest: digest("2"), empty: true } }, { hook, atBase: spec });
    const approved = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-migrate", gate: "split-queues", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: digest("m") }] });
    const result = await run(again, approved, spec);
    expect(result.exitCode).toBe(0);
    const reruns = again.envs.filter((e, i) => again.calls[i]!.startsWith("migrate"));
    expect(reruns).toHaveLength(2);
    expect(JSON.parse(reruns[1]!.CHANT_HOLD_APPROVED!)).toMatchObject({ op: "tf-migrate", gate: "split-queues", approvedBy: "alice" });
    expect(result.hooks.filter((o) => o.name === "migrate").map((o) => o.outcome)).toEqual(["held", "passed"]);
    again.done();
  });

  test("an approved re-run holds the wave on a further gate: two migrations wait, then apply in turn (#3847)", async () => {
    const migrate = { name: "migrate", command: ["migrate", "{runs}"], onFailure: "approve" as const };
    const spec: OpWavesSpec = { ...tg, hooks: { before: { plan: [migrate] }, after: tg.hooks!.after } };
    // The first migration holds on its gate; once approved it applies, and the second (whose digest is known only now) holds on its own.
    const applied: string[] = [];
    const hook = (argv: string[], env: Record<string, string>, dir: string) => {
      if (argv[0] !== "migrate") return 0;
      const done = env.CHANT_HOLDS_APPROVED ? (JSON.parse(env.CHANT_HOLDS_APPROVED) as Array<{ gate: string }>).map((a) => a.gate) : [];
      for (const gate of done) if (!applied.includes(gate)) applied.push(gate);
      const next = ["split-queues", "move-topics"].find((g) => !done.includes(g));
      if (!next) return 0;
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: next, digest: digest(next === "split-queues" ? "m" : "n") }));
      return 3;
    };
    const plans = { vpc: { planDigest: digest("1"), empty: true }, dns: { planDigest: digest("2"), empty: true } };
    const first = { version: 1 as const, op: "tf-migrate", gate: "split-queues", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: digest("m") };

    // Only the first is approved: it applies, and the wave waits on the second (exit 3), naming it.
    const h = harness(plans, { hook, atBase: spec });
    const gates = memoryGateLedgerPort({ resolutions: [first] });
    const waiting = await run(h, gates, spec);
    expect(waiting.exitCode).toBe(3);
    expect(waiting.decision).toMatchObject({
      status: "waiting",
      approve: `chant approve tf-migrate move-topics --plan ${digest("n")}`,
      heldOn: { op: "tf-migrate", gate: "move-topics", digest: digest("n"), status: "waiting", after: [{ gate: "split-queues", digest: digest("m"), approvedBy: "alice" }] },
    });
    expect(gates.appended).toEqual([expect.objectContaining({ op: "tf-migrate", gate: "move-topics", planDigest: digest("n") })]);
    expect(applied).toEqual(["split-queues"]);
    expect(h.calls.some((c) => c.startsWith("tg plan"))).toBe(false);
    expect(waiting.hooks.filter((o) => o.name === "migrate").map((o) => o.outcome)).toEqual(["held", "held"]);
    h.done();

    // Both approved: the hook runs three times, the last with both approvals, and the wave applies.
    applied.length = 0;
    const again = harness(plans, { hook, atBase: spec });
    const both = memoryGateLedgerPort({ resolutions: [first, { ...first, gate: "move-topics", resolvedBy: "bob", planDigest: digest("n") }] });
    const result = await run(again, both, spec);
    expect(result.exitCode).toBe(0);
    expect(applied).toEqual(["split-queues", "move-topics"]);
    const reruns = again.envs.filter((_, i) => again.calls[i]!.startsWith("migrate"));
    expect(reruns).toHaveLength(3);
    expect(JSON.parse(reruns[2]!.CHANT_HOLD_APPROVED!)).toMatchObject({ gate: "move-topics", approvedBy: "bob" });
    expect(JSON.parse(reruns[2]!.CHANT_HOLDS_APPROVED!).map((a: { gate: string }) => a.gate)).toEqual(["split-queues", "move-topics"]);
    expect(result.hooks.filter((o) => o.name === "migrate").map((o) => o.outcome)).toEqual(["held", "held", "passed"]);
    again.done();
  });

  test("an approved re-run that holds again on the same gate and digest, or past the bound, fails the wave (#3847)", async () => {
    const migrate = { name: "migrate", command: ["migrate", "{runs}"], onFailure: "approve" as const };
    const spec: OpWavesSpec = { ...tg, hooks: { before: { plan: [migrate] }, after: tg.hooks!.after } };
    const plans = { vpc: { planDigest: digest("1") }, dns: { planDigest: digest("2") } };
    const same = (argv: string[], env: Record<string, string>, dir: string) => {
      if (argv[0] !== "migrate") return 0;
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: "split-queues", digest: digest("m") }));
      return 3;
    };
    const h = harness(plans, { hook: same, atBase: spec });
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-migrate", gate: "split-queues", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: digest("m") }] });
    expect((await run(h, gates, spec)).exitCode).toBe(1);
    expect(h.calls.filter((c) => c.startsWith("migrate"))).toHaveLength(2);
    h.done();

    const { OP_WAVE_MAX_CHAINED_HOLDS } = await import("./op-waves-run");
    let n = 0;
    const endless = (argv: string[], env: Record<string, string>, dir: string) => {
      if (argv[0] !== "migrate") return 0;
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: `step-${n}`, digest: digest("m") }));
      n++;
      return 3;
    };
    const many = harness(plans, { hook: endless, atBase: spec });
    const all = memoryGateLedgerPort({ resolutions: Array.from({ length: 20 }, (_, i) => ({ version: 1 as const, op: "tf-migrate", gate: `step-${i}`, resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: digest("m") })) });
    expect((await run(many, all, spec)).exitCode).toBe(1);
    expect(many.calls.filter((c) => c.startsWith("migrate"))).toHaveLength(OP_WAVE_MAX_CHAINED_HOLDS + 1);
    many.done();
  });
});

describe("discovered waves, a cost member and applies that apply nothing (#3821)", () => {
  const digest = (n: string) => `sha256:${n.repeat(64)}`;
  const tg: OpWavesSpec = {
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    digest: { over: "changing" },
    planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
    applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
    waves: [
      { name: "layer", runs: [], discover: true, gate: "never" },
      { name: "rest", runs: [], discover: true, rest: true, gate: "never" },
    ],
  };
  /** `layers[k-1]` is what wave k's plan finds; `apply` says what each apply call writes to CHANT_APPLY_OUTCOME. */
  function harness(layers: Array<Record<string, { planDigest: string; empty?: boolean }>>, opts: { extra?: (k: number) => Record<string, unknown>; apply?: (k: number, n: number) => unknown; atBase?: OpWavesSpec } = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-3821c-"));
    const calls: string[] = [];
    const runsFiles: OpWaveRunsFile[] = [];
    const applies = new Map<number, number>();
    const exec: OpWaveExec = (argv, dir, env = {}) => {
      calls.push(argv.join(" "));
      const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
      runsFiles.push(runs);
      if (argv[1] === "plan") {
        const found = layers[runs.number - 1] ?? {};
        const entries = runs.discover ? Object.entries(found).map(([target, p]) => ({ target, ...p })) : runs.runs.map((r) => ({ target: r.target, ...found[r.target] }));
        writeFileSync(join(dir, argv[4]!), JSON.stringify({ runs: entries, waves: layers.length, ...(opts.extra?.(runs.number) ?? {}) }));
      }
      if (argv[1] === "apply") {
        const n = (applies.get(runs.number) ?? 0) + 1;
        applies.set(runs.number, n);
        const said = opts.apply?.(runs.number, n);
        if (said) writeFileSync(join(dir, env.CHANT_APPLY_OUTCOME!), JSON.stringify(said));
      }
      return 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(opts.atBase ?? tg) });
    return { cwd, calls, runsFiles, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const run = (h: ReturnType<typeof harness>, wave: number, gates = memoryGateLedgerPort(), spec: OpWavesSpec = tg) =>
    runOpWave({ spec, specFile: "waves.json", wave, cwd: h.cwd, exec: h.exec, show: h.show, gates, now: "2026-10-11T00:00:00.000Z", log: () => {} });

  test("the spec checks discover and rest", () => {
    expect(() => assertOpWavesSpec(tg)).not.toThrow();
    expect(() => assertOpWavesSpec({ ...tg, planWave: undefined, plan: ["p", "{plan}"] })).toThrow(/only `planWave` can report/);
    expect(() => assertOpWavesSpec({ ...tg, waves: [{ name: "a", runs: [{ target: "x" }], discover: true }] })).toThrow(/lists none/);
    expect(() => assertOpWavesSpec({ ...tg, waves: [{ name: "a", runs: [], rest: true, discover: true }, { name: "b", runs: [], discover: true }] })).toThrow(/only the last wave/);
    expect(() => assertOpWavesSpec({ ...tg, waves: [{ name: "a", runs: [], rest: true }] })).toThrow(/set discover too/);
    expect(() => assertOpWavesSpec({ ...tg, waves: [{ name: "a", runs: [], discover: true, rest: true, shares: 2 }] })).toThrow(/cannot be split/);
  });

  test("a wave plans the runs its plan command finds, and the rest wave walks on to the last wave it found", async () => {
    const layers: Array<Record<string, { planDigest: string }>> = [{ "a/vpc": { planDigest: digest("1") } }, { "b/db": { planDigest: digest("2") } }, { "c/app": { planDigest: digest("3") } }, { "d/dns": { planDigest: digest("4") } }];
    const h = harness(layers);
    const first = await run(h, 1);
    expect(first).toMatchObject({ exitCode: 0, applied: ["a/vpc"], decision: { gate: "wave-1", discovered: { waves: 4 } } });
    expect(h.runsFiles[0]).toMatchObject({ discover: true, runs: [] });
    const rest = await run(h, 2);
    expect(rest).toMatchObject({ exitCode: 0, applied: ["b/db", "c/app", "d/dns"], decision: { wave: 4, gate: "wave-4", name: "rest" } });
    expect(rest.rest!.map((r) => [r.wave, r.exitCode])).toEqual([[2, 0], [3, 0], [4, 0]]);
    h.done();

    // A repo with fewer waves than jobs: the later job finds nothing to apply.
    const short = harness([{ "a/vpc": { planDigest: digest("1") } }]);
    expect(await run(short, 2)).toMatchObject({ exitCode: 0, applied: [] });
    short.done();
  });

  test("a wide discovering wave hands its found runs to its shares", async () => {
    const spec: OpWavesSpec = { ...tg, waves: [{ name: "layer", runs: [], discover: true, gate: "never", shares: 2 }] };
    const layers = [{ "a/1": { planDigest: digest("1") }, "a/2": { planDigest: digest("2") }, "a/3": { planDigest: digest("3") } }];
    const h = harness(layers, { atBase: spec });
    expect(await runOpWave({ spec, specFile: "waves.json", wave: 1, decide: true, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} })).toMatchObject({ exitCode: 0, applied: [] });
    const share = await runOpWave({ spec, specFile: "waves.json", wave: 1, share: 2, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} });
    expect(share).toMatchObject({ exitCode: 0, applied: ["a/3"] });
    h.done();
  });

  test("a cost member joins the digest, so an approval at one cost does not apply at another", async () => {
    const spec: OpWavesSpec = { ...tg, waves: [{ name: "layer", runs: [], discover: true, gate: "always" }] };
    const layers = [{ "a/vpc": { planDigest: digest("1") }, "a/idle": { planDigest: digest("2"), empty: true } }];
    const cost = (usd: string) => ({ members: [{ member: "cost", planDigest: `usd:${usd}` }] });
    const h = harness(layers, { extra: () => cost("120.00"), atBase: spec });
    const gates = memoryGateLedgerPort();
    const result = await run(h, 1, gates, spec);
    const priced = waveSetDigest([{ member: "a/vpc", planDigest: digest("1") }, { member: "cost", planDigest: "usd:120.00" }]);
    expect(result).toMatchObject({ exitCode: 3, decision: { digest: priced, extras: [{ member: "cost", planDigest: "usd:120.00" }] } });
    h.done();

    const dearer = harness(layers, { extra: () => cost("900.00"), atBase: spec });
    const approved = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: priced }] });
    expect(await run(dearer, 1, approved, spec)).toMatchObject({ exitCode: 3, decision: { mismatch: { approved: priced } } });
    dearer.done();

    const clash = harness([{ cost: { planDigest: digest("1") } }], { extra: () => cost("1"), atBase: spec });
    await expect(run(clash, 1, memoryGateLedgerPort(), spec)).rejects.toThrow(/also a run's target/);
    clash.done();
  });

  test("an apply that stood down or was held applies nothing and fails nothing; one that asks plans again", async () => {
    const layers = [{ "a/vpc": { planDigest: digest("1") } }];
    const down = harness(layers, { apply: () => ({ outcome: "stood-down", reason: "a newer push is on main" }) });
    const stood = await run(down, 1);
    expect(stood).toMatchObject({ exitCode: 6, applied: [], failed: [], outcome: { outcome: "stood-down", reason: "a newer push is on main" } });
    const { opWaveNotifyFields } = await import("./op-waves-notify");
    expect(opWaveNotifyFields(tg, 1, { result: stood })).toBeUndefined();
    down.done();

    const busy = harness(layers, { apply: () => ({ outcome: "held", holder: { run: "github:123", url: "https://example.test/run/123" } }) });
    const held = await run(busy, 1);
    expect(held).toMatchObject({ exitCode: 5, applied: [], failed: [], outcome: { outcome: "held", holder: { run: "github:123" } } });
    expect(opWaveNotifyFields(tg, 1, { result: held })).toMatchObject({ event: "refused", status: "held", targets: ["a/vpc"] });
    busy.done();

    const again = harness(layers, { apply: (_k, n) => (n === 1 ? { outcome: "replan", reason: "run 123 let go" } : undefined) });
    const replanned = await run(again, 1);
    expect(replanned).toMatchObject({ exitCode: 0, applied: ["a/vpc"] });
    expect(again.calls.filter((c) => c.startsWith("tg plan"))).toHaveLength(2);
    again.done();
  });

  test("planned again to the same digest, the approval the job found still holds and is not spent twice", async () => {
    const spec: OpWavesSpec = { ...tg, approvals: { spend: true }, waves: [{ name: "layer", runs: [], discover: true, gate: "always" }] };
    const layers = [{ "a/vpc": { planDigest: digest("1") } }];
    const set = waveSetDigest([{ member: "a/vpc", planDigest: digest("1") }]);
    const h = harness(layers, { apply: (_k, n) => (n === 1 ? { outcome: "replan" } : undefined), atBase: spec });
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "tf-apply", gate: "wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set }] });
    const result = await run(h, 1, gates, spec);
    expect(result).toMatchObject({ exitCode: 0, applied: ["a/vpc"], decision: { status: "approved", approvedBy: "alice" } });
    expect(gates.applied).toHaveLength(1);
    h.done();
  });
});

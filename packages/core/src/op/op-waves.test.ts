import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, opWaveJobs, opWaveShare, type OpWavesSpec } from "./op-waves";
import { recordOpWaveHeadPlans, runOpWave, type OpWaveExec, type OpWaveRunsFile, type OpWaveShowAtBase } from "./op-waves-run";
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

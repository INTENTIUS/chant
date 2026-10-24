/**
 * Hook `targets` and the `before.observe` moment (#4288), in an Op waves
 * job and through `runStageHooks`.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWaveHooks, assertPrLoopHooks, opWaveHookRuns, opWaveHooksAt, OP_WAVE_HOOK_MOMENTS, type OpWavesSpec } from "./op-waves";
import { runOpWave, runStageHooks, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

describe("hook targets and before.observe in the spec (#4288)", () => {
  test("before.observe is the first moment, and opWaveHooksAt reads it", () => {
    expect(OP_WAVE_HOOK_MOMENTS[0]).toBe("before-observe");
    const hooks = opWaveHooksAt({ hooks: { before: { observe: [{ command: ["init"] }] } }, waves: [{ name: "prod", runs: [] }] }, "prod");
    expect(hooks["before-observe"]).toEqual([{ command: ["init"] }]);
  });

  test("the spec refuses after.observe, {plan} before the observe and targets that are not a list of names", () => {
    expect(() => assertOpWaveHooks("w", { after: { observe: [{ command: ["x"] }] } } as never)).toThrow(/hooks.after.observe is not a moment/);
    expect(() => assertOpWaveHooks("w", { before: { observe: [{ command: ["x", "{plan}"], perRun: true }] } })).toThrow(/no \{plan\} yet/);
    expect(() => assertOpWaveHooks("w", { before: { plan: [{ command: ["x"], targets: [] }] } })).toThrow(/targets must be a non-empty list/);
    expect(() => assertOpWaveHooks("w", { before: { plan: [{ command: ["x"], targets: ["prod/*", 3] as never }] } })).toThrow(/targets must be a non-empty list/);
    expect(() => assertOpWaveHooks("w", { before: { observe: [{ command: ["x"], targets: ["prod/**"], onFailure: "approve" }] } })).not.toThrow();
  });

  test("a pull-request job accepts after.gate (#4323) and refuses apply.runBy", () => {
    expect(() => assertPrLoopHooks("ci.hooks", { after: { gate: [{ command: ["x"] }] } })).not.toThrow();
    // onFailure "approve" stays refused at after.gate, as in an Op waves job.
    expect(() => assertPrLoopHooks("ci.hooks", { after: { gate: [{ command: ["x"], onFailure: "approve" }] } })).toThrow(/after.gate/);
    expect(() => assertPrLoopHooks("ci.hooks", { apply: { runBy: "apply" } })).toThrow(/runBy is for an Op waves spec/);
    expect(() => assertPrLoopHooks("ci.hooks", { before: { observe: [{ command: ["x"] }], apply: [{ command: ["y"] }] } })).not.toThrow();
  });

  test("targets match a run by name or by a pattern, as a job group's runs do", () => {
    const runs = [{ target: "prod/eu" }, { target: "prod/us/east" }, { target: "dev" }];
    expect(opWaveHookRuns({}, runs).map((r) => r.target)).toEqual(["prod/eu", "prod/us/east", "dev"]);
    expect(opWaveHookRuns({ targets: ["prod/*"] }, runs).map((r) => r.target)).toEqual(["prod/eu"]);
    expect(opWaveHookRuns({ targets: ["prod/**", "dev"] }, runs).map((r) => r.target)).toEqual(["prod/eu", "prod/us/east", "dev"]);
  });
});

describe("runOpWave with targets and before.observe (#4288)", () => {
  const spec: OpWavesSpec = {
    name: "roots",
    op: "tf",
    plan: ["tool", "plan", "{target}", "{plan}"],
    apply: ["tool", "apply", "{target}", "{plan}"],
    hooks: {
      before: {
        observe: [{ name: "init", command: ["hook", "init", "{target}"], perRun: true, targets: ["eu/*"] }],
        plan: [{ name: "us-only", command: ["hook", "us", "{runs}"], targets: ["us/*"] }],
      },
      after: { plan: [{ name: "eu-check", command: ["hook", "eu-check", "{runs}"], targets: ["eu/*"] }] },
    },
    waves: [{ name: "prod", runs: [{ target: "eu/a" }, { target: "eu/b" }, { target: "asia/c" }], gate: "never" }],
  };

  function harness(fails: string[] = []) {
    const cwd = mkdtempSync(join(tmpdir(), "op-waves-targets-"));
    const calls: Array<{ argv: string; env?: Record<string, string> }> = [];
    const exec: OpWaveExec = (argv, dir, env) => {
      calls.push({ argv: argv.join(" "), ...(env ? { env } : {}) });
      if (argv[1] === "plan") writeFileSync(join(dir, argv[3]!), JSON.stringify({ planDigest: digest(argv[2]!.endsWith("a") ? "1" : "2") }));
      return fails.some((f) => argv.join(" ").startsWith(f)) ? 1 : 0;
    };
    const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
    return { cwd, calls, exec, show, argv: () => calls.map((c) => c.argv), done: () => rmSync(cwd, { recursive: true, force: true }) };
  }

  test("before-observe runs ahead of before-plan, each hook only for the runs its targets match", async () => {
    const h = harness();
    const logs: string[] = [];
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: (l) => logs.push(l) });
    expect(result.exitCode).toBe(0);
    expect(h.argv().filter((c) => c.startsWith("hook") || c.startsWith("tool plan"))).toEqual([
      "hook init eu/a",
      "hook init eu/b",
      "tool plan eu/a .chant/op-waves/roots/wave-1/eu_a.plan.json",
      "tool plan eu/b .chant/op-waves/roots/wave-1/eu_b.plan.json",
      "tool plan asia/c .chant/op-waves/roots/wave-1/asia_c.plan.json",
      "hook eu-check .chant/op-waves/roots/wave-1/runs.json",
    ]);
    expect(h.calls[0]!.env).toMatchObject({ CHANT_HOOK: "before-observe", CHANT_TARGET: "eu/a" });
    expect(logs).toContain("before-plan hook us-only: no run matches its targets (us/*), so it did not run");
    expect(result.hooks.map((o) => `${o.moment} ${o.name}${o.target ? ` ${o.target}` : ""} ${o.outcome}`)).toEqual([
      "before-observe init eu/a passed",
      "before-observe init eu/b passed",
      "after-plan eu-check passed",
    ]);
    h.done();
  });

  test("a failed before-observe hook stops the wave before anything plans", async () => {
    const h = harness(["hook init eu/b"]);
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: () => {} });
    expect(result.exitCode).toBe(1);
    expect(h.argv().some((c) => c.startsWith("tool"))).toBe(false);
    h.done();
  });
});

describe("runStageHooks (#4288)", () => {
  test("runs one moment's hooks for the runs given, with targets, and counts an approve failure as a hold", () => {
    const cwd = mkdtempSync(join(tmpdir(), "stage-hooks-"));
    const calls: string[] = [];
    const exec: OpWaveExec = (argv) => {
      calls.push(argv.join(" "));
      return argv[1] === "gate" ? 1 : 0;
    };
    const ran = runStageHooks(
      "before-plan",
      [
        { name: "each", command: ["hook", "each", "{target}", "{op}"], perRun: true, targets: ["api"] },
        { name: "gate", command: ["hook", "gate", "{wave}"], onFailure: "approve" },
      ],
      { name: "pr-7", op: "pr-7", wave: "prod", runs: [{ target: "api", op: "pr-7" }, { target: "web", op: "pr-7" }], runsFile: "runs.json", holdFile: "hold.json", cwd, exec, log: () => {} },
    );
    expect(calls).toEqual(["hook each api pr-7", "hook gate prod"]);
    expect(ran.failed).toBeUndefined();
    expect(ran.holds).toEqual(["before-plan hook gate"]);
    expect(ran.outcomes.map((o) => o.outcome)).toEqual(["passed", "held"]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

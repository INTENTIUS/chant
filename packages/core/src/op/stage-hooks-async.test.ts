/**
 * runStageHooksAsync (#4334): the async stage runner gives what the sync one
 * gives for the same hooks, and two calls run side by side.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWaveHook } from "./op-waves";
import { runStageHooks, runStageHooksAsync, spawnExecAsync, type OpWaveAsyncExec, type OpWaveExec } from "./stage-hooks";

const hooks: OpWaveHook[] = [
  { name: "each", command: ["hook", "each", "{target}", "{op}"], perRun: true, targets: ["api"] },
  { name: "gate", command: ["hook", "gate", "{wave}"], onFailure: "approve" },
  { name: "other", command: ["hook", "other"], onFailure: "approve" },
  { name: "lost", command: ["hook", "lost"] },
  { name: "stop", command: ["hook", "stop"] },
  { name: "after", command: ["hook", "after"] },
];
const runs = [{ target: "api", op: "pr-7" }, { target: "web", op: "pr-7" }];

/** Exit codes by the hook's second word; `other` writes a hold on another gate and `lost` cannot start. */
function codeOf(argv: string[], cwd: string, env?: Record<string, string>): number {
  if (argv[1] === "other") writeFileSync(join(cwd, env!.CHANT_HOLD!), JSON.stringify({ gate: "dba", digest: "sha256:abc" }));
  if (argv[1] === "lost") throw new Error("spawn hook ENOENT");
  return argv[1] === "gate" || argv[1] === "other" || argv[1] === "stop" ? 1 : 0;
}

describe("runStageHooksAsync (#4334)", () => {
  test("gives the outcomes, holds and failure the sync runner gives", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stage-hooks-async-"));
    const options = { name: "pr-7", op: "pr-7", wave: "prod", runs, runsFile: "runs.json", holdFile: "hold.json", cwd };
    const syncCalls: string[] = [];
    const syncLog: string[] = [];
    const exec: OpWaveExec = (argv, at, env) => (syncCalls.push(argv.join(" ")), codeOf(argv, at, env));
    const sync = runStageHooks("before-plan", hooks, { ...options, exec, log: (l) => syncLog.push(l) });
    const asyncCalls: string[] = [];
    const asyncLog: string[] = [];
    const asyncExec: OpWaveAsyncExec = async (argv, at, env) => (asyncCalls.push(argv.join(" ")), codeOf(argv, at, env));
    const ran = await runStageHooksAsync("before-plan", hooks, { ...options, exec: asyncExec, log: (l) => asyncLog.push(l) });
    expect(ran).toEqual(sync);
    expect(asyncCalls).toEqual(syncCalls);
    expect(asyncLog).toEqual(syncLog);
    expect(asyncCalls).toEqual(["hook each api pr-7", "hook gate prod", "hook other", "hook lost"]);
    expect(ran.failed).toBe("before-plan hook lost exited 127");
    expect(ran.holds).toEqual(["before-plan hook gate", "before-plan hook other (on pr-7 / dba)"]);
    expect(ran.outcomes.map((o) => o.outcome)).toEqual(["passed", "held", "held", "failed"]);
    expect(asyncLog).toContain("before-plan hook lost did not run: spawn hook ENOENT");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("two calls run side by side", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stage-hooks-async-"));
    const started: string[] = [];
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const exec: OpWaveAsyncExec = async (argv) => {
      started.push(argv[1]!);
      if (started.length === 2) release();
      await both;
      return 0;
    };
    const one = (name: string) =>
      runStageHooksAsync("before-plan", [{ command: ["hook", name] }], { name, op: name, wave: "prod", runs: [], runsFile: `${name}/runs.json`, holdFile: `${name}/hold.json`, cwd, exec, log: () => {} });
    const [a, b] = await Promise.all([one("a"), one("b")]);
    expect(started.sort()).toEqual(["a", "b"]);
    expect([a.outcomes[0]!.outcome, b.outcomes[0]!.outcome]).toEqual(["passed", "passed"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("the default exec spawns the hook, gives its exit code and rejects a command that cannot start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stage-hooks-async-"));
    expect(await spawnExecAsync([process.execPath, "-e", "process.exit(process.env.CODE === '3' ? 3 : 0)"], cwd, { CODE: "3" })).toBe(3);
    await expect(spawnExecAsync(["./no-such-hook"], cwd)).rejects.toThrow(/ENOENT/);
    const ran = await runStageHooksAsync("after-apply", [{ name: "ok", command: [process.execPath, "-e", "process.exit(0)"] }], { name: "s", op: "s", wave: "w", runs: [], runsFile: "runs.json", holdFile: "hold.json", cwd, log: () => {} });
    expect(ran).toEqual({ outcomes: [{ moment: "after-apply", name: "ok", exit: 0, outcome: "passed" }], holds: [] });
    rmSync(cwd, { recursive: true, force: true });
  });
});

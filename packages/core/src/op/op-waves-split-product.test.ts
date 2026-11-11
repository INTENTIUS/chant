/**
 * #4994: a product's bin runs each job of a split wave, and the one-job
 * shape, with its own process's hooks.
 *
 * - A hook the spec names is served in the job's own process by name
 *   (`inProcessHooks`, a product wave hook's `hooks`): in the plan job, the
 *   gate job and the applying job, each in its own process, in place of a
 *   command that called back into a long-lived product process. What the
 *   plan job's code keeps for the later jobs goes under
 *   `opWaveProductStateDir`, which the gate and applying jobs read.
 * - A hold that asks chant to `record` its gate works with the split: the
 *   plan job finds the approval and cannot spend it, the gate job spends it
 *   for a re-run of the hook at the wave's commit, the next run's plan job
 *   runs the hook again under it, and the gate job after that writes the
 *   finished line. The approval is used once.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { opWaveRecordPath, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveDecision, type OpWaveExec, type OpWaveInProcessHook, type OpWaveRunPort, type OpWaveSavedPlan, type OpWaveShowAtBase } from "./op-waves-run";
import { opWaveProductStateDir, opWaveSavedPlanPath } from "./op-waves-split";
import { memoryGateLedgerPort } from "./gate";
import { CHANT_EXIT } from "../exit-codes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const noWrites: OpWaveRunPort = { append: async () => Promise.reject(new Error("this job writes no run record to the ledger")) };

/** A spec whose hooks, read at base, called back into the product's process over a socket (`product-call ...`). */
const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  hooks: {
    before: {
      plan: [{ name: "migrations", command: ["product-call", "migrate-check", "{runs}"] }],
      apply: [{ name: "ready", command: ["product-call", "ready", "{runs}"] }],
    },
    after: { gate: [{ name: "report", command: ["product-call", "gate", "{runs}"] }] },
  },
  waves: [{ name: "dev", runs: [{ target: "network" }], gate: "never" }],
};
const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });

/** The tools a job runs: the engine's plan and apply, and the socket client, which finds no product process to call. */
function tools(): { exec: OpWaveExec; socketCalls: string[]; applied: string[] } {
  const socketCalls: string[] = [];
  const applied: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    if (argv[0] === "product-call") {
      socketCalls.push(argv.join(" "));
      return 1;
    }
    if (argv[0] === "tool" && argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest("a") }));
    if (argv[0] === "tool" && argv[1] === "apply") applied.push(argv[2]!);
    return 0;
  };
  return { exec, socketCalls, applied };
}

/** The product's hooks, each in the job's own process: the plan job keeps a note for the gate job's report. */
function productHooks(log: string[]): Record<string, OpWaveInProcessHook> {
  const state = (cwd: string) => join(cwd, opWaveProductStateDir(spec, 1), "planned.json");
  return {
    migrations: async (call) => {
      log.push(`${call.moment} ${call.name}`);
      mkdirSync(dirname(state(call.cwd)), { recursive: true });
      writeFileSync(state(call.cwd), JSON.stringify({ roots: ["network"] }));
      return 0;
    },
    report: async (call) => {
      const kept = existsSync(state(call.cwd)) ? (JSON.parse(readFileSync(state(call.cwd), "utf-8")) as { roots: string[] }).roots.join(",") : "none";
      log.push(`${call.moment} ${call.name} ${call.env.CHANT_GATE_STATUS} planned=${kept} argv=${call.argv.slice(0, 2).join(" ")}`);
      return 0;
    },
    ready: async (call) => {
      log.push(`${call.moment} ${call.name}`);
      return 0;
    },
  };
}

describe("a product's hooks in its own process (#4994)", () => {
  test("each job of a split wave calls the hooks it runs in its own process, in place of their commands", async () => {
    const cwd = tmp("split-product-");
    const { exec, socketCalls, applied } = tools();
    const gates = memoryGateLedgerPort();
    const base = { spec, specFile: "waves.json", wave: 1, cwd, exec, show, gates, log: () => {} };

    const plan: string[] = [];
    expect((await runOpWave({ ...base, phase: "plan", runs: noWrites, inProcessHooks: productHooks(plan) })).exitCode).toBe(CHANT_EXIT.done);
    expect(plan).toEqual(["before-plan migrations"]);

    // The gate job is a process of its own: its report reads what the plan job's hook kept.
    const gate: string[] = [];
    expect((await runOpWave({ ...base, phase: "gate", runs: { append: async () => {} }, inProcessHooks: productHooks(gate) })).exitCode).toBe(CHANT_EXIT.done);
    expect(gate).toEqual(["after-gate report not-required planned=network argv=product-call gate"]);

    const apply: string[] = [];
    expect((await runOpWave({ ...base, phase: "apply", runs: noWrites, inProcessHooks: productHooks(apply) })).exitCode).toBe(CHANT_EXIT.done);
    expect(apply).toEqual(["before-apply ready"]);
    expect(applied).toEqual(["network"]);

    expect((await runOpWave({ ...base, phase: "record", runs: { append: async () => {} }, inProcessHooks: productHooks([]) })).exitCode).toBe(CHANT_EXIT.done);
    // No job ran a command that called back over a socket.
    expect(socketCalls).toEqual([]);
  });

  test("the one-job shape calls the same hooks in its one process", async () => {
    const cwd = tmp("split-product-one-");
    const { exec, socketCalls, applied } = tools();
    const log: string[] = [];
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd, exec, show, gates: memoryGateLedgerPort(), runs: { append: async () => {} }, releases: false, log: () => {}, inProcessHooks: productHooks(log) });
    expect(result.exitCode).toBe(CHANT_EXIT.done);
    expect(log).toEqual(["before-plan migrations", "after-gate report not-required planned=network argv=product-call gate", "before-apply ready"]);
    expect(applied).toEqual(["network"]);
    expect(socketCalls).toEqual([]);
  });

  test("a hook the process does not serve runs its command, as before", async () => {
    const cwd = tmp("split-product-cmd-");
    const { exec, socketCalls } = tools();
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd, exec, show, gates: memoryGateLedgerPort(), runs: { append: async () => {} }, releases: false, log: () => {}, inProcessHooks: { report: async () => 0, ready: async () => 0 } });
    // The before-plan hook's command found no product process, so the wave failed before it planned.
    expect(result.exitCode).toBe(CHANT_EXIT.failed);
    expect(socketCalls).toEqual(["product-call migrate-check .chant/op-waves/roots/wave-1/runs.json"]);
  });
});

/** A wave held before it plans on `tf-migrate / split-queues` by a hook that asks chant to record the gate, served in process. */
function recordHold() {
  const cwd = tmp("split-record-hold-");
  const migrate = { name: "migrate", command: ["product-call", "migrate", "{runs}"], onFailure: "approve" as const };
  const holdSpec: OpWavesSpec = {
    name: "migrations",
    op: "migrate",
    plan: ["tool", "plan", "{target}", "--out", "{plan}"],
    apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
    hooks: { before: { plan: [migrate] } },
    waves: [{ name: "staging", runs: [{ target: "staging" }], gate: "never" }],
  };
  const { exec, socketCalls } = tools();
  const reruns: Array<Record<string, string>> = [];
  const hooks: Record<string, OpWaveInProcessHook> = {
    migrate: async ({ cwd: dir, env }) => {
      if (env.CHANT_HOLD_APPROVED) {
        reruns.push(env);
        // The migration ran under the approval: how it ended, for the finished line.
        writeFileSync(join(dir, env.CHANT_HOLD_FINISHED!), JSON.stringify({ result: "applied", detail: { moved: 2 } }));
        return 0;
      }
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: "split-queues", digest: digest("m"), description: "move the queues", record: true }));
      return 3;
    },
  };
  const approval = { version: 1 as const, op: "tf-migrate", gate: "split-queues", resolvedBy: "alice", timestamp: "2026-11-10T00:00:00Z", planDigest: digest("m") };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(holdSpec) });
  const head = "c".repeat(40);
  return { cwd, holdSpec, socketCalls, reruns, approval, head, base: { spec: holdSpec, specFile: "waves.json", wave: 1, cwd, exec, show, inProcessHooks: hooks, log: () => {} } };
}

describe("a `record` hold with the split (#4994)", () => {
  test("the gate job spends the approval, the next run's plan job runs the hook again under it, and its gate job writes the finished line", async () => {
    const h = recordHold();
    const gates = memoryGateLedgerPort({ resolutions: [h.approval] });
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);

    // Run 1, plan job: the gate is approved, and this job cannot spend the approval.
    const planned = await runOpWave({ ...h.base, phase: "plan", head: h.head, gates, runs: noWrites, log });
    expect(planned.exitCode).toBe(CHANT_EXIT.waiting);
    expect(h.reruns).toEqual([]);
    expect(gates.applied).toEqual([]);
    const saved = JSON.parse(readFileSync(join(h.cwd, opWaveSavedPlanPath(h.holdSpec, 1)), "utf-8")) as OpWaveSavedPlan;
    expect(saved.end?.decision?.heldOn?.deferred?.spend).toMatchObject({ approvedBy: "alice", head: h.head });

    // Run 1, gate job: it spends the approval for the hook's re-run at this commit, and the wave waits.
    const gated = await runOpWave({ ...h.base, phase: "gate", head: h.head, gates, runs: { append: async () => {} }, log });
    expect(gated.exitCode).toBe(CHANT_EXIT.waiting);
    expect(gates.applied).toEqual([expect.objectContaining({ op: "tf-migrate", gate: "split-queues", planDigest: digest("m"), approvedBy: "alice", rerun: { head: h.head } })]);
    const decision = JSON.parse(readFileSync(join(h.cwd, opWaveRecordPath(h.holdSpec, 1)), "utf-8")) as OpWaveDecision;
    expect(decision.heldOn?.spentForRerun).toMatchObject({ approvedBy: "alice", rerun: { head: h.head } });
    expect(gates.appended).toEqual([]);
    expect(lines.join("\n")).toContain("is spent for before-plan hook migrate to run again; run the wave again from its plan job");

    // Another commit's plan job does not run the hook under it.
    const other = await runOpWave({ ...h.base, phase: "plan", head: "d".repeat(40), gates, runs: noWrites, log });
    expect(other.exitCode).toBe(CHANT_EXIT.waiting);
    expect(h.reruns).toEqual([]);

    // Run 2, plan job: the hook runs again under the spent approval, and the wave plans.
    const again = await runOpWave({ ...h.base, phase: "plan", head: h.head, gates, runs: noWrites, log });
    expect(again.exitCode, lines.join("\n")).toBe(CHANT_EXIT.done);
    expect(h.reruns).toHaveLength(1);
    expect(JSON.parse(h.reruns[0]!.CHANT_HOLD_APPROVED!)).toMatchObject({ op: "tf-migrate", gate: "split-queues", approvedBy: "alice" });
    expect(gates.finished).toEqual([]);
    const savedAgain = JSON.parse(readFileSync(join(h.cwd, opWaveSavedPlanPath(h.holdSpec, 1)), "utf-8")) as OpWaveSavedPlan;
    expect(savedAgain.holdsFinished).toEqual([expect.objectContaining({ result: "applied", detail: { moved: 2 } })]);

    // Run 2, gate job: it writes the finished line, then decides the wave.
    const decided = await runOpWave({ ...h.base, phase: "gate", head: h.head, gates, runs: { append: async () => {} }, log });
    expect(decided.exitCode).toBe(CHANT_EXIT.done);
    expect(gates.finished).toEqual([expect.objectContaining({ op: "tf-migrate", gate: "split-queues", planDigest: digest("m"), applied: gates.applied[0]!.timestamp, result: "applied", detail: { moved: 2 } })]);

    // Run 3: the approval was used once. A hook that holds on the same digest again does not run again, and its gate
    // job refuses to spend the approval twice, as a one-job wave refuses it.
    const third = await runOpWave({ ...h.base, phase: "plan", head: h.head, gates, runs: noWrites, log });
    expect(third.exitCode).toBe(CHANT_EXIT.waiting);
    expect(h.reruns).toHaveLength(1);
    const refused = await runOpWave({ ...h.base, phase: "gate", head: h.head, gates, runs: { append: async () => {} }, log });
    expect(refused.exitCode).toBe(CHANT_EXIT.failed);
    expect(lines.join("\n")).toContain("a held request applies once, so it is not spent again");
    expect(gates.applied).toHaveLength(1);
    expect(h.socketCalls).toEqual([]);
  });

  test("a finished line the plan job claims for an applied line the ledger does not hold is not written", async () => {
    const h = recordHold();
    const gates = memoryGateLedgerPort({ resolutions: [h.approval] });
    await runOpWave({ ...h.base, phase: "plan", head: h.head, gates, runs: noWrites });
    await runOpWave({ ...h.base, phase: "gate", head: h.head, gates, runs: { append: async () => {} } });
    await runOpWave({ ...h.base, phase: "plan", head: h.head, gates, runs: noWrites });
    // The change's code in the plan job rewrites what it hands on.
    const path = join(h.cwd, opWaveSavedPlanPath(h.holdSpec, 1));
    const saved = JSON.parse(readFileSync(path, "utf-8")) as OpWaveSavedPlan;
    saved.holdsFinished = saved.holdsFinished!.map((f) => ({ ...f, applied: { ...f.applied, timestamp: "2020-01-01T00:00:00.000Z" } }));
    writeFileSync(path, JSON.stringify(saved));
    const lines: string[] = [];
    await runOpWave({ ...h.base, phase: "gate", head: h.head, gates, runs: { append: async () => {} }, log: (l) => lines.push(l) });
    expect(gates.finished).toEqual([]);
    expect(lines.join("\n")).toContain("which the ledger holds no re-run of this commit for, so no finished line is written");
  });

  test("the gate job does not spend an approval for a commit other than the plan job's", async () => {
    const h = recordHold();
    const gates = memoryGateLedgerPort({ resolutions: [h.approval] });
    await runOpWave({ ...h.base, phase: "plan", head: h.head, gates, runs: noWrites });
    const gated = await runOpWave({ ...h.base, phase: "gate", head: "e".repeat(40), gates, runs: { append: async () => {} } });
    expect(gated.exitCode).toBe(CHANT_EXIT.failed);
    expect(gates.applied).toEqual([]);
  });
});

describe("a product's bin runs a split wave's job with its wave hook (#4994)", () => {
  test("runChantInProcess with `hooks` runs `run wave --phase plan` with the hook in process", async () => {
    const cwd = tmp("split-product-bin-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@chant.dev");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    const plan = ["node", "-e", `require("fs").writeFileSync(process.argv[1], JSON.stringify({ planDigest: "${digest("a")}" }))`, "{plan}"];
    const binSpec: OpWavesSpec = { ...spec, plan, apply: ["true"] };
    mkdirSync(join(cwd, ".chant"), { recursive: true });
    writeFileSync(join(cwd, ".chant", "waves.json"), JSON.stringify(binSpec));
    git("add", ".");
    git("commit", "-q", "-m", "spec");
    const { runChantInProcess } = await import("../ci-product");
    const calls: string[] = [];
    const was = process.cwd();
    process.chdir(cwd);
    let code: number;
    try {
      code = await runChantInProcess(["run", "wave", "--spec", ".chant/waves.json", "--wave", "1", "--phase", "plan", "--base", "HEAD"], { product: "terragucci" }, {
        wave: { hooks: { migrations: async (c) => (calls.push(`${c.moment} ${c.name}`), 0) } },
      });
    } finally {
      process.chdir(was);
    }
    expect(code).toBe(CHANT_EXIT.done);
    expect(calls).toEqual(["before-plan migrations"]);
    expect(existsSync(join(cwd, opWaveSavedPlanPath(binSpec, 1)))).toBe(true);
  }, 20_000);
});

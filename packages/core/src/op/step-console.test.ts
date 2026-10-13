/**
 * A running step's console (#3956): a step's output is printed as it
 * arrives, each line carrying its phase and step, and a quiet step says it
 * is still running.
 */

import { describe, test, expect, vi } from "vitest";
import { shellCmd, type ShellCmdArgs } from "./activities/shell";
import { activity, phase, shell } from "./builders";
import { ACTIVITY_PROFILES } from "./activity-profiles";
import { runOpLocally } from "./local-executor";
import { memoryGateLedgerPort } from "./gate";
import type { ActivityFn } from "./activity-registry";
import { DEFAULT_STEP_HEARTBEAT_MS, stepHeartbeatMs, stepLabel } from "./step-console";

const shellFn: ActivityFn = (args, signal) => shellCmd(args as unknown as ShellCmdArgs, signal);

/** A writer that keeps each line with when it arrived. */
function recorder() {
  const lines: Array<{ at: number; text: string }> = [];
  return { lines, write: (text: string) => void lines.push({ at: Date.now(), text }) };
}

// A command that writes a line, waits, and writes another on stderr, then a
// last line on stdout with no newline.
const SLOW = `node -e "console.log('first'); setTimeout(() => { console.error('second'); process.stdout.write('third'); }, 600)"`;

describe("a step's output streams as it arrives (#3956)", () => {
  test("the first line is printed before the command exits, prefixed with its phase and step", async () => {
    const out = recorder();
    let ended = 0;
    const timed: ActivityFn = async (args, signal) => {
      try {
        return await shellFn(args, signal);
      } finally {
        ended = Date.now();
      }
    };
    const result = await runOpLocally(
      { name: "seed", overview: "", phases: [phase("Seed", [shell(SLOW, { id: "wait-agent" })])] },
      new Map([["shellCmd", timed]]),
      ACTIVITY_PROFILES,
      undefined,
      { gates: memoryGateLedgerPort(), stepOutput: out.write, stepHeartbeatMs: 0 },
    );

    expect(result.status).toBe("ok");
    expect(out.lines.map((l) => l.text)).toEqual([
      "[Seed] wait-agent | first",
      "[Seed] wait-agent | second",
      "[Seed] wait-agent | third",
    ]);
    // The first line arrived well before the command ended, not with it.
    expect(ended - out.lines[0]!.at).toBeGreaterThan(300);
  });

  test("a step without an id is named by its call, as the run's render names it", async () => {
    const out = recorder();
    await runOpLocally(
      { name: "hello", overview: "", phases: [phase("Go", [shell("echo hi")])] },
      new Map([["shellCmd", shellFn]]),
      ACTIVITY_PROFILES,
      undefined,
      { gates: memoryGateLedgerPort(), stepOutput: out.write, stepHeartbeatMs: 0 },
    );
    expect(out.lines.map((l) => l.text)).toEqual(["[Go] shellCmd(cmd=echo hi) | hi"]);
  });

  test("a failing command's output is printed too, before the failure", async () => {
    const out = recorder();
    await expect(
      runOpLocally(
        { name: "broken", overview: "", phases: [phase("Go", [shell(`node -e "console.error('no such table'); process.exit(2)"`, { id: "migrate" })])] },
        new Map([["shellCmd", shellFn]]),
        ACTIVITY_PROFILES,
        undefined,
        { gates: memoryGateLedgerPort(), stepOutput: out.write, stepHeartbeatMs: 0 },
      ),
    ).rejects.toThrow();
    expect(out.lines.map((l) => l.text)).toEqual(["[Go] migrate | no such table"]);
  });

  test("without a writer nothing is printed while the step runs, and stdout is not echoed", async () => {
    const written = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runOpLocally(
      { name: "quiet", overview: "", phases: [phase("Go", [shell("echo hi", { id: "say" })])] },
      new Map([["shellCmd", shellFn]]),
      ACTIVITY_PROFILES,
      undefined,
      { gates: memoryGateLedgerPort() },
    ).finally(() => {
      written.mockRestore();
      logged.mockRestore();
    });
    expect(result.status).toBe("ok");
    expect(written).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("a quiet step says it is still running (#3956)", () => {
  test("an activity that only returns a value gets a still-running line each interval", async () => {
    const out = recorder();
    const slow: ActivityFn = () => new Promise((r) => setTimeout(() => r({ done: true }), 280));
    await runOpLocally(
      { name: "wait", overview: "", phases: [phase("Deploy", [activity("waitForAgent", {}, { id: "agent" })])] },
      new Map([["waitForAgent", slow]]),
      ACTIVITY_PROFILES,
      undefined,
      { gates: memoryGateLedgerPort(), stepOutput: out.write, stepHeartbeatMs: 100 },
    );
    expect(out.lines.map((l) => l.text.replace(/\d+s$/, "Ns"))).toEqual([
      "[Deploy] agent: still running after Ns",
      "[Deploy] agent: still running after Ns",
    ]);
  });

  test("a step printing output is not interrupted by the still-running line", async () => {
    const out = recorder();
    const chatty = `node -e "let n = 0; const t = setInterval(() => { console.log('tick ' + n); if (++n === 6) clearInterval(t); }, 40)"`;
    await runOpLocally(
      { name: "chatty", overview: "", phases: [phase("Go", [shell(chatty, { id: "ticks" })])] },
      new Map([["shellCmd", shellFn]]),
      ACTIVITY_PROFILES,
      undefined,
      { gates: memoryGateLedgerPort(), stepOutput: out.write, stepHeartbeatMs: 100 },
    );
    expect(out.lines.filter((l) => l.text.includes("still running"))).toEqual([]);
    expect(out.lines.map((l) => l.text)).toContain("[Go] ticks | tick 5");
  });

  test("CHANT_STEP_HEARTBEAT sets the interval, and 0 or off turns it off", () => {
    expect(stepHeartbeatMs({})).toBe(DEFAULT_STEP_HEARTBEAT_MS);
    expect(stepHeartbeatMs({ CHANT_STEP_HEARTBEAT: "30s" })).toBe(30_000);
    expect(stepHeartbeatMs({ CHANT_STEP_HEARTBEAT: "5m" })).toBe(300_000);
    expect(stepHeartbeatMs({ CHANT_STEP_HEARTBEAT: "0" })).toBe(0);
    expect(stepHeartbeatMs({ CHANT_STEP_HEARTBEAT: "off" })).toBe(0);
    const warnings: string[] = [];
    expect(stepHeartbeatMs({ CHANT_STEP_HEARTBEAT: "soon" }, (m) => warnings.push(m))).toBe(DEFAULT_STEP_HEARTBEAT_MS);
    expect(warnings).toHaveLength(1);
  });

  test("a long call is cut to a readable label", () => {
    const label = stepLabel("shellCmd", { cmd: "x".repeat(200) });
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith("...)")).toBe(true);
    expect(stepLabel("shellCmd", { cmd: "echo hi" }, "say")).toBe("say");
  });
});

/**
 * A plan the product's policy holds (#4294): the wave waits for a person's
 * approval of its set digest whatever its gate policy says, and applies
 * once one stands.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { waveSetDigest } from "../gated-waves";

const spec: OpWavesSpec = {
  name: "roots",
  op: "tf",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "dev", runs: [{ target: "vpc" }], gate: "never" }],
};

const digest = (n: string) => `sha256:${n.repeat(64)}`;

function harness(plan: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-hold-"));
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify(plan));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, calls, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("a policy hold on an Op waves plan (#4294)", () => {
  test("a held run makes a gate: never wave wait, and an approval of its digest lets it apply", async () => {
    const h = harness({ planDigest: digest("1"), held: { rules: ["main.hold_iam", "main.hold_iam"], reason: "an IAM change" } });
    const waiting = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(waiting.exitCode).toBe(3);
    expect(waiting.decision).toMatchObject({ status: "waiting", policy: "never", heldBy: ["policy on vpc (main.hold_iam): an IAM change"] });
    expect(waiting.decision!.members[0]).toMatchObject({ member: "vpc", held: { rules: ["main.hold_iam"] } });
    expect(h.calls.some((c) => c.startsWith("tool apply"))).toBe(false);

    const set = waveSetDigest([{ member: "vpc", planDigest: digest("1") }]);
    const gates = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "roots", gate: "roots-wave-1", resolvedBy: "alice", timestamp: "2026-10-10T00:00:00Z", planDigest: set }] });
    const approved = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates });
    expect(approved).toMatchObject({ exitCode: 0, applied: ["vpc"], decision: { status: "approved", approvedBy: "alice" } });
    h.done();
  });

  test("a run with no hold under gate: never needs no approval", async () => {
    const h = harness({ planDigest: digest("2") });
    const free = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() });
    expect(free).toMatchObject({ exitCode: 0, applied: ["vpc"], decision: { status: "not-required" } });
    h.done();
  });

  test("a hold that names no rule is refused", async () => {
    const h = harness({ planDigest: digest("3"), held: { rules: [] } });
    await expect(runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort() })).rejects.toThrow(/a hold is \{ "rules"/);
    h.done();
  });
});

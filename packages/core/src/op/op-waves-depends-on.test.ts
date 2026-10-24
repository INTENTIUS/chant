/**
 * A failed run blocks only the runs that depend on it (#4322): the waves'
 * jobs pass outcome files, and a later wave's job reads them.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, opWaveJobs, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";

const spec: OpWavesSpec = {
  name: "roots",
  op: "tf",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "base", runs: [{ target: "a" }, { target: "b" }, { target: "b2", dependsOn: ["a"] }], gate: "never" },
    { name: "app", runs: [{ target: "c", dependsOn: ["b"] }, { target: "d", dependsOn: ["a"] }, { target: "e", dependsOn: ["b2"] }, { target: "f", dependsOn: ["d"] }], gate: "never" },
  ],
};

const digest = (n: string) => `sha256:${n.repeat(64)}`;

function harness(failing: string[], s: OpWavesSpec = spec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-deps-"));
  const calls: string[] = [];
  const exec: OpWaveExec = (argv, dir) => {
    calls.push(argv.join(" "));
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest("1") }));
    if (argv[1] === "apply" && failing.includes(argv[2]!)) return 1;
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  const run = (wave: number) => runOpWave({ spec: s, specFile: "waves.json", wave, cwd, exec, show, gates: memoryGateLedgerPort(), log: () => {} });
  return { cwd, calls, run, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("run-level dependsOn on Op waves (#4322)", () => {
  test("two runs in wave 1, one failing: the wave 2 run that depends on the other applies", async () => {
    const h = harness(["a"]);
    const one = await h.run(1);
    expect(one).toMatchObject({ exitCode: 1, applied: ["b"], failed: ["a"], blocked: { b2: "a" } });
    const two = await h.run(2);
    expect(two.applied).toEqual(["c"]);
    expect(two.blocked).toEqual({ d: "a", e: "a", f: "a" });
    expect(two.exitCode).toBe(1);
    expect(h.calls.some((c) => c.startsWith("tool apply c "))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("tool plan d") || c.startsWith("tool apply d"))).toBe(false);
    h.done();
  });

  test("with nothing failed every run applies and the wave 2 job exits 0", async () => {
    const h = harness([]);
    expect((await h.run(1)).exitCode).toBe(0);
    const two = await h.run(2);
    expect(two).toMatchObject({ exitCode: 0, applied: ["c", "d", "e", "f"] });
    expect(two.blocked).toBeUndefined();
    h.done();
  });

  test("a run listed before in its own wave blocks its dependent when it fails", async () => {
    const h = harness(["c"]);
    await h.run(1);
    const two = await h.run(2);
    expect(two).toMatchObject({ exitCode: 1, failed: ["c"] });
    expect(two.applied).toEqual(["d", "e", "f"]);
    h.done();
  });

  test("a spec whose dependsOn names no earlier or preceding run is refused", () => {
    const bad: OpWavesSpec = { ...spec, waves: [{ name: "x", runs: [{ target: "a", dependsOn: ["nope"] }], gate: "never" }] };
    expect(() => assertOpWavesSpec(bad)).toThrow(/depends on "nope"/);
  });

  test("every wave job names an outcome file", () => {
    for (const job of opWaveJobs(spec, "waves.json")) expect(job.outcome).toMatch(/^\.chant\/op-waves\/roots\/outcomes\/outcome-wave-\d/);
  });
});

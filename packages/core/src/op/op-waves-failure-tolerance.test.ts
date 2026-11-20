/**
 * A wave's failure tolerance (#5324): failed runs within it let the wave
 * count as applied, and only the tolerance at the base commit counts.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";

const targets = ["t1", "t2", "t3", "t4"];
const spec = (failureTolerance?: number | `${number}%`): OpWavesSpec => ({
  name: "tenants",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [{ name: "prod", runs: targets.map((target) => ({ target })), gate: "never", ...(failureTolerance !== undefined ? { failureTolerance } : {}) }],
});

function run(failing: string[], head: OpWavesSpec, base: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-tolerance-"));
  const exec: OpWaveExec = (argv, dir) => {
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: `sha256:${"1".repeat(64)}` }));
    if (argv[1] === "apply" && failing.includes(argv[2]!)) return 1;
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(base) });
  const lines: string[] = [];
  return runOpWave({ spec: head, specFile: "waves.json", wave: 1, cwd, exec, show, gates: memoryGateLedgerPort(), log: (l) => lines.push(l) }).then((r) => ({ ...r, lines }));
}

describe("failureTolerance on an op wave (#5324)", () => {
  test("failed runs within the tolerance at base: the runs stay failed and the wave exits as applied", async () => {
    const out = await run(["t2"], spec("25%"), spec("25%"));
    expect(out).toMatchObject({ exitCode: 0, failed: ["t2"], applied: ["t1", "t3", "t4"] });
    expect(out.lines.some((l) => l.includes("within its failure tolerance of 1"))).toBe(true);
  });

  test("more failed runs than the tolerance fail the wave", async () => {
    expect(await run(["t1", "t2"], spec(1), spec(1))).toMatchObject({ exitCode: 1, failed: ["t1", "t2"] });
  });

  test("a tolerance only the change has does not count", async () => {
    expect(await run(["t2"], spec(2), spec())).toMatchObject({ exitCode: 1, failed: ["t2"] });
  });

  test("a tolerance that does not read is refused", () => {
    expect(() => assertOpWavesSpec({ ...spec(), waves: [{ ...spec().waves[0]!, failureTolerance: "half" as never }] })).toThrow(/failureTolerance "half"/);
  });
});

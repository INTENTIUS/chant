/** #5320: what a failed release.check printed reaches the refusal, in a single cut and in a train cut. */

import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedOutputBlock, runToStderrCaptured, tailLines } from "./train-shell";
import { spawnMemberCut, TrainCutError, type TrainCutMember } from "./train-cut";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("failed command output (#5320)", () => {
  test("tailLines keeps the last lines and says how many it left out", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = tailLines(text, 60);
    expect(out.split("\n")[0]).toBe("... (40 earlier lines left out)");
    expect(out).toContain("line 100");
    expect(out).not.toContain("line 40\n");
    expect(tailLines("a\nb\n")).toBe("a\nb");
    expect(tailLines("")).toBe("");
  });

  test("runToStderrCaptured keeps stdout and stderr apart", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const r = await runToStderrCaptured("echo out; echo err >&2; exit 4", { cwd: tmpdir() });
      expect(r).toEqual({ code: 4, stdout: "out\n", stderr: "err\n" });
    } finally {
      spy.mockRestore();
    }
  });

  test("the block is labeled with the command and shows both streams", () => {
    const block = failedOutputBlock("release.check", "npm test", { stdout: "Ran all test suites.", stderr: "FAIL src/a.test.ts\n  expected 1" });
    expect(block).toContain("release.check: npm test printed:");
    expect(block).toContain("--- stdout ---\nRan all test suites.");
    expect(block).toContain("--- stderr ---\nFAIL src/a.test.ts\n  expected 1");
    expect(failedOutputBlock("release.check", "true", { stdout: "", stderr: "" })).toContain("(no output)");
  });

  test("a train cut's error carries the member's output, not only its last lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-train-shell-"));
    dirs.push(dir);
    const script = join(dir, "fake-chant.js");
    writeFileSync(script, `for (let i = 1; i <= 100; i++) console.error("jest detail " + i);\nconsole.error("error: no release was cut [release-check-failed]");\nprocess.exit(1);\n`);
    const argv1 = process.argv[1];
    const execArgv = [...process.execArgv];
    process.argv[1] = script;
    process.execArgv.length = 0;
    try {
      const m = { member: "app", dir: ".", label: "0.1.1" } as unknown as TrainCutMember;
      const err = await spawnMemberCut(m, "abc", { root: dir, yes: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TrainCutError);
      expect((err as TrainCutError).code).toBe("train-cut-failed");
      const msg = (err as TrainCutError).message;
      expect(msg).toContain("the cut of app at 0.1.1 failed");
      expect(msg).toContain("jest detail 100");
      expect(msg).toContain("jest detail 60");
      expect(msg).not.toContain("jest detail 40\n");
      expect(msg).toContain("earlier lines left out");
    } finally {
      process.argv[1] = argv1!;
      process.execArgv.push(...execArgv);
    }
  });
});

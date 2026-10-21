/**
 * chant #4093: the example's pull-request workflow is generated, never
 * hand-edited. This regenerates it in-process through the command the CLI
 * runs (`runCommandInProcess`, the same dispatch `chant build` uses) into a
 * temp directory and compares bytes with the committed file.
 */
import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommandInProcess } from "../../packages/core/src/cli/main";

const exampleDir = resolve(__dirname);
const committed = join(exampleDir, ".forgejo", "workflows", "chant-pr.yml");

/** The flags the README names, in the order it names them. */
export const GENERATE_ARGS = [
  "build",
  exampleDir,
  "--components",
  "--generate",
  "forgejo",
  "--pr-loop",
  // #4168: a merge records by default; the demo's story is a merge that applies.
  "--apply-on-merge",
  "--env",
  "demo",
  "--events-json",
  "--report-url",
  "s3://chant-demo/fan-out-estate/reports",
  "--image",
  "chant-fan-out-demo-job:local",
  "--pr-build-command",
  "npm run build",
];

describe("fan-out-estate chant-pr.yml", () => {
  test("is exactly what chant build --generate forgejo --pr-loop writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fan-out-estate-wf-"));
    const out = join(dir, "chant-pr.yml");
    try {
      const code = await runCommandInProcess([...GENERATE_ARGS, "-o", out]);
      expect(code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(readFileSync(committed, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("plans, records and applies the estate with build, lint, then ci run plan, record or apply and nothing else", () => {
    const text = readFileSync(committed, "utf8");
    expect(text).toContain("run: npm run build");
    expect(text).toContain("run: chant lint");
    // #4156: each job runs its command through chant ci run, which writes the job's run record.
    expect(text).toContain("chant ci run plan --in-place");
    expect(text).toContain("chant ci run apply --in-place");
    expect(text).not.toContain("chant components pr-");
    expect(text).toContain("chant ci run record --in-place");
    // One job per stage: the 15 stacks are the members of one pr-plan, one pr-record and one pr-apply (#4168 step 9).
    expect(text.split("\njobs:\n")[1].match(/^ {2}[a-z-]+:$/gm)).toEqual(["  plan:", "  record:", "  apply:"]);
    expect(text).not.toContain("fan-out ");
  });
});

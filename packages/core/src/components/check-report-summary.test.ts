/**
 * #4914: the check report's markdown section, which `chant ci check
 * --summary <file>` appends to a product's own report, so a product's check
 * step runs chant's check stage (hooks, lexicon steps, signing) and renders
 * nothing of its own.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkReportSummary } from "./check-hooks";
import { parseArgs } from "../cli/parse-args";
import type { CommandContext } from "../cli/registry";

const BASE = "0123456789abcdef0123456789abcdef01234567";

describe("checkReportSummary (#4914)", () => {
  test("names the base, each hook run and step, the failure and the evidence signed", () => {
    const lines = checkReportSummary({
      status: "failed",
      base: BASE,
      hooks: [
        { name: "fmt", exit: 0, outcome: "passed" },
        { name: "tflint", target: "roots/a", exit: 2, outcome: "failed" },
        { name: "checkov", exit: 0, outcome: "skipped", reason: "current local evidence from person alice" },
      ],
      steps: [{ lexicon: "pulumi", step: "pulumi-about", member: "app", stack: "dev", exit: 0, outcome: "passed" }],
      failed: "a check hook failed: tflint",
      evidence: { signed: ["fmt"], runner: "ci", commit: BASE },
    });
    expect(lines).toEqual([
      "### Check hooks (read at 0123456789ab)",
      "",
      "- passed: `fmt`",
      "- failed: `tflint` for `roots/a`, exit 2",
      "- skipped: `checkov` (current local evidence from person alice)",
      "- passed: `pulumi pulumi-about` for `app` (stack `dev`)",
      "- a check hook failed: tflint",
      "- signed: `fmt` as ci",
      "",
    ]);
  });

  test("nothing when no hook is declared and no step ran", () => {
    expect(checkReportSummary({ status: "none", base: "HEAD", hooks: [] })).toEqual([]);
  });
});

describe("chant ci check --summary (#4914)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("the flag parses", () => {
    expect(parseArgs(["ci", "check", "--base", "HEAD", "--summary", ".terragucci/check/report.md"])).toMatchObject({ checkSummary: ".terragucci/check/report.md" });
    expect(() => parseArgs(["ci", "check", "--summary"])).toThrow(/--summary needs a file/);
  });

  test("appends the section to the file after the check hooks ran", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-4914-summary-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet");
    writeFileSync(join(cwd, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [], ci: { hooks: { check: [{ name: "ok", command: ["true"] }] } } }, null, 2) + "\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    const file = join(cwd, "out", "report.md");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const said: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: string) => void said.push(String(l)));
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    const { runCiCheck } = await import("../cli/handlers/ci-check");
    const code = await runCiCheck({ args: parseArgs(["ci", "check", "--base", "HEAD", "--output", join(cwd, ".chant/check"), "--summary", file]), plugins: [{} as never] } as unknown as CommandContext);
    vi.unstubAllEnvs();
    expect(code, said.join("\n")).toBe(0);
    expect(said.join("\n")).toContain("1 passed");
    expect(readFileSync(file, "utf-8")).toContain("- passed: `ok`");
  });
});

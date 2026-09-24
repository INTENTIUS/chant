/**
 * `chant workspace check` over chant's own trees (#2641): the repository's
 * declaration (#2557), run from the root and from `reference-workspace/`,
 * and the reference workspace (#2543) as a workspace of its own, copied out
 * of the repository with its declaration. Every check runs, the member
 * ledger, pipeline and generated-file checks included, and none may report
 * an error. Warnings are fine: the `other` members are reported on purpose.
 *
 * Declared generators are not run here (`--generated`): on the chant
 * repository they take about six minutes. The file sits beside the checks
 * rather than in test/, whose files vitest includes one by one.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/main";
import { runWorkspaceCheck } from "./lineage-check";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const fixture = join(repoRoot, "reference-workspace");

interface Report {
  ok: boolean;
  declaration?: { ok: boolean; diagnostics: { ruleId: string; severity: string; message: string }[] };
}

/** `chant workspace check --json` run in `cwd`, with its report. */
async function check(cwd: string): Promise<{ code: number; report: Report }> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const code = await runWorkspaceCheck({ args: parseArgs(["workspace", "check", "--json"]), plugins: [] } as never);
  vi.restoreAllMocks();
  return { code, report: JSON.parse(out.join("\n")) as Report };
}

const errors = (r: Report) => (r.declaration?.diagnostics ?? []).filter((d) => d.severity === "error").map((d) => `${d.ruleId}: ${d.message}`);

describe("chant workspace check on chant's own trees (#2641)", () => {
  afterEach(() => vi.restoreAllMocks());

  test("the chant repository's declaration has no error, from the root or from the reference workspace", async () => {
    for (const cwd of [repoRoot, fixture]) {
      const { code, report } = await check(cwd);
      expect(report.declaration, cwd).toBeDefined();
      expect(errors(report), cwd).toEqual([]);
      expect(code, cwd).toBe(0);
    }
  });

  test("the reference workspace, copied out with its declaration, has no error", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "chant-2641-check-")), "ws");
    try {
      cpSync(fixture, target, { recursive: true, filter: (src) => !/(^|[\\/])(node_modules|dist)$/.test(src) });
      // Until #2543 lands the fixture holds its declaration as a draft.
      const draft = join(target, "chant.workspace.draft.json");
      if (existsSync(draft)) renameSync(draft, join(target, "chant.workspace.json"));
      execFileSync("git", ["init", "-q"], { cwd: target });
      const { code, report } = await check(target);
      expect(errors(report)).toEqual([]);
      expect(report.declaration?.diagnostics.map((d) => d.ruleId)).toContain("WSP009");
      expect(code).toBe(0);
    } finally {
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });
});

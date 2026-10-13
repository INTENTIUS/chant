/**
 * Affected Terragrunt units (#3415) against a real `terragrunt` 1.1+ and
 * `git`: each case of `../__fixtures__/terragrunt/affected-cases.ts` is made
 * as a commit on a copy of the `affected/` fixture. Terragrunt's own
 * `[HEAD~1...HEAD]` filter must select exactly the case's `terragrunt`
 * column (for the three supplements, nothing: the red half), and
 * `findTerragruntAffected` must return the case's expected units and reasons.
 *
 * Nothing is planned, so `tofu` is not needed. Skipped, with the reason in
 * the title, when `terragrunt` or `git` is not on PATH.
 */

import { execFileSync, execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AFFECTED_CASES } from "../__fixtures__/terragrunt/affected-cases";
import { defaultTerragruntExec, discoverTerragruntUnits, findTerragruntAffected, parseTerragruntFind, terragruntAffectedFindArgs } from "./index";

function onPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const skipReason = !onPath("terragrunt") ? "no terragrunt on PATH" : !onPath("git") ? "no git on PATH" : "";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/terragrunt");
const tmp = mkdtempSync(join(tmpdir(), "chant-tg-affected-accept-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "chant", GIT_AUTHOR_EMAIL: "chant@example.com", GIT_COMMITTER_NAME: "chant", GIT_COMMITTER_EMAIL: "chant@example.com" };
const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
const generate = (dir: string): void => {
  execFileSync("terragrunt", ["stack", "generate", "--no-color"], { cwd: dir, stdio: "ignore" });
};

/** A copy of the fixture as a git repository at its base commit, stacks generated. */
function baseRepo(name: string): string {
  const dir = join(tmp, name.replace(/[^a-z0-9]+/gi, "-"));
  cpSync(join(fixtures, "affected"), dir, { recursive: true });
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  generate(dir);
  return dir;
}

describe.skipIf(skipReason !== "")(`affected Terragrunt units against a real terragrunt${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  it("discovers what recorded/affected-find.json holds", async () => {
    const dir = baseRepo("discovery");
    const { units } = await discoverTerragruntUnits({ dir });
    expect(units).toEqual(parseTerragruntFind(readFileSync(join(fixtures, "recorded/affected-find.json"), "utf8")));
  });

  for (const c of AFFECTED_CASES) {
    it(
      c.name,
      async () => {
        const dir = baseRepo(c.name);
        c.change(dir);
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", c.name);
        generate(dir);
        expect(git(dir, "diff", "--name-only", "HEAD~1...HEAD").trim().split("\n").sort()).toEqual([...c.changed].sort());

        const own = await defaultTerragruntExec("terragrunt", terragruntAffectedFindArgs({ base: "HEAD~1" }), { cwd: dir, env: {} });
        expect(own.code, own.stderr).toBe(0);
        expect(parseTerragruntFind(own.stdout).map((u) => u.path).sort()).toEqual(c.terragrunt);

        const got = await findTerragruntAffected({ dir, base: "HEAD~1" });
        expect(got.units).toEqual(c.expected);
        expect(got.notes).toEqual([]);
      },
      60_000,
    );
  }
});

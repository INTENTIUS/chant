/**
 * The files a change touched (#3183), as a project in a workspace member
 * sees them (#3465): every changed file in the repository, relative to the
 * member's directory, so one outside it reads `../...`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { changedFilesBetween } from "./changed-files";

const repo = mkdtempSync(join(tmpdir(), "chant-changed-files-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

function put(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

git("init", "-q", "-b", "main");
put("infra/network/roots/vpc/main.tf", "");
put("shared/modules/base/main.tf", "");
put("apps/web/main.tf", "");
git("add", "-A");
git("commit", "-q", "-m", "base");
const base = git("rev-parse", "HEAD");
put("infra/network/roots/vpc/main.tf", "# changed\n");
put("shared/modules/base/main.tf", "# changed\n");
put("apps/web/main.tf", "# changed\n");
git("add", "-A");
git("commit", "-q", "-m", "change");

describe("changedFilesBetween", () => {
  test("at the repository root, every file by its repository path", async () => {
    expect(await changedFilesBetween(repo, base)).toEqual([
      "apps/web/main.tf",
      "infra/network/roots/vpc/main.tf",
      "shared/modules/base/main.tf",
    ]);
  });

  test("in a member's directory, every file relative to the member, outside ones included", async () => {
    expect(await changedFilesBetween(join(repo, "infra/network"), base)).toEqual([
      "../../apps/web/main.tf",
      "../../shared/modules/base/main.tf",
      "roots/vpc/main.tf",
    ]);
  });
});

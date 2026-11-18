/**
 * #5261: `release.check` runs at the cut of a single release, in its dry run
 * too, once the label is stamped and before anything is recorded or tagged.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITLAB_CI", "CI_PIPELINE_ID", "GITLAB_USER_LOGIN", "CHANT_ENV", "CHANT_RELEASE_LABEL", "CHANT_RELEASE_COMMIT", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

function chant(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "alice" };
  for (const k of CI_VARS) delete env[k];
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// The label's major.minor must be the one in SPEC_VERSION, read from the stamped package.json; the log records each run.
const CHECK = `v=$(node -p "require('./package.json').version"); echo "$CHANT_RELEASE_LABEL $CHANT_RELEASE_COMMIT $v" >> "$CHECK_LOG"; case "$v" in "$(cat SPEC_VERSION)".*) ;; *) echo "label $v is not spec $(cat SPEC_VERSION)"; echo "detail on stderr" >&2; exit 3;; esac`;

describe("release.check (#5261)", () => {
  test(
    "the dry run and the cut run the lines on the stamped label, and a failing line refuses the cut with nothing recorded or tagged",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-check-"));
      try {
        const dir = join(root, "app");
        const log = join(root, "check.log");
        git(root, "init", "-q", "--bare", "-b", "main", "app.git");
        git(root, "init", "-q", "-b", "main", dir);
        git(dir, "config", "user.email", "alice@example.com");
        git(dir, "config", "user.name", "Alice");
        git(dir, "remote", "add", "origin", join(root, "app.git"));
        writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "acme-spec", version: "0.0.0", private: true }, null, 2)}\n`);
        writeFileSync(join(dir, "SPEC_VERSION"), "1.6\n");
        writeFileSync(
          join(dir, "chant.config.json"),
          `${JSON.stringify({ release: { green: "none", version: { packages: ["."] }, publish: [{ type: "npm", packages: ["."] }], check: [`CHECK_LOG=${log}; ${CHECK}`] } }, null, 2)}\n`,
        );
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "chore: init");
        git(dir, "push", "-q", "origin", "main");
        git(dir, "fetch", "-q", "origin");
        const sha = git(dir, "rev-parse", "HEAD");

        // A label of another major.minor: the dry run refuses it, as the cut does.
        const dry = chant(dir, ["release", "cut", "1.7.0"]);
        expect(dry.code, dry.stderr).toBe(1);
        expect(dry.stderr).toContain("release-check-failed");
        expect(dry.stderr).toContain("label 1.7.0 is not spec 1.6");
        const cutWrong = chant(dir, ["release", "cut", "1.7.0", "--yes"]);
        expect(cutWrong.code, cutWrong.stderr).toBe(1);
        expect(cutWrong.stderr).toContain("release-check-failed");
        // #5320: the failing line's output is printed, labeled, before the refusal.
        expect(cutWrong.stderr).toContain("release.check: ");
        expect(cutWrong.stderr).toContain("printed:");
        expect(cutWrong.stderr).toContain("--- stdout ---\nlabel 1.7.0 is not spec 1.6");
        expect(cutWrong.stderr).toContain("--- stderr ---\ndetail on stderr");
        expect(cutWrong.stderr.indexOf("printed:")).toBeLessThan(cutWrong.stderr.lastIndexOf("release-check-failed"));
        expect(git(dir, "tag", "--list", "release/*")).toBe("");
        expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"], { cwd: dir }).status).not.toBe(0);
        // The stamped package.json is put back.
        expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version).toBe("0.0.0");

        // The label the spec allows: the dry run says the checks passed, and the cut records and tags.
        const ok = chant(dir, ["release", "cut", "1.6.2"]);
        expect(ok.code, ok.stderr).toBe(0);
        expect(ok.stdout).toContain("release.check: 1 line(s) passed");
        const cut = chant(dir, ["release", "cut", "1.6.2", "--yes", "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        // Under --json stdout is the document alone: the check's output went to stderr.
        expect(() => JSON.parse(cut.stdout)).not.toThrow();
        expect(git(dir, "tag", "--list", "release/*")).toBe("release/1.6.2");

        expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual([`1.7.0 ${sha} 1.7.0`, `1.7.0 ${sha} 1.7.0`, `1.6.2 ${sha} 1.6.2`, `1.6.2 ${sha} 1.6.2`]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

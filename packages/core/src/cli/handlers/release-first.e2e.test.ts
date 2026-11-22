/**
 * terragucci#1526, sql-yodeler#406: the release-cut hook a pipeline's first
 * stage runs cuts the first release of a member that has none, at the
 * version `release.first` names (default 0.1.0), and the merge after it
 * bumps that release.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";
import { releaseCutHook } from "../../pipeline/stages";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITLAB_CI", "CI_PIPELINE_ID", "GITLAB_USER_LOGIN", "CHANT_ENV", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

function run(cwd: string, command: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "alice" };
  for (const k of CI_VARS) delete env[k];
  const r = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const COMPONENT = (note: string) => `${note}export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`;

/** A member with one environment, no release and no version tag, its commits pushed and green. */
function member(root: string): { dir: string; green: (message: string) => string } {
  const dir = join(root, "app");
  git(root, "init", "-q", "--bare", "-b", "main", "app.git");
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.email", "alice@example.com");
  git(dir, "config", "user.name", "Alice");
  git(dir, "remote", "add", "origin", join(root, "app.git"));
  writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev"], release: { tag: "v{version}" } };\n`);
  writeFileSync(join(dir, "api.component.ts"), COMPONENT(""));
  // The template is committed, so the hook's cut builds nothing.
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "api.template.json"), `{"Resources":{}}\n`);
  const green = (message: string): string => {
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", message);
    git(dir, "push", "-q", "origin", "main");
    git(dir, "fetch", "-q", "origin");
    const sha = git(dir, "rev-parse", "HEAD");
    git(dir, "tag", `ci/green/${sha}`);
    return sha;
  };
  return { dir, green };
}

describe("a pipeline's release cut on a member with no release (terragucci#1526, sql-yodeler#406)", () => {
  test(
    "the hook's command cuts the first release at release.first's default, and the next merge bumps it",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-first-"));
      try {
        const { dir, green } = member(root);
        const first = green("feat: start");
        const hook = releaseCutHook({ release: { bin: CHANT } })!;
        expect(hook.command.slice(CHANT.length)).toEqual(["release", "cut", "auto", "--first", "0.1.0", "--yes", "--wait-checks"]);

        // Without --first the cut still refuses, as before.
        const bare = run(dir, [...CHANT, "release", "cut", "auto", "--yes", "--json"]);
        expect(bare.code).toBe(1);
        expect(bare.stderr).toContain("release-next-no-previous");

        const cut = run(dir, [...hook.command, "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        const doc = JSON.parse(cut.stdout);
        expect(doc.label).toBe("0.1.0");
        expect(doc.tag).toEqual({ name: "v0.1.0", created: true });
        expect(git(dir, "rev-parse", "v0.1.0^{commit}")).toBe(first);

        // The same hook on the next merge bumps the release it cut.
        writeFileSync(join(dir, "api.component.ts"), COMPONENT("// fixed\n"));
        green("fix: close the socket");
        const next = run(dir, [...hook.command, "--json"]);
        expect(next.code, next.stderr).toBe(0);
        expect(JSON.parse(next.stdout).label).toBe("0.1.1");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  test(
    "release.first names another first version",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-first-"));
      try {
        const { dir, green } = member(root);
        green("feat: start");
        const hook = releaseCutHook({ release: { bin: CHANT, first: "1.0.0" } })!;
        const cut = run(dir, [...hook.command, "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        expect(JSON.parse(cut.stdout).label).toBe("1.0.0");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

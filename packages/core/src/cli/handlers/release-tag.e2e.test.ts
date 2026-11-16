/**
 * #5150: `release.tag` decides the tag a cut makes, `chant release tag`
 * reads a release back from its tag through the ledger, and a publish moves
 * the floating tag once every target has revealed.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITLAB_CI", "CI_PIPELINE_ID", "GITLAB_USER_LOGIN", "CHANT_ENV", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];

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

const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;

describe("release.tag (#5150)", () => {
  test(
    "a cut makes the template's tag, release tag reads it back, and publish moves the floating tag",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-tag-"));
      try {
        const dir = join(root, "app");
        git(root, "init", "-q", "--bare", "-b", "main", "app.git");
        git(root, "init", "-q", "-b", "main", dir);
        git(dir, "config", "user.email", "alice@example.com");
        git(dir, "config", "user.name", "Alice");
        git(dir, "remote", "add", "origin", join(root, "app.git"));
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev"], release: { tag: { name: "v{version}", floating: "v{major}" } } };\n`);
        writeFileSync(
          join(dir, "api.component.ts"),
          `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
        );
        writeFileSync(join(dir, ".gitignore"), "dist/\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "init");
        git(dir, "push", "-q", "origin", "main");
        git(dir, "fetch", "-q", "origin");
        const sha = git(dir, "rev-parse", "HEAD");
        git(dir, "tag", `ci/green/${sha}`);

        const dry = chant(dir, ["release", "cut", "1.0.0", "--build", BUILD, "--json"]);
        expect(dry.code, dry.stderr).toBe(0);
        expect(JSON.parse(dry.stdout).tag).toEqual({ name: "v1.0.0", exists: false });

        const cut = chant(dir, ["release", "cut", "1.0.0", "--build", BUILD, "--yes", "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        const doc = JSON.parse(cut.stdout);
        expect(doc.tag).toEqual({ name: "v1.0.0", created: true });
        expect(doc.next[0]).toBe("git push origin v1.0.0");
        expect(git(dir, "rev-parse", "v1.0.0^{commit}")).toBe(sha);

        const byTag = chant(dir, ["release", "tag", "v1.0.0", "--json"]);
        expect(byTag.code, byTag.stderr).toBe(0);
        expect(JSON.parse(byTag.stdout)).toMatchObject({ label: "1.0.0", tag: "v1.0.0", floating: "v1", commit: sha, template: "v{version}" });
        const byLabel = chant(dir, ["release", "tag", "1.0.0"]);
        expect(byLabel.stdout.trim()).toBe("v1.0.0");
        const none = chant(dir, ["release", "tag", "v1", "--json"]);
        expect(none.code).toBe(1);
        expect(JSON.parse(none.stdout).error.code).toBe("release-not-found");

        const dryPublish = chant(dir, ["release", "publish", "1.0.0"]);
        expect(dryPublish.code, dryPublish.stderr).toBe(0);
        expect(dryPublish.stdout).toContain("floating tag v1: moves to");
        expect(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/tags/v1"], { cwd: dir }).status).not.toBe(0);

        const publish = chant(dir, ["release", "publish", "1.0.0", "--yes", "--json"]);
        expect(publish.code, publish.stderr).toBe(0);
        expect(JSON.parse(publish.stdout)).toMatchObject({ floating: { name: "v1", move: true }, floatingMoved: true });
        expect(git(dir, "rev-parse", "v1^{commit}")).toBe(sha);
        expect(git(join(root, "app.git"), "rev-parse", "v1^{commit}")).toBe(sha);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

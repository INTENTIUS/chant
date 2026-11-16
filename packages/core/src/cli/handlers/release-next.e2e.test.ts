/**
 * #5159: `chant release next` prints the label the commits and intent files
 * since the previous release give, `chant release cut auto` cuts it and
 * records the intent files it consumed, and the next release skips them.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("release next and release cut auto (#5159)", () => {
  test(
    "the label follows the commits and intent files, the cut consumes the intent files, and the next release skips them",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-next-"));
      try {
        const dir = join(root, "app");
        git(root, "init", "-q", "--bare", "-b", "main", "app.git");
        git(root, "init", "-q", "-b", "main", dir);
        git(dir, "config", "user.email", "alice@example.com");
        git(dir, "config", "user.name", "Alice");
        git(dir, "remote", "add", "origin", join(root, "app.git"));
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev"], release: { tag: "v{version}" } };\n`);
        writeFileSync(
          join(dir, "api.component.ts"),
          `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
        );
        writeFileSync(join(dir, ".gitignore"), "dist/\n");
        const green = (message: string): string => {
          git(dir, "add", ".");
          git(dir, "commit", "-q", "-m", message);
          git(dir, "push", "-q", "origin", "main");
          git(dir, "fetch", "-q", "origin");
          const sha = git(dir, "rev-parse", "HEAD");
          git(dir, "tag", `ci/green/${sha}`);
          return sha;
        };
        green("chore: init");

        const none = chant(dir, ["release", "next", "--json"]);
        expect(none.code).toBe(1);
        expect(JSON.parse(none.stdout).error.code).toBe("release-next-no-previous");
        const first = chant(dir, ["release", "cut", "1.0.0", "--build", BUILD, "--yes", "--json"]);
        expect(first.code, first.stderr).toBe(0);

        writeFileSync(join(dir, "api.component.ts"), `${"// fixed\n"}export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`);
        mkdirSync(join(dir, ".chant", "release"), { recursive: true });
        writeFileSync(join(dir, ".chant", "release", "streaming.md"), "---\n'*': minor\n---\nThe api streams its responses.\n");
        const second = green("fix: close the socket");

        const next = chant(dir, ["release", "next", "--json"]);
        expect(next.code, next.stderr).toBe(0);
        const doc = JSON.parse(next.stdout);
        expect(doc).toMatchObject({ label: "1.1.0", bump: "minor", alreadyCut: false, from: { label: "1.0.0" }, tag: "v1.1.0", at: second });
        expect(doc.intents).toEqual([{ path: ".chant/release/streaming.md", added: second, bump: "minor", summary: "The api streams its responses." }]);
        const plain = chant(dir, ["release", "next"]);
        expect(plain.stdout.trim()).toBe("1.1.0");

        const cut = chant(dir, ["release", "cut", "auto", "--build", BUILD, "--yes", "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        const cutDoc = JSON.parse(cut.stdout);
        expect(cutDoc.label).toBe("1.1.0");
        expect(cutDoc.tag).toEqual({ name: "v1.1.0", created: true });
        expect(cutDoc.cut.intents).toEqual([{ path: ".chant/release/streaming.md", added: second, bump: "minor" }]);

        // The same commit answers the label it has, so a run started again cuts nothing new.
        expect(JSON.parse(chant(dir, ["release", "next", "--json"]).stdout)).toMatchObject({ label: "1.1.0", alreadyCut: true });

        // The intent file is still in the tree, and the next release does not take it again.
        writeFileSync(join(dir, "api.component.ts"), `${"// fixed again\n"}export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`);
        green("fix: one more");
        const after = JSON.parse(chant(dir, ["release", "next", "--json"]).stdout);
        expect(after).toMatchObject({ label: "1.1.1", bump: "patch", intents: [] });
        const pre = chant(dir, ["release", "next", "--pre", "rc"]);
        expect(pre.stdout.trim()).toBe("1.1.1-rc.0");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

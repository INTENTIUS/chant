/**
 * `chant release cut` and `chant release list` end to end (#4026): the cut
 * compiles each environment in a child chant with CHANT_ENV set, in a temp
 * repo, and the list prints the read contract's `releases` document. No
 * cloud is touched: the fixture's deploy is never run.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, REPO } from "../../workspace/__fixtures__/contract-repo";
import releasesSchema from "../../workspace/releases.schema.json";
import { contentDigest } from "../../content-digest";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];

function chant(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of ["GITHUB_RUN_ID", "CI_PIPELINE_ID", "GITHUB_ACTOR", "GITLAB_USER_LOGIN", "CHANT_ENV"]) delete env[k];
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;

describe("chant release cut and list", () => {
  test(
    "cuts a green commit once per environment's compile, refuses a commit that isn't green, and lists the release",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "chant-release-cut-"));
      try {
        git(dir, "init", "-q", "-b", "main");
        git(dir, "config", "user.email", "t@chant.dev");
        git(dir, "config", "user.name", "T");
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "prod", "pr-*"] };\n`);
        writeFileSync(
          join(dir, "api.component.ts"),
          `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
        );
        writeFileSync(join(dir, ".gitignore"), "dist/\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "init");
        const sha = git(dir, "rev-parse", "HEAD");

        const refused = chant(dir, "release", "cut", "v1", "--build", BUILD);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(/has no ci\/green tag.*\[release-commit-not-green\]/);

        git(dir, "tag", `ci/green/${sha}`);
        const cut = chant(dir, "release", "cut", "v1", "--build", BUILD, "--json");
        expect(cut.code, cut.stderr).toBe(0);
        const result = JSON.parse(cut.stdout);
        expect(result.label).toBe("v1");
        expect(result.release.commit).toBe(sha);
        expect(result.release.targets).toEqual([
          { env: "dev", params: [], templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"dev"}`) }] },
          { env: "prod", params: [], templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"prod"}`) }] },
        ]);

        const again = chant(dir, "release", "cut", "--build", BUILD, "--json");
        expect(again.code, again.stderr).toBe(0);
        expect(JSON.parse(again.stdout)).toMatchObject({ label: "v1", cut: null, release: { releaseDigest: result.release.releaseDigest } });

        const list = chant(dir, "release", "list", "--json");
        expect(list.code, list.stderr).toBe(0);
        const doc = JSON.parse(list.stdout);
        contract(releasesSchema).expectValid(doc);
        expect(doc.releases).toHaveLength(1);
        expect(doc.releases[0]).toMatchObject({ releaseDigest: result.release.releaseDigest, label: "v1", environments: [] });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

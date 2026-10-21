/**
 * `chant release cut --at <sha>` and `chant release candidates` end to end
 * (#4168 4.2): a cut of a chosen green commit of trunk from a temporary
 * worktree, while the checkout sits elsewhere with uncommitted changes, with
 * the label reaching the build as CHANT_RELEASE_LABEL (decision 5). A temp
 * repo with a temp bare remote; no cloud, no push of tags.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, REPO } from "../../workspace/__fixtures__/contract-repo";
import candidatesSchema from "../../workspace/release-candidates.schema.json";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITLAB_CI", "CI_PIPELINE_ID", "CHANT_ENV", "CHANT_RELEASE_LABEL"];
const { expectValid } = contract(candidatesSchema);

function chant(cwd: string, args: string[], extra: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of CI_VARS) delete env[k];
  Object.assign(env, extra);
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

// The template records the environment, the label, and which commit's file the build read.
const BUILD = `mkdir -p dist && printf '{"env":"%s","label":"%s","marker":"%s"}' "$CHANT_ENV" "$CHANT_RELEASE_LABEL" "$(cat marker.txt)" > dist/api.template.json`;

describe("chant release cut --at and release candidates", () => {
  test(
    "cuts a chosen green commit from a temporary worktree with the label in the build, and lists candidates",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-cut-at-"));
      try {
        const dir = join(root, "work");
        const remote = join(root, "origin.git");
        git(root, "init", "-q", "--bare", "-b", "main", remote);
        git(root, "init", "-q", "-b", "main", dir);
        git(dir, "config", "user.email", "t@chant.dev");
        git(dir, "config", "user.name", "T");
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "prod"] };\n`);
        writeFileSync(
          join(dir, "api.component.ts"),
          `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
        );
        writeFileSync(join(dir, ".gitignore"), "dist/\n");
        writeFileSync(join(dir, "marker.txt"), "one");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "one (#11)");
        const one = git(dir, "rev-parse", "HEAD");
        writeFileSync(join(dir, "marker.txt"), "two");
        git(dir, "commit", "-q", "-am", "two (#12)");
        const two = git(dir, "rev-parse", "HEAD");
        git(dir, "remote", "add", "origin", remote);
        git(dir, "push", "-q", "origin", "main");
        git(dir, "fetch", "-q", "origin");
        git(dir, "tag", `ci/green/${one}`);
        // The checkout is at two, not green, with an uncommitted change.
        writeFileSync(join(dir, "marker.txt"), "dirty");

        const unknown = chant(dir, ["release", "cut", "v1", "--at", "nope", "--build", BUILD]);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain("[release-at-unknown]");
        const notGreen = chant(dir, ["release", "cut", "v1", "--at", two, "--build", BUILD]);
        expect(notGreen.code).toBe(1);
        expect(notGreen.stderr).toContain("[release-commit-not-green]");

        const candidates = chant(dir, ["release", "candidates", "--json"]);
        expect(candidates.code, candidates.stderr).toBe(0);
        const doc = JSON.parse(candidates.stdout);
        expectValid(doc);
        expect(doc.candidates.map((c: { commit: string }) => c.commit)).toEqual([one]);
        expect(doc.candidates[0]).toMatchObject({ newFor: ["dev", "prod"], cut: [] });
        expect(doc.candidates[0].changes[0]).toMatchObject({ commit: one, pr: 11 });
        expect(doc.pending.map((c: { commit: string }) => c.commit)).toEqual([two]);

        const dry = chant(dir, ["release", "cut", "v1", "--at", one, "--build", BUILD, "--json"]);
        expect(dry.code, dry.stderr).toBe(0);
        expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, commit: one, at: { ref: one, commit: one } });

        const cut = chant(dir, ["release", "cut", "v1", "--at", one, "--build", BUILD, "--yes", "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        const result = JSON.parse(cut.stdout);
        expect(result.release.commit).toBe(one);
        expect(result.tag).toEqual({ name: "release/v1", created: true });
        expect(git(dir, "rev-parse", "release/v1^{commit}")).toBe(one);

        // The recorded template is commit one's, built with the label, and the checkout is untouched.
        const out = join(root, "export");
        const exported = chant(dir, ["release", "export", "v1", "--env", "prod", "-o", out]);
        expect(exported.code, exported.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(out, "dist", "api.template.json"), "utf-8"))).toEqual({ env: "prod", label: "v1", marker: "one" });
        expect(readFileSync(join(dir, "marker.txt"), "utf-8")).toBe("dirty");
        expect(git(dir, "rev-parse", "HEAD")).toBe(two);
        expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);

        const after = JSON.parse(chant(dir, ["release", "candidates", "--json"]).stdout);
        expect(after.candidates[0].cut).toEqual(["v1"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

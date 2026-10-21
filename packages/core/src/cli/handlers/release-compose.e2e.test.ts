/**
 * `chant release compose` end to end (#4168 4.3, mode b): a chosen trunk
 * change composed onto a released commit while trunk carries unready work,
 * a conflict that stops with nothing written, the tick judging the pushed
 * compose branch, and a cut of the composed commit that records its base,
 * its sources and a publish channel. A temp repo with a temp bare remote;
 * the tick's forge is a fake that answers check runs. No key or signer.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";
import { ciTick } from "../../workspace/ci-green";
import type { CheckRun, CiForge } from "../../workspace/ci-green-forge";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITLAB_CI", "CI_PIPELINE_ID", "CHANT_ENV", "CHANT_RELEASE_LABEL"];

function chant(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of CI_VARS) delete env[k];
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const BUILD = `mkdir -p dist && printf '{"env":"%s","marker":"%s","fix":"%s"}' "$CHANT_ENV" "$(cat marker.txt)" "$(cat fix.txt 2>/dev/null)" > dist/api.template.json`;
const PASSING: CheckRun[] = [{ id: 1, name: "test", status: "completed", conclusion: "success", url: null } as unknown as CheckRun];

describe("chant release compose", () => {
  test(
    "composes a fix onto a released commit, stops on a conflict, and cuts the composed commit once the tick has judged it green",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-compose-"));
      try {
        const dir = join(root, "work");
        const remote = join(root, "origin.git");
        git(root, "init", "-q", "--bare", "-b", "main", remote);
        git(root, "init", "-q", "-b", "main", dir);
        git(dir, "config", "user.email", "t@chant.dev");
        git(dir, "config", "user.name", "T");
        writeFileSync(
          join(dir, "chant.workspace.json"),
          JSON.stringify({ name: "w", schema: 1, members: [{ name: "api", dir: ".", kind: "chant" }], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"] } } }, null, 2),
        );
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
        // Trunk moves on: unready work, a fix, and work on top of the unready work.
        writeFileSync(join(dir, "marker.txt"), "two");
        git(dir, "commit", "-q", "-am", "unready (#12)");
        writeFileSync(join(dir, "fix.txt"), "fixed");
        git(dir, "add", "fix.txt");
        git(dir, "commit", "-q", "-m", "the fix (#13)\n\nChant-Record: work:fix-1");
        const fix = git(dir, "rev-parse", "HEAD");
        writeFileSync(join(dir, "marker.txt"), "four");
        git(dir, "commit", "-q", "-am", "more on unready (#14)");
        git(dir, "remote", "add", "origin", remote);
        git(dir, "push", "-q", "origin", "main");
        git(dir, "fetch", "-q", "origin");

        // A change that needs the unready one stops, naming it and the file, and writes nothing.
        const conflict = chant(dir, ["release", "compose", "bad", "--base", one, "--pr", "14", "--yes"]);
        expect(conflict.code).toBe(1);
        expect(conflict.stderr).toContain("[compose-conflict]");
        expect(conflict.stderr).toContain("marker.txt");
        expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/compose/bad"], { cwd: remote }).status).not.toBe(0);

        const dry = chant(dir, ["release", "compose", "hotfix", "--base", one, "--work", "fix-1", "--json"]);
        expect(dry.code, dry.stderr).toBe(0);
        expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, written: false, pushed: false, picked: [{ commit: fix, pr: 13, work: ["fix-1"] }] });

        const composed = chant(dir, ["release", "compose", "hotfix", "--base", one, "--pr", "13", "--yes", "--json"]);
        expect(composed.code, composed.stderr).toBe(0);
        const tip = JSON.parse(composed.stdout).tip as string;
        expect(git(remote, "rev-parse", "refs/heads/chant/compose/hotfix")).toBe(tip);
        expect(git(dir, "show", "-s", "--format=%(trailers:key=Chant-Composed-From,valueonly)", tip)).toBe(fix);

        // Not green yet, so no cut.
        const early = chant(dir, ["release", "cut", "v1.0.1", "--at", tip, "--build", BUILD]);
        expect(early.code).toBe(1);
        expect(early.stderr).toContain("[release-commit-not-green]");

        // The tick walks the compose branch and tags the composed commit green.
        const forge: CiForge = { kind: "github", checkRuns: async () => PASSING };
        const tick = await ciTick({ cwd: dir, forge, now: new Date() });
        expect(tick.composed.map((b) => b.branch)).toEqual(["chant/compose/hotfix"]);
        expect(tick.made).toContain(`ci/green/${tip}`);

        const cut = chant(dir, ["release", "cut", "v1.0.1", "--at", tip, "--build", BUILD, "--channel", "hotfix", "--yes", "--json"]);
        expect(cut.code, cut.stderr).toBe(0);
        const result = JSON.parse(cut.stdout);
        expect(result.release.commit).toBe(tip);
        expect(result.composed).toEqual({ branch: "chant/compose/hotfix", base: one, sources: [fix] });
        expect(result.cut).toMatchObject({ label: "v1.0.1", channel: "hotfix", composed: { base: one, sources: [fix] }, signature: null });

        // The release carries the fix on the released marker, not trunk's unready one.
        const out = join(root, "export");
        expect(chant(dir, ["release", "export", "v1.0.1", "--env", "prod", "-o", out]).code).toBe(0);
        expect(JSON.parse(spawnSync("cat", [join(out, "dist", "api.template.json")], { encoding: "utf-8" }).stdout)).toEqual({ env: "prod", marker: "one", fix: "fixed" });

        // A commit that is on neither trunk nor a compose branch is still refused.
        git(dir, "checkout", "-q", "-b", "side", one);
        writeFileSync(join(dir, "marker.txt"), "side");
        git(dir, "commit", "-q", "-am", "side");
        const side = git(dir, "rev-parse", "HEAD");
        git(dir, "checkout", "-q", "main");
        const refused = chant(dir, ["release", "cut", "v9", "--at", side, "--build", BUILD]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("[release-commit-not-on-trunk]");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

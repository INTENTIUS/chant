/**
 * #4027 requirement 3: the same command cuts the same release on a
 * workstation and in CI. Two clones of one commit, each with its own temp
 * bare remote, run `chant release cut v1 --yes`, one with a workstation's
 * environment and one with GitHub Actions'. The records are equivalent:
 * the release files are byte-identical, and the cut lines differ only in
 * the run id and its origin, the actor and the timestamp.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];

const CI_VARS = ["CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_ACTOR", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITLAB_CI", "CI_PIPELINE_ID", "GITLAB_USER_LOGIN", "CHANT_ENV"];

function chant(cwd: string, args: string[], extra: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CI_VARS) delete env[k];
  Object.assign(env, extra);
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 120_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;

/** Every file under `_releases/` on the clone's chant/lifecycle, by path, as bytes. */
function releaseFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of git(dir, "ls-tree", "-r", "--name-only", "chant/lifecycle", "_releases").split("\n").filter(Boolean)) {
    if (path.endsWith("cuts.jsonl")) continue;
    out.set(path, git(dir, "show", `chant/lifecycle:${path}`));
  }
  return out;
}

describe("a release cut on a workstation and one cut in CI (#4027)", () => {
  test(
    "from the same commit produce the same release files, and cut lines that differ only in run id, run origin, actor and timestamp",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-equiv-"));
      try {
        const seed = join(root, "seed");
        git(root, "init", "-q", "-b", "main", seed);
        git(seed, "config", "user.email", "seed@chant.dev");
        git(seed, "config", "user.name", "Seed");
        writeFileSync(join(seed, "chant.config.ts"), `export default { environments: ["dev", "prod"] };\n`);
        writeFileSync(
          join(seed, "api.component.ts"),
          `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
        );
        writeFileSync(join(seed, ".gitignore"), "dist/\n");
        git(seed, "add", ".");
        git(seed, "commit", "-q", "-m", "init");
        const sha = git(seed, "rev-parse", "HEAD");

        // Each clone pushes to a bare remote of its own, which holds main; the green tag is made locally in each.
        const clone = (name: string, email: string | null): string => {
          const dir = join(root, name);
          git(root, "init", "-q", "--bare", "-b", "main", `${name}.git`);
          git(root, "clone", "-q", seed, dir);
          git(dir, "remote", "set-url", "origin", join(root, `${name}.git`));
          git(dir, "push", "-q", "origin", "main");
          git(dir, "fetch", "-q", "origin");
          if (email) git(dir, "config", "user.email", email);
          git(dir, "tag", `ci/green/${sha}`);
          return dir;
        };
        const laptop = clone("laptop", "alice@example.com");
        const runner = clone("runner", null);

        const workstation = { USER: "alice" };
        const ci = {
          CI: "true",
          GITHUB_ACTIONS: "true",
          GITHUB_RUN_ID: "4242",
          GITHUB_ACTOR: "release-bot",
          GITHUB_REPOSITORY: "acme/app",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_SHA: sha,
          USER: "runner",
        };
        const cut = (dir: string, env: Record<string, string>) => {
          const r = chant(dir, ["release", "cut", "v1", "--build", BUILD, "--yes", "--json"], env);
          expect(r.code, r.stderr).toBe(0);
          return JSON.parse(r.stdout);
        };
        const a = cut(laptop, workstation);
        const b = cut(runner, ci);

        // The release is the same object, stored as the same bytes.
        expect(b.release).toEqual(a.release);
        const [filesA, filesB] = [releaseFiles(laptop), releaseFiles(runner)];
        expect([...filesA.keys()].sort()).toEqual([...filesB.keys()].sort());
        expect(filesA.size).toBeGreaterThan(0);
        for (const [path, bytes] of filesA) expect(filesB.get(path), path).toBe(bytes);

        // The cut lines, as stored, are equal apart from the run, the actor and the time.
        const line = (dir: string) => JSON.parse(git(dir, "show", "chant/lifecycle:_releases/cuts.jsonl"));
        const [la, lb] = [line(laptop), line(runner)];
        const rest = ({ runId: _r, runOrigin: _o, actor: _a, timestamp: _t, ...others }: Record<string, unknown>) => others;
        expect(rest(lb)).toEqual(rest(la));
        expect(Object.keys(la).sort()).toEqual(Object.keys(lb).sort());

        expect(la).toMatchObject({ actor: "alice@example.com", runId: expect.stringMatching(/^local-\d+$/), runOrigin: { forge: "local" }, signature: null });
        expect(lb).toMatchObject({
          actor: "release-bot",
          runId: "4242",
          runOrigin: { forge: "github", repo: "acme/app", url: "https://github.com/acme/app/actions/runs/4242" },
          signature: null,
        });

        // Both tag the commit the same way; the next command differs by where it ran.
        expect(a.tag).toEqual({ name: "release/v1", created: true });
        expect(b.tag).toEqual({ name: "release/v1", created: true });
        expect(a.next[0]).toBe("git push origin release/v1");
        expect(b.next[0]).toBe("chant release publish v1");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

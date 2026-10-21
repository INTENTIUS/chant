/**
 * `chant release cut`, `publish` and `list` end to end (#4026, #4027): the cut
 * compiles each environment in a child chant with CHANT_ENV set, in a temp
 * repo with a temp bare remote, and the list prints the read contract's
 * `releases` document. No cloud is touched: the fixture's deploy is never
 * run, no tag is pushed, and nothing is published: this member declares no
 * publish target (release-publish-targets.e2e.test.ts publishes to stand-ins).
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, REPO } from "../../workspace/__fixtures__/contract-repo";
import releasesSchema from "../../workspace/releases.schema.json";
import { contentDigest } from "../../content-digest";
import { sameWithYes } from "./release";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];

/** The CI variables a run in this suite may inherit, removed so the cut reads as a workstation's unless a test sets them. */
const CI_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_ACTOR",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITLAB_CI",
  "CI_PIPELINE_ID",
  "GITLAB_USER_LOGIN",
  "CHANT_ENV",
];

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

const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;

/** A member at `<root>/work` with one commit on main pushed to `<root>/origin.git`. */
function project(root: string): { dir: string; sha: string; remote: string } {
  const dir = join(root, "work");
  const remote = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", dir);
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
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  return { dir, sha: git(dir, "rev-parse", "HEAD"), remote };
}

const hasRef = (dir: string, ref: string) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: dir }).status === 0;

describe("chant release cut, publish and list", () => {
  test(
    "refuses a dirty tree, a commit not on trunk or not pushed, and one that isn't green; a dry run writes nothing; --yes cuts, tags and names the next command",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-cut-"));
      try {
        const { dir, sha, remote } = project(root);
        const cut = (...extra: string[]) => chant(dir, ["release", "cut", "v1", "--build", BUILD, ...extra]);

        writeFileSync(join(dir, "extra.component.ts"), "export const extra = {};\n");
        expect(cut().stderr).toMatch(/1 untracked file\(s\) such as extra\.component\.ts.*\[release-worktree-dirty\]/);
        unlinkSync(join(dir, "extra.component.ts"));
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev"] };\n`);
        expect(cut().stderr).toMatch(/1 tracked file\(s\) with uncommitted changes.*\[release-worktree-dirty\]/);
        git(dir, "checkout", "--", "chant.config.ts");

        git(dir, "checkout", "-q", "-b", "feature");
        git(dir, "commit", "-q", "--allow-empty", "-m", "feature");
        expect(cut().stderr).toMatch(/is not on origin\/main.*\[release-commit-not-on-trunk\]/);
        git(dir, "checkout", "-q", "main");
        git(dir, "commit", "-q", "--allow-empty", "-m", "unpushed");
        expect(cut().stderr).toMatch(/is on main( \(the branch origin\/HEAD names\))? but not on origin\/main, so it has not been pushed \[release-commit-not-pushed\]/);
        git(dir, "reset", "-q", "--hard", sha);

        const refused = cut();
        expect(refused.code).toBe(1);
        expect(refused.stderr).toMatch(/has no ci\/green tag.*\[release-commit-not-green\]/);
        git(dir, "tag", `ci/green/${sha}`);

        // A dry run by default: it compiles and prints the plan, and writes no ledger and no tag.
        const dry = cut();
        expect(dry.code, dry.stderr).toBe(0);
        expect(dry.stdout).toMatch(/^Dry run: cut .*v1.* from commit [0-9a-f]{12} \(on origin\/main, green\)/m);
        expect(dry.stdout).toContain("  actor t@chant.dev (from git user.email)");
        expect(dry.stdout).toContain("  tag release/v1, made here and not pushed");
        expect(dry.stdout).toContain("  dev: 1 template(s)");
        expect(dry.stdout).toContain("chant release publish v1: nothing, since this member declares no publish target (release.publish in chant.config.ts)");
        expect(dry.stderr).toContain(`Dry run: nothing was cut, signed or tagged. Run again with --yes to cut: ${sameWithYes(["release", "cut", "v1", "--build", BUILD])}`);
        const dryJson = JSON.parse(cut("--json").stdout);
        expect(dryJson).toMatchObject({ dryRun: true, label: "v1", commit: sha, actor: "t@chant.dev", actorSource: "git", tag: { name: "release/v1", exists: false }, build: [] });
        expect(dryJson.releaseDigest).toMatch(/^jcs1-sha256:/);
        expect(hasRef(dir, "refs/heads/chant/lifecycle")).toBe(false);
        expect(hasRef(dir, "refs/tags/release/v1")).toBe(false);

        const done = cut("--yes", "--json");
        expect(done.code, done.stderr).toBe(0);
        const result = JSON.parse(done.stdout);
        expect(result).toMatchObject({ dryRun: false, label: "v1", actor: "t@chant.dev", actorSource: "git", tag: { name: "release/v1", created: true } });
        expect(result.release.releaseDigest).toBe(dryJson.releaseDigest);
        expect(result.release.commit).toBe(sha);
        expect(result.release.targets).toEqual([
          { env: "dev", params: [], templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"dev"}`) }], trees: [] },
          { env: "prod", params: [], templates: [{ component: "api", path: "dist/api.template.json", digest: contentDigest(`{"env":"prod"}`) }], trees: [] },
        ]);
        expect(result.cut).toMatchObject({ actor: "t@chant.dev", runId: expect.stringMatching(/^local-\d+$/), runOrigin: { forge: "local" }, signature: null });
        expect(result.next).toEqual(["git push origin release/v1", "chant release publish v1", "chant components promote --release v1 --to dev"]);
        expect(git(dir, "rev-parse", "release/v1^{commit}")).toBe(sha);
        // chant pushes its ledger branch to the remote, and never a tag.
        expect(git(root, "ls-remote", "--tags", remote)).toBe("");

        const again = chant(dir, ["release", "cut", "--build", BUILD, "--yes"]);
        expect(again.code, again.stderr).toBe(0);
        expect(again.stderr).toContain("Already cut as");
        expect(again.stderr).toContain("tag release/v1 (already there), not pushed");
        expect(again.stderr).toContain("Next: git push origin release/v1");

        const list = chant(dir, ["release", "list", "--json"]);
        expect(list.code, list.stderr).toBe(0);
        const doc = JSON.parse(list.stdout);
        contract(releasesSchema).expectValid(doc);
        expect(doc.releases).toHaveLength(1);
        expect(doc.releases[0]).toMatchObject({ releaseDigest: result.release.releaseDigest, label: "v1", environments: [] });
        expect(doc.releases[0].cuts[0]).toMatchObject({ runId: result.cut.runId, runOrigin: { forge: "local" } });

        // #4168: the cut is not signed, and with no release gate or verified-releases group a publish takes it quietly.
        // A publish is a dry run without --yes, as a cut is.
        const dryPub = chant(dir, ["release", "publish", "v1"]);
        expect(dryPub.code, dryPub.stderr).toBe(0);
        expect(dryPub.stderr).not.toContain("release-unsigned");
        expect(dryPub.stderr).not.toContain("no signed cut");
        expect(dryPub.stdout).toContain("What would be published where:\n  nothing: this member declares no publish target (release.publish in chant.config.ts)");
        expect(dryPub.stderr).toContain("Dry run: nothing was published. Run again with --yes to publish: chant release publish v1 --yes");

        // Publish from the workstation: with no supply-chain group there is no OIDC warning either.
        const pub = chant(dir, ["release", "publish", "v1", "--yes"]);
        expect(pub.code, pub.stderr).toBe(0);
        expect(pub.stderr).not.toContain("without OIDC");
        expect(pub.stderr).toContain("Nothing was published: this member declares no publish target (release.publish in chant.config.ts).");
        expect(pub.stderr).toContain("chant components promote --release v1 --to dev");

        // The --json document records what is missing: no signature and no OIDC provenance.
        const asJson = chant(dir, ["release", "publish", "v1", "--json"]);
        expect(asJson.code, asJson.stderr).toBe(0);
        expect(JSON.parse(asJson.stdout)).toMatchObject({ dryRun: true, label: "v1", signature: { status: "unsigned" }, provenance: { oidc: false }, warnings: [], targets: [], published: [] });

        // In GitHub Actions with id-token: write the provenance is OIDC.
        const oidc = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" };
        const fromCi = chant(dir, ["release", "publish", "v1", "--json"], oidc);
        expect(fromCi.code, fromCi.stderr).toBe(0);
        expect(JSON.parse(fromCi.stdout)).toMatchObject({ dryRun: true, label: "v1", provenance: { oidc: true, ci: "github" }, warnings: [], targets: [], published: [] });

        const unknown = chant(dir, ["release", "publish", "v9"]);
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toMatch(/\[release-not-found\]/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

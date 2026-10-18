/**
 * `chant release publish` with targets, end to end (#4047): a member that
 * declares an npm target of two packages and an OCI target is cut, then
 * published to stand-ins only, a fake `npm` first on PATH and a registry fake
 * on 127.0.0.1 that this test starts and closes. The publish is a dry run
 * without --yes; with --yes and a CI OIDC token it runs npm with
 * --provenance for each package in order and pushes the image by digest; no
 * credential appears in its output or on `chant/lifecycle`; and a checkout
 * that moved past the release's commit is refused.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";
import { startFakeRegistry, writeFakeNpm, writeOciLayout, writePackage, type FakeRegistry } from "../../lifecycle/__fixtures__/publish-fakes";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const CI_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_SHA",
  "GITHUB_ACTOR",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITLAB_CI",
  "CI_PIPELINE_ID",
  "GITLAB_USER_LOGIN",
  "CHANT_ENV",
  "NODE_AUTH_TOKEN",
  "OCI_USERNAME",
  "OCI_PASSWORD",
];

/** Run chant without blocking this process, so the registry fake in it can answer. */
function chant(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of CI_VARS) delete env[k];
  Object.assign(env, extra);
  return new Promise((resolve) => {
    const child = spawn(CHANT[0]!, [...CHANT.slice(1), ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

const BUILD = `mkdir -p dist && printf '{"env":"%s"}' "$CHANT_ENV" > dist/api.template.json`;
const NPM_TOKEN = "npm_e2eSecretToken0042";
const OCI_PASSWORD = "oci-e2e-password-0042";
const REGISTRY_TOKEN = "registry-e2e-token-0042";

let reg: FakeRegistry;
let root: string;
beforeAll(async () => {
  reg = await startFakeRegistry({ username: "robot", password: OCI_PASSWORD, token: REGISTRY_TOKEN });
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-release-publish-targets-")));
});
afterAll(async () => {
  await reg.close();
  rmSync(root, { recursive: true, force: true });
});

describe("chant release publish with targets", () => {
  test(
    "a dry run by default; with --yes publishes two npm packages in order with --provenance and an image by digest, prints no credential, and refuses a moved checkout",
    async () => {
      const dir = join(root, "work");
      const remote = join(root, "origin.git");
      git(root, "init", "-q", "--bare", "-b", "main", remote);
      git(root, "init", "-q", "-b", "main", dir);
      git(dir, "config", "user.email", "t@chant.dev");
      git(dir, "config", "user.name", "T");
      const publish = [
        { type: "npm", packages: ["packages/core", "packages/cli"], access: "public" },
        { type: "oci", image: "image", repository: `${reg.host}/acme/api`, usernameEnv: "OCI_USERNAME", passwordEnv: "OCI_PASSWORD" },
      ];
      writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev"], release: { publish: ${JSON.stringify(publish)} } };\n`);
      writeFileSync(
        join(dir, "api.component.ts"),
        `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
      );
      writeFileSync(join(dir, ".gitignore"), "dist/\n");
      writePackage(join(dir, "packages", "core"), "@acme/core", "1.0.0");
      writePackage(join(dir, "packages", "cli"), "@acme/cli", "1.0.0");
      const { digest } = writeOciLayout(join(dir, "image"));
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "init");
      git(dir, "remote", "add", "origin", remote);
      git(dir, "push", "-q", "origin", "main");
      git(dir, "fetch", "-q", "origin");
      const sha = git(dir, "rev-parse", "HEAD");
      git(dir, "tag", `ci/green/${sha}`);

      const log = join(root, "npm.log");
      const bin = join(root, "bin");
      writeFakeNpm(bin, log);
      const path = { PATH: `${bin}:${process.env.PATH}` };
      const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; tokenSet: boolean }) : []);

      const dryCut = await chant(dir, ["release", "cut", "v1", "--build", BUILD], path);
      expect(dryCut.code, dryCut.stderr).toBe(0);
      expect(dryCut.stdout).toContain("chant release publish v1: npm (2 packages) to npm the registry npm's config names");
      expect(dryCut.stdout).toContain(`chant release publish v1: oci ${reg.host}/acme/api to ${reg.host}/acme/api`);
      const cut = await chant(dir, ["release", "cut", "v1", "--build", BUILD, "--yes"], path);
      expect(cut.code, cut.stderr).toBe(0);

      const secrets = { NODE_AUTH_TOKEN: NPM_TOKEN, OCI_USERNAME: "robot", OCI_PASSWORD };
      const oidc = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token-0042" };

      const dry = await chant(dir, ["release", "publish", "v1"], { ...path, ...secrets, ...oidc });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("What would be published where:");
      expect(dry.stdout).toContain("  npm (2 packages), with --provenance:\n    @acme/core@1.0.0 to the registry npm's config names, dist-tag latest\n    @acme/cli@1.0.0 to");
      expect(dry.stdout).toContain(`    image (tag v1) to ${reg.host}/acme/api@${digest}`);
      expect(dry.stderr).toContain("Dry run: nothing was published. Run again with --yes to publish: chant release publish v1 --yes");
      expect(calls()).toEqual([]);
      expect(reg.requests).toEqual([]);

      const pub = await chant(dir, ["release", "publish", "v1", "--yes"], { ...path, ...secrets, ...oidc });
      expect(pub.code, pub.stderr).toBe(0);
      expect(calls().map((c) => c.args)).toEqual([
        ["publish", join(dir, "packages/core"), "--access", "public", "--provenance"],
        ["publish", join(dir, "packages/cli"), "--access", "public", "--provenance"],
      ]);
      expect(calls().every((c) => c.tokenSet)).toBe(true);
      expect(reg.manifests.has(digest)).toBe(true);
      expect(reg.manifests.has("v1")).toBe(true);
      expect(pub.stderr).toContain(`published: image (tag v1) to ${reg.host}/acme/api@${digest}`);
      expect(pub.stderr).toContain("Published v1 to 2 target(s)");

      // No credential in the output, or anywhere on chant/lifecycle.
      const lifecycle = git(dir, "log", "-p", "--all");
      for (const secret of [NPM_TOKEN, OCI_PASSWORD, REGISTRY_TOKEN, "oidc-request-token-0042"]) {
        for (const text of [dry.stdout, dry.stderr, pub.stdout, pub.stderr, lifecycle]) expect(text).not.toContain(secret);
      }
      expect(pub.stderr).toContain("npm notice token [redacted]");

      // From a workstation the publish warns that it carries no provenance, and the plan offers none.
      const asJson = await chant(dir, ["release", "publish", "v1", "--json"], { ...path, ...secrets });
      expect(asJson.code, asJson.stderr).toBe(0);
      expect(asJson.stderr).toContain("this publish runs without OIDC");
      const doc = JSON.parse(asJson.stdout);
      expect(doc).toMatchObject({ dryRun: true, label: "v1", provenance: { oidc: false } });
      expect(doc.targets.map((t: { kind: string }) => t.kind)).toEqual(["npm", "oci"]);

      // A checkout past the release's commit is refused before anything runs.
      git(dir, "commit", "-q", "--allow-empty", "-m", "later");
      const moved = await chant(dir, ["release", "publish", "v1", "--yes"], { ...path, ...secrets, ...oidc });
      expect(moved.code).toBe(1);
      expect(moved.stderr).toMatch(/\[release-head-mismatch\]/);
      expect(calls()).toHaveLength(2);
    },
    240_000,
  );
});

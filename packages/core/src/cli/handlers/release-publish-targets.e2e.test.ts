/**
 * `chant release publish` with targets, end to end (#4047): a member that
 * declares an npm target of two packages and an OCI target is cut, then
 * published to stand-ins only, a fake `npm` first on PATH and a registry fake
 * on 127.0.0.1 that this test starts and closes. The publish is a dry run
 * without --yes; with --yes and a CI OIDC token it stages each package under
 * next with --provenance and the image by digest, then moves latest and the
 * tag (#4048); no credential appears in its output or on `chant/lifecycle`;
 * and a checkout that moved past the release's commit is refused. A publish
 * that fails part way is resumed from a fresh clone, as a CI job would, from
 * the record it pushed, and publishes nothing again.
 *
 * #4049: the first release is cut signed with a throwaway key the signers
 * file lists, and published as CI publishes it: each package carries its
 * SBOM, the image gets its SBOM and the release's provenance statement as
 * referrers, and the fake npm records `npm audit signatures` run over what
 * was published. The second is published unsigned under --allow-unsigned.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "../../workspace/__fixtures__/contract-repo";
import { readFakeNpmRegistry, startFakeRegistry, writeFakeNpm, writeLockfile, writeOciLayout, writePackage, type FakeRegistry } from "../../lifecycle/__fixtures__/publish-fakes";
import { hasSshKeygen } from "../../workspace/trust/test-repo";

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
  test.skipIf(!hasSshKeygen)(
    "a dry run by default; with --yes publishes a signed release's two npm packages in order with --provenance, audits their signatures, and an image by digest with its SBOM and provenance; prints no credential, and refuses a moved checkout",
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
      writeLockfile(dir);
      const { digest } = writeOciLayout(join(dir, "image"));
      // #4049: alice's throwaway key, which the signers file lists.
      const key = join(root, "alice-key");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "alice", "-f", key]);
      const alicePub = readFileSync(`${key}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ");
      mkdirSync(join(dir, ".chant"), { recursive: true });
      writeFileSync(join(dir, ".chant", "allowed_signers"), `alice ${alicePub}\n`);
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
      const cut = await chant(dir, ["release", "cut", "v1", "--build", BUILD, "--sign", key, "--yes"], path);
      expect(cut.code, cut.stderr).toBe(0);
      expect(cut.stderr).toContain("signed by alice");

      const secrets = { NODE_AUTH_TOKEN: NPM_TOKEN, OCI_USERNAME: "robot", OCI_PASSWORD };
      const oidc = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token-0042" };

      const dry = await chant(dir, ["release", "publish", "v1"], { ...path, ...secrets, ...oidc });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("What would be published where:");
      expect(dry.stdout).toContain("  npm (2 packages), with --provenance:\n    @acme/core@1.0.0 to the registry npm's config names, dist-tag next, then latest, carrying sbom.spdx.json\n    @acme/cli@1.0.0 to");
      expect(dry.stdout).toContain(`    image (tag v1) to ${reg.host}/acme/api@${digest}`);
      expect(dry.stderr).toContain("Dry run: nothing was published. Run again with --yes to publish: chant release publish v1 --yes");
      expect(calls()).toEqual([]);
      expect(reg.requests).toEqual([]);

      const pub = await chant(dir, ["release", "publish", "v1", "--yes"], { ...path, ...secrets, ...oidc });
      expect(pub.code, pub.stderr).toBe(0);
      expect(pub.stderr).toContain("signed by alice");
      expect(calls().map((c) => c.args)).toEqual([
        ["view", "@acme/core@1.0.0", "version"],
        ["publish", join(dir, "packages/core"), "--tag", "next", "--access", "public", "--provenance"],
        ["view", "@acme/cli@1.0.0", "version"],
        ["publish", join(dir, "packages/cli"), "--tag", "next", "--access", "public", "--provenance"],
        ["dist-tag", "add", "@acme/core@1.0.0", "latest"],
        ["dist-tag", "add", "@acme/cli@1.0.0", "latest"],
        // #4049: in CI, what was published is installed in an empty directory and its signatures and attestations audited.
        ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        ["audit", "signatures"],
      ]);
      expect(pub.stderr).toContain("2 packages have verified attestations");
      expect(calls().every((c) => c.tokenSet)).toBe(true);
      expect(reg.manifests.has(digest)).toBe(true);
      expect(reg.manifests.has("v1")).toBe(true);
      expect(pub.stderr).toContain(`published: image (tag v1) to ${reg.host}/acme/api@${digest}`);
      expect(pub.stderr).toContain("published: @acme/core@1.0.0 to the registry npm's config names, dist-tag latest, carrying sbom.spdx.json");
      expect(pub.stderr).toMatch(/published: sbom\.spdx\.json \(SBOM\) to .*@sha256:[0-9a-f]{64}, a referrer of the image/);
      expect(pub.stderr).toMatch(/published: release\.intoto\.json \(provenance\) to .*@sha256:[0-9a-f]{64}, a referrer of the image/);
      expect(pub.stderr).toContain("Published v1 to 2 target(s)");
      // The image's referrers: each names the image as its subject, and the provenance statement carries the cut's signature.
      const referrers = [...reg.manifests.entries()]
        .filter(([k]) => k.startsWith("sha256:") && k !== digest)
        .map(([, m]) => JSON.parse(m.bytes.toString("utf-8")) as { artifactType: string; subject: { digest: string }; layers: Array<{ digest: string }> });
      expect(referrers.map((m) => m.artifactType).sort()).toEqual(["application/spdx+json", "application/vnd.in-toto+json"]);
      expect(referrers.every((m) => m.subject.digest === digest)).toBe(true);
      const statement = JSON.parse(reg.blobs.get(referrers.find((m) => m.artifactType === "application/vnd.in-toto+json")!.layers[0]!.digest)!.toString("utf-8"));
      expect(statement).toMatchObject({
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ digest: { sha256: digest.slice(7) } }],
        predicateType: "https://intentius.io/chant/release/v1",
        predicate: { label: "v1", cut: { actor: "alice", namespace: "chant-release", signature: expect.stringMatching(/^-----BEGIN SSH SIGNATURE-----/) }, provenance: { kind: "oidc", ci: "github" } },
      });

      // The release verifies offline against the signers file at its commit.
      const verified = await chant(dir, ["release", "verify", "v1", "--json"]);
      expect(verified.code, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toMatchObject({ label: "v1", status: "verified", verifiedBy: { actor: "alice" } });

      // No credential in the output, or anywhere on chant/lifecycle.
      const lifecycle = git(dir, "log", "-p", "--all");
      for (const secret of [NPM_TOKEN, OCI_PASSWORD, REGISTRY_TOKEN, "oidc-request-token-0042"]) {
        for (const text of [dry.stdout, dry.stderr, pub.stdout, pub.stderr, lifecycle]) expect(text).not.toContain(secret);
      }
      expect(pub.stderr).toContain("npm notice token [redacted]");

      // From a workstation the plan offers no provenance, and with no supply-chain group says nothing about it (#4168).
      const asJson = await chant(dir, ["release", "publish", "v1", "--json"], { ...path, ...secrets });
      expect(asJson.code, asJson.stderr).toBe(0);
      expect(asJson.stderr).not.toContain("this publish runs without OIDC");
      const doc = JSON.parse(asJson.stdout);
      expect(doc).toMatchObject({ dryRun: true, label: "v1", provenance: { oidc: false } });
      expect(doc.targets.map((t: { kind: string }) => t.kind)).toEqual(["npm", "oci"]);

      // A checkout past the release's commit is refused before anything runs.
      git(dir, "commit", "-q", "--allow-empty", "-m", "later");
      const moved = await chant(dir, ["release", "publish", "v1", "--yes"], { ...path, ...secrets, ...oidc });
      expect(moved.code).toBe(1);
      expect(moved.stderr).toMatch(/\[release-head-mismatch\]/);
      expect(calls()).toHaveLength(8);
    },
    240_000,
  );
  test(
    "a publish that failed at the image is resumed from a fresh clone with the record it pushed, and stages no package again",
    async () => {
      const work = join(root, "resume");
      const remote = join(root, "resume-origin.git");
      git(root, "init", "-q", "--bare", "-b", "main", remote);
      git(root, "init", "-q", "-b", "main", work);
      git(work, "config", "user.email", "t@chant.dev");
      git(work, "config", "user.name", "T");
      const publish = [
        { type: "npm", packages: ["packages/core", "packages/cli"] },
        { type: "oci", image: "image", repository: `${reg.host}/acme/resume` },
      ];
      writeFileSync(join(work, "chant.config.ts"), `export default { environments: ["dev"], release: { publish: ${JSON.stringify(publish)} } };\n`);
      writeFileSync(
        join(work, "api.component.ts"),
        `export const api = { name: "api", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", template: "dist/api.template.json" }] }] };\n`,
      );
      writeFileSync(join(work, ".gitignore"), "dist/\n");
      writePackage(join(work, "packages", "core"), "@acme/rcore", "3.0.0");
      writePackage(join(work, "packages", "cli"), "@acme/rcli", "3.0.0");
      writeLockfile(work);
      const { digest } = writeOciLayout(join(work, "image"), "resume layer");
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", "init");
      git(work, "remote", "add", "origin", remote);
      git(work, "push", "-q", "origin", "main");
      git(work, "fetch", "-q", "origin");
      git(work, "tag", `ci/green/${git(work, "rev-parse", "HEAD")}`);

      const log = join(root, "resume-npm.log");
      const bin = join(root, "resume-bin");
      writeFakeNpm(bin, log);
      const path = { PATH: `${bin}:${process.env.PATH}` };
      const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { args: string[] }).args) : []);
      const cut = await chant(work, ["release", "cut", "r3", "--build", BUILD, "--yes"], path);
      expect(cut.code, cut.stderr).toBe(0);

      // The registry refuses the password: npm staged, the image did not, and no tag moved. These packages
      // are new, and npm makes a new package's first version latest whatever tag it was published under.
      const failed = await chant(work, ["release", "publish", "r3", "--allow-unsigned", "--yes"], { ...path, OCI_USERNAME: "robot", OCI_PASSWORD: "wrong-password-0042" });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toMatch(/\[publish-oci-failed\]/);
      expect(failed.stderr).toContain("nothing is visible yet; staged: npm (2 packages)");
      expect(failed.stderr).toContain("Run the same command again to resume; what went out is not published again: chant release publish r3 --allow-unsigned --yes");
      expect(failed.stderr).not.toContain("wrong-password-0042");
      expect(readFakeNpmRegistry(log).packages["@acme/rcore"]!.distTags).toEqual({ next: "3.0.0", latest: "3.0.0" });
      expect(calls().filter((a) => a[0] === "dist-tag")).toEqual([]);
      expect([...reg.manifests.keys()].filter((k) => k === "r3")).toEqual([]);

      // A CI job resumes on a fresh clone of the release's commit: the record came with chant/lifecycle.
      const fresh = join(root, "resume-fresh");
      git(root, "clone", "-q", remote, fresh);
      git(fresh, "config", "user.email", "ci@chant.dev");
      git(fresh, "config", "user.name", "CI");
      const before = calls().length;
      const dry = await chant(fresh, ["release", "publish", "r3", "--allow-unsigned"], path);
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("npm (2 packages) (staged by an earlier run; only revealed):");
      const resumed = await chant(fresh, ["release", "publish", "r3", "--allow-unsigned", "--yes", "--json"], { ...path, OCI_USERNAME: "robot", OCI_PASSWORD });
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(calls().slice(before)).toEqual([
        ["dist-tag", "add", "@acme/rcore@3.0.0", "latest"],
        ["dist-tag", "add", "@acme/rcli@3.0.0", "latest"],
      ]);
      expect(reg.manifests.has(digest)).toBe(true);
      expect(reg.manifests.has("r3")).toBe(true);
      const doc = JSON.parse(resumed.stdout);
      expect(doc.resumed).toEqual([{ target: "npm (2 packages)", step: "staged" }]);
      expect(doc.targets.map((t: { progress: string }) => t.progress)).toEqual(["staged", "none"]);
      const record = git(fresh, "show", "chant/lifecycle:_releases/publishes.jsonl").split("\n").map((l) => JSON.parse(l) as { kind: string; step: string });
      expect(record.map((l) => `${l.kind} ${l.step}`)).toEqual(["npm staged", "oci staged", "npm revealed", "oci revealed"]);
      expect(git(fresh, "log", "-p", "--all")).not.toContain(OCI_PASSWORD);
    },
    240_000,
  );
});

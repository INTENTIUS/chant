/**
 * #4047, #4048: the publish targets, each against a stand-in: npm against a
 * fake `npm` binary that keeps a registry with dist-tags in a file, OCI
 * against a registry fake on 127.0.0.1 started and closed here, and the forge
 * targets against a forge fake with draft releases. Each target stages, and
 * nothing is visible under `latest`, a moved tag or a published release until
 * its reveal runs. Nothing reaches a network or a real registry, and no token
 * is ever printed.
 */

import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor, REDACTED } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { createPublishTargets } from "./publish-targets";
import { memberSbom } from "./publish-attachments";
import { parseRepository } from "./publish-oci";
import { PublishTargetError, type PublishContext, type PublishTarget, type PublishedTarget } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { readFakeNpmRegistry, seedFakeNpmRegistry, startFakeForge, startFakeRegistry, writeFakeNpm, writeLockfile, writeOciLayout, writePackage } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-targets-"));
  dirs.push(d);
  return d;
};

const OIDC = { oidc: true, ci: "github" as const, reason: "GitHub Actions hands this job an OIDC token" };
const NO_OIDC = { oidc: false, ci: null, reason: "this run is not in CI, and a workstation has no OIDC token" };

function context(cwd: string, over: Partial<PublishContext> & { artifacts?: ReleaseArtifact[] } = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? {};
  const redactor = over.redactor ?? createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: over.artifacts ?? [], targets: [{ env: "dev", params: [], templates: [] }] });
  return {
    release,
    label: "v1.4.0",
    releaseTag: "release/v1.4.0",
    provenance: NO_OIDC,
    cwd,
    tag: null,
    env,
    redactor,
    log: (l) => lines.push(redactor.redact(l)),
    ...over,
    lines,
  };
}

const decl = (d: unknown) => PublishDeclarationSchema.parse(d);
/** Both steps of one target, as a publish of that target alone runs them. */
const publish = async (t: PublishTarget, ctx: PublishContext): Promise<PublishedTarget> => t.reveal(ctx, await t.stage(ctx));
async function refused(p: Promise<unknown>): Promise<PublishTargetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishTargetError) return err;
    throw err;
  }
  throw new Error("expected a PublishTargetError");
}

describe("credentials", () => {
  test("the redactor masks token variables, values it is given, and npm and header token forms", () => {
    const r = createRedactor({ GITHUB_TOKEN: "ghp_abcdef123456", PATH: "/usr/bin" }, ["MY_SECRET"]);
    r.add("s3cret-value");
    r.add("ab");
    expect(r.redact("token ghp_abcdef123456 and s3cret-value, ab, /usr/bin")).toBe(`token ${REDACTED} and ${REDACTED}, ab, /usr/bin`);
    expect(r.redact("//registry.npmjs.org/:_authToken=npm_xyz789")).toBe(`//registry.npmjs.org/:_authToken=${REDACTED}`);
    expect(r.redact("Authorization: Bearer eyJhbGciOi.x.y")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(r.redact("PRIVATE-TOKEN: glpat-123")).toBe(`PRIVATE-TOKEN: ${REDACTED}`);
  });

  test("a declaration names variables, never values, and an unknown key is refused", () => {
    expect(() => decl({ type: "oci", image: "x", repository: "ghcr.io/a/b", password: "hunter2" })).toThrow();
    expect(() => decl({ type: "forge", forge: "github", repo: "a/b", assets: ["x"], tokenEnv: "not a name" })).toThrow();
    expect(decl({ type: "npm", packages: ["a"] })).toEqual({ type: "npm", packages: ["a"] });
  });
});

describe("npm", () => {
  function setup(): { dir: string; npm: string; log: string } {
    const dir = temp();
    writePackage(join(dir, "packages", "core"), "@acme/core", "1.4.0");
    writePackage(join(dir, "packages", "cli"), "@acme/cli", "1.4.0");
    writePackage(join(dir, "packages", "kit"), "@acme/kit", "1.4.0");
    // The third is packed, as npm pack writes it.
    writePackage(join(dir, "stage", "package"), "@acme/kit", "1.4.0");
    execFileSync("tar", ["-czf", join(dir, "kit.tgz"), "-C", join(dir, "stage"), "package"], { stdio: "ignore" });
    rmSync(join(dir, "stage"), { recursive: true });
    const log = join(dir, "npm.log");
    // The registry holds the previous release, 1.3.0, as latest.
    seedFakeNpmRegistry(log, {
      packages: Object.fromEntries(["@acme/core", "@acme/cli", "@acme/kit"].map((n) => [n, { versions: ["1.3.0"], distTags: { latest: "1.3.0" } }])),
    });
    return { dir, npm: writeFakeNpm(join(dir, "bin"), log), log };
  }
  const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; tokenSet: boolean }) : []);
  const latest = (log: string) => Object.fromEntries(Object.entries(readFakeNpmRegistry(log).packages).map(([n, p]) => [n, p.distTags.latest]));

  test("stages a set under next in the order declared, with nothing under latest until the reveal moves core's latest first", async () => {
    const { dir, npm, log } = setup();
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["packages/core", "packages/cli", "kit.tgz"], access: "public" })], { npm });
    const env = { PATH: process.env.PATH, NODE_AUTH_TOKEN: "npm_secretToken42" };
    const ctx = context(dir, { env, provenance: OIDC });

    const planned = await target!.plan(ctx);
    expect(planned.map((i) => i.name)).toEqual(["@acme/core@1.4.0", "@acme/cli@1.4.0", "@acme/kit@1.4.0"]);
    expect(planned[0]!.destination).toBe("the registry npm's config names, dist-tag next, then latest");
    expect(calls(log)).toEqual([]);

    const staged = await target!.stage(ctx);
    expect(staged.items.map((i) => i.name)).toEqual(["@acme/core@1.4.0", "@acme/cli@1.4.0", "@acme/kit@1.4.0"]);
    expect(calls(log).filter((c) => c.args[0] === "publish").map((c) => c.args)).toEqual([
      ["publish", join(dir, "packages/core"), "--tag", "next", "--access", "public", "--provenance"],
      ["publish", join(dir, "packages/cli"), "--tag", "next", "--access", "public", "--provenance"],
      ["publish", join(dir, "kit.tgz"), "--tag", "next", "--access", "public", "--provenance"],
    ]);
    // Staged: every version is on the registry under next, and latest has not moved.
    expect(latest(log)).toEqual({ "@acme/core": "1.3.0", "@acme/cli": "1.3.0", "@acme/kit": "1.3.0" });
    expect(readFakeNpmRegistry(log).packages["@acme/cli"]!.distTags.next).toBe("1.4.0");

    const before = calls(log).length;
    const done = await target!.reveal(ctx, staged);
    const moves = calls(log).slice(before).map((c) => c.args);
    expect(moves).toEqual([
      ["dist-tag", "add", "@acme/core@1.4.0", "latest"],
      ["dist-tag", "add", "@acme/cli@1.4.0", "latest"],
      ["dist-tag", "add", "@acme/kit@1.4.0", "latest"],
      // #4049: with an OIDC token, what was published is installed in an empty directory and its signatures audited.
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      ["audit", "signatures"],
    ]);
    expect(done.items.map((i) => i.sbom)).toEqual(Array(3).fill("sbom.spdx.json"));
    expect(latest(log)).toEqual({ "@acme/core": "1.4.0", "@acme/cli": "1.4.0", "@acme/kit": "1.4.0" });
    expect(done.items.map((i) => i.destination)).toEqual(Array(3).fill("the registry npm's config names, dist-tag latest"));

    // npm got the token from the run's environment; chant printed none of it.
    expect(calls(log).every((x) => x.tokenSet)).toBe(true);
    const out = ctx.lines.join("\n");
    expect(out).toContain(`npm notice token ${REDACTED}`);
    expect(out).toContain(`_authToken=${REDACTED}`);
    expect(out).not.toContain("npm_secretToken42");
  });

  test("passes no --provenance without an OIDC token, passes the registry to each command, and reveals under the context's tag", async () => {
    const { dir, npm, log } = setup();
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["kit.tgz"], registry: "http://127.0.0.1:4873/" })], { npm });
    const ctx = context(dir, { env: { PATH: process.env.PATH }, tag: "beta" });
    const done = await publish(target!, ctx);
    expect(done.items).toEqual([{ name: "@acme/kit@1.4.0", destination: "http://127.0.0.1:4873/, dist-tag beta", digest: expect.stringMatching(/^sha256:/), sbom: "sbom.spdx.json" }]);
    expect(calls(log).map((c) => c.args)).toEqual([
      ["view", "@acme/kit@1.4.0", "version", "--registry", "http://127.0.0.1:4873/"],
      ["publish", join(dir, "kit.tgz"), "--tag", "next", "--registry", "http://127.0.0.1:4873/"],
      ["dist-tag", "add", "@acme/kit@1.4.0", "beta", "--registry", "http://127.0.0.1:4873/"],
    ]);
    expect(readFakeNpmRegistry(log).packages["@acme/kit"]!.distTags).toEqual({ latest: "1.3.0", next: "1.4.0", beta: "1.4.0" });
  });

  test("a stage that failed part way names what it staged and, run again, publishes only the rest; a tag move that fails names what moved", async () => {
    const { dir, npm, log } = setup();
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["packages/core", "packages/cli", "packages/kit"] })], { npm });
    const err = await refused(target!.stage(context(dir, { env: { PATH: process.env.PATH, FAKE_NPM_FAIL: "packages/cli" } })));
    expect(err.code).toBe("publish-npm-failed");
    expect(err.message).toMatch(/npm publish of @acme\/cli@1\.4\.0 exited 1, after @acme\/core@1\.4\.0 were staged under next: npm error 403 Forbidden/);
    expect(latest(log)["@acme/core"]).toBe("1.3.0");

    const before = calls(log).length;
    const ctx = context(dir, { env: { PATH: process.env.PATH, FAKE_NPM_FAIL_TAG: "@acme/cli" } });
    const staged = await target!.stage(ctx);
    const publishes = calls(log).slice(before).filter((c) => c.args[0] === "publish").map((c) => c.args[1]);
    expect(publishes).toEqual([join(dir, "packages/cli"), join(dir, "packages/kit")]);
    expect(staged.items.map((i) => [i.name, i.present ?? false])).toEqual([["@acme/core@1.4.0", true], ["@acme/cli@1.4.0", false], ["@acme/kit@1.4.0", false]]);
    expect(ctx.lines.join("\n")).toContain("@acme/core@1.4.0 is already on the registry; not published again");

    const tagErr = await refused(target!.reveal(ctx, staged));
    expect(tagErr.code).toBe("publish-npm-tag-failed");
    expect(tagErr.message).toMatch(/npm dist-tag add @acme\/cli@1\.4\.0 latest exited 1, after latest moved for @acme\/core@1\.4\.0/);
    expect(latest(log)).toEqual({ "@acme/core": "1.4.0", "@acme/cli": "1.3.0", "@acme/kit": "1.3.0" });

    const [missing] = await createPublishTargets([decl({ type: "npm", packages: ["packages/nope"] })], { npm });
    expect((await refused(missing!.plan(context(dir)))).code).toBe("publish-file-missing");

    const [packed] = await createPublishTargets([decl({ type: "npm", packages: ["kit.tgz"] })], { npm });
    const other: ReleaseArtifact = { component: "kit", kind: "asset", path: "kit.tgz", digest: "sha256:" + "0".repeat(64) };
    expect((await refused(packed!.plan(context(dir, { artifacts: [other] })))).code).toBe("publish-artifact-digest-mismatch");
  });
});

describe("oci", () => {
  test("parses GHCR, Docker Hub and local registries", () => {
    expect(parseRepository("ghcr.io/acme/api")).toEqual({ host: "ghcr.io", base: "https://ghcr.io", name: "acme/api" });
    expect(parseRepository("docker.io/nginx")).toEqual({ host: "docker.io", base: "https://registry-1.docker.io", name: "library/nginx" });
    expect(parseRepository("acme/api")).toEqual({ host: "docker.io", base: "https://registry-1.docker.io", name: "acme/api" });
    expect(parseRepository("127.0.0.1:5000/acme/api")).toEqual({ host: "127.0.0.1:5000", base: "http://127.0.0.1:5000", name: "acme/api" });
  });

  test("stages by digest with no tag moved until the reveal, through a Bearer challenge; a stage run again pushes nothing; no credential is printed", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "oci-pass-9876", token: "registry-token-abcdef" });
    try {
      const dir = temp();
      writeLockfile(dir);
      const { digest, configDigest } = writeOciLayout(join(dir, "dist", "api.oci"));
      const repo = `${reg.host}/acme/api`;
      const [target] = await createPublishTargets([decl({ type: "oci", image: "dist/api.oci", repository: repo, tags: ["{label}", "latest"] })], {});
      const env = { OCI_USERNAME: "robot", OCI_PASSWORD: "oci-pass-9876" };
      const ctx = context(dir, { env, artifacts: [{ component: "api", kind: "image", path: "dist/api.oci", digest: configDigest }] });

      const planned = await target!.plan(ctx);
      expect(planned[0]).toEqual({ name: "dist/api.oci (tags v1.4.0, latest)", destination: `${repo}@${digest}`, digest });
      // #4049: the SBOM and the provenance statement go as referrers of the image.
      expect(planned.slice(1).map((i) => [i.name, i.attachment])).toEqual([["sbom.spdx.json", "sbom"], ["release.intoto.json", "provenance"]]);
      expect(reg.requests).toEqual([]);

      const staged = await target!.stage(ctx);
      expect(staged.items[0]).toEqual({ name: "dist/api.oci", destination: `${repo}@${digest}`, digest });
      const referrers = staged.items.slice(1).map((i) => i.digest!);
      expect(referrers).toEqual(planned.slice(1).map((i) => i.digest));
      // Two image blobs, then the empty config and each attached file.
      expect(reg.uploads).toBe(5);
      // Staged: the manifest and its referrers are there by digest, and no tag names them yet.
      expect([...reg.manifests.keys()]).toEqual([digest, ...referrers]);
      expect(reg.requests.some((r) => r.authorization === "Bearer registry-token-abcdef")).toBe(true);

      const again = await target!.stage(ctx);
      expect(again.items.map((i) => i.present)).toEqual([true, true, true]);
      expect(reg.uploads).toBe(5);
      expect([...reg.manifests.keys()]).toEqual([digest, ...referrers]);

      const done = await target!.reveal(ctx, staged);
      expect(done.items[0]!.destination).toBe(`${repo}@${digest}`);
      expect([...reg.manifests.keys()].sort()).toEqual([digest, ...referrers, "latest", "v1.4.0"].sort());
      expect(reg.manifests.get("v1.4.0")!.type).toBe("application/vnd.oci.image.manifest.v1+json");
      const out = ctx.lines.join("\n");
      expect(out).toContain("with credentials from OCI_PASSWORD");
      expect(out).not.toMatch(/oci-pass-9876|registry-token-abcdef/);
    } finally {
      await reg.close();
    }
  });

  test("pushes a docker save style tar with docker config credentials; refuses bad credentials, a layout the release did not build, and a missing one", async () => {
    const reg = await startFakeRegistry({ username: "dh", password: "dockerhub-pat-555", token: "tok-777777" });
    try {
      const dir = temp();
      writeLockfile(dir);
      const { digest } = writeOciLayout(join(dir, "layout"), "other layer");
      execFileSync("tar", ["-cf", join(dir, "api.tar"), "-C", join(dir, "layout"), "."], { stdio: "ignore" });
      const dockerDir = join(dir, "docker");
      mkdirSync(dockerDir, { recursive: true });
      writeFileSync(join(dockerDir, "config.json"), JSON.stringify({ auths: { [reg.host]: { auth: Buffer.from("dh:dockerhub-pat-555").toString("base64") } } }));
      const [target] = await createPublishTargets([decl({ type: "oci", image: "api.tar", repository: `${reg.host}/acme/api` })], {});
      const ctx = context(dir, { env: { DOCKER_CONFIG: dockerDir } });
      await publish(target!, ctx);
      expect(reg.manifests.has(digest)).toBe(true);
      expect(reg.manifests.has("v1.4.0")).toBe(true);
      expect(ctx.lines.join("\n")).toContain("with credentials from docker config");
      expect(ctx.lines.join("\n")).not.toContain("dockerhub-pat-555");

      const wrong = context(dir, { env: { OCI_PASSWORD: "wrong-password" } });
      const err = await refused(target!.stage(wrong));
      expect(err.code).toBe("publish-oci-failed");
      expect(err.message).not.toContain("wrong-password");

      const mismatch = context(dir, { artifacts: [{ component: "api", kind: "image", path: "api.tar", digest: "sha256:" + "1".repeat(64) }] });
      expect((await refused(target!.plan(mismatch))).code).toBe("publish-artifact-digest-mismatch");
      const [missing] = await createPublishTargets([decl({ type: "oci", image: "nope.tar", repository: `${reg.host}/a` })], {});
      expect((await refused(missing!.plan(context(dir)))).code).toBe("publish-file-missing");
    } finally {
      await reg.close();
    }
  });
});

describe("forge release assets", () => {
  function assetDir(): string {
    const dir = temp();
    writeFileSync(join(dir, "api-linux.tar.gz"), "binary bytes");
    writeFileSync(join(dir, "api-darwin.tar.gz"), "other bytes");
    writeLockfile(dir);
    return dir;
  }
  const DIGEST = `sha256:${createHash("sha256").update("binary bytes").digest("hex")}`;
  const ASSETS = ["api-linux.tar.gz", "api-darwin.tar.gz"];
  /** The declared assets, then the SBOM and the provenance statement chant attaches (#4049). */
  const ATTACHED = [...ASSETS, "sbom.spdx.json", "release.intoto.json"];

  test("GitHub: uploads to a draft release at the commit, which no consumer sees until the reveal publishes it; a stage run again uploads only what is missing", async () => {
    const dir = assetDir();
    const api = "https://api.github.test";
    const forge = startFakeForge("github", api, "acme/api");
    const [target] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ASSETS })], { fetch: forge.fetch });
    const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_tokentoken" } });
    expect((await target!.plan(ctx))[0]).toEqual({ name: "api-linux.tar.gz", destination: "github acme/api release release/v1.4.0, asset api-linux.tar.gz", digest: DIGEST });
    expect(forge.calls).toEqual([]);

    // The second upload fails: the draft keeps the first, and nothing is visible.
    forge.failOnce("POST https://uploads.forge.test/repos/acme/api/releases/100/assets?name=api-darwin");
    expect((await refused(target!.stage(ctx))).code).toBe("publish-forge-failed");
    expect(forge.releases).toMatchObject([{ tag_name: "release/v1.4.0", draft: true, target: ctx.release.commit, assets: [{ name: "api-linux.tar.gz" }] }]);
    expect(forge.visible()).toEqual([]);

    const n = forge.calls.length;
    const staged = await target!.stage(ctx);
    const uploads = forge.calls.slice(n).filter((c) => c.url.startsWith("https://uploads.forge.test"));
    expect(uploads.map((c) => c.url)).toEqual(ATTACHED.slice(1).map((a) => `https://uploads.forge.test/repos/acme/api/releases/100/assets?name=${a}`));
    expect(uploads[0]!.headers).toMatchObject({ authorization: "Bearer ghs_tokentoken", "content-type": "application/octet-stream" });
    expect(staged.items.map((i) => i.present ?? false)).toEqual([true, false, false, false]);
    expect(staged.items.map((i) => i.attachment)).toEqual([undefined, undefined, "sbom", "provenance"]);
    expect(staged.state).toEqual({ releaseId: "100" });
    expect(forge.releases).toHaveLength(1);
    expect(forge.visible()).toEqual([]);

    await target!.reveal(ctx, staged);
    expect(forge.visible()).toEqual([{ tag: "release/v1.4.0", assets: ATTACHED }]);
    expect(forge.calls.at(-1)).toMatchObject({ method: "PATCH", url: `${api}/repos/acme/api/releases/100`, body: JSON.stringify({ draft: false }) });
    expect(ctx.lines.join("\n")).not.toContain("ghs_tokentoken");

    // Published with every asset: a stage finds it done and uploads nothing.
    const m = forge.calls.length;
    const again = await target!.stage(ctx);
    expect(again.state).toEqual({ published: "true" });
    expect(forge.calls.slice(m).map((c) => c.method)).toEqual(["GET"]);
  });

  test("GitHub: a release already published without the assets, and an asset on the draft that differs, are refused", async () => {
    const dir = assetDir();
    const api = "https://api.github.test";
    const published = startFakeForge("github", api, "acme/api", [{ id: 7, tag_name: "release/v1.4.0", draft: false, target: "x", assets: [] }]);
    const [t1] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ASSETS })], { fetch: published.fetch });
    const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_tokentoken" } });
    expect((await refused(t1!.stage(ctx))).code).toBe("publish-forge-release-published");
    expect(published.calls.every((c) => c.method === "GET")).toBe(true);

    const differs = startFakeForge("github", api, "acme/api", [{ id: 7, tag_name: "release/v1.4.0", draft: true, target: "x", assets: [{ name: "api-linux.tar.gz", digest: "sha256:" + "2".repeat(64), bytes: "x" }] }]);
    const [t2] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ASSETS })], { fetch: differs.fetch });
    expect((await refused(t2!.stage(ctx))).code).toBe("publish-forge-asset-exists");
  });

  test("GitLab: assets go to the generic package registry with a CI job token, and the release is made with its links only at the reveal", async () => {
    const dir = assetDir();
    const api = "https://gitlab.test/api/v4";
    const project = `${api}/projects/acme%2Fapi`;
    const forge = startFakeForge("gitlab", api, "acme/api");
    const [target] = await createPublishTargets([decl({ type: "forge", forge: "gitlab", repo: "acme/api", assets: ASSETS })], { fetch: forge.fetch });
    const ctx = context(dir, { env: { CI_JOB_TOKEN: "glcbt-jobtoken", CI_API_V4_URL: api } });
    const staged = await target!.stage(ctx);
    expect(staged.items.map((i) => i.destination)).toEqual(ATTACHED.map((a) => `${project}/packages/generic/release/v1.4.0/${a}`));
    expect(forge.calls.map((c) => c.method)).toEqual(["GET", "PUT", "PUT", "PUT", "PUT"]);
    expect(forge.calls[1]!.headers).toMatchObject({ "job-token": "glcbt-jobtoken" });
    expect(forge.visible()).toEqual([]);

    await target!.reveal(ctx, staged);
    expect(forge.visible()).toEqual([{ tag: "release/v1.4.0", assets: ATTACHED }]);
    expect(JSON.parse(forge.calls.at(-1)!.body as string)).toEqual({
      tag_name: "release/v1.4.0",
      ref: ctx.release.commit,
      name: "v1.4.0",
      assets: { links: ATTACHED.map((a) => ({ name: a, url: `${project}/packages/generic/release/v1.4.0/${a}`, link_type: "package" })) },
    });
  });

  test("Forgejo: a multipart upload to a draft, published at the reveal; it needs an API root, a token and a tag", async () => {
    const dir = assetDir();
    const api = "https://forgejo.test/api/v1";
    const forge = startFakeForge("forgejo", api, "acme/api");
    const make = async (over: Record<string, unknown> = {}) => (await createPublishTargets([decl({ type: "forge", forge: "forgejo", repo: "acme/api", assets: ["api-linux.tar.gz"], ...over })], { fetch: forge.fetch }))[0]!;
    expect((await refused((await make()).plan(context(dir, { env: { FORGEJO_TOKEN: "fj-token-1" } })))).code).toBe("publish-forge-no-api");
    expect((await refused((await make({ api })).plan(context(dir, { env: {} })))).code).toBe("publish-credentials-missing");
    expect((await refused((await make({ api })).plan(context(dir, { env: { FORGEJO_TOKEN: "fj-token-1" }, releaseTag: null, label: null })))).code).toBe("publish-forge-no-tag");

    const ctx = context(dir, { env: { FORGEJO_TOKEN: "fj-token-1" } });
    const target = await make({ api });
    const staged = await target.stage(ctx);
    const upload = forge.calls.find((c) => c.url.endsWith("?name=api-linux.tar.gz"))!;
    expect(upload.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=chant-/);
    expect(upload.headers.authorization).toBe("token fj-token-1");
    expect(Buffer.from(upload.body as Uint8Array).toString()).toContain('name="attachment"; filename="api-linux.tar.gz"');
    expect(forge.releases[0]).toMatchObject({ draft: true });
    expect(forge.releases[0]!.assets[0]).toMatchObject({ name: "api-linux.tar.gz", bytes: "binary bytes" });
    expect(forge.visible()).toEqual([]);
    await target.reveal(ctx, staged);
    expect(forge.visible()).toEqual([{ tag: "release/v1.4.0", assets: ["api-linux.tar.gz", "sbom.spdx.json", "release.intoto.json"] }]);
    expect(ctx.lines.join("\n")).not.toContain("fj-token-1");
  });
});

describe("SBOMs and provenance (#4049)", () => {
  const CUT = { actor: "alice", label: "v1.4.0", timestamp: "2026-10-17T10:00:00.000Z", runId: "local-1", signature: "-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n" };

  test("npm: a package carries its SBOM; under supply-chain one with none is refused; one that is not SPDX or CycloneDX is refused; sbom: false publishes without", async () => {
    const dir = temp();
    writePackage(join(dir, "with"), "@acme/with", "1.0.0");
    writePackage(join(dir, "without"), "@acme/without", "1.0.0", false);
    writePackage(join(dir, "bad"), "@acme/bad", "1.0.0", false);
    writeFileSync(join(dir, "bad", "bom.json"), JSON.stringify({ not: "an sbom" }));
    writePackage(join(dir, "cdx", "package"), "@acme/cdx", "1.0.0", false);
    writeFileSync(join(dir, "cdx", "package", "bom.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" }));
    execFileSync("tar", ["-czf", join(dir, "cdx.tgz"), "-C", join(dir, "cdx"), "package"], { stdio: "ignore" });
    const npm = writeFakeNpm(join(dir, "bin"), join(dir, "npm.log"));
    const plan = async (d: Record<string, unknown>, requireSbom = true) => (await createPublishTargets([decl({ type: "npm", ...d })], { npm }))[0]!.plan(context(dir, { requireSbom }));

    expect((await plan({ packages: ["with"] }))[0]!.sbom).toBe("sbom.spdx.json");
    // #4168: outside supply-chain a package with none publishes without one, quietly.
    expect((await plan({ packages: ["without"] }, false))[0]!.sbom).toBeUndefined();
    const missing = await refused(plan({ packages: ["without"] }));
    expect(missing.code).toBe("publish-sbom-missing");
    expect(missing.message).toBe("@acme/without (without) carries no SBOM: npm keeps no file beside a package, so its SBOM goes in it, and none of sbom.spdx.json, sbom.cdx.json, sbom.cyclonedx.json is at its root");
    expect(missing.fix).toContain("npm sbom --sbom-format spdx > without/sbom.spdx.json");
    expect((await refused(plan({ packages: ["bad"], sbom: "bom.json" }))).code).toBe("publish-sbom-invalid");
    expect((await plan({ packages: ["without"], sbom: false }))[0]!.sbom).toBeUndefined();
    // In a packed .tgz, the file the declaration names under package/.
    expect((await plan({ packages: ["cdx.tgz"], sbom: "bom.json" }))[0]!.sbom).toBe("bom.json");
  });

  test("npm: in CI the reveal audits what it published with npm audit signatures, and a failed audit names the packages", async () => {
    const dir = temp();
    writePackage(join(dir, "core"), "@acme/core", "1.0.0");
    const log = join(dir, "npm.log");
    const npm = writeFakeNpm(join(dir, "bin"), log);
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["core"] })], { npm });
    const ctx = context(dir, { env: { PATH: process.env.PATH, FAKE_NPM_AUDIT_FAIL: "1" }, provenance: OIDC });
    const staged = await target!.stage(ctx);
    const err = await refused(target!.reveal(ctx, staged));
    expect(err.code).toBe("publish-npm-audit-failed");
    expect(err.message).toBe("npm audit signatures exited 1 for @acme/core@1.0.0, after latest moved: 1 packages have invalid attestations");
    expect(readFileSync(log, "utf-8")).toContain(`"args":["audit","signatures"]`);
  });

  test("OCI: the provenance statement carries the cut's signature, says a workstation's provenance is the signature, and is the same bytes every run; a declared SBOM is pushed as it is", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "pw-attach", token: "tok-attach" });
    try {
      const dir = temp();
      const { digest } = writeOciLayout(join(dir, "image"));
      writeFileSync(join(dir, "image.spdx.json"), JSON.stringify({ spdxVersion: "SPDX-2.3", name: "image", packages: [] }));
      const repo = `${reg.host}/acme/api`;
      const [target] = await createPublishTargets([decl({ type: "oci", image: "image", repository: repo, sbom: "image.spdx.json" })], {});
      const ctx = context(dir, { env: { OCI_USERNAME: "robot", OCI_PASSWORD: "pw-attach" }, cut: CUT });
      const planned = await target!.plan(ctx);
      expect(planned.slice(1).map((i) => i.name)).toEqual(["image.spdx.json", "release.intoto.json"]);
      expect(await target!.plan(ctx)).toEqual(planned);

      await target!.stage(ctx);
      const manifests = planned.slice(1).map((i) => JSON.parse(reg.manifests.get(i.digest!)!.bytes.toString("utf-8")) as { artifactType: string; subject: { digest: string }; layers: Array<{ digest: string }> });
      expect(manifests.map((m) => [m.artifactType, m.subject.digest])).toEqual([
        ["application/spdx+json", digest],
        ["application/vnd.in-toto+json", digest],
      ]);
      expect(reg.blobs.get(manifests[0]!.layers[0]!.digest)!.toString("utf-8")).toBe(readFileSync(join(dir, "image.spdx.json"), "utf-8"));
      const statement = JSON.parse(reg.blobs.get(manifests[1]!.layers[0]!.digest)!.toString("utf-8"));
      expect(statement.predicate).toEqual({
        releaseDigest: ctx.release.releaseDigest,
        label: "v1.4.0",
        member: null,
        commit: ctx.release.commit,
        cut: { ...CUT, namespace: "chant-release" },
        provenance: { kind: "signature", ci: null },
      });

      // sbom: false pushes the provenance statement alone.
      const [bare] = await createPublishTargets([decl({ type: "oci", image: "image", repository: repo, sbom: false })], {});
      expect((await bare!.plan(ctx)).slice(1).map((i) => i.attachment)).toEqual(["provenance"]);
    } finally {
      await reg.close();
    }
  });

  test("forge: with no declared SBOM and no lockfile the target is refused under supply-chain and attaches none otherwise; a declared SBOM goes on the release by its own name", async () => {
    const dir = temp();
    writeFileSync(join(dir, "api.tar.gz"), "bytes");
    const api = "https://api.github.test";
    const forge = startFakeForge("github", api, "acme/api");
    const make = async (over: Record<string, unknown> = {}) => (await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["api.tar.gz"], ...over })], { fetch: forge.fetch }))[0]!;
    const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_x" }, cut: CUT });
    expect((await (await make()).plan(ctx)).map((i) => i.attachment ?? null)).not.toContain("sbom");
    const err = await refused((await make()).plan({ ...ctx, requireSbom: true }));
    expect(err.code).toBe("publish-sbom-missing");
    expect(err.fix).toContain("sbom: false");

    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "api.cdx.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" }));
    const target = await make({ sbom: "dist/api.cdx.json" });
    await target.reveal(ctx, await target.stage(ctx));
    expect(forge.visible()).toEqual([{ tag: "release/v1.4.0", assets: ["api.tar.gz", "api.cdx.json", "release.intoto.json"] }]);
    const statement = JSON.parse(forge.releases[0]!.assets.find((a) => a.name === "release.intoto.json")!.bytes);
    expect(statement.subject).toEqual([{ name: "api.tar.gz", digest: { sha256: createHash("sha256").update("bytes").digest("hex") } }]);
    expect(statement.predicate.cut.signature).toBe(CUT.signature);
  });
});

describe("the Cargo.lock SBOM source (#4168 decision 12)", () => {
  const CARGO_LOCK = '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "serde"\nversion = "1.0.210"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n';
  const NPM_LOCK = JSON.stringify({ name: "web", lockfileVersion: 3, packages: { "": { name: "web" }, "node_modules/left-pad": { version: "1.3.0" } } });

  test("a member with a Cargo.toml writes its SBOM from Cargo.lock, ahead of a package-lock.json beside it", () => {
    const dir = temp();
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"app\"\n");
    writeFileSync(join(dir, "Cargo.lock"), CARGO_LOCK);
    writeFileSync(join(dir, "package-lock.json"), NPM_LOCK);
    const sbom = memberSbom(context(dir), undefined, "app", "forge release assets")!;
    const text = Buffer.from(sbom.bytes).toString("utf-8");
    expect(text).toContain("pkg:cargo/serde@1.0.210");
    expect(text).toContain("chant-lockfile-sbom/Cargo.lock");
    expect(text).not.toContain("left-pad");
  });

  test("any other member reads package-lock.json first", () => {
    const dir = temp();
    writeFileSync(join(dir, "Cargo.lock"), CARGO_LOCK);
    writeFileSync(join(dir, "package-lock.json"), NPM_LOCK);
    const text = Buffer.from(memberSbom(context(dir), undefined, "web", "forge release assets")!.bytes).toString("utf-8");
    expect(text).toContain("left-pad");
    expect(text).not.toContain("pkg:cargo/");
  });
});

/**
 * #4047: the publish targets, each against a stand-in: npm against a fake
 * `npm` binary, OCI against a registry fake on 127.0.0.1 started and closed
 * here, and the forge targets against a recording `fetch`. Nothing reaches a
 * network or a real registry, and no token is ever printed.
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
import { parseRepository } from "./publish-oci";
import { PublishTargetError, type PublishContext, type PublishFetch } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeRegistry, writeFakeNpm, writeOciLayout, writePackage } from "./__fixtures__/publish-fakes";

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
    return { dir, npm: writeFakeNpm(join(dir, "bin"), log), log };
  }
  const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; tokenSet: boolean }) : []);

  test("publishes a set of several packages in the order declared, with --provenance under a CI OIDC token, and masks the token", async () => {
    const { dir, npm, log } = setup();
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["packages/core", "packages/cli"], access: "public" })], { npm });
    const env = { PATH: process.env.PATH, NODE_AUTH_TOKEN: "npm_secretToken42" };
    const ctx = context(dir, { env, provenance: OIDC });

    const planned = await target!.plan(ctx);
    expect(planned.map((i) => i.name)).toEqual(["@acme/core@1.4.0", "@acme/cli@1.4.0"]);
    expect(calls(log)).toEqual([]);

    const done = await target!.publish(ctx);
    expect(done.items.map((i) => i.name)).toEqual(["@acme/core@1.4.0", "@acme/cli@1.4.0"]);
    const c = calls(log);
    expect(c.map((x) => x.args)).toEqual([
      ["publish", join(dir, "packages/core"), "--access", "public", "--provenance"],
      ["publish", join(dir, "packages/cli"), "--access", "public", "--provenance"],
    ]);
    // npm got the token from the run's environment; chant printed none of it.
    expect(c.every((x) => x.tokenSet)).toBe(true);
    const out = ctx.lines.join("\n");
    expect(out).toContain(`npm notice token ${REDACTED}`);
    expect(out).toContain(`_authToken=${REDACTED}`);
    expect(out).not.toContain("npm_secretToken42");
  });

  test("passes no --provenance without an OIDC token, publishes a packed .tgz, and passes the registry and a dist-tag", async () => {
    const { dir, npm, log } = setup();
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["kit.tgz"], registry: "http://127.0.0.1:4873/" })], { npm });
    const ctx = context(dir, { env: { PATH: process.env.PATH }, tag: "next" });
    const done = await target!.publish(ctx);
    expect(done.items).toEqual([{ name: "@acme/kit@1.4.0", destination: "http://127.0.0.1:4873/, dist-tag next", digest: expect.stringMatching(/^sha256:/) }]);
    expect(calls(log)[0]!.args).toEqual(["publish", join(dir, "kit.tgz"), "--registry", "http://127.0.0.1:4873/", "--tag", "next"]);
  });

  test("a failure names the packages already published; a missing package and a tarball the release built differently are refused at plan", async () => {
    const { dir, npm, log } = setup();
    const [target] = await createPublishTargets([decl({ type: "npm", packages: ["packages/core", "packages/cli", "packages/kit"] })], { npm });
    const err = await refused(target!.publish(context(dir, { env: { PATH: process.env.PATH, FAKE_NPM_FAIL: "packages/cli" } })));
    expect(err.code).toBe("publish-npm-failed");
    expect(err.message).toMatch(/npm publish of @acme\/cli@1\.4\.0 exited 1, after @acme\/core@1\.4\.0 were published: npm error 403 Forbidden/);
    expect(calls(log)).toHaveLength(2);

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

  test("pushes a layout by digest through a Bearer challenge, tags it, uploads nothing twice, and prints no credential", async () => {
    const reg = await startFakeRegistry({ username: "robot", password: "oci-pass-9876", token: "registry-token-abcdef" });
    try {
      const dir = temp();
      const { digest, configDigest } = writeOciLayout(join(dir, "dist", "api.oci"));
      const repo = `${reg.host}/acme/api`;
      const [target] = await createPublishTargets([decl({ type: "oci", image: "dist/api.oci", repository: repo, tags: ["{label}", "latest"] })], {});
      const env = { OCI_USERNAME: "robot", OCI_PASSWORD: "oci-pass-9876" };
      const ctx = context(dir, { env, artifacts: [{ component: "api", kind: "image", path: "dist/api.oci", digest: configDigest }] });

      expect(await target!.plan(ctx)).toEqual([{ name: "dist/api.oci (tags v1.4.0, latest)", destination: `${repo}@${digest}`, digest }]);
      expect(reg.requests).toEqual([]);

      const done = await target!.publish(ctx);
      expect(done.items[0]!.destination).toBe(`${repo}@${digest}`);
      expect(reg.uploads).toBe(2);
      expect([...reg.manifests.keys()].sort()).toEqual([digest, "latest", "v1.4.0"].sort());
      expect(reg.manifests.get("v1.4.0")!.type).toBe("application/vnd.oci.image.manifest.v1+json");
      expect(reg.requests.some((r) => r.authorization === "Bearer registry-token-abcdef")).toBe(true);

      await target!.publish(ctx);
      expect(reg.uploads).toBe(2);
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
      const { digest } = writeOciLayout(join(dir, "layout"), "other layer");
      execFileSync("tar", ["-cf", join(dir, "api.tar"), "-C", join(dir, "layout"), "."], { stdio: "ignore" });
      const dockerDir = join(dir, "docker");
      mkdirSync(dockerDir, { recursive: true });
      writeFileSync(join(dockerDir, "config.json"), JSON.stringify({ auths: { [reg.host]: { auth: Buffer.from("dh:dockerhub-pat-555").toString("base64") } } }));
      const [target] = await createPublishTargets([decl({ type: "oci", image: "api.tar", repository: `${reg.host}/acme/api` })], {});
      const ctx = context(dir, { env: { DOCKER_CONFIG: dockerDir } });
      await target!.publish(ctx);
      expect(reg.manifests.has(digest)).toBe(true);
      expect(reg.manifests.has("v1.4.0")).toBe(true);
      expect(ctx.lines.join("\n")).toContain("with credentials from docker config");
      expect(ctx.lines.join("\n")).not.toContain("dockerhub-pat-555");

      const wrong = context(dir, { env: { OCI_PASSWORD: "wrong-password" } });
      const err = await refused(target!.publish(wrong));
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
  interface Call {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array | string;
  }
  /** A recording fetch that answers by `METHOD url` prefix. */
  function fakeFetch(routes: Array<[string, number, unknown]>): { fetch: PublishFetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetch: PublishFetch = async (url, init) => {
      calls.push({ method: init.method, url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
      const hit = routes.find(([k]) => `${init.method} ${url}`.startsWith(k));
      const [, status, body] = hit ?? ["", 404, { message: "Not Found" }];
      return { ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    return { fetch, calls };
  }
  function assetDir(): string {
    const dir = temp();
    writeFileSync(join(dir, "api-linux.tar.gz"), "binary bytes");
    return dir;
  }
  const DIGEST = `sha256:${createHash("sha256").update("binary bytes").digest("hex")}`;

  test("GitHub: creates the release at the commit when the tag has none, uploads, and skips an asset whose digest matches", async () => {
    const dir = assetDir();
    const api = "https://api.github.test";
    const { fetch, calls } = fakeFetch([
      [`GET ${api}/repos/acme/api/releases/tags/release%2Fv1.4.0`, 404, {}],
      [`POST ${api}/repos/acme/api/releases`, 201, { id: 7, upload_url: "https://uploads.github.test/repos/acme/api/releases/7/assets{?name,label}", assets: [] }],
      ["POST https://uploads.github.test/repos/acme/api/releases/7/assets?name=api-linux.tar.gz", 201, { browser_download_url: "https://github.test/acme/api/releases/download/x/api-linux.tar.gz" }],
    ]);
    const [target] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["api-linux.tar.gz"] })], { fetch });
    const ctx = context(dir, { env: { GITHUB_TOKEN: "ghs_tokentoken" } });
    expect(await target!.plan(ctx)).toEqual([{ name: "api-linux.tar.gz", destination: "github acme/api release release/v1.4.0, asset api-linux.tar.gz", digest: DIGEST }]);
    expect(calls).toEqual([]);
    const done = await target!.publish(ctx);
    expect(done.items[0]!.destination).toBe("https://github.test/acme/api/releases/download/x/api-linux.tar.gz");
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ tag_name: "release/v1.4.0", target_commitish: ctx.release.commit, name: "v1.4.0" });
    expect(calls[2]!.headers).toMatchObject({ authorization: "Bearer ghs_tokentoken", "content-type": "application/octet-stream" });
    expect(Buffer.from(calls[2]!.body as Uint8Array).toString()).toBe("binary bytes");
    expect(ctx.lines.join("\n")).not.toContain("ghs_tokentoken");

    const again = fakeFetch([[`GET ${api}/repos/acme/api/releases/tags/`, 200, { id: 7, assets: [{ name: "api-linux.tar.gz", digest: DIGEST }] }]]);
    const [t2] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["api-linux.tar.gz"] })], { fetch: again.fetch });
    expect((await t2!.publish(ctx)).items[0]!.present).toBe(true);
    expect(again.calls).toHaveLength(1);

    const differs = fakeFetch([[`GET ${api}/repos/acme/api/releases/tags/`, 200, { id: 7, assets: [{ name: "api-linux.tar.gz", digest: "sha256:" + "2".repeat(64) }] }]]);
    const [t3] = await createPublishTargets([decl({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["api-linux.tar.gz"] })], { fetch: differs.fetch });
    expect((await refused(t3!.publish(ctx))).code).toBe("publish-forge-asset-exists");
  });

  test("GitLab: a CI job token, the generic package registry and a release link", async () => {
    const dir = assetDir();
    const api = "https://gitlab.test/api/v4";
    const project = `${api}/projects/acme%2Fapi`;
    const { fetch, calls } = fakeFetch([
      [`GET ${project}/releases/release%2Fv1.4.0`, 200, { tag_name: "release/v1.4.0", assets: { links: [] } }],
      [`PUT ${project}/packages/generic/release/v1.4.0/api-linux.tar.gz`, 201, { message: "201 Created" }],
      [`POST ${project}/releases/release%2Fv1.4.0/assets/links`, 201, { id: 1 }],
    ]);
    const [target] = await createPublishTargets([decl({ type: "forge", forge: "gitlab", repo: "acme/api", assets: ["api-linux.tar.gz"] })], { fetch });
    const ctx = context(dir, { env: { CI_JOB_TOKEN: "glcbt-jobtoken", CI_API_V4_URL: api } });
    const done = await target!.publish(ctx);
    expect(done.items[0]!.destination).toBe(`${project}/packages/generic/release/v1.4.0/api-linux.tar.gz`);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "POST"]);
    expect(calls[1]!.headers).toMatchObject({ "job-token": "glcbt-jobtoken" });
    expect(JSON.parse(calls[2]!.body as string)).toEqual({ name: "api-linux.tar.gz", url: `${project}/packages/generic/release/v1.4.0/api-linux.tar.gz`, link_type: "package" });
  });

  test("Forgejo: a multipart upload to the release, which needs an API root and a token", async () => {
    const dir = assetDir();
    const api = "https://forgejo.test/api/v1";
    const { fetch, calls } = fakeFetch([
      [`GET ${api}/repos/acme/api/releases/tags/release%2Fv1.4.0`, 404, {}],
      [`POST ${api}/repos/acme/api/releases/3/assets?name=api-linux.tar.gz`, 201, { browser_download_url: "https://forgejo.test/a" }],
      [`POST ${api}/repos/acme/api/releases`, 201, { id: 3, assets: [] }],
    ]);
    const make = async (over: Record<string, unknown> = {}) => (await createPublishTargets([decl({ type: "forge", forge: "forgejo", repo: "acme/api", assets: ["api-linux.tar.gz"], ...over })], { fetch }))[0]!;
    expect((await refused((await make()).plan(context(dir, { env: { FORGEJO_TOKEN: "fj-token-1" } })))).code).toBe("publish-forge-no-api");
    expect((await refused((await make({ api })).plan(context(dir, { env: {} })))).code).toBe("publish-credentials-missing");
    expect((await refused((await make({ api })).plan(context(dir, { env: { FORGEJO_TOKEN: "fj-token-1" }, releaseTag: null, label: null })))).code).toBe("publish-forge-no-tag");

    const ctx = context(dir, { env: { FORGEJO_TOKEN: "fj-token-1" } });
    await (await make({ api })).publish(ctx);
    const upload = calls.at(-1)!;
    expect(upload.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=chant-/);
    expect(upload.headers.authorization).toBe("token fj-token-1");
    expect(Buffer.from(upload.body as Uint8Array).toString()).toContain('name="attachment"; filename="api-linux.tar.gz"');
    expect(ctx.lines.join("\n")).not.toContain("fj-token-1");
  });
});

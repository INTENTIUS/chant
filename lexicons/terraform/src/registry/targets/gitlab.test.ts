// chant#4603: the GitLab module target against the in-memory GitLab fake. No request leaves the
// process, and no token value appears in a log line, an error or a staged record.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PublishTargetError } from "@intentius/chant/lifecycle/release-publish";
import { createRedactor, REDACTED } from "@intentius/chant/lifecycle/publish-credentials";
import { archiveContent, gitlabModuleTarget, gitlabUploadUrl, type ModuleVersionContext } from "../index";
import { createFakeGitlab } from "./fake-gitlab";

const HOST = "gitlab.example.com";
const API = `https://${HOST}/api/v4`;
const WRITE_TOKEN = "glpat-write-0123456789";
const READ_TOKEN = "glpat-read-9876543210";
const JOB_TOKEN = "job-token-abcdefghij";
const OTHER_TOKEN = "glpat-other-project-0000";

function fake() {
  return createFakeGitlab({
    host: HOST,
    projects: { "42": "acme/modules", "7": "elsewhere/other" },
    tokens: { [WRITE_TOKEN]: ["42"], [READ_TOKEN]: [], [JOB_TOKEN]: ["42"], [OTHER_TOKEN]: ["7"] },
  });
}

const archiveOf = (text: string) => gzipSync(Buffer.from(`module tar: ${text}`));

function context(env: NodeJS.ProcessEnv, over: Partial<ModuleVersionContext> = {}): ModuleVersionContext & { lines: string[] } {
  const archive = over.archive ?? archiveOf("vpc 1.2.0");
  const redactor = createRedactor(env);
  const lines: string[] = [];
  return {
    cwd: "/nowhere",
    env,
    redactor,
    log: (line) => lines.push(redactor.redact(line)),
    provenance: { oidc: false, ci: null, reason: "not in CI" },
    tag: null,
    address: { namespace: "acme", name: "vpc", system: "aws" },
    version: "1.2.0",
    revision: "3f2a9c1d0b7e3f2a9c1d0b7e3f2a9c1d0b7e3f2a",
    content: archiveContent(archive),
    archive,
    ...over,
    lines,
  };
}

const target = (gl: ReturnType<typeof fake>, opts = {}) => gitlabModuleTarget({ api: API, project: "42", ...opts }, { fetch: gl.fetch, registryFetch: gl.fetch });

const errorOf = async (p: Promise<unknown>): Promise<PublishTargetError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PublishTargetError);
  return e as PublishTargetError;
};

describe("GitLab module target (chant#4603)", () => {
  it("uploads with one PUT to the project's module file path, with the token header and the archive as the body", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN });
    const t = target(gl);
    expect(await t.plan(ctx)).toEqual([{ name: "acme/vpc/aws 1.2.0", destination: `${HOST}/acme/vpc/aws`, digest: ctx.content }]);
    const staged = await t.stage(ctx);
    const puts = gl.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(`${API}/projects/42/packages/terraform/modules/vpc/aws/1.2.0/file`);
    expect(puts[0]!.headers["private-token"]).toBe(WRITE_TOKEN);
    expect(puts[0]!.headers["job-token"]).toBeUndefined();
    expect(puts[0]!.headers["content-type"]).toBe("application/octet-stream");
    expect(Buffer.from(puts[0]!.body!)).toEqual(Buffer.from(ctx.archive));
    expect(staged.items[0]!.present).toBeUndefined();
    expect(JSON.stringify(staged)).not.toContain(WRITE_TOKEN);

    const published = await t.reveal(ctx, staged);
    expect(published.destination).toBe(`${HOST}/acme/vpc/aws`);
    expect(await t.versions(ctx.address, ctx)).toEqual(["1.2.0"]);
  });

  it("sends a CI job token as JOB-TOKEN, with the project and API root from GitLab CI's variables", async () => {
    const gl = fake();
    const ctx = context({ CI_JOB_TOKEN: JOB_TOKEN, CI_PROJECT_ID: "42", CI_API_V4_URL: API });
    const t = gitlabModuleTarget({}, { fetch: gl.fetch, registryFetch: gl.fetch });
    await t.stage(ctx);
    const put = gl.requests.find((r) => r.method === "PUT")!;
    expect(put.headers["job-token"]).toBe(JOB_TOKEN);
    expect(put.headers["private-token"]).toBeUndefined();
    expect(put.url).toBe(gitlabUploadUrl(API, "42", ctx.address, "1.2.0"));
  });

  it("encodes a project given by its full path", () => {
    expect(gitlabUploadUrl(API, "acme/modules", { name: "vpc", system: "aws" }, "1.2.0")).toBe(`${API}/projects/acme%2Fmodules/packages/terraform/modules/vpc/aws/1.2.0/file`);
  });

  it("comes back present and sends nothing when the version is held with the same content", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN });
    gl.seed("42", "vpc", "aws", "1.2.0", ctx.archive);
    const t = target(gl);
    expect(await t.held(ctx.address, "1.2.0", ctx)).toEqual({ content: ctx.content });
    const staged = await t.stage(ctx);
    expect(staged.items[0]!.present).toBe(true);
    expect(gl.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(ctx.lines.some((l) => l.includes("nothing sent"))).toBe(true);
  });

  it("refuses a version held with other content, and sends nothing", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN });
    gl.seed("42", "vpc", "aws", "1.2.0", archiveOf("something else"));
    const err = await errorOf(target(gl).stage(ctx));
    expect(err.code).toBe("publish-version-held");
    expect(err.message).toContain(archiveContent(archiveOf("something else")));
    expect(gl.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("answers held with undefined for a version the host does not list", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN });
    expect(await target(gl).held(ctx.address, "9.9.9", ctx)).toBeUndefined();
    expect(await target(gl).versions(ctx.address, ctx)).toEqual([]);
  });

  it("names the variable on a 401, never its value", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: "glpat-unknown-to-the-fake" }, {});
    gl.seed("42", "other", "aws", "0.1.0", archiveOf("x"));
    // Reads take TF_TOKEN_<host>, so the upload is the call that meets the unknown token.
    const env = { ...ctx.env, TF_TOKEN_gitlab_example_com: READ_TOKEN };
    const c = context(env);
    const err = await errorOf(target(gl).stage(c));
    expect(err.code).toBe("publish-credentials-refused");
    expect(err.message).toContain("401");
    expect(err.message).toContain("GITLAB_TOKEN");
    expect(`${err.message} ${err.fix}`).not.toContain("glpat-unknown-to-the-fake");
  });

  it("names the variable on a 403, never its value", async () => {
    const gl = fake();
    const ctx = context({ DEPLOY_TOKEN: OTHER_TOKEN, TF_TOKEN_gitlab_example_com: READ_TOKEN });
    const err = await errorOf(target(gl, { tokenEnv: "DEPLOY_TOKEN" }).stage(ctx));
    expect(err.code).toBe("publish-credentials-refused");
    expect(err.message).toContain("403");
    expect(err.message).toContain("DEPLOY_TOKEN");
    expect(`${err.message} ${err.fix}`).not.toContain(OTHER_TOKEN);
  });

  it("refuses to plan without a token or a project, naming what to set", async () => {
    const gl = fake();
    const none = await errorOf(target(gl).plan(context({})));
    expect(none.code).toBe("publish-credentials-missing");
    expect(none.message).toContain("GITLAB_TOKEN or CI_JOB_TOKEN");
    const noProject = await errorOf(gitlabModuleTarget({ api: API }, { fetch: gl.fetch, registryFetch: gl.fetch }).plan(context({ GITLAB_TOKEN: WRITE_TOKEN })));
    expect(noProject.code).toBe("publish-config-invalid");
    expect(noProject.fix).toContain("CI_PROJECT_ID");
  });

  it("refuses an archive whose content is not the one the context names", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN }, { content: "sha256:0000" });
    expect((await errorOf(target(gl).plan(ctx))).code).toBe("publish-artifact-digest-mismatch");
  });

  it("reads back with TF_TOKEN_<host> as a bearer token, apart from the upload token", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN, TF_TOKEN_gitlab_example_com: READ_TOKEN });
    const t = target(gl);
    await t.reveal(ctx, await t.stage(ctx));
    const reads = gl.requests.filter((r) => r.method === "GET" && r.url.includes("/packages/terraform/modules/v1/") && !r.url.includes("/file?"));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.headers.authorization).toBe(`Bearer ${READ_TOKEN}`);
    const tarball = gl.requests.find((r) => r.url.includes("/file?"));
    // The download link carries its own grant, so no Authorization header goes with it.
    if (tarball) expect(tarball.headers.authorization).toBeUndefined();
  });

  it("a refused read names TF_TOKEN_<host>, never a value", async () => {
    const gl = fake();
    const ctx = context({ TF_TOKEN_gitlab_example_com: "not-a-known-token-value" });
    const err = await errorOf(target(gl).versions(ctx.address, ctx));
    expect(err.code).toBe("publish-read-failed");
    expect(err.message).toContain("refused the token");
    expect(err.message).not.toContain("not-a-known-token-value");
  });

  it("masks every token in every log line and error", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN, TF_TOKEN_gitlab_example_com: READ_TOKEN });
    const t = target(gl);
    await t.reveal(ctx, await t.stage(ctx));
    // A rerun with other content fails; its error must be clean too.
    const other = context(ctx.env, { archive: archiveOf("changed"), content: archiveContent(archiveOf("changed")) });
    const err = await errorOf(t.stage(other));
    const all = [...ctx.lines, ...other.lines, err.message, err.fix ?? ""].join("\n");
    for (const secret of [WRITE_TOKEN, READ_TOKEN]) expect(all).not.toContain(secret);
    expect(ctx.redactor.redact(`PRIVATE-TOKEN: ${WRITE_TOKEN} and ${READ_TOKEN}`)).toBe(`PRIVATE-TOKEN: ${REDACTED} and ${REDACTED}`);
  });

  it("keeps the download link's grant out of error text", async () => {
    const gl = fake();
    const ctx = context({ GITLAB_TOKEN: WRITE_TOKEN, TF_TOKEN_gitlab_example_com: READ_TOKEN });
    gl.seed("42", "vpc", "aws", "1.2.0", new Uint8Array([1, 2, 3]));
    const err = await errorOf(target(gl).held(ctx.address, "1.2.0", ctx));
    expect(err.message).toContain("?[query]");
    expect(err.message).not.toContain("fake-download-grant");
  });
});

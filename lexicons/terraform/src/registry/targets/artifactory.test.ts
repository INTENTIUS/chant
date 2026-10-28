// chant#4605: the Artifactory module target against the in-memory Artifactory fake. No request
// leaves the process, and no credential appears in a log line, an error or a staged record.
import { describe, expect, it } from "vitest";
import { PublishTargetError } from "@intentius/chant/lifecycle/release-publish";
import { createRedactor } from "@intentius/chant/lifecycle/publish-credentials";
import { archiveContent, artifactoryBase, artifactoryDeployUrl, artifactoryModuleTarget, moduleZip, readModuleZipComment, readZip, type ModuleVersionContext } from "../index";
import { createFakeArtifactory, type FakeArtifactoryOptions } from "./fake-artifactory";
import { moduleTarball } from "./fake-http";

const HOST = "acme.jfrog.io";
const URL_ = `https://${HOST}/artifactory`;
const USER = "ci-deployer";
const TOKEN = "jfrog-access-0123456789abcdef";
const READER = "ci-reader";
const READER_TOKEN = "jfrog-reader-fedcba9876543210";
const ENV = { JFROG_USER: USER, JFROG_ACCESS_TOKEN: TOKEN };

const fake = (over: Partial<FakeArtifactoryOptions> = {}) =>
  createFakeArtifactory({ host: HOST, repos: ["terraform-local"], users: { [USER]: TOKEN, [READER]: READER_TOKEN }, deployers: { "terraform-local": [USER] }, ...over });

const clock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps };
};

const archiveOf = (text: string) => moduleTarball({ "main.tf": `# ${text}\n`, "README.md": "# vpc\n" });

function context(env: NodeJS.ProcessEnv, over: Partial<ModuleVersionContext> = {}): ModuleVersionContext & { lines: string[] } {
  const archive = over.archive ?? archiveOf("vpc 1.2.0");
  const redactor = createRedactor(env, ["JFROG_ACCESS_TOKEN"]);
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

const target = (af: ReturnType<typeof fake>, opts = {}, c = clock()) =>
  artifactoryModuleTarget({ url: URL_, repo: "terraform-local", ...opts }, { fetch: af.fetch, registryFetch: af.fetch, sleep: c.sleep, now: c.now });

const errorOf = async (p: Promise<unknown>): Promise<PublishTargetError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PublishTargetError);
  return e as PublishTargetError;
};

const noSecret = (text: string) => {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(Buffer.from(`${USER}:${TOKEN}`).toString("base64"));
};

describe("Artifactory module target (chant#4605)", () => {
  it("deploys the zip of the attested archive with one PUT, basic credentials and application/zip", async () => {
    const af = fake();
    const ctx = context(ENV);
    const t = target(af);
    expect(await t.plan(ctx)).toEqual([{ name: "terraform-local__acme/vpc/aws 1.2.0", destination: `${HOST}/terraform-local__acme/vpc/aws`, digest: ctx.content }]);
    const staged = await t.stage(ctx);
    const puts = af.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(`${URL_}/terraform-local/acme/vpc/aws/1.2.0.zip`);
    expect(puts[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`);
    expect(puts[0]!.headers["content-type"]).toBe("application/zip");
    expect(Buffer.compare(Buffer.from(puts[0]!.body!), moduleZip(ctx.archive, ctx.content, ctx.revision))).toBe(0);
    const zip = readZip(puts[0]!.body!);
    expect(zip.entries.map((e) => e.path).sort()).toEqual(["README.md", "main.tf"]);
    expect(readModuleZipComment(zip.comment)?.content).toBe(ctx.content);
    noSecret(JSON.stringify(staged));

    const published = await t.reveal(ctx, staged);
    expect(published.destination).toBe(`${HOST}/terraform-local__acme/vpc/aws`);
    expect(await t.versions(ctx.address, ctx)).toEqual(["1.2.0"]);
    expect(await t.held(ctx.address, "1.2.0", ctx)).toEqual({ content: ctx.content, revision: ctx.revision });
  });

  it("reads through the registry protocol at <host>/<repo>__<ns>/<name>/<system>", async () => {
    const af = fake();
    const ctx = context(ENV);
    const t = target(af);
    await t.reveal(ctx, await t.stage(ctx));
    const reads = af.requests.filter((r) => r.method === "GET").map((r) => new URL(r.url).pathname);
    expect(reads).toContain("/.well-known/terraform.json");
    expect(reads).toContain("/artifactory/api/terraform/v1/modules/terraform-local__acme/vpc/aws/versions");
    expect(reads).toContain("/artifactory/api/terraform/v1/modules/terraform-local__acme/vpc/aws/1.2.0/download");
  });

  it("sends TF_TOKEN_<host> on the protocol reads, apart from the deploy credentials", async () => {
    const af = fake();
    const ctx = context({ ...ENV, TF_TOKEN_acme_jfrog_io: READER_TOKEN });
    const t = target(af);
    await t.reveal(ctx, await t.stage(ctx));
    const versionsRead = af.requests.find((r) => r.url.endsWith("/versions"))!;
    expect(versionsRead.headers.authorization).toBe(`Bearer ${READER_TOKEN}`);
    const put = af.requests.find((r) => r.method === "PUT")!;
    expect(put.headers.authorization).toMatch(/^Basic /);
  });

  it("waits for Artifactory to index the deploy before the reveal", async () => {
    const af = fake({ indexAfter: 2 });
    const c = clock();
    const ctx = context(ENV);
    const t = target(af, { pollMs: 1000 }, c);
    await t.reveal(ctx, await t.stage(ctx));
    expect(c.sleeps).toEqual([1000, 1000]);
  });

  it("stops after the wait with the index fix when the version is never listed", async () => {
    const af = fake({ indexAfter: 100 });
    const ctx = context(ENV);
    const t = target(af, { waitMs: 3000, pollMs: 1000 });
    const e = await errorOf(t.reveal(ctx, await t.stage(ctx)));
    expect(e.code).toBe("publish-reveal-missing");
    expect(e.fix).toContain("Recalculate Index");
  });

  it("sends nothing for a version already deployed with the same content", async () => {
    const af = fake();
    const ctx = context(ENV);
    af.seed("terraform-local", "acme", "vpc", "aws", "1.2.0", moduleZip(ctx.archive, ctx.content, ctx.revision));
    const staged = await target(af).stage(ctx);
    expect(staged.items[0]!.present).toBe(true);
    expect(af.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(ctx.lines.join("\n")).toContain("nothing sent");
  });

  it("refuses a version already deployed with other content", async () => {
    const af = fake();
    const ctx = context(ENV);
    const other = archiveOf("something else");
    af.seed("terraform-local", "acme", "vpc", "aws", "1.2.0", moduleZip(other, archiveContent(other)));
    const e = await errorOf(target(af).stage(ctx));
    expect(e.code).toBe("publish-version-held");
    expect(af.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("refuses a zip deployed by hand, which names no attested content", async () => {
    const af = fake();
    const ctx = context(ENV);
    af.seed("terraform-local", "acme", "vpc", "aws", "1.2.0", Buffer.from("PK\x05\x06" + "\0".repeat(18), "latin1"));
    expect((await errorOf(target(af).stage(ctx))).code).toBe("publish-version-held");
  });

  it("judges a 409 after a race by what the repository then holds", async () => {
    const af = fake();
    const ctx = context(ENV);
    // The held read answers 404; another run's deploy then lands before ours, which gets 409.
    const real = af.fetch;
    let raced = false;
    const racing: typeof af.fetch = async (url, init) => {
      if (!raced && init?.method === "PUT") {
        raced = true;
        af.seed("terraform-local", "acme", "vpc", "aws", "1.2.0", moduleZip(ctx.archive, ctx.content, ctx.revision));
      }
      return real(url, init);
    };
    const t2 = artifactoryModuleTarget({ url: URL_, repo: "terraform-local" }, { fetch: racing, registryFetch: racing });
    const staged = await t2.stage(ctx);
    expect(staged.items[0]!.present).toBe(true);
    expect(af.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("names the variables on a refused deploy, never their values", async () => {
    const af = fake({ deployers: { "terraform-local": [] } });
    const ctx = context(ENV);
    const e = await errorOf(target(af).stage(ctx));
    expect(e.code).toBe("publish-credentials-refused");
    expect(e.message).toContain("JFROG_USER");
    expect(e.message).toContain("JFROG_ACCESS_TOKEN");
    noSecret(`${e.message} ${e.fix}`);
  });

  it("gives a 401 for an unknown token as refused credentials", async () => {
    const af = fake();
    const ctx = context({ JFROG_USER: USER, JFROG_ACCESS_TOKEN: "jfrog-wrong-token-000" });
    const e = await errorOf(target(af).stage(ctx));
    expect(e.code).toBe("publish-credentials-refused");
    expect(e.message).not.toContain("jfrog-wrong-token-000");
  });

  it("refuses to plan without a user or a token", async () => {
    const af = fake();
    const e1 = await errorOf(target(af).plan(context({ JFROG_ACCESS_TOKEN: TOKEN })));
    expect(e1.code).toBe("publish-credentials-missing");
    expect(e1.message).toContain("JFROG_USER");
    const e2 = await errorOf(target(af).plan(context({ JFROG_USER: USER })));
    expect(e2.message).toContain("JFROG_ACCESS_TOKEN");
    expect(await target(af, { user: USER }).plan(context({ JFROG_ACCESS_TOKEN: TOKEN }))).toHaveLength(1);
  });

  it("reads the token and user from the declared variables", async () => {
    const af = fake();
    const ctx = context({ DEPLOY_USER: USER, DEPLOY_TOKEN: TOKEN });
    const staged = await target(af, { userEnv: "DEPLOY_USER", tokenEnv: "DEPLOY_TOKEN" }).stage(ctx);
    expect(staged.items[0]!.present).toBeUndefined();
  });

  it("fails a 5xx with the status and no credential", async () => {
    const af = fake();
    const ctx = context(ENV);
    const failing: typeof af.fetch = async (url, init) => (init?.method === "PUT" ? new Response("upstream down", { status: 503 }) : af.fetch(url, init));
    const e = await errorOf(artifactoryModuleTarget({ url: URL_, repo: "terraform-local" }, { fetch: failing, registryFetch: failing }).stage(ctx));
    expect(e.code).toBe("publish-upload-failed");
    expect(e.message).toContain("503");
    noSecret(e.message);
  });

  it("answers a 401 from failNext on the first read as refused credentials", async () => {
    const af = fake();
    af.failNext(401);
    const e = await errorOf(target(af).stage(context(ENV)));
    expect(e.code).toBe("publish-credentials-refused");
  });

  it("refuses an archive whose content is not the release's", async () => {
    const af = fake();
    const ctx = context(ENV, { content: archiveContent(archiveOf("other")) });
    expect((await errorOf(target(af).plan(ctx))).code).toBe("publish-artifact-digest-mismatch");
  });

  it("builds the deploy URL and the base", () => {
    expect(artifactoryBase("https://acme.jfrog.io")).toBe("https://acme.jfrog.io/artifactory");
    expect(artifactoryBase("https://acme.jfrog.io/artifactory/")).toBe("https://acme.jfrog.io/artifactory");
    expect(artifactoryDeployUrl("https://h/artifactory", "terraform-local", { namespace: "acme", name: "vpc", system: "aws" }, "1.0.0")).toBe("https://h/artifactory/terraform-local/acme/vpc/aws/1.0.0.zip");
  });

  it("masks the credentials in every log line", async () => {
    const af = fake();
    const ctx = context(ENV);
    const t = target(af);
    await t.reveal(ctx, await t.stage(ctx));
    noSecret(ctx.lines.join("\n"));
  });
});

// chant#4605: the Nexus module target against the in-memory Nexus fake. No request leaves the
// process, no CLI config file is written, and no credential appears in a log line or an error.
import { describe, expect, it } from "vitest";
import { PublishTargetError } from "@intentius/chant/lifecycle/release-publish";
import { createRedactor } from "@intentius/chant/lifecycle/publish-credentials";
import {
  archiveContent,
  moduleZip,
  nexusHostBlock,
  nexusHostLabel,
  nexusModuleTarget,
  nexusUploadUrl,
  readModuleZipComment,
  readZip,
  registryVersions,
  type ModuleVersionContext,
} from "../index";
import { createFakeNexus, type FakeNexusOptions } from "./fake-nexus";
import { moduleTarball } from "./fake-http";

const HOST = "nexus.example.com";
const URL_ = `https://${HOST}`;
const USER = "tf-publisher";
const TOKEN = "nexus-pass-0123456789abcdef";
const ENV = { NEXUS_USER: USER, NEXUS_TOKEN: TOKEN };
const BASIC = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;

const fake = (over: Partial<FakeNexusOptions> = {}) => createFakeNexus({ host: HOST, repos: ["terraform-hosted"], users: { [USER]: TOKEN }, ...over });

const clock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps };
};

const archiveOf = (text: string) => moduleTarball({ "main.tf": `# ${text}\n`, "outputs.tf": "" });

function context(env: NodeJS.ProcessEnv, over: Partial<ModuleVersionContext> = {}): ModuleVersionContext & { lines: string[] } {
  const archive = over.archive ?? archiveOf("vpc 1.2.0");
  const redactor = createRedactor(env, ["NEXUS_TOKEN"]);
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

const target = (nx: ReturnType<typeof fake>, opts = {}, c = clock()) =>
  nexusModuleTarget({ url: URL_, repo: "terraform-hosted", ...opts }, { fetch: nx.fetch, registryFetch: nx.fetch, sleep: c.sleep, now: c.now });

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
  expect(text).not.toContain(BASIC.slice(6));
  expect(text).not.toMatch(/TerraformBearerToken\.fake/);
};

describe("Nexus module target (chant#4605)", () => {
  it("uploads the zip of the attested archive with one PUT, basic credentials and application/zip", async () => {
    const nx = fake();
    const ctx = context(ENV);
    const t = target(nx);
    expect(await t.plan(ctx)).toEqual([{ name: "acme/vpc/aws 1.2.0", destination: "terraform-hosted/acme/vpc/aws", digest: ctx.content }]);
    const staged = await t.stage(ctx);
    const puts = nx.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(`${URL_}/repository/terraform-hosted/v1/modules/acme/vpc/aws/1.2.0/vpc-1.2.0.zip`);
    expect(puts[0]!.headers.authorization).toBe(BASIC);
    expect(puts[0]!.headers["content-type"]).toBe("application/zip");
    expect(Buffer.compare(Buffer.from(puts[0]!.body!), moduleZip(ctx.archive, ctx.content, ctx.revision))).toBe(0);
    expect(readModuleZipComment(readZip(puts[0]!.body!).comment)?.content).toBe(ctx.content);
    noSecret(JSON.stringify(staged));

    const published = await t.reveal(ctx, staged);
    expect(published.destination).toBe("terraform-hosted/acme/vpc/aws");
    expect(await t.held(ctx.address, "1.2.0", ctx)).toEqual({ content: ctx.content, revision: ctx.revision });
  });

  it("reads back through the registry protocol with an in-memory host block, never discovery", async () => {
    const nx = fake();
    const ctx = context(ENV);
    const t = target(nx);
    await t.reveal(ctx, await t.stage(ctx));
    const paths = nx.requests.map((r) => new URL(r.url).pathname);
    expect(paths).not.toContain("/.well-known/terraform.json");
    expect(paths).toContain("/repository/terraform-hosted/v1/modules/acme/vpc/aws/versions");
    expect(paths).toContain("/repository/terraform-hosted/v1/modules/acme/vpc/aws/1.2.0/download");
  });

  it("reads with the 3.95 bearer token issued for the basic credentials", async () => {
    const nx = fake();
    const ctx = context(ENV);
    const t = target(nx);
    await t.reveal(ctx, await t.stage(ctx));
    expect(nx.issued.size).toBe(1);
    const read = nx.requests.find((r) => r.url.endsWith("/versions"))!;
    expect(read.headers.authorization).toBe(`Bearer ${[...nx.issued][0]}`);
    noSecret(ctx.lines.join("\n"));
  });

  it("reads with the basic credentials on a Nexus without the token call", async () => {
    const nx = fake({ bearer: false });
    const ctx = context(ENV);
    const t = target(nx);
    await t.reveal(ctx, await t.stage(ctx));
    const read = nx.requests.find((r) => r.url.endsWith("/versions"))!;
    expect(read.headers.authorization).toBe(BASIC);
  });

  it("reads with TF_TOKEN_<nexus host> when it is set", async () => {
    const nx = fake({ bearer: false });
    const ctx = context({ ...ENV, TF_TOKEN_nexus_example_com: "cli-token-1234567890" });
    const t = target(nx);
    const read = await errorOf(t.versions(ctx.address, ctx));
    // The fake does not know the CLI token: the read is refused, and the token is never printed.
    expect(read.code).toBe("publish-read-failed");
    expect(read.message).not.toContain("cli-token-1234567890");
    expect(nx.requests.at(-1)!.headers.authorization).toBe("Bearer cli-token-1234567890");
  });

  it("waits out a cached not-found after the upload", async () => {
    const nx = fake({ cacheNotFound: 2 });
    const c = clock();
    const ctx = context(ENV);
    const t = target(nx, { pollMs: 500 }, c);
    await t.reveal(ctx, await t.stage(ctx));
    expect(c.sleeps).toEqual([500, 500]);
  });

  it("stops after the wait when the version is never listed", async () => {
    const nx = fake({ cacheNotFound: 100 });
    const ctx = context(ENV);
    const t = target(nx, { waitMs: 1000, pollMs: 500 });
    const e = await errorOf(t.reveal(ctx, await t.stage(ctx)));
    expect(e.code).toBe("publish-reveal-missing");
    expect(e.fix).toContain("3.95.0");
  });

  it("sends nothing for a version already uploaded with the same content", async () => {
    const nx = fake();
    const ctx = context(ENV);
    nx.seed("terraform-hosted", "acme", "vpc", "aws", "1.2.0", "vpc-1.2.0.zip", moduleZip(ctx.archive, ctx.content));
    const staged = await target(nx).stage(ctx);
    expect(staged.items[0]!.present).toBe(true);
    expect(nx.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("refuses a version already uploaded with other content", async () => {
    const nx = fake();
    const ctx = context(ENV);
    const other = archiveOf("other");
    nx.seed("terraform-hosted", "acme", "vpc", "aws", "1.2.0", "vpc-1.2.0.zip", moduleZip(other, archiveContent(other)));
    expect((await errorOf(target(nx).stage(ctx))).code).toBe("publish-version-held");
  });

  it("refuses a 401 naming the variables, never their values", async () => {
    const nx = fake();
    const ctx = context({ NEXUS_USER: USER, NEXUS_TOKEN: "nexus-wrong-pass-0000" });
    const e = await errorOf(target(nx).stage(ctx));
    expect(e.code).toBe("publish-credentials-refused");
    expect(`${e.message} ${e.fix}`).not.toContain("nexus-wrong-pass-0000");
  });

  it("refuses to plan without a user or a token", async () => {
    const nx = fake();
    const e = await errorOf(target(nx).plan(context({ NEXUS_TOKEN: TOKEN })));
    expect(e.code).toBe("publish-credentials-missing");
    expect(e.message).toContain("NEXUS_USER");
  });

  it("names the hosted floor on an upload Nexus refuses", async () => {
    const nx = fake();
    const ctx = context(ENV);
    const failing: typeof nx.fetch = async (url, init) => (init?.method === "PUT" ? new Response("{}", { status: 500 }) : nx.fetch(url, init));
    const e = await errorOf(nexusModuleTarget({ url: URL_, repo: "terraform-hosted" }, { fetch: failing, registryFetch: failing }).stage(ctx));
    expect(e.code).toBe("publish-upload-failed");
    expect(e.fix).toContain("3.89.0");
  });

  it("gives the CLI host block consumers add, and refuses a label a host block cannot carry", () => {
    expect(nexusHostBlock({ url: URL_, repo: "terraform-hosted" })).toBe(
      `host "terraform-hosted" {\n  services = {\n    "modules.v1" = "${URL_}/repository/terraform-hosted/v1/modules/"\n  }\n}\n`,
    );
    expect(() => nexusHostLabel({ repo: "terraform_hosted" })).toThrow(PublishTargetError);
    expect(nexusHostLabel({ repo: "terraform_hosted", host: "tf-hosted" })).toBe("tf-hosted");
    expect(nexusUploadUrl(URL_, "r", { namespace: "n", name: "m", system: "aws" }, "1.0.0")).toBe(`${URL_}/repository/r/v1/modules/n/m/aws/1.0.0/m-1.0.0.zip`);
  });

  it("lets the registry reader take a bare host from its services map", async () => {
    const nx = fake();
    const ctx = context(ENV);
    await target(nx).stage(ctx);
    const versions = await registryVersions("terraform-hosted/acme/vpc/aws", {
      services: { "terraform-hosted": `${URL_}/repository/terraform-hosted/v1/modules/` },
      authorization: BASIC,
      token: false,
      fetch: nx.fetch,
    });
    expect(versions).toEqual(["1.2.0"]);
  });
});

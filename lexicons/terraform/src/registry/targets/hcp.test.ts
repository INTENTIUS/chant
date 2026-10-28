// chant#4604: the HCP Terraform module target against the in-memory HCP fake. No HCP account and no
// HCP call: every request goes to the fake, the clock is the test's, and no token value appears in a
// log line, an error or a staged record.
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PublishTargetError } from "@intentius/chant/lifecycle/release-publish";
import { createRedactor } from "@intentius/chant/lifecycle/publish-credentials";
import { HCP_RATE_RETRIES, archiveContent, hcpModuleTarget, hcpTokenEnv, retryDelay, type HcpModuleTargetOptions, type ModuleVersionContext } from "../index";
import { ARCHIVIST, createFakeHcp, type FakeHcpOptions } from "./fake-hcp";

const ORG = "acme";
const TOKEN = "team-token.atlasv1.0123456789abcdef";
const NO_MANAGE = "team-token.atlasv1.readonly-000000";

const fake = (over: Partial<FakeHcpOptions> = {}) => createFakeHcp({ organization: ORG, tokens: { [TOKEN]: { manageModules: true }, [NO_MANAGE]: { manageModules: false } }, ...over });
const archiveOf = (text: string) => gzipSync(Buffer.from(`module tar: ${text}`));

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps };
}

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
    address: { namespace: "ignored", name: "vpc", system: "aws" },
    version: "1.2.0",
    revision: "3f2a9c1d0b7e3f2a9c1d0b7e3f2a9c1d0b7e3f2a",
    content: archiveContent(archive),
    archive,
    ...over,
    lines,
  };
}

function target(hcp: ReturnType<typeof fake>, c = clock(), opts: Partial<HcpModuleTargetOptions> = {}) {
  return hcpModuleTarget({ organization: ORG, waitMs: 10_000, pollMs: 1000, ...opts }, { fetch: hcp.fetch, registryFetch: hcp.fetch, sleep: c.sleep, now: c.now });
}

const writes = (hcp: ReturnType<typeof fake>) => hcp.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`);

const errorOf = async (p: Promise<unknown>): Promise<PublishTargetError> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PublishTargetError);
  return e as PublishTargetError;
};

const API = "https://app.terraform.io/api/v2/organizations/acme/registry-modules";

describe("HCP Terraform module target (chant#4604)", () => {
  it("makes the three calls in order: create the module, create the version, upload the tarball", async () => {
    const hcp = fake();
    const ctx = context({ TFE_TOKEN: TOKEN });
    const t = target(hcp);
    expect(await t.plan(ctx)).toEqual([{ name: "acme/vpc/aws 1.2.0", destination: "app.terraform.io/acme/vpc/aws", digest: ctx.content }]);
    const staged = await t.stage(ctx);
    expect(writes(hcp)).toEqual([`POST ${API}`, `POST ${API}/private/acme/vpc/aws/versions`, `PUT https://${ARCHIVIST}/v1/object/obj1`]);

    const [createModule, createVersion, upload] = hcp.requests.filter((r) => r.method !== "GET");
    expect(JSON.parse(new TextDecoder().decode(createModule!.body))).toEqual({ data: { type: "registry-modules", attributes: { name: "vpc", provider: "aws", "registry-name": "private" } } });
    expect(JSON.parse(new TextDecoder().decode(createVersion!.body))).toEqual({ data: { type: "registry-module-versions", attributes: { version: "1.2.0", "commit-sha": ctx.revision } } });
    expect(createModule!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(createModule!.headers["content-type"]).toBe("application/vnd.api+json");
    expect(upload!.headers["content-type"]).toBe("application/octet-stream");
    expect(upload!.headers.authorization).toBeUndefined();
    expect(Buffer.from(upload!.body!)).toEqual(Buffer.from(ctx.archive));
    // The module was read first, and created only because it was absent.
    expect(hcp.requests[0]!.method).toBe("GET");
    expect(hcp.requests[0]!.url).toBe(`${API}/private/acme/vpc/aws`);
    expect(staged.items[0]!.present).toBeUndefined();
    expect(JSON.stringify(staged)).not.toContain(TOKEN);

    await t.reveal(ctx, staged);
    expect(hcp.modules.get("vpc/aws")!.get("1.2.0")!.commitSha).toBe(ctx.revision);
  });

  it("does not create a module that is already there", async () => {
    const hcp = fake();
    hcp.seed("vpc", "aws");
    await target(hcp).stage(context({ TFE_TOKEN: TOKEN }));
    expect(writes(hcp)).toEqual([`POST ${API}/private/acme/vpc/aws/versions`, `PUT https://${ARCHIVIST}/v1/object/obj1`]);
  });

  it("comes back present and sends nothing for a version held with the same content", async () => {
    const hcp = fake();
    const ctx = context({ TFE_TOKEN: TOKEN });
    hcp.seed("vpc", "aws", { version: "1.2.0", archive: ctx.archive });
    const t = target(hcp);
    expect(await t.held(ctx.address, "1.2.0", ctx)).toEqual({ content: ctx.content });
    const staged = await t.stage(ctx);
    expect(staged.items[0]!.present).toBe(true);
    expect(writes(hcp)).toEqual([]);
    expect(await t.versions(ctx.address, ctx)).toEqual(["1.2.0"]);
  });

  it("refuses a version held with other content, and sends nothing", async () => {
    const hcp = fake();
    hcp.seed("vpc", "aws", { version: "1.2.0", archive: archiveOf("other") });
    const err = await errorOf(target(hcp).stage(context({ TFE_TOKEN: TOKEN })));
    expect(err.code).toBe("publish-version-held");
    expect(writes(hcp)).toEqual([]);
  });

  it("refuses a version an earlier run left pending, naming the fix", async () => {
    const hcp = fake();
    hcp.seed("vpc", "aws", { version: "1.2.0", archive: archiveOf("x"), status: "pending" });
    hcp.modules.get("vpc/aws")!.get("1.2.0")!.archive = undefined;
    const err = await errorOf(target(hcp).stage(context({ TFE_TOKEN: TOKEN })));
    expect(err.code).toBe("publish-version-unfinished");
    expect(err.fix).toContain("delete the version");
  });

  it("retries a 429 after Retry-After, then succeeds", async () => {
    const hcp = fake();
    const c = clock();
    hcp.throttle(2, "3");
    const ctx = context({ TFE_TOKEN: TOKEN });
    await target(hcp, c).stage(ctx);
    expect(c.sleeps).toEqual([3000, 3000]);
    expect(writes(hcp)).toContain(`PUT https://${ARCHIVIST}/v1/object/obj1`);
    expect(ctx.lines.filter((l) => l.includes("429"))).toHaveLength(2);
  });

  it("backs off, doubling, when a 429 has no Retry-After", async () => {
    const hcp = fake();
    const c = clock();
    hcp.throttle(3);
    await target(hcp, c).stage(context({ TFE_TOKEN: TOKEN }));
    expect(c.sleeps).toEqual([1000, 2000, 4000]);
    expect(retryDelay(null, 0, 0)).toBe(1000);
    expect(retryDelay(new Date(5000).toUTCString(), 0, 2000)).toBe(3000);
  });

  it("stops with publish-rate-limited after the retry limit", async () => {
    const hcp = fake();
    const c = clock();
    hcp.throttle(HCP_RATE_RETRIES + 1, "1");
    const err = await errorOf(target(hcp, c).stage(context({ TFE_TOKEN: TOKEN })));
    expect(err.code).toBe("publish-rate-limited");
    expect(c.sleeps).toHaveLength(HCP_RATE_RETRIES);
    expect(writes(hcp)).toEqual([]);
  });

  it("names both causes on a 404: the Manage modules permission and the entitlement", async () => {
    for (const [hcp, env] of [
      [fake(), { TFE_TOKEN: NO_MANAGE }],
      [fake({ entitled: false }), { TFE_TOKEN: TOKEN }],
    ] as const) {
      const err = await errorOf(target(hcp).stage(context({ ...env })));
      expect(err.code).toBe("publish-not-found");
      expect(err.message).toContain("Manage modules");
      expect(err.message).toContain("entitlement");
      expect(err.message).not.toContain(env.TFE_TOKEN);
    }
  });

  it("names the variable on a refused token, never its value", async () => {
    const hcp = fake();
    const err = await errorOf(target(hcp).stage(context({ TFE_TOKEN: "unknown-token-value-1234" })));
    expect(err.code).toBe("publish-credentials-refused");
    expect(err.message).toContain("TFE_TOKEN");
    expect(`${err.message} ${err.fix}`).not.toContain("unknown-token-value-1234");
  });

  it("takes TF_TOKEN_<host> when TFE_TOKEN is not set, and refuses with neither", async () => {
    const hcp = fake();
    await target(hcp).stage(context({ TF_TOKEN_app_terraform_io: TOKEN }));
    expect(hcp.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const none = await errorOf(target(fake()).plan(context({})));
    expect(none.code).toBe("publish-credentials-missing");
    expect(none.message).toContain("TFE_TOKEN or TF_TOKEN_app_terraform_io");
    expect(hcpTokenEnv({ host: "tfe.example.com" })).toEqual(["TFE_TOKEN", "TF_TOKEN_tfe_example_com"]);
  });

  it("talks to a Terraform Enterprise host when one is given", async () => {
    const hcp = fake({ host: "tfe.example.com" });
    await target(hcp, clock(), { host: "tfe.example.com" }).stage(context({ TFE_TOKEN: TOKEN }));
    expect(hcp.requests[0]!.url).toBe("https://tfe.example.com/api/v2/organizations/acme/registry-modules/private/acme/vpc/aws");
  });

  it("reveals once polling sees the version's status turn ok", async () => {
    const hcp = fake({ parseAfterReads: 3 });
    const c = clock();
    const ctx = context({ TFE_TOKEN: TOKEN });
    const t = target(hcp, c);
    const published = await t.reveal(ctx, await t.stage(ctx));
    expect(published.destination).toBe("app.terraform.io/acme/vpc/aws");
    expect(hcp.modules.get("vpc/aws")!.get("1.2.0")!.status).toBe("ok");
    expect(c.sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(c.sleeps.length).toBeGreaterThan(0);
    expect(ctx.lines.some((l) => l.includes("still"))).toBe(false);
  });

  it("reports a version still parsing past the wait, without failing", async () => {
    const hcp = fake({ parseAfterReads: Infinity });
    const c = clock();
    const ctx = context({ TFE_TOKEN: TOKEN });
    const t = target(hcp, c);
    const published = await t.reveal(ctx, await t.stage(ctx));
    expect(published.items).toHaveLength(1);
    expect(ctx.lines.some((l) => l.includes("is still pending"))).toBe(true);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
  });

  it("masks the token in every log line and error", async () => {
    const hcp = fake({ parseAfterReads: Infinity });
    const c = clock();
    hcp.throttle(1, "1");
    const ctx = context({ TFE_TOKEN: TOKEN });
    const t = target(hcp, c);
    await t.reveal(ctx, await t.stage(ctx));
    const other = context(ctx.env, { version: "1.2.0", archive: archiveOf("changed"), content: archiveContent(archiveOf("changed")) });
    const err = await errorOf(t.stage(other));
    const all = [...ctx.lines, ...other.lines, err.message, err.fix ?? ""].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(ctx.redactor.redact(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN);
  });
});

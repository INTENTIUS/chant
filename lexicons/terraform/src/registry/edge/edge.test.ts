// The edge function for bucket registries (chant#4566), tested as a handler in process: no CDN, no deploy.
// The reader's `reads: "terraform"` and `reads: "tofu"` stand in for the two CLIs' download reading, and
// its token lookup for the CLIs' TF_TOKEN_<host> (chant#4563).
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { downloadDoc, fetchTarball, handlerFetch, headersFile, readHeadersFile, registryLocation, registryVersions, type RegistryFetch } from "../index";
import { lambdaEdgeHandler, registryEdge, registryWorkerFetch, signLocation, tokensFromSecret, verifySignedUrl, type CloudFrontRequestEvent, type RegistryEdgeOptions } from "./index";

const HOST = "modules.test";
const MOD = `${HOST}/acme/net/generic`;
const DIR = "v1/modules/acme/net/generic";
const TARBALL = `https://${HOST}/${DIR}/0.1.0/net-0.1.0.tar.gz`;

/** A bucket's objects, as an edge function reads them: no headers per object. */
function bucket(prefix = ""): Map<string, string | Uint8Array> {
  const p = prefix ? `${prefix}/` : "";
  return new Map<string, string | Uint8Array>([
    [`${p}.well-known/terraform.json`, '{"modules.v1":"/v1/modules/"}\n'],
    [`${p}${DIR}/versions`, JSON.stringify({ modules: [{ versions: [{ version: "0.1.0" }] }] })],
    [`${p}${DIR}/0.1.0/download`, downloadDoc(TARBALL)],
    [`${p}${DIR}/0.1.0/net-0.1.0.tar.gz`, new Uint8Array(gzipSync(Buffer.from("module bytes")))],
    [`${p}${DIR}/0.2.0/download`, downloadDoc("git::https://git.test/acme/net.git?ref=v0.2.0")],
  ]);
}

const files = (objects: Map<string, string | Uint8Array>): RegistryEdgeOptions["files"] => async (key) => ({ body: objects.get(key) });

const edgeFetch = (options: Partial<RegistryEdgeOptions> & { objects?: Map<string, string | Uint8Array> } = {}): RegistryFetch => handlerFetch(registryEdge({ files: files(options.objects ?? bucket()), ...options }));

const noCredentials = { env: {}, readFile: () => undefined };
const withToken = (token: string) => ({ env: { TF_TOKEN_modules_test: token }, readFile: () => undefined });

describe("auth off (the default)", () => {
  it("adds X-Terraform-Get, so both CLIs' readings find the plain tarball URL with no token", async () => {
    const fetch = edgeFetch();
    expect(await registryVersions(MOD, { fetch, credentials: noCredentials })).toEqual(["0.1.0"]);
    expect(await registryLocation(MOD, "0.1.0", { fetch, credentials: noCredentials, reads: "terraform" })).toBe(TARBALL);
    expect(await registryLocation(MOD, "0.1.0", { fetch, credentials: noCredentials, reads: "tofu" })).toBe(TARBALL);
    expect((await fetchTarball(TARBALL, { fetch, credentials: noCredentials })).toString()).toBe("module bytes");
  });

  it("leaves a git location as stored", async () => {
    expect(await registryLocation(MOD, "0.2.0", { fetch: edgeFetch(), credentials: noCredentials, reads: "terraform" })).toBe("git::https://git.test/acme/net.git?ref=v0.2.0");
  });

  it("reads the registry under a prefix in the bucket", async () => {
    const fetch = edgeFetch({ objects: bucket("registry"), prefix: "registry" });
    expect(await registryLocation(MOD, "0.1.0", { fetch, credentials: noCredentials, reads: "terraform" })).toBe(TARBALL);
  });
});

describe("auth on", () => {
  const auth = { tokens: ["old-token", "s3cret"], signingKey: "sign-key", ttl: 300 };
  const now = 1_800_000_000_000;

  it("refuses discovery, versions and download without the token, with 401", async () => {
    const log: string[] = [];
    const fetch = edgeFetch({ auth, now: () => now, log: (l) => log.push(l) });
    await expect(registryVersions(MOD, { fetch, credentials: noCredentials })).rejects.toThrow("answered 401");
    await expect(registryVersions(MOD, { fetch, token: "wrong" })).rejects.toThrow("refused the token");
    for (const path of [".well-known/terraform.json", `${DIR}/versions`, `${DIR}/0.1.0/download`, `${DIR}/0.1.0/net-0.1.0.tar.gz`]) {
      const res = await fetch(`https://${HOST}/${path}`);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect(log.every((l) => !l.includes("s3cret"))).toBe(true);
  });

  it("answers with the token, under both readings, and accepts either token while one rotates", async () => {
    const fetch = edgeFetch({ auth, now: () => now });
    expect(await registryVersions(MOD, { fetch, credentials: withToken("s3cret") })).toEqual(["0.1.0"]);
    expect(await registryVersions(MOD, { fetch, credentials: withToken("old-token") })).toEqual(["0.1.0"]);
    const terraform = await registryLocation(MOD, "0.1.0", { fetch, credentials: withToken("s3cret"), reads: "terraform" });
    const tofu = await registryLocation(MOD, "0.1.0", { fetch, credentials: withToken("s3cret"), reads: "tofu" });
    expect(terraform).toBe(tofu);
    expect(terraform).not.toBe(TARBALL);
    expect(terraform.startsWith(`${TARBALL}?expires=`)).toBe(true);
  });

  it("serves the tarball through the signed URL with no token, until it expires", async () => {
    let clock = now;
    const fetch = edgeFetch({ auth, now: () => clock });
    const signed = await registryLocation(MOD, "0.1.0", { fetch, credentials: withToken("s3cret"), reads: "terraform" });
    // go-getter sends no token for the tarball.
    expect((await fetchTarball(signed, { fetch, token: false })).toString()).toBe("module bytes");
    expect((await fetch(signed, { method: "HEAD" })).status).toBe(200);
    clock = now + 301_000;
    expect((await fetch(signed)).status).toBe(401);
  });

  it("refuses a signature moved to another file or tampered with", async () => {
    const signed = new URL(await signLocation(TARBALL, "sign-key", now, 300));
    expect(await verifySignedUrl(signed, "sign-key", now)).toBe(true);
    expect(await verifySignedUrl(signed, "other-key", now)).toBe(false);
    const moved = new URL(signed.toString().replace("net-0.1.0", "net-0.2.0"));
    expect(await verifySignedUrl(moved, "sign-key", now)).toBe(false);
    const extended = new URL(signed);
    extended.searchParams.set("expires", String(Number(extended.searchParams.get("expires")) + 3600));
    expect(await verifySignedUrl(extended, "sign-key", now)).toBe(false);
    // A signed URL opens files, never the protocol answers.
    const fetch = edgeFetch({ auth, now: () => now });
    const sneaky = new URL(`https://${HOST}/${DIR}/versions`);
    sneaky.search = signed.search;
    expect((await fetch(sneaky.toString())).status).toBe(401);
  });

  it("signs with the first token when no signing key is set", async () => {
    const fetch = edgeFetch({ auth: { tokens: ["s3cret"] }, now: () => now });
    const signed = await registryLocation(MOD, "0.1.0", { fetch, credentials: withToken("s3cret"), reads: "terraform" });
    expect(await verifySignedUrl(new URL(signed), "s3cret", now)).toBe(true);
  });
});

describe("Cloudflare Worker", () => {
  const r2 = (objects: Map<string, string | Uint8Array>) => ({
    get: async (key: string) => {
      const body = objects.get(key);
      if (body === undefined) return null;
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      return { arrayBuffer: async () => bytes.slice().buffer };
    },
  });

  it("leaves auth off unless REGISTRY_AUTH is token", async () => {
    const res = await registryWorkerFetch(new Request(`https://${HOST}/${DIR}/0.1.0/download`), { REGISTRY_BUCKET: r2(bucket()) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-terraform-get")).toBe(TARBALL);
  });

  it("checks the token from REGISTRY_TOKENS when REGISTRY_AUTH is token", async () => {
    const env = { REGISTRY_BUCKET: r2(bucket()), REGISTRY_AUTH: "token", REGISTRY_TOKENS: "a\ns3cret" };
    expect((await registryWorkerFetch(new Request(`https://${HOST}/${DIR}/versions`), env)).status).toBe(401);
    expect((await registryWorkerFetch(new Request(`https://${HOST}/${DIR}/versions`, { headers: { authorization: "Bearer s3cret" } }), env)).status).toBe(200);
    expect(tokensFromSecret(" a, b \n\nc ")).toEqual(["a", "b", "c"]);
  });

  it("says what is missing without a bucket", async () => {
    expect((await registryWorkerFetch(new Request(`https://${HOST}/x`), {})).status).toBe(500);
  });
});

describe("Lambda@Edge", () => {
  const event = (uri: string, headers: Record<string, string> = {}, querystring = ""): CloudFrontRequestEvent => ({
    Records: [{ cf: { request: { uri, querystring, method: "GET", headers: { host: [{ key: "Host", value: HOST }], ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), [{ key: k, value: v }]])) } } } }],
  });

  it("answers a download itself and passes other files on to the bucket", async () => {
    const handler = lambdaEdgeHandler({ files: files(bucket()) });
    const answer = await handler(event(`/${DIR}/0.1.0/download`));
    expect("status" in answer && answer.status).toBe("200");
    expect("status" in answer && answer.headers["x-terraform-get"]?.[0]?.value).toBe(TARBALL);
    const passed = await handler(event(`/${DIR}/versions`));
    expect("uri" in passed && passed.uri).toBe(`/${DIR}/versions`);
  });

  it("refuses without the token and drops the signature before the bucket", async () => {
    const now = 1_800_000_000_000;
    const handler = lambdaEdgeHandler({ files: files(bucket()), auth: { tokens: ["s3cret"] }, now: () => now });
    const refused = await handler(event(`/${DIR}/versions`));
    expect("status" in refused && refused.status).toBe("401");
    const signed = new URL(await signLocation(TARBALL, "s3cret", now));
    const passed = await handler(event(signed.pathname, {}, signed.search.slice(1)));
    expect("uri" in passed && passed.querystring).toBe("");
  });
});

describe("_headers for Cloudflare Pages and Netlify", () => {
  it("writes a rule per download and keeps the site's other rules", () => {
    const existing = "/*\n  X-Frame-Options: DENY\n\n/v1/modules/acme/net/generic/0.1.0/download\n  X-Terraform-Get: https://old.test/x.tar.gz\n";
    const text = headersFile([{ path: `${DIR}/0.1.0/download`, location: TARBALL }, { path: `/${DIR}/0.0.9/download`, location: "https://modules.test/y.tar.gz" }], existing);
    expect(text).toContain("/*\n  X-Frame-Options: DENY");
    expect(text).toContain(`/${DIR}/0.1.0/download\n  X-Terraform-Get: ${TARBALL}`);
    expect(text).not.toContain("old.test");
    expect(readHeadersFile(text).downloads.map((r) => r.path)).toEqual([`/${DIR}/0.0.9/download`, `/${DIR}/0.1.0/download`]);
  });
});

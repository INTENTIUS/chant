/**
 * The deprecated-version check against a fixture catalog, the catalog reader
 * with the registry's token (chant#4599), and the handler's page types.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReleaseCatalog } from "@intentius/chant/lifecycle/release-catalog";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import { moduleConsumers } from "../pin/consumers";
import { catalogUrl, readRegistryCatalog } from "./catalog-read";
import { deprecatedPins } from "./deprecated";
import { registryContentType, registryHandler } from "./handler";
import { RegistryError } from "./reader";

const REPO = join(import.meta.dirname, "..", "pin", "__fixtures__", "consumers");

const rec = (releaseVersion: string, digest: string, timestamp: string): ReleaseRecord => ({
  version: 1,
  component: "acme/vpc/aws",
  env: "registry",
  digest,
  releaseVersion,
  gitSha: "a".repeat(40),
  runId: "r",
  timestamp,
  actor: "ci",
});

const catalog = buildReleaseCatalog(
  {
    releases: [rec("1.0.0", "sha256:v1", "2026-10-01T00:00:00.000Z"), rec("1.1.0", "sha256:v11", "2026-10-02T00:00:00.000Z"), rec("2.0.0", "sha256:v2", "2026-10-03T00:00:00.000Z")],
    statuses: [
      { component: "acme/vpc/aws", digest: "sha256:v1", status: "deprecated", reason: "drops flow logs", replacement: "1.1.0", actor: "ana", timestamp: "2026-10-04T00:00:00.000Z" },
      { component: "acme/vpc/aws", digest: "sha256:v2", status: "yanked", reason: "breaks routes", replacement: "1.1.0", actor: "ana", timestamp: "2026-10-04T00:00:00.000Z" },
    ],
    fields: [{ component: "acme/vpc/aws", engine: "terraform", fields: { address: "registry.acme.dev/acme/vpc/aws" } }],
  },
  { generatedAt: "2026-10-27T00:00:00.000Z" },
);

describe("deprecatedPins", () => {
  test("warns on a deprecated pin, refuses a yanked one, and passes an active one", async () => {
    const consumers = await moduleConsumers(REPO, ["live/prod", "live/dev", "units/vpc"]);
    const { warnings, refusals } = deprecatedPins(consumers, catalog);
    expect(warnings.map((w) => [w.consumer.root, w.version, w.replacement])).toEqual([["live/prod", "1.0.0", "1.1.0"]]);
    expect(warnings[0]!.message).toBe("live/prod/main.tf module.vpc pins acme/vpc/aws 1.0.0, which is deprecated: drops flow logs; move to 1.1.0");
    // live/dev pins v2.0.0: the leading v is ignored, and its host's case too.
    expect(refusals.map((r) => [r.consumer.root, r.version, r.status])).toEqual([["live/dev", "2.0.0", "yanked"]]);
    expect(refusals[0]!.message).toContain("which is yanked: breaks routes; move to 1.1.0");
  });

  test("leaves unpinned calls and modules the catalog does not list alone", async () => {
    const consumers = await moduleConsumers(REPO, ["live/prod"]);
    const { warnings, refusals } = deprecatedPins(consumers.filter((c) => c.address !== "module.vpc"), catalog);
    expect(warnings).toEqual([]);
    expect(refusals).toEqual([]);
  });

  test("matches a component by name when it has no terraform address, and a pin by digest", () => {
    const byName = buildReleaseCatalog(
      {
        releases: [{ ...rec("3.1.0", "sha256:c31", "2026-10-01T00:00:00.000Z"), component: "oci://registry.acme.dev/modules/cache", releaseVersion: undefined }],
        statuses: [{ component: "oci://registry.acme.dev/modules/cache", digest: "sha256:c31", status: "yanked", actor: "a", timestamp: "2026-10-02T00:00:00.000Z" }],
      },
      { generatedAt: "2026-10-27T00:00:00.000Z" },
    );
    const call = { root: "r", file: "r/main.tf", address: "module.cache", kind: "terraform" as const, source: "oci://registry.acme.dev/modules/cache?digest=sha256:c31", module: "oci://registry.acme.dev/modules/cache", pin: "sha256:c31", at: "source" as const, param: "digest" as const };
    const { refusals } = deprecatedPins([call], byName);
    expect(refusals.map((r) => [r.version, r.reason])).toEqual([["sha256:c31", null]]);
    expect(refusals[0]!.message).toBe("r/main.tf module.cache pins oci://registry.acme.dev/modules/cache sha256:c31, which is yanked");
  });
});

describe("readRegistryCatalog", () => {
  const body = JSON.stringify(catalog);

  test("sends the registry's token and validates the answer", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const got = await readRegistryCatalog("modules.acme.dev", {
      token: "t0k",
      fetch: async (url, init) => {
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect(seen).toEqual([{ url: "https://modules.acme.dev/catalog/index.json", auth: "Bearer t0k" }]);
    expect(got).toEqual(catalog);
  });

  test("reads the token the CLIs would send", async () => {
    let auth: string | null = null;
    await readRegistryCatalog("modules.acme.dev", {
      credentials: { env: { TF_TOKEN_modules_acme_dev: "from-env" } },
      fetch: async (_url, init) => ((auth = new Headers(init?.headers).get("authorization")), new Response(body)),
    });
    expect(auth).toBe("Bearer from-env");
  });

  test("a registry with no catalog gives null; a refusal names where the token goes and never a value", async () => {
    expect(await readRegistryCatalog("https://cdn.acme.dev/registry", { token: false, fetch: async () => new Response("", { status: 404 }) })).toBeNull();
    const refused = readRegistryCatalog("modules.acme.dev", { token: false, fetch: async () => new Response("", { status: 401 }) });
    await expect(refused).rejects.toBeInstanceOf(RegistryError);
    await expect(readRegistryCatalog("modules.acme.dev", { token: "secret-value", fetch: async () => new Response("", { status: 403 }) })).rejects.toThrow(/refused the token for modules\.acme\.dev/);
    await expect(readRegistryCatalog("modules.acme.dev", { token: "secret-value", fetch: async () => new Response("", { status: 403 }) })).rejects.not.toThrow(/secret-value/);
  });

  test("an answer that is not a catalog is an error", async () => {
    await expect(readRegistryCatalog("modules.acme.dev", { token: false, fetch: async () => new Response("{\"contract\":1}") })).rejects.toThrow(/is not a release catalog/);
  });

  test("catalogUrl takes a host or a base URL", () => {
    expect(catalogUrl("modules.acme.dev")).toBe("https://modules.acme.dev/catalog/index.json");
    expect(catalogUrl("https://cdn.acme.dev/registry")).toBe("https://cdn.acme.dev/registry/catalog/index.json");
    expect(catalogUrl("localhost:8080", "http")).toBe("http://localhost:8080/catalog/index.json");
  });
});

describe("the handler serves catalog pages so a browser renders them", () => {
  test.each([
    ["catalog/index.html", "text/html; charset=utf-8"],
    ["catalog/style.css", "text/css; charset=utf-8"],
    ["catalog/search.js", "text/javascript; charset=utf-8"],
    ["catalog/logo.SVG", "image/svg+xml"],
    ["catalog/index.json", "application/json"],
    ["v1/modules/acme/vpc/aws/versions", "application/json"],
    ["vpc-1.0.0.tar.gz", "application/gzip"],
    ["catalog.d/README", "application/octet-stream"],
    ["providers/x.zip", "application/octet-stream"],
  ])("%s is %s", (key, type) => {
    expect(registryContentType(key)).toBe(type);
  });

  test("on a request", async () => {
    const handler = registryHandler(async (key) => (key === "catalog/index.html" ? { body: "<!doctype html>" } : {}));
    const res = await handler(new Request("https://modules.acme.dev/catalog/index.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

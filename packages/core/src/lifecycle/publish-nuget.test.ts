/**
 * #5232: the NuGet target, against a fake feed that serves a flat container,
 * the push API and nuget.org's trusted-publishing exchange. The stage pushes
 * nothing; the reveal pushes. Nothing reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formFile, publishContext, refusal, reply, sha256, zipOf } from "./__fixtures__/package-files";
import { NugetPublishSchema } from "./publish-declaration";
import { normalizeNugetVersion, readNupkg } from "./publish-nuget";
import { createPublishTargets } from "./publish-targets";
import type { StatusContext } from "./release-publish";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Arugula.Kit</id>
    <version>1.2.0</version>
    <authors>acme</authors>
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Arugula.Core" version="1.2.0" />
        <dependency id="Newtonsoft.Json" version="13.0.3" />
      </group>
    </dependencies>
  </metadata>
</package>`;

function member(opts: { sbom?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-nuget-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist", "nuget"), { recursive: true });
  const nupkg = zipOf({ "Arugula.Kit.nuspec": NUSPEC, "lib/net8.0/Arugula.Kit.dll": "MZ", ...(opts.sbom ? { "_manifest/spdx_2.2/manifest.spdx.json": "{}" } : {}) });
  writeFileSync(join(dir, "dist", "nuget", "Arugula.Kit.1.2.0.nupkg"), nupkg);
  return { dir, nupkg };
}

/** A fake nuget.org: versions per id, pushes that add to them, unlists, and the token exchange. */
function fakeFeed(opts: { versions?: string[]; trusted?: boolean } = {}) {
  const versions = new Set(opts.versions ?? []);
  const pushes: Array<{ key: string; protocol: string; field: string; bytes: Buffer }> = [];
  const calls: Array<{ method: string; url: string }> = [];
  const exchanges: unknown[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    calls.push({ method: init.method, url });
    if (init.method === "GET" && url === "https://api.nuget.org/v3-flatcontainer/arugula.kit/index.json") return versions.size ? reply(200, JSON.stringify({ versions: [...versions] })) : reply(404);
    if (init.method === "PUT" && url === "https://www.nuget.org/api/v2/package") {
      const key = init.headers["x-nuget-apikey"]!;
      if (key !== "nuget-secret-key" && key !== "exchanged-key") return reply(403, "The specified API key is invalid");
      const f = formFile(init.body as Uint8Array, init.headers["content-type"]!);
      if (versions.has("1.2.0")) return reply(409, "A package with ID 'Arugula.Kit' and version '1.2.0' already exists");
      pushes.push({ key, protocol: init.headers["x-nuget-protocol-version"]!, field: f.field, bytes: f.bytes });
      return reply(201);
    }
    if (url.startsWith("https://www.nuget.org/api/v2/package/Arugula.Kit/1.2.0")) return reply(init.method === "DELETE" ? 204 : 200);
    if (init.method === "GET" && url.startsWith("https://gha.test/token")) return new URL(url).searchParams.get("audience") === "https://www.nuget.org" ? reply(200, JSON.stringify({ value: "gha-id-token" })) : reply(400);
    if (init.method === "POST" && url === "https://www.nuget.org/api/v2/token") {
      exchanges.push({ auth: init.headers.authorization, body: JSON.parse(init.body as string) });
      return opts.trusted && init.headers.authorization === "Bearer gha-id-token" ? reply(200, JSON.stringify({ apiKey: "exchanged-key" })) : reply(401, JSON.stringify({ error: "No matching trust policy" }));
    }
    return reply(404);
  };
  return { fetch, versions, pushes, calls, exchanges };
}

const decl = (d: Record<string, unknown> = {}) => NugetPublishSchema.parse({ type: "nuget", packages: ["dist/nuget"], ...d });
const gha = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" };

describe("nuget (#5232)", () => {
  test("reads the nuspec and normalizes versions as the flat container lists them", () => {
    const { dir } = member({ sbom: true });
    const p = readNupkg("dist/nuget/Arugula.Kit.1.2.0.nupkg", join(dir, "dist", "nuget", "Arugula.Kit.1.2.0.nupkg"));
    expect(p).toMatchObject({ id: "Arugula.Kit", version: "1.2.0", dependencies: ["Arugula.Core", "Newtonsoft.Json"], sbom: "_manifest/spdx_2.2/manifest.spdx.json" });
    expect(normalizeNugetVersion("1.02.0.0")).toBe("1.2.0");
    expect(normalizeNugetVersion("1.2.0-RC.1+abc")).toBe("1.2.0-rc.1");
    expect(normalizeNugetVersion("1.2")).toBe("1.2.0");
  });

  test("the declaration keeps a feed's URLs together and trusted publishing on nuget.org", () => {
    expect(NugetPublishSchema.safeParse({ type: "nuget", packages: ["x"], pushUrl: "https://feed.test/push" }).success).toBe(false);
    expect(NugetPublishSchema.safeParse({ type: "nuget", packages: ["x"], pushUrl: "https://feed.test/push", flatContainerUrl: "https://feed.test/flat/", auth: "trusted-publishing" }).success).toBe(false);
  });

  test("the stage pushes nothing; the reveal pushes with the key and the protocol header", async () => {
    const { dir, nupkg } = member();
    const feed = fakeFeed();
    const [t] = await createPublishTargets([decl()], { fetch: feed.fetch });
    const ctx = publishContext(dir, { NUGET_API_KEY: "nuget-secret-key" });
    const staged = await t!.stage(ctx);
    expect(feed.pushes).toHaveLength(0);
    expect(staged.items).toEqual([{ name: "Arugula.Kit@1.2.0", destination: "https://www.nuget.org/packages/Arugula.Kit/1.2.0", digest: `sha256:${sha256(nupkg)}` }]);
    const out = await t!.reveal(ctx, staged);
    expect(feed.pushes).toEqual([{ key: "nuget-secret-key", protocol: "4.1.0", field: "package", bytes: nupkg }]);
    expect(out.items[0]!.present).toBeUndefined();
    expect(ctx.lines.join("\n")).not.toContain("nuget-secret-key");
  });

  test("a version the feed lists is present, and a 409 at the push is present too", async () => {
    const { dir } = member();
    const listed = fakeFeed({ versions: ["1.2.0"] });
    const [t] = await createPublishTargets([decl()], { fetch: listed.fetch });
    const ctx = publishContext(dir, { NUGET_API_KEY: "nuget-secret-key" });
    const staged = await t!.stage(ctx);
    expect(staged.state).toEqual({ present: "true" });
    expect((await t!.reveal(ctx, staged)).items[0]!.present).toBe(true);

    const racing = fakeFeed();
    const [u] = await createPublishTargets([decl()], { fetch: racing.fetch });
    const staged2 = await u!.stage(ctx);
    racing.versions.add("1.2.0");
    const fetchHidingIt = async (url: string, init: Parameters<typeof racing.fetch>[1]) => (url.endsWith("/index.json") ? reply(404) : racing.fetch(url, init));
    const [v] = await createPublishTargets([decl()], { fetch: fetchHidingIt });
    expect((await v!.reveal(ctx, staged2)).items[0]!.present).toBe(true);
  });

  test("trusted publishing exchanges the run's ID token with the user for a key", async () => {
    const { dir } = member();
    const feed = fakeFeed({ trusted: true });
    const [t] = await createPublishTargets([decl()], { fetch: feed.fetch });
    const ctx = publishContext(dir, { ...gha, NUGET_USER: "acme-bot" });
    const staged = await t!.stage(ctx);
    expect(feed.exchanges).toEqual([{ auth: "Bearer gha-id-token", body: { username: "acme-bot", tokenType: "ApiKey" } }]);
    await t!.reveal(ctx, staged);
    expect(feed.pushes[0]!.key).toBe("exchanged-key");
    expect(feed.exchanges).toHaveLength(2);
  });

  test("with NUGET_ID_TOKEN the stage keeps the token for the reveal's one exchange", async () => {
    const { dir } = member();
    const feed = fakeFeed();
    const [t] = await createPublishTargets([decl({ auth: "trusted-publishing" })], { fetch: feed.fetch });
    const ctx = publishContext(dir, { NUGET_ID_TOKEN: "gitlab-id-token", NUGET_USER: "acme-bot" });
    await t!.stage(ctx);
    expect(feed.exchanges).toHaveLength(0);
    expect(ctx.lines.join("\n")).toContain("takes an ID token once");
  });

  test("refusals: no key, no user, no trusted policy, no SBOM under supply-chain", async () => {
    const { dir } = member();
    const feed = fakeFeed();
    const [t] = await createPublishTargets([decl()], { fetch: feed.fetch });
    expect((await refusal(t!.plan(publishContext(dir, {})))).code).toBe("publish-credentials-missing");
    expect((await refusal(t!.plan(publishContext(dir, gha)))).message).toContain("NUGET_USER");
    expect((await refusal(t!.stage(publishContext(dir, { ...gha, NUGET_USER: "acme-bot" })))).code).toBe("publish-nuget-trusted-publishing");
    expect((await refusal(t!.plan(publishContext(dir, { NUGET_API_KEY: "k-123" }, [], { requireSbom: true })))).code).toBe("publish-sbom-missing");
  });

  test("names, and yank and restore as unlist and list", async () => {
    const { dir } = member();
    const feed = fakeFeed();
    const [t] = await createPublishTargets([decl()], { fetch: feed.fetch });
    const ctx = publishContext(dir, { NUGET_API_KEY: "nuget-secret-key" });
    expect(await t!.names!(ctx)).toEqual({ provides: ["nuget:arugula.kit"], needs: ["nuget:arugula.core", "nuget:newtonsoft.json"] });
    const status = (s: StatusContext["status"]): StatusContext => ({ ...ctx, status: s, reason: null, replacement: null, revealed: [{ name: "Arugula.Kit@1.2.0", destination: "" }], head: null, forgeYank: "prerelease", apply: true });
    expect((await t!.setStatus!(status("yanked")))[0]!.what).toContain("DELETE https://www.nuget.org/api/v2/package/Arugula.Kit/1.2.0");
    expect((await t!.setStatus!(status("active")))[0]!.what).toContain("POST");
    expect((await t!.setStatus!(status("deprecated")))[0]!.already).toBe(true);
  });
});

/**
 * #5232: the RubyGems target, against a fake host that serves the versions
 * API, the push and yank API and the trusted-publishing exchange. The stage
 * pushes nothing; the reveal pushes. Nothing reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { publishContext, refusal, reply, sha256, tarOf } from "./__fixtures__/package-files";
import { RubygemsPublishSchema } from "./publish-declaration";
import { parseGemItemName, parseGemMetadata, readGem } from "./publish-rubygems";
import { createPublishTargets } from "./publish-targets";
import type { StatusContext } from "./release-publish";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SPEC = `--- !ruby/object:Gem::Specification
name: arugula
version: !ruby/object:Gem::Version
  version: 1.2.0
platform: ruby
authors:
- acme
dependencies:
- !ruby/object:Gem::Dependency
  name: arugula-core
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '1.2'
  type: :runtime
  prerelease: false
- !ruby/object:Gem::Dependency
  name: rspec
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '0'
  type: :development
  prerelease: false
description: A gem
`;

function member() {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-rubygems-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist", "gem"), { recursive: true });
  const gem = tarOf({ "metadata.gz": gzipSync(Buffer.from(SPEC)), "data.tar.gz": gzipSync(Buffer.alloc(1024)), "checksums.yaml.gz": gzipSync(Buffer.from("---\n")) });
  writeFileSync(join(dir, "dist", "gem", "arugula-1.2.0.gem"), gem);
  return { dir, gem };
}

/** A fake RubyGems.org: versions by name, pushes that add to them, yanks, and the trusted-publishing exchange. */
function fakeHost(opts: { listed?: Map<string, string>; trusted?: boolean } = {}) {
  const listed = opts.listed ?? new Map<string, string>();
  const pushes: Array<{ key: string; bytes: Buffer }> = [];
  const yanks: string[] = [];
  let exchanges = 0;
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    if (init.method === "GET" && url === "https://rubygems.org/api/v1/versions/arugula.json") {
      return listed.size ? reply(200, JSON.stringify([...listed].map(([number, sha]) => ({ number, platform: "ruby", sha })))) : reply(404, "This rubygem could not be found.");
    }
    if (init.method === "POST" && url === "https://rubygems.org/api/v1/gems") {
      const key = init.headers.authorization!;
      if (key !== "rubygems-secret-key" && key !== "exchanged-key") return reply(401, "Access Denied. Please sign up for an account at https://rubygems.org");
      const bytes = Buffer.from(init.body as Uint8Array);
      if (listed.has("1.2.0")) return reply(409, "Repushing of gem versions is not allowed.");
      pushes.push({ key, bytes });
      listed.set("1.2.0", sha256(bytes));
      return reply(200, "Successfully registered gem: arugula (1.2.0)");
    }
    if (init.method === "DELETE" && url === "https://rubygems.org/api/v1/gems/yank") {
      yanks.push(init.body as string);
      listed.delete("1.2.0");
      return reply(200, "Successfully deleted gem: arugula (1.2.0)");
    }
    if (init.method === "GET" && url.startsWith("https://gha.test/token")) return new URL(url).searchParams.get("audience") === "rubygems.org" ? reply(200, JSON.stringify({ value: "gha-id-token" })) : reply(400);
    if (init.method === "POST" && url === "https://rubygems.org/api/v1/oidc/trusted_publisher/exchange_token") {
      exchanges++;
      const { jwt } = JSON.parse(init.body as string) as { jwt: string };
      return opts.trusted && jwt === "gha-id-token" ? reply(201, JSON.stringify({ rubygems_api_key: "exchanged-key", name: "x", scopes: ["push_rubygem"], expires_at: "2026-11-16T12:00:00Z" })) : reply(404, "Not Found");
    }
    return reply(404);
  };
  return { fetch, listed, pushes, yanks, exchanges: () => exchanges };
}

const decl = (d: Record<string, unknown> = {}) => RubygemsPublishSchema.parse({ type: "rubygems", gems: ["dist/gem"], ...d });
const gha = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" };

describe("rubygems (#5232)", () => {
  test("reads a gem's metadata, leaving out development dependencies", () => {
    const { dir } = member();
    expect(readGem("dist/gem/arugula-1.2.0.gem", join(dir, "dist", "gem", "arugula-1.2.0.gem"))).toMatchObject({ name: "arugula", version: "1.2.0", platform: "ruby", dependencies: ["arugula-core"] });
    expect(parseGemMetadata("name: x\nversion: !ruby/object:Gem::Version\n  version: 2.0.0.pre\nplatform: x86_64-linux\n")).toMatchObject({ name: "x", version: "2.0.0.pre", platform: "x86_64-linux" });
    expect(parseGemItemName("nokogiri@1.16.0-x86_64-linux")).toEqual({ name: "nokogiri", version: "1.16.0", platform: "x86_64-linux" });
  });

  test("the stage pushes nothing; the reveal pushes the gem's bytes with the key", async () => {
    const { dir, gem } = member();
    const host = fakeHost();
    const [t] = await createPublishTargets([decl()], { fetch: host.fetch });
    const ctx = publishContext(dir, { GEM_HOST_API_KEY: "rubygems-secret-key" });
    const staged = await t!.stage(ctx);
    expect(host.pushes).toHaveLength(0);
    expect(staged.items).toEqual([{ name: "arugula@1.2.0", destination: "https://rubygems.org/gems/arugula/versions/1.2.0", digest: `sha256:${sha256(gem)}` }]);
    await t!.reveal(ctx, staged);
    expect(host.pushes).toEqual([{ key: "rubygems-secret-key", bytes: gem }]);
    // Run again after a lost record: the host has it with the same bytes, so nothing is sent.
    const again = await t!.reveal(ctx, staged);
    expect(host.pushes).toHaveLength(1);
    expect(again.items[0]!.present).toBe(true);
  });

  test("a version the host has with other bytes is refused", async () => {
    const { dir } = member();
    const host = fakeHost({ listed: new Map([["1.2.0", "0".repeat(64)]]) });
    const [t] = await createPublishTargets([decl()], { fetch: host.fetch });
    expect((await refusal(t!.stage(publishContext(dir, { GEM_HOST_API_KEY: "rubygems-secret-key" })))).code).toBe("publish-rubygems-version-exists");
  });

  test("trusted publishing exchanges the run's ID token at the stage and again at the reveal", async () => {
    const { dir } = member();
    const host = fakeHost({ trusted: true });
    const [t] = await createPublishTargets([decl()], { fetch: host.fetch });
    const ctx = publishContext(dir, gha);
    const staged = await t!.stage(ctx);
    await t!.reveal(ctx, staged);
    expect(host.exchanges()).toBe(2);
    expect(host.pushes[0]!.key).toBe("exchanged-key");
    const untrusted = fakeHost();
    const [u] = await createPublishTargets([decl()], { fetch: untrusted.fetch });
    expect((await refusal(u!.stage(ctx))).code).toBe("publish-rubygems-trusted-publishing");
  });

  test("refusals: no key, and supply-chain without sbom: false", async () => {
    const { dir } = member();
    const [t] = await createPublishTargets([decl()], { fetch: fakeHost().fetch });
    expect((await refusal(t!.plan(publishContext(dir, {})))).code).toBe("publish-credentials-missing");
    expect((await refusal(t!.plan(publishContext(dir, { GEM_HOST_API_KEY: "k-123" }, [], { requireSbom: true })))).code).toBe("publish-sbom-missing");
    const [u] = await createPublishTargets([decl({ sbom: false })], { fetch: fakeHost().fetch });
    expect(await u!.plan(publishContext(dir, { GEM_HOST_API_KEY: "k-123" }, [], { requireSbom: true }))).toHaveLength(1);
  });

  test("names; a yank yanks, a restore is refused, a deprecate changes nothing", async () => {
    const { dir, gem } = member();
    const host = fakeHost({ listed: new Map([["1.2.0", sha256(gem)]]) });
    const [t] = await createPublishTargets([decl()], { fetch: host.fetch });
    const ctx = publishContext(dir, { GEM_HOST_API_KEY: "rubygems-secret-key" });
    expect(await t!.names!(ctx)).toEqual({ provides: ["rubygems:arugula"], needs: ["rubygems:arugula-core"] });
    const status = (s: StatusContext["status"]): StatusContext => ({ ...ctx, status: s, reason: null, replacement: null, revealed: [{ name: "arugula@1.2.0", destination: "" }], head: null, forgeYank: "prerelease", apply: true });
    expect((await t!.setStatus!(status("yanked")))[0]!.already).toBeUndefined();
    expect(host.yanks).toEqual(["gem_name=arugula&version=1.2.0"]);
    expect((await t!.setStatus!(status("yanked")))[0]!.already).toBe(true);
    expect((await t!.setStatus!(status("active")))[0]!.refused?.code).toBe("release-status-unsupported");
    expect((await t!.setStatus!(status("deprecated")))[0]!.already).toBe(true);
  });
});

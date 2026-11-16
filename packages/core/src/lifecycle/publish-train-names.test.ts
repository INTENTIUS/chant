/**
 * #5165: what each kind of publish target tells a release train: the names it
 * publishes and needs, whether a pinned release is published, and the wait
 * until a reveal is served. Every registry is an in-process fake fetch.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { createPublishTargets } from "./publish-targets";
import { ociRepositoryName, pep440Version, pypiFileVersion, pypiRequirements, trainName, waitUntilServed } from "./publish-train-names";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishTarget } from "./release-publish";
import { makeRelease } from "./release-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-train-names-"));
  dirs.push(d);
  return d;
};

function context(cwd: string, env: NodeJS.ProcessEnv = {}, label: string | null = "1.4.0", releaseTag: string | null = label ? `v${label}` : null): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label, releaseTag, provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(l), lines };
}

type Route = (method: string, url: URL, body: string) => { status: number; body?: string | Uint8Array; headers?: Record<string, string> } | undefined;

/** A fetch that answers from `route`, and 404 for anything it leaves. */
function fakeFetch(route: Route): PublishFetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}${u.search}`);
    const r = route(init.method, u, typeof init.body === "string" ? init.body : init.body ? Buffer.from(init.body).toString("utf-8") : "") ?? { status: 404, body: "" };
    const bytes = typeof r.body === "string" || r.body === undefined ? Buffer.from(r.body ?? "", "utf-8") : Buffer.from(r.body);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => bytes.toString("utf-8"),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }) as PublishFetch & { calls: string[] };
  f.calls = calls;
  return f;
}

/** Sleeps that move a clock, so a wait runs at once. */
function clock(): Pick<PublishDeps, "sleep" | "now"> & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) };
}

async function target(decl: Record<string, unknown>, deps: PublishDeps): Promise<PublishTarget> {
  const [t] = await createPublishTargets([PublishDeclarationSchema.parse(decl)], deps);
  return t!;
}

/** A zip holding one stored file, as a `.vsix` or wheel holds its manifest. */
function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text, "utf-8"));
    const raw = Buffer.from(text, "utf-8");
    const n = Buffer.from(name, "utf-8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("names", () => {
  test("are qualified by kind, in the form each registry compares", () => {
    expect(trainName("npm", "@acme/core")).toBe("npm:@acme/core");
    expect(trainName("pypi", "Acme_Core.Lib")).toBe("pypi:acme-core-lib");
    expect(trainName("cargo", "Acme_Core")).toBe("cargo:acme-core");
    expect(trainName("marketplace", "Acme.Ext")).toBe("marketplace:acme.ext");
    expect(trainName("oci", "ghcr.io/Acme/API:1.4.0")).toBe("oci:ghcr.io/acme/api");
    expect(ociRepositoryName("docker.io/library/nginx@sha256:abc")).toBe("nginx");
    expect(ociRepositoryName("localhost:5000/acme/api:1")).toBe("localhost:5000/acme/api");
  });

  test("a Python project's requirements leave out an extra's; a file name gives its version", () => {
    expect(pypiRequirements([["Requires-Dist", "acme-core>=1.4"], ["Requires-Dist", "rich[jupyter] ; python_version < '3.12'"], ["Requires-Dist", 'pytest ; extra == "test"'], ["Name", "x"]])).toEqual(["acme-core", "rich"]);
    expect(pypiFileVersion("acme_core-1.4.0rc1-py3-none-any.whl")).toEqual({ name: "acme_core", version: "1.4.0rc1" });
    expect(pypiFileVersion("acme-core-1.4.0.tar.gz")).toEqual({ name: "acme-core", version: "1.4.0" });
    expect(pep440Version("1.4.0-rc.1")).toBe("1.4.0rc1");
    expect(pep440Version("2.0.0-beta.2")).toBe(pep440Version("2.0.0b2"));
    expect(pep440Version("1.4.0")).toBe("1.4.0");
  });
});

describe("the wait until a reveal is served", () => {
  test("asks again until nothing is missing, and gives up after the cap with the code", async () => {
    const c = clock();
    let left = 2;
    const lines: string[] = [];
    await waitUntilServed({ log: (l) => lines.push(l) }, c, { what: "the index", code: "x-not-served", check: async () => (left-- > 0 ? ["a@1"] : []) });
    expect(c.slept).toHaveLength(2);
    expect(lines[0]).toBe("waiting for the index to serve a@1");
    const never = await waitUntilServed({ log: () => undefined }, c, { what: "the index", code: "x-not-served", capMs: 30_000, check: async () => ["a@1"] }).catch((e: unknown) => e);
    expect(never).toBeInstanceOf(PublishTargetError);
    expect(never).toMatchObject({ code: "x-not-served" });
  });
});

describe("oci", () => {
  const repo = "127.0.0.1:5999/acme/api";
  test("provides its repository; a pinned label is published when its tag is there; the wait reads each tag's digest", async () => {
    let tagged: string | null = null;
    const fetch = fakeFetch((method, url) => {
      if (method === "GET" && url.pathname === "/v2/acme/api/manifests/1.4.0") return { status: 200, body: "{}", headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": "sha256:aaa" } };
      if (method === "GET" && url.pathname === "/v2/acme/api/manifests/latest") {
        const d = tagged;
        tagged = "sha256:aaa";
        return d ? { status: 200, body: "{}", headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": d } } : { status: 404 };
      }
      return undefined;
    });
    const c = clock();
    const t = await target({ type: "oci", image: "img.tar", repository: repo, tags: ["{label}", "latest"] }, { fetch, ...c });
    const ctx = context(tmp());
    expect(await t.names!(ctx)).toEqual({ provides: ["oci:127.0.0.1:5999/acme/api"], needs: [] });
    expect(await t.published!(ctx)).toBe(true);
    expect(await t.published!(context(tmp(), {}, "1.5.0"))).toBe(false);
    await t.visible!(ctx, { target: t.name, destination: repo, items: [{ name: "img.tar", destination: `${repo}@sha256:aaa`, digest: "sha256:aaa" }] });
    expect(c.slept).toHaveLength(1);
  });

  test("with no tag that names the label, can't say", async () => {
    const t = await target({ type: "oci", image: "img.tar", repository: repo, tags: ["latest"] }, { fetch: fakeFetch(() => undefined) });
    expect(await t.published!(context(tmp()))).toBeNull();
  });
});

describe("forge", () => {
  const api = "https://api.forge.test";
  const fetch = fakeFetch((method, url) => (method === "GET" && url.pathname === "/repos/acme/api/releases/tags/v1.4.0" ? { status: 200, body: JSON.stringify({ id: 1, tag_name: "v1.4.0", draft: false, assets: [] }) } : undefined));
  test("is published when the forge has a published release for the tag; without a token it can't say", async () => {
    const t = await target({ type: "forge", forge: "github", repo: "acme/api", api, assets: ["api.tar.gz"] }, { fetch });
    expect(await t.names!(context(tmp()))).toEqual({ provides: ["forge:github/acme/api"], needs: [] });
    expect(await t.published!(context(tmp(), { GITHUB_TOKEN: "t" }))).toBe(true);
    expect(await t.published!(context(tmp(), { GITHUB_TOKEN: "t" }, "1.5.0"))).toBe(false);
    expect(await t.published!(context(tmp(), {}))).toBeNull();
    await t.visible!(context(tmp(), { GITHUB_TOKEN: "t" }), { target: t.name, destination: "", items: [] });
  });
});

describe("homebrew", () => {
  test("is published when the tap's branch holds the formula with the version; the wait reads the formula's digest", async () => {
    const formula = 'class Api < Formula\n  version "1.4.0"\nend\n';
    const fetch = fakeFetch((method, url) => {
      if (url.pathname === "/repos/acme/homebrew-tap") return { status: 200, body: JSON.stringify({ default_branch: "main" }) };
      if (url.pathname === "/repos/acme/homebrew-tap/contents/Formula/api.rb") return { status: 200, body: JSON.stringify({ content: Buffer.from(formula).toString("base64"), encoding: "base64", sha: "s" }) };
      return undefined;
    });
    const t = await target({ type: "homebrew", tap: "acme/homebrew-tap", formula: "Formula/api.rb", template: "api.rb", assets: ["api.tar.gz"], url: "https://x/{name}" }, { fetch });
    const env = { HOMEBREW_TAP_TOKEN: "t" };
    expect(await t.names!(context(tmp()))).toEqual({ provides: ["homebrew:acme/homebrew-tap/api"], needs: [] });
    expect(await t.published!(context(tmp(), env))).toBe(true);
    expect(await t.published!(context(tmp(), env, "1.5.0"))).toBe(false);
    const { bytesDigest } = await import("./publish-targets");
    await t.visible!(context(tmp(), env), { target: t.name, destination: "", items: [{ name: "Formula/api.rb", destination: "", digest: bytesDigest(new Uint8Array(Buffer.from(formula))) }] });
  });
});

describe("marketplace", () => {
  test("names the extension and its dependencies; asks the gallery for the release's version", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "ext.vsix"), zipOf({ "extension/package.json": JSON.stringify({ publisher: "acme", name: "lang", version: "1.4.0", extensionDependencies: ["acme.core", "redhat.vscode-yaml"], extensionPack: ["Acme.Lang"] }) }));
    const fetch = fakeFetch((method, url, body) =>
      method === "POST" && url.pathname === "/_apis/public/gallery/extensionquery" && body.includes("acme.lang") ? { status: 200, body: JSON.stringify({ results: [{ extensions: [{ versions: [{ version: "1.4.0" }] }] }] }) } : undefined,
    );
    const t = await target({ type: "marketplace", marketplace: "vscode", vsix: "ext.vsix", registry: "https://gallery.test" }, { fetch });
    expect(await t.names!(context(cwd))).toEqual({ provides: ["marketplace:acme.lang"], needs: ["marketplace:acme.core", "marketplace:redhat.vscode-yaml"] });
    expect(await t.published!(context(cwd))).toBe(true);
    expect(await t.published!(context(cwd, {}, "1.5.0"))).toBe(false);
    await t.visible!(context(cwd), { target: t.name, destination: "", items: [{ name: "acme.lang@1.4.0", destination: "" }] });
  });

  test("with no .vsix in the checkout, the member's package.json names the extension", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ publisher: "acme", name: "lang" }));
    const fetch = fakeFetch((method, url) => (url.pathname === "/api/acme/lang/1.4.0" ? { status: 200, body: "{}" } : undefined));
    const t = await target({ type: "marketplace", marketplace: "openvsx", vsix: "ext.vsix", registry: "https://ovsx.test" }, { fetch });
    expect(await t.names!(context(cwd))).toEqual({ provides: ["marketplace:acme.lang"], needs: [] });
    expect(await t.published!(context(cwd))).toBe(true);
  });
});

describe("mcp-registry", () => {
  test("needs every package its server.json lists, across kinds", async () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, "server.json"),
      JSON.stringify({
        name: "io.github.acme/api",
        version: "1.4.0",
        packages: [
          { registryType: "npm", identifier: "@acme/mcp", version: "1.4.0" },
          { registryType: "pypi", identifier: "Acme_MCP", version: "1.4.0" },
          { registryType: "oci", identifier: "ghcr.io/acme/mcp:1.4.0" },
          { registryType: "mcpb", identifier: "https://x/acme.mcpb" },
        ],
      }),
    );
    const fetch = fakeFetch((method, url) => (url.pathname === "/v0.1/servers/io.github.acme%2Fapi/versions/1.4.0" || url.pathname === "/v0.1/servers/io.github.acme/api/versions/1.4.0" ? { status: 200, body: JSON.stringify({ server: { packages: [] } }) } : undefined));
    const t = await target({ type: "mcp-registry", registry: "https://mcp.test" }, { fetch });
    expect(await t.names!(context(cwd))).toEqual({ provides: ["mcp:io.github.acme/api"], needs: ["npm:@acme/mcp", "pypi:acme-mcp", "oci:ghcr.io/acme/mcp"] });
    expect(await t.published!(context(cwd))).toBe(true);
    expect(await t.published!(context(cwd, {}, "1.5.0"))).toBe(false);
    await t.visible!(context(cwd), { target: t.name, destination: "", items: [{ name: "io.github.acme/api@1.4.0", destination: "" }] });
  });
});

describe("pypi", () => {
  test("names the project from pyproject.toml when no file is built here, and finds the release's version in the simple API", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "pyproject.toml"), '[project]\nname = "Acme_Core"\nversion = "0"\n');
    mkdirSync(join(cwd, "dist"));
    const fetch = fakeFetch((method, url) =>
      url.pathname === "/simple/acme-core/" ? { status: 200, body: JSON.stringify({ files: [{ filename: "acme_core-1.4.0rc1-py3-none-any.whl", hashes: { sha256: "a".repeat(64) } }] }) } : undefined,
    );
    const t = await target({ type: "pypi", files: ["dist"], simpleUrl: "https://pypi.test/simple/", uploadUrl: "https://pypi.test/legacy/" }, { fetch });
    expect(await t.names!(context(cwd))).toEqual({ provides: ["pypi:acme-core"], needs: [] });
    expect(await t.published!(context(cwd, {}, "1.4.0-rc.1"))).toBe(true);
    expect(await t.published!(context(cwd, {}, "1.4.0"))).toBe(false);
    await t.visible!(context(cwd), { target: t.name, destination: "", items: [{ name: "acme_core-1.4.0rc1-py3-none-any.whl", destination: "" }] });
  });
});

describe("cargo", () => {
  test("names the crates and what they depend on; reads the sparse index at the release's version", async () => {
    const cwd = tmp();
    const bin = join(cwd, "cargo");
    const meta = {
      packages: [
        { name: "acme-cli", version: "1.4.0", publish: null, dependencies: [{ name: "acme-core", req: "^1.4.0", kind: null }, { name: "serde", req: "^1", kind: null }, { name: "insta", req: "^1", kind: "dev" }] },
      ],
    };
    writeFileSync(join(cwd, "Cargo.toml"), "[package]\n");
    writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify(meta)}'\n`, { mode: 0o755 });
    const fetch = fakeFetch((method, url) => (url.pathname === "/ac/me/acme-cli" ? { status: 200, body: `${JSON.stringify({ name: "acme-cli", vers: "1.4.0", cksum: "c" })}\n` } : undefined));
    const t = await target({ type: "cargo", index: "https://index.test/" }, { fetch, cargo: bin });
    expect(await t.names!(context(cwd))).toEqual({ provides: ["cargo:acme-cli"], needs: ["cargo:acme-core", "cargo:serde"] });
    expect(await t.published!(context(cwd))).toBe(true);
    expect(await t.published!(context(cwd, {}, "1.5.0"))).toBeNull();
    await t.visible!(context(cwd), { target: t.name, destination: "", items: [{ name: "acme-cli@1.4.0", destination: "" }] });
  });
});

describe("tauri-updater", () => {
  test("is published while the rolling release is the version's", async () => {
    const fetch = fakeFetch((method, url) => (url.pathname === "/repos/acme/app/releases/tags/app-latest" ? { status: 200, body: JSON.stringify({ id: 9, draft: false, name: "app-latest 1.4.0", assets: [] }) } : undefined));
    const t = await target({ type: "tauri-updater", repo: "acme/app", tag: "app-latest", api: "https://api.gh.test", platforms: { "darwin-aarch64": "a.tar.gz" } }, { fetch });
    const env = { GITHUB_TOKEN: "t" };
    expect(await t.names!(context(tmp()))).toEqual({ provides: ["tauri-updater:acme/app@app-latest"], needs: [] });
    expect(await t.published!(context(tmp(), env))).toBe(true);
    expect(await t.published!(context(tmp(), env, "1.3.0"))).toBeNull();
    expect(await t.published!(context(tmp(), env, "1.5.0-rc.1"))).toBe(true);
    await t.visible!(context(tmp(), env), { target: t.name, destination: "", items: [] });
  });
});

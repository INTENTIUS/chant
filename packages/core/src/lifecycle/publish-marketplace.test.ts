/**
 * #4676: the editor marketplace target. Open VSX against a fake of its REST
 * API, the VS Code Marketplace against a fake `vsce` binary and a fake of the
 * gallery's query API. The stage uploads nothing, since a marketplace has no
 * draft; the reveal uploads. Nothing reaches a network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { readZipEntry, vsixIdentity } from "./publish-marketplace";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-marketplace-"));
  dirs.push(d);
  return d;
};

function context(cwd: string, env: NodeJS.ProcessEnv, artifacts: ReleaseArtifact[] = []): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: artifacts, targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.2.0", releaseTag: "release/v1.2.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), lines };
}

async function refused(p: Promise<unknown>): Promise<PublishTargetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishTargetError) return err;
    throw err;
  }
  throw new Error("expected a PublishTargetError");
}

/** A zip of `files`, the first stored and the rest deflated, as `vsce package` writes a .vsix. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const raw = Buffer.from(text);
    const method = i === 0 ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    central.push(cd, n);
    offset += 30 + n.length + data.length;
  });
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const MANIFEST = JSON.stringify({ publisher: "arugula", name: "arugula-vscode", version: "1.2.0", engines: { vscode: "^1.90.0" } });
function member(manifest = MANIFEST): { dir: string; bytes: Buffer; digest: string } {
  const dir = temp();
  mkdirSync(join(dir, "dist"));
  const bytes = zip({ "[Content_Types].xml": "<Types/>", "extension.vsixmanifest": "<PackageManifest/>", "extension/package.json": manifest, "extension/out/main.js": "exports.activate = () => {};\n".repeat(50) });
  writeFileSync(join(dir, "dist", "arugula.vsix"), bytes);
  return { dir, bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

const reply = (status: number, body: string | Uint8Array = "") => ({
  ok: status < 300,
  status,
  headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : Buffer.from(body).toString("utf-8")),
  arrayBuffer: async () => {
    const b = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
});

/**
 * An Open VSX fake: namespaces, and the versions published to it by
 * `POST /api/-/publish`. `trusted` lists the extensions whose trusted
 * publisher is a GitHub Actions ID token with the registry as its audience
 * (`gha-id-token`) or `ovsx-id-token`; `refuse` is a status every upload gets.
 */
function fakeOpenVsx(root: string, namespaces: string[], versions = new Map<string, Uint8Array>(), opts: { trusted?: string[]; refuse?: number } = {}) {
  const calls: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> = [];
  let issued = 0;
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    calls.push({ method: init.method, url, headers: init.headers, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const u = new URL(url);
    if (u.host === "token.actions.test") {
      if (init.headers.authorization !== "Bearer gha-request-token") return reply(401);
      return reply(200, JSON.stringify({ value: u.searchParams.get("audience") === root ? "gha-id-token" : "gha-id-token-for-another-audience" }));
    }
    if (init.method === "POST" && u.pathname === "/api/-/trusted-publishing/token") {
      const req = JSON.parse(init.body as string) as { namespace: string; extension: string; token: string };
      if (!["gha-id-token", "ovsx-id-token"].includes(req.token) || !(opts.trusted ?? []).includes(`${req.namespace}.${req.extension}`)) {
        return reply(400, JSON.stringify({ error: `No trusted publisher matches this token for ${req.namespace}.${req.extension}.` }));
      }
      return reply(201, JSON.stringify({ value: `tp-token-${++issued}`, expiresTimestamp: "2026-11-01T00:10:00Z" }));
    }
    if (init.method === "POST" && u.pathname === "/api/-/publish") {
      if (opts.refuse) return reply(opts.refuse);
      const token = u.searchParams.get("token") ?? "";
      if (token !== "ovsx-token-1" && token !== `tp-token-${issued}`) return reply(403, '{"error":"Invalid access token."}');
      const id = vsixIdentity(Buffer.from(init.body as Uint8Array), "upload");
      const key = `${id.publisher}/${id.name}/${id.version}`;
      if (versions.has(key)) return reply(400, '{"error":"already published"}');
      versions.set(key, init.body as Uint8Array);
      return reply(201, "{}");
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "files") return versions.has(parts.slice(1, 4).join("/")) ? reply(200, versions.get(parts.slice(1, 4).join("/"))!) : reply(404);
    if (parts[0] === "api" && parts.length === 2) return namespaces.includes(parts[1]!) ? reply(200, JSON.stringify({ name: parts[1] })) : reply(404, '{"error":"Namespace not found"}');
    if (parts[0] === "api" && parts.length === 4) {
      const key = parts.slice(1).join("/");
      return versions.has(key) ? reply(200, JSON.stringify({ version: parts[3], files: { download: `${root}/files/${key}/x.vsix` } })) : reply(404);
    }
    return reply(404);
  };
  return { fetch, calls, versions, issued: () => issued };
}

/** A fake `vsce` that logs each run and its VSCE_PAT, and a gallery fake that lists the versions it published. */
function fakeVsce(dir: string) {
  const log = join(dir, "vsce.log");
  const bin = join(dir, "vsce");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), pat: process.env.VSCE_PAT || "" }) + "\\n");
if (process.argv[2] === "verify-pat") {
  if (process.env.FAKE_VSCE_VERIFY_FAIL) { console.error("ERROR  Can not acquire a Microsoft Entra ID access token."); process.exit(1); }
  console.log("DONE  The Personal Access Token verification succeeded for the publisher '" + process.argv[3] + "'.");
  process.exit(0);
}
console.log("Publishing with " + process.env.VSCE_PAT);
if (process.env.FAKE_VSCE_FAIL) { console.error("ERROR  Access Denied"); process.exit(1); }
console.log("DONE  Published arugula.arugula-vscode v1.2.0.");
`,
  );
  chmodSync(bin, 0o755);
  const runs = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; pat: string }) : []);
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    calls.push({ method: init.method, url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    if (init.method === "POST" && url === "https://marketplace.test/_apis/public/gallery/extensionquery") {
      const published = runs().some((r) => !process.env.FAKE_VSCE_FAIL && r.args[0] === "publish");
      return reply(200, JSON.stringify({ results: [{ extensions: published ? [{ versions: [{ version: "1.2.0" }, { version: "1.1.0" }] }] : [] }] }));
    }
    return reply(404);
  };
  return { bin, runs, fetch, calls };
}

describe("editor marketplaces (#4676)", () => {
  test("Open VSX: the stage checks the namespace and uploads nothing; the reveal publishes and checks what Open VSX serves against the file", async () => {
    const { dir, bytes, digest } = member();
    const ovsx = fakeOpenVsx("https://open-vsx.test", ["arugula"]);
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "dist/arugula.vsix", registry: "https://open-vsx.test" })], { fetch: ovsx.fetch });
    const ctx = context(dir, { OVSX_PAT: "ovsx-token-1" }, [{ component: "editor", kind: "asset", path: "dist/arugula.vsix", digest }]);
    const item = { name: "arugula.arugula-vscode@1.2.0", destination: "https://open-vsx.test/extension/arugula/arugula-vscode/1.2.0", digest };
    expect(await target!.plan(ctx)).toEqual([item]);

    const staged = await target!.stage(ctx);
    expect(staged).toMatchObject({ items: [item], state: {} });
    expect(ovsx.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(ovsx.versions.size).toBe(0);

    expect(await target!.reveal(ctx, staged)).toMatchObject({ items: [item] });
    expect(Buffer.from(ovsx.versions.get("arugula/arugula-vscode/1.2.0")!).equals(bytes)).toBe(true);
    expect(ctx.lines.join("\n")).not.toContain("ovsx-token-1");

    // Revealed: the version is there with the same bytes, so a stage finds it present and a reveal sends nothing.
    const again = await target!.stage(ctx);
    expect(again.state).toEqual({ present: "true" });
    const n = ovsx.calls.length;
    await target!.reveal(ctx, { ...staged });
    expect(ovsx.calls.slice(n).some((c) => c.method === "POST")).toBe(false);
  });

  test("Open VSX: refuses a missing namespace and a version already there with other bytes, before anything is uploaded", async () => {
    const { dir } = member();
    const make = async (ovsx: ReturnType<typeof fakeOpenVsx>) =>
      (await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "dist/arugula.vsix", registry: "https://open-vsx.test" })], { fetch: ovsx.fetch }))[0]!;
    const ctx = context(dir, { OVSX_PAT: "ovsx-token-1" });
    expect((await refused((await make(fakeOpenVsx("https://open-vsx.test", []))).stage(ctx))).code).toBe("publish-marketplace-no-namespace");
    const other = fakeOpenVsx("https://open-vsx.test", ["arugula"], new Map([["arugula/arugula-vscode/1.2.0", new Uint8Array(Buffer.from("other"))]]));
    expect((await refused((await make(other)).stage(ctx))).code).toBe("publish-marketplace-version-exists");
    expect(other.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("VS Code Marketplace: the stage asks the gallery and runs nothing; the reveal runs vsce publish with the token in VSCE_PAT", async () => {
    const { dir, digest } = member();
    const vsce = fakeVsce(temp());
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "vscode", vsix: "dist/arugula.vsix", registry: "https://marketplace.test", tokenEnv: "MARKETPLACE_PAT" })], {
      fetch: vsce.fetch,
      vsce: vsce.bin,
    });
    const ctx = context(dir, { MARKETPLACE_PAT: "vsce-pat-secret", PATH: process.env.PATH });
    const staged = await target!.stage(ctx);
    expect(staged.items).toEqual([{ name: "arugula.arugula-vscode@1.2.0", destination: "https://marketplace.test/items?itemName=arugula.arugula-vscode", digest }]);
    expect(JSON.parse(vsce.calls[0]!.body!)).toMatchObject({ filters: [{ criteria: [{ filterType: 7, value: "arugula.arugula-vscode" }] }] });
    expect(vsce.runs()).toEqual([]);

    await target!.reveal(ctx, staged);
    expect(vsce.runs()).toEqual([{ args: ["publish", "--packagePath", join(dir, "dist/arugula.vsix")], pat: "vsce-pat-secret" }]);
    expect(ctx.lines.join("\n")).toContain("vsce: DONE  Published arugula.arugula-vscode v1.2.0.");
    expect(ctx.lines.join("\n")).not.toContain("vsce-pat-secret");

    // Run again: the gallery lists the version, so nothing runs.
    expect((await target!.stage(ctx)).state).toEqual({ present: "true" });
    await target!.reveal(ctx, staged);
    expect(vsce.runs()).toHaveLength(1);
  });

  test("VS Code Marketplace: a vsce failure is the target's, with vsce's message and no token", async () => {
    const { dir } = member();
    const vsce = fakeVsce(temp());
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "vscode", vsix: "dist/arugula.vsix", registry: "https://marketplace.test" })], { fetch: vsce.fetch, vsce: vsce.bin });
    const ctx = context(dir, { VSCE_PAT: "vsce-pat-secret", FAKE_VSCE_FAIL: "1", PATH: process.env.PATH });
    const err = await refused(target!.reveal(ctx, await target!.stage(ctx)));
    expect(err.code).toBe("publish-marketplace-failed");
    expect(err.message).toContain("Access Denied");
    expect(err.message).not.toContain("vsce-pat-secret");
  });

  test("refuses a .vsix that is not the release's, one with no manifest, and a missing token", async () => {
    const make = async () => (await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "dist/arugula.vsix" })], { fetch: fakeOpenVsx("x", []).fetch }))[0]!;
    const { dir } = member();
    expect((await refused((await make()).plan(context(dir, { OVSX_PAT: "t0ken" }, [{ component: "e", kind: "asset", path: "dist/arugula.vsix", digest: `sha256:${"0".repeat(64)}` }])))).code).toBe(
      "publish-artifact-digest-mismatch",
    );
    expect((await refused((await make()).plan(context(member(JSON.stringify({ name: "x" })).dir, { OVSX_PAT: "t0ken" })))).code).toBe("publish-marketplace-vsix-invalid");
    expect((await refused((await make()).plan(context(dir, {})))).code).toBe("publish-credentials-missing");
    expect(() => PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "eclipse", vsix: "x.vsix" })).toThrow();
  });

  test("reads stored and deflated zip entries", () => {
    const z = zip({ a: "stored", "b/c.json": '{"x":1}' });
    expect(readZipEntry(z, "a")!.toString()).toBe("stored");
    expect(readZipEntry(z, "b/c.json")!.toString()).toBe('{"x":1}');
    expect(readZipEntry(z, "missing")).toBeNull();
    expect(() => readZipEntry(Buffer.from("not a zip at all, long enough to scan"), "a")).toThrow(/not a zip/);
  });
});

describe("marketplaces with the run's identity, and a refusal as a warning (#4698)", () => {
  const GHA = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/idtoken?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" };

  test("VS Code Marketplace, azure-credential: the stage runs vsce verify-pat and the reveal vsce publish, both with --azure-credential and no VSCE_PAT", async () => {
    const { dir } = member();
    const vsce = fakeVsce(temp());
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "vscode", vsix: "dist/arugula.vsix", registry: "https://marketplace.test", auth: "azure-credential" })], {
      fetch: vsce.fetch,
      vsce: vsce.bin,
    });
    // A PAT left in the environment is not passed on: vsce prefers it to --azure-credential.
    const ctx = context(dir, { VSCE_PAT: "stray-pat", PATH: process.env.PATH });
    expect(target!.credentialEnv).toEqual(["AZURE_CLIENT_SECRET"]);
    await target!.plan(ctx);
    expect(vsce.runs()).toEqual([]);

    const staged = await target!.stage(ctx);
    expect(vsce.runs()).toEqual([{ args: ["verify-pat", "arugula", "--azure-credential"], pat: "" }]);
    expect(staged.state).toEqual({});

    await target!.reveal(ctx, staged);
    expect(vsce.runs()[1]).toEqual({ args: ["publish", "--packagePath", join(dir, "dist/arugula.vsix"), "--azure-credential"], pat: "" });
    expect(ctx.lines.join("\n")).not.toContain("using the token");
  });

  test("VS Code Marketplace, azure-credential: an identity vsce can't sign in with is refused at the stage, before anything reveals", async () => {
    const { dir } = member();
    const vsce = fakeVsce(temp());
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "vscode", vsix: "dist/arugula.vsix", registry: "https://marketplace.test", auth: "azure-credential" })], {
      fetch: vsce.fetch,
      vsce: vsce.bin,
    });
    const err = await refused(target!.stage(context(dir, { FAKE_VSCE_VERIFY_FAIL: "1", PATH: process.env.PATH })));
    expect(err.code).toBe("publish-marketplace-azure-credential");
    expect(err.message).toContain("Microsoft Entra");
    expect(vsce.runs().map((r) => r.args[0])).toEqual(["verify-pat"]);
  });

  test("Open VSX, trusted-publishing: the stage exchanges the GitHub Actions ID token to check the registration, and the reveal exchanges again to upload", async () => {
    const { dir, bytes } = member();
    const ovsx = fakeOpenVsx("https://open-vsx.test", ["arugula"], new Map(), { trusted: ["arugula.arugula-vscode"] });
    const [target] = await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "dist/arugula.vsix", registry: "https://open-vsx.test", auth: "trusted-publishing" })], { fetch: ovsx.fetch });
    const ctx = context(dir, GHA);
    expect(target!.credentialEnv).toEqual(["OVSX_ID_TOKEN"]);
    await target!.plan(ctx);
    expect(ovsx.calls).toEqual([]);

    const staged = await target!.stage(ctx);
    expect(ovsx.issued()).toBe(1);
    const idRequest = ovsx.calls.find((c) => c.url.startsWith("https://token.actions.test/"))!;
    expect(new URL(idRequest.url).searchParams.get("audience")).toBe("https://open-vsx.test");
    expect(new URL(idRequest.url).searchParams.get("api-version")).toBe("2.0");
    expect(JSON.parse(ovsx.calls.find((c) => c.url.endsWith("/trusted-publishing/token"))!.body!)).toEqual({ namespace: "arugula", extension: "arugula-vscode", token: "gha-id-token" });
    expect(ovsx.versions.size).toBe(0);

    await target!.reveal(ctx, staged);
    expect(ovsx.issued()).toBe(2);
    expect(Buffer.from(ovsx.versions.get("arugula/arugula-vscode/1.2.0")!).equals(bytes)).toBe(true);
    expect(ovsx.calls.find((c) => c.url.includes("/api/-/publish"))!.url).toContain("token=tp-token-2");
    const out = ctx.lines.join("\n");
    for (const secret of ["gha-id-token", "tp-token-1", "tp-token-2", "gha-request-token"]) expect(out).not.toContain(secret);
  });

  test("Open VSX, trusted-publishing: reads an ID token from OVSX_ID_TOKEN outside GitHub Actions; refuses a run with none, and an extension with no trusted publisher", async () => {
    const { dir } = member();
    const make = async (ovsx: ReturnType<typeof fakeOpenVsx>) =>
      (await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "dist/arugula.vsix", registry: "https://open-vsx.test", auth: "trusted-publishing" })], { fetch: ovsx.fetch }))[0]!;
    const trusted = fakeOpenVsx("https://open-vsx.test", ["arugula"], new Map(), { trusted: ["arugula.arugula-vscode"] });
    await (await make(trusted)).stage(context(dir, { OVSX_ID_TOKEN: "ovsx-id-token" }));
    expect(trusted.issued()).toBe(1);
    expect(trusted.calls.some((c) => c.url.startsWith("https://token.actions.test/"))).toBe(false);

    const none = await refused((await make(trusted)).plan(context(dir, { OVSX_PAT: "a-pat-is-not-read" })));
    expect(none.code).toBe("publish-credentials-missing");
    expect(none.fix).toContain("id-token: write");

    const unregistered = fakeOpenVsx("https://open-vsx.test", ["arugula"]);
    const err = await refused((await make(unregistered)).stage(context(dir, GHA)));
    expect(err.code).toBe("publish-marketplace-trusted-publishing");
    expect(err.message).toContain("No trusted publisher matches");
    expect(err.fix).toContain("https://open-vsx.test/user-settings/trusted-publishers");
    expect(unregistered.calls.some((c) => c.url.includes("/api/-/publish"))).toBe(false);
  });

  test("an auth the marketplace does not take, or tokenEnv beside an identity, is refused when the targets are made", async () => {
    const make = (d: Record<string, unknown>) => createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", vsix: "x.vsix", ...d })]);
    expect((await refused(make({ marketplace: "openvsx", auth: "azure-credential" }))).code).toBe("publish-marketplace-auth-invalid");
    expect((await refused(make({ marketplace: "vscode", auth: "trusted-publishing" }))).code).toBe("publish-marketplace-auth-invalid");
    expect((await refused(make({ marketplace: "vscode", auth: "azure-credential", tokenEnv: "VSCE_PAT" }))).code).toBe("publish-marketplace-auth-invalid");
    expect(() => PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "x.vsix", onRefusal: "ignore" })).toThrow();
  });

  test("onRefusal warn: an upload Open VSX refuses comes back refused with a warning; without it the reveal fails", async () => {
    const { dir } = member();
    const make = async (ovsx: ReturnType<typeof fakeOpenVsx>, onRefusal?: "warn") =>
      (await createPublishTargets([PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "openvsx", vsix: "dist/arugula.vsix", registry: "https://open-vsx.test", ...(onRefusal ? { onRefusal } : {}) })], { fetch: ovsx.fetch }))[0]!;
    const ctx = context(dir, { OVSX_PAT: "ovsx-token-1" });

    const strict = await make(fakeOpenVsx("https://open-vsx.test", ["arugula"], new Map(), { refuse: 406 }));
    expect((await refused(strict.reveal(ctx, await strict.stage(ctx)))).code).toBe("publish-marketplace-failed");

    const lenient = await make(fakeOpenVsx("https://open-vsx.test", ["arugula"], new Map(), { refuse: 406 }), "warn");
    const out = await lenient.reveal(ctx, await lenient.stage(ctx));
    expect(out.items).toEqual([expect.objectContaining({ name: "arugula.arugula-vscode@1.2.0", refused: true })]);
    expect(out.warning).toContain("Open VSX refused arugula.arugula-vscode@1.2.0");
    expect(out.warning).toContain("answered 406");
    expect(out.warning).not.toContain("ovsx-token-1");

    // The stage's checks still refuse under warn.
    expect((await refused((await make(fakeOpenVsx("https://open-vsx.test", []), "warn")).stage(ctx))).code).toBe("publish-marketplace-no-namespace");
  });

  test("onRefusal warn: a vsce publish that fails comes back refused; vsce missing from PATH still fails", async () => {
    const { dir } = member();
    const vsce = fakeVsce(temp());
    const decl = PublishDeclarationSchema.parse({ type: "marketplace", marketplace: "vscode", vsix: "dist/arugula.vsix", registry: "https://marketplace.test", onRefusal: "warn" });
    const [target] = await createPublishTargets([decl], { fetch: vsce.fetch, vsce: vsce.bin });
    const ctx = context(dir, { VSCE_PAT: "vsce-pat-secret", FAKE_VSCE_FAIL: "1", PATH: process.env.PATH });
    const out = await target!.reveal(ctx, await target!.stage(ctx));
    expect(out.items[0]!.refused).toBe(true);
    expect(out.warning).toContain("Access Denied");
    expect(out.warning).not.toContain("vsce-pat-secret");

    const [missing] = await createPublishTargets([decl], { fetch: fakeVsce(temp()).fetch, vsce: join(temp(), "no-vsce") });
    expect((await refused(missing!.reveal(ctx, await missing!.stage(ctx)))).code).toBe("publish-marketplace-vsce-missing");
  });
});

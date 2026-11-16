/**
 * #5167: the PyPI target, against a fake index that serves PyPI's simple API,
 * its legacy upload API and its trusted-publishing exchange. The stage uploads
 * nothing, since an index has no draft; the reveal uploads. Nothing reaches a
 * network.
 */

import { afterAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { createRedactor } from "./publish-credentials";
import { PypiPublishSchema } from "./publish-declaration";
import { normalizeProjectName, parseCoreMetadata, pypiAuth, readDistribution, tarEntries } from "./publish-pypi";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "chant-publish-pypi-"));
  dirs.push(d);
  return d;
};

function context(cwd: string, env: NodeJS.ProcessEnv, artifacts: ReleaseArtifact[] = [], extra: Partial<PublishContext> = {}): PublishContext & { lines: string[] } {
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: artifacts, targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "1.2.0", releaseTag: "release/1.2.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), lines, ...extra };
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

/** A ustar tar.gz of `files`. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, "utf-8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const METADATA = "Metadata-Version: 2.4\nName: Arugula_Kit\nVersion: 1.2.0\nSummary: A kit\nClassifier: Programming Language :: Python :: 3\nClassifier: License :: OSI Approved :: MIT License\nRequires-Dist: requests>=2\n\n# Arugula kit\n\nLong description.\n";

const sha = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

function member(opts: { sbom?: boolean; attestation?: boolean } = {}) {
  const dir = temp();
  mkdirSync(join(dir, "dist"));
  const wheel = zip({
    "arugula_kit/__init__.py": "x = 1\n",
    "arugula_kit-1.2.0.dist-info/METADATA": METADATA,
    "arugula_kit-1.2.0.dist-info/WHEEL": "Wheel-Version: 1.0\n",
    ...(opts.sbom ? { "arugula_kit-1.2.0.dist-info/sboms/sbom.spdx.json": '{"spdxVersion":"SPDX-2.3"}' } : {}),
  });
  const sdist = tarGz({ "arugula_kit-1.2.0/PKG-INFO": METADATA, "arugula_kit-1.2.0/pyproject.toml": "[project]\nname = 'arugula-kit'\n" });
  writeFileSync(join(dir, "dist", "arugula_kit-1.2.0-py3-none-any.whl"), wheel);
  writeFileSync(join(dir, "dist", "arugula_kit-1.2.0.tar.gz"), sdist);
  if (opts.attestation) writeFileSync(join(dir, "dist", "arugula_kit-1.2.0-py3-none-any.whl.publish.attestation"), JSON.stringify({ version: 1, envelope: { statement: "e30=", signature: "c2ln" } }));
  return { dir, wheel, sdist };
}

const reply = (status: number, body = "") => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => body });

/** The parts of a multipart/form-data body. */
function parseForm(body: Uint8Array, type: string): { fields: Array<[string, string]>; file: { name: string; bytes: Buffer } | null } {
  const boundary = /boundary=(.+)$/.exec(type)![1]!;
  const raw = Buffer.from(body).toString("latin1");
  const fields: Array<[string, string]> = [];
  let file: { name: string; bytes: Buffer } | null = null;
  for (const part of raw.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    const value = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head!)![1]!;
    const filename = /filename="([^"]+)"/.exec(head!);
    if (filename) file = { name: filename[1]!, bytes: Buffer.from(value, "latin1") };
    else fields.push([name, Buffer.from(value, "latin1").toString("utf-8")]);
  }
  return { fields, file };
}

/** A fake PyPI: projects' files by name, uploads that add to them, the OIDC audience and mint-token exchange. */
function fakeIndex(site = "https://pypi.test", opts: { trusted?: boolean; html?: boolean; files?: Map<string, Buffer> } = {}) {
  const files = opts.files ?? new Map<string, Buffer>();
  const uploads: Array<{ auth: string; fields: Array<[string, string]>; file: string }> = [];
  const calls: Array<{ method: string; url: string }> = [];
  let minted = 0;
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => {
    calls.push({ method: init.method, url });
    if (init.method === "GET" && url === `${site}/simple/arugula-kit/`) {
      if (files.size === 0) return reply(404);
      if (opts.html) return reply(200, [...files].map(([f, b]) => `<a href="../../packages/${f}#sha256=${createHash("sha256").update(b).digest("hex")}">${f}</a>`).join("\n"));
      return reply(200, JSON.stringify({ name: "arugula-kit", files: [...files].map(([f, b]) => ({ filename: f, hashes: { sha256: createHash("sha256").update(b).digest("hex") } })) }));
    }
    if (init.method === "POST" && url === `${site}/legacy/`) {
      const form = parseForm(init.body as Uint8Array, init.headers["content-type"]!);
      const auth = Buffer.from((init.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf-8");
      if (!auth.endsWith(":pypi-secret-token") && !auth.endsWith(":minted-upload-token")) return reply(403, "Invalid or non-existent authentication information.");
      if (files.has(form.file!.name)) return reply(400, `File already exists ('${form.file!.name}').`);
      uploads.push({ auth, fields: form.fields, file: form.file!.name });
      files.set(form.file!.name, form.file!.bytes);
      return reply(200, "OK");
    }
    if (init.method === "GET" && url === `${site}/_/oidc/audience`) return reply(200, JSON.stringify({ audience: "pypi" }));
    if (init.method === "GET" && url.startsWith("https://gha.test/token")) {
      return new URL(url).searchParams.get("audience") === "pypi" ? reply(200, JSON.stringify({ value: "gha-id-token-for-pypi" })) : reply(400);
    }
    if (init.method === "POST" && url === `${site}/_/oidc/mint-token`) {
      const { token } = JSON.parse(init.body as string) as { token: string };
      if (opts.trusted && token === "gha-id-token-for-pypi") {
        minted++;
        return reply(200, JSON.stringify({ success: true, token: "minted-upload-token" }));
      }
      return reply(422, JSON.stringify({ message: "Token request failed", errors: [{ code: "invalid-publisher", description: "valid token, but no corresponding publisher" }] }));
    }
    return reply(404);
  };
  return { fetch, files, uploads, calls, minted: () => minted };
}

const decl = (d: Record<string, unknown>) => PypiPublishSchema.parse({ type: "pypi", ...d });
const custom = { uploadUrl: "https://pypi.test/legacy/", simpleUrl: "https://pypi.test/simple/" };

describe("pypi (#5167)", () => {
  test("reads a wheel's and an sdist's metadata", () => {
    const { dir } = member({ sbom: true });
    const w = readDistribution("dist/arugula_kit-1.2.0-py3-none-any.whl", join(dir, "dist", "arugula_kit-1.2.0-py3-none-any.whl"));
    expect(w).toMatchObject({ filetype: "bdist_wheel", pyversion: "py3", name: "Arugula_Kit", version: "1.2.0", sbom: "arugula_kit-1.2.0.dist-info/sboms/sbom.spdx.json" });
    const s = readDistribution("dist/arugula_kit-1.2.0.tar.gz", join(dir, "dist", "arugula_kit-1.2.0.tar.gz"));
    expect(s).toMatchObject({ filetype: "sdist", pyversion: "source", name: "Arugula_Kit", version: "1.2.0", sbom: null });
    expect(parseCoreMetadata(METADATA).fields.filter(([k]) => k === "Classifier")).toHaveLength(2);
    expect(parseCoreMetadata(METADATA).fields.find(([k]) => k === "Description")![1]).toContain("Long description.");
    expect(normalizeProjectName("Arugula_Kit")).toBe("arugula-kit");
    expect([...tarEntries(Buffer.alloc(1024)).keys()]).toEqual([]);
    writeFileSync(join(dir, "dist", "broken.whl"), "not a zip");
    expect(() => readDistribution("dist/broken.whl", join(dir, "dist", "broken.whl"))).toThrow(/not a wheel or sdist/);
  });

  test("the stage reads the index and uploads nothing; the reveal uploads each file with its metadata, and a reveal run again sends nothing", async () => {
    const { dir, wheel, sdist } = member();
    const index = fakeIndex();
    const [target] = await createPublishTargets([decl({ files: ["dist"], ...custom })], { fetch: index.fetch });
    expect(target!.uploadsAtReveal).toBe(true);
    const ctx = context(dir, { PYPI_TOKEN: "pypi-secret-token" }, [{ component: "python", kind: "asset", path: "dist/arugula_kit-1.2.0-py3-none-any.whl", digest: sha(wheel) }]);
    const planned = await target!.plan(ctx);
    expect(planned.map((i) => [i.name, i.digest])).toEqual([
      ["arugula_kit-1.2.0-py3-none-any.whl", sha(wheel)],
      ["arugula_kit-1.2.0.tar.gz", sha(sdist)],
    ]);

    const staged = await target!.stage(ctx);
    expect(staged.state).toEqual({});
    expect(index.uploads).toEqual([]);
    expect(ctx.lines.join("\n")).toContain("uploaded at the reveal");

    const done = await target!.reveal(ctx, staged);
    expect(done.items.every((i) => !i.present)).toBe(true);
    expect(index.uploads.map((u) => u.file)).toEqual(["arugula_kit-1.2.0-py3-none-any.whl", "arugula_kit-1.2.0.tar.gz"]);
    const fields = index.uploads[0]!.fields;
    expect(fields).toContainEqual([":action", "file_upload"]);
    expect(fields).toContainEqual(["filetype", "bdist_wheel"]);
    expect(fields).toContainEqual(["pyversion", "py3"]);
    expect(fields).toContainEqual(["name", "Arugula_Kit"]);
    expect(fields).toContainEqual(["sha256_digest", sha(wheel).slice(7)]);
    expect(fields.filter(([k]) => k === "classifiers")).toHaveLength(2);
    expect(fields).toContainEqual(["requires_dist", "requests>=2"]);
    expect(index.uploads[0]!.auth).toBe("__token__:pypi-secret-token");
    expect(index.uploads[1]!.fields).toContainEqual(["pyversion", "source"]);
    expect(ctx.lines.join("\n")).not.toContain("pypi-secret-token");

    // Lost record: the reveal reads the index first and sends nothing again; a stage finds every file present.
    await target!.reveal(ctx, staged);
    expect(index.uploads).toHaveLength(2);
    expect((await target!.stage(ctx)).state).toEqual({ present: "true" });
  });

  test("reads PEP 503 HTML, refuses a file the index serves with other bytes, and a file that differs from the release's", async () => {
    const { dir, wheel } = member();
    const index = fakeIndex("https://pypi.test", { html: true, files: new Map([["arugula_kit-1.2.0.tar.gz", Buffer.from("other bytes")]]) });
    const [target] = await createPublishTargets([decl({ files: ["dist"], ...custom })], { fetch: index.fetch });
    expect((await refused(target!.stage(context(dir, { PYPI_TOKEN: "pypi-secret-token" })))).code).toBe("publish-pypi-file-exists");
    const wrong = context(dir, { PYPI_TOKEN: "pypi-secret-token" }, [{ component: "python", kind: "asset", path: "dist/arugula_kit-1.2.0-py3-none-any.whl", digest: sha(Buffer.concat([wheel, Buffer.from("x")])) }]);
    expect((await refused(target!.plan(wrong))).code).toBe("publish-artifact-digest-mismatch");
  });

  test("names files by artifact:<name>", async () => {
    const { dir, wheel } = member();
    const index = fakeIndex();
    const [target] = await createPublishTargets([decl({ files: ["artifact:python"], ...custom })], { fetch: index.fetch });
    const ctx = context(dir, { PYPI_TOKEN: "pypi-secret-token" }, [{ component: "python", kind: "asset", path: "dist/arugula_kit-1.2.0-py3-none-any.whl", digest: sha(wheel) }]);
    expect((await target!.plan(ctx)).map((i) => i.name)).toEqual(["arugula_kit-1.2.0-py3-none-any.whl"]);
    expect((await refused((await createPublishTargets([decl({ files: ["artifact:nope"], ...custom })], { fetch: index.fetch }))[0]!.plan(ctx))).code).toBe("publish-artifact-not-recorded");
  });

  test("trusted publishing: the stage proves the exchange and drops the token; the reveal exchanges again and uploads with it", async () => {
    const { dir } = member();
    const index = fakeIndex("https://pypi.org", { trusted: true });
    // The named index's URLs are PyPI's; route them to the fake.
    const fetch = (url: string, init: Parameters<typeof index.fetch>[1]) => index.fetch(url.replace("https://upload.pypi.org/legacy/", "https://pypi.org/legacy/"), init);
    const [target] = await createPublishTargets([decl({ files: ["dist/arugula_kit-1.2.0-py3-none-any.whl"] })], { fetch });
    const env = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" };
    expect(pypiAuth(decl({ files: ["dist"] }), env)).toBe("trusted-publishing");
    expect(pypiAuth(decl({ files: ["dist"] }), { ...env, PYPI_TOKEN: "t0ken" })).toBe("token");
    const ctx = context(dir, env);
    const staged = await target!.stage(ctx);
    expect(index.minted()).toBe(1);
    expect(index.uploads).toEqual([]);
    const done = await target!.reveal(ctx, staged);
    expect(index.minted()).toBe(2);
    expect(index.uploads.map((u) => u.auth)).toEqual(["__token__:minted-upload-token"]);
    expect(done.items[0]!.destination).toBe("https://pypi.org/project/arugula-kit/1.2.0/");
    expect(ctx.lines.join("\n")).not.toMatch(/minted-upload-token|gha-id-token-for-pypi/);
  });

  test("trusted publishing that the index refuses fails the stage with its reason; no credential at all is refused in the plan", async () => {
    const { dir } = member();
    const index = fakeIndex("https://pypi.org", { trusted: false });
    const [target] = await createPublishTargets([decl({ files: ["dist"], auth: "trusted-publishing" })], { fetch: index.fetch });
    const err = await refused(target!.stage(context(dir, { ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" })));
    expect(err.code).toBe("publish-pypi-trusted-publishing");
    expect(err.message).toContain("no corresponding publisher");
    expect((await refused(target!.plan(context(dir, {})))).code).toBe("publish-credentials-missing");
    const [tokenTarget] = await createPublishTargets([decl({ files: ["dist"], index: "testpypi" })], { fetch: index.fetch });
    const missing = await refused(tokenTarget!.plan(context(dir, {})));
    expect(missing.code).toBe("publish-credentials-missing");
    expect(missing.message).toContain("TEST_PYPI_TOKEN");
  });

  test("uploads the PEP 740 attestations beside a file, and a wrong token fails the reveal", async () => {
    const { dir } = member({ attestation: true });
    const index = fakeIndex();
    const [target] = await createPublishTargets([decl({ files: ["dist/arugula_kit-1.2.0-py3-none-any.whl"], ...custom })], { fetch: index.fetch });
    const ctx = context(dir, { PYPI_TOKEN: "pypi-secret-token" });
    const planned = await target!.plan(ctx);
    expect(planned.map((i) => [i.name, i.attachment ?? null])).toEqual([
      ["arugula_kit-1.2.0-py3-none-any.whl", null],
      ["arugula_kit-1.2.0-py3-none-any.whl.publish.attestation", "provenance"],
    ]);
    await target!.reveal(ctx, await target!.stage(ctx));
    const att = index.uploads[0]!.fields.find(([k]) => k === "attestations")![1];
    expect(JSON.parse(att)).toEqual([{ version: 1, envelope: { statement: "e30=", signature: "c2ln" } }]);

    const other = fakeIndex();
    const [t2] = await createPublishTargets([decl({ files: ["dist/arugula_kit-1.2.0.tar.gz"], ...custom })], { fetch: other.fetch });
    const bad = context(dir, { PYPI_TOKEN: "wrong-token-value" });
    const err = await refused(t2!.reveal(bad, await t2!.stage(bad)));
    expect(err.code).toBe("publish-pypi-failed");
    expect(err.message).not.toContain("wrong-token-value");
  });

  test("supply-chain: a wheel without an SBOM in .dist-info/sboms/ is refused unless sbom is false", async () => {
    const index = fakeIndex();
    const bare = member();
    const [target] = await createPublishTargets([decl({ files: ["dist"], ...custom })], { fetch: index.fetch });
    expect((await refused(target!.plan(context(bare.dir, { PYPI_TOKEN: "pypi-secret-token" }, [], { requireSbom: true })))).code).toBe("publish-sbom-missing");
    const [optOut] = await createPublishTargets([decl({ files: ["dist"], sbom: false, ...custom })], { fetch: index.fetch });
    expect(await optOut!.plan(context(bare.dir, { PYPI_TOKEN: "pypi-secret-token" }, [], { requireSbom: true }))).toHaveLength(2);
    const carried = member({ sbom: true });
    const items = await target!.plan(context(carried.dir, { PYPI_TOKEN: "pypi-secret-token" }, [], { requireSbom: true }));
    expect(items[0]!.sbom).toBe("arugula_kit-1.2.0.dist-info/sboms/sbom.spdx.json");
  });

  test("signing on under trusted publishing: the stage signs a publish attestation per file and the reveal uploads it; under a token it signs none", async () => {
    const { dir, wheel } = member();
    const index = fakeIndex("https://pypi.org", { trusted: true });
    const fetch = (url: string, init: Parameters<typeof index.fetch>[1]) => index.fetch(url.replace("https://upload.pypi.org/legacy/", "https://pypi.org/legacy/"), init);
    const statements: unknown[] = [];
    const signer = {
      name: "fake-cosign",
      unavailable: () => null,
      signBlob: async () => new Uint8Array(),
      signStatement: async (st: unknown) => {
        statements.push(st);
        return new Uint8Array(Buffer.from(JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: { certificate: { rawBytes: "Y2VydA==" }, tlogEntries: [{ logIndex: "7" }] }, dsseEnvelope: { payload: Buffer.from(JSON.stringify(st)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "c2ln" }] } })));
      },
    };
    const signing = { signer, identity: { issuer: "https://token.actions.githubusercontent.com", identity: "^https://github.com/acme/kit/" } };
    const [target] = await createPublishTargets([decl({ files: ["dist/arugula_kit-1.2.0-py3-none-any.whl"] })], { fetch });
    const env = { GITHUB_ACTIONS: "true", ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha.test/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "gha-request-token" };
    const ctx = context(dir, env, [], { signing });
    const staged = await target!.stage(ctx);
    expect(statements).toEqual([{ _type: "https://in-toto.io/Statement/v1", subject: [{ name: "arugula_kit-1.2.0-py3-none-any.whl", digest: { sha256: sha(wheel).slice(7) } }], predicateType: "https://docs.pypi.org/attestations/publish/v1", predicate: {} }]);
    expect(staged.items.map((i) => [i.name, i.attachment ?? null])).toEqual([
      ["arugula_kit-1.2.0-py3-none-any.whl", null],
      ["arugula_kit-1.2.0-py3-none-any.whl.publish.attestation", "attestation"],
    ]);
    // A resumed reveal takes the attestation from the recorded state; nothing is signed again.
    await target!.reveal(context(dir, env, [], { signing }), { ...staged });
    expect(statements).toHaveLength(1);
    const sent = JSON.parse(index.uploads[0]!.fields.find(([k]) => k === "attestations")![1]) as Array<Record<string, unknown>>;
    expect(sent).toEqual([{ version: 1, verification_material: { certificate: "Y2VydA==", transparency_entries: [{ logIndex: "7" }] }, envelope: { statement: expect.any(String), signature: "c2ln" } }]);

    const other = member();
    const [tokenTarget] = await createPublishTargets([decl({ files: ["dist"], ...custom })], { fetch: fakeIndex().fetch });
    const tctx = context(other.dir, { PYPI_TOKEN: "pypi-secret-token" }, [], { signing });
    await tokenTarget!.stage(tctx);
    expect(statements).toHaveLength(1);
    expect(tctx.lines.join("\n")).toContain("attestations only from a trusted publisher");
  });

  test("the declaration refuses mixed index settings and a token beside trusted publishing", () => {
    expect(() => decl({ files: ["dist"], uploadUrl: "https://x.test/legacy/" })).toThrow();
    expect(() => decl({ files: ["dist"], index: "testpypi", ...custom })).toThrow();
    expect(() => decl({ files: ["dist"], auth: "trusted-publishing", ...custom })).toThrow();
    expect(() => decl({ files: ["dist"], auth: "trusted-publishing", tokenEnv: "X" })).toThrow();
    expect(() => decl({ files: ["dist"], password: "x" })).toThrow();
  });
});

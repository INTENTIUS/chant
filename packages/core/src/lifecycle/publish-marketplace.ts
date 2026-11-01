/**
 * The editor marketplace target (#4676): a packaged `.vsix` published to the
 * VS Code Marketplace or to Open VSX.
 *
 * The extension's publisher, name and version are read from the
 * `extension/package.json` inside the `.vsix`, and the file must match the
 * digest the release records for it.
 *
 * A marketplace has no draft: a version is visible as soon as it is
 * uploaded, and a version can't be uploaded twice. So the stage uploads
 * nothing. It checks what it can without changing anything: the file and its
 * digest, the token, and whether the marketplace already has the version.
 * The reveal uploads. A failure of another target's stage therefore leaves
 * nothing on a marketplace, and a marketplace's own failure shows only at the
 * reveal, after the targets before it revealed.
 *
 * - Open VSX, through its REST API: the stage reads
 *   `GET {registry}/api/{namespace}` (a missing namespace is refused before
 *   anything reveals) and `GET {registry}/api/{namespace}/{name}/{version}`.
 *   A version already there is `present` when its download's SHA-256 is the
 *   file's, and refused otherwise (`publish-marketplace-version-exists`). The
 *   reveal sends the file with `POST {registry}/api/-/publish`, then
 *   downloads what Open VSX serves for the version and refuses a digest that
 *   differs (`publish-marketplace-digest-mismatch`).
 * - The VS Code Marketplace, through `vsce`: the stage asks the gallery's
 *   public `extensionquery` API for the extension's versions, and a version
 *   already there is `present`, by version only, since the gallery reports no
 *   digest. The reveal runs `vsce publish --packagePath <file>` with the
 *   token in `VSCE_PAT`. `vsce` must be on `PATH` (`npm i -g @vscode/vsce`).
 *
 * The token is read from `tokenEnv`, else `VSCE_PAT` or `OVSX_PAT`, the
 * variables `vsce` and `ovsx` read, and is masked in all output.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { readCredential, type Credential } from "./publish-credentials";
import type { MarketplacePublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, memberFile, publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant that publishes a `marketplace` target (#4676). */
export const PUBLISH_MARKETPLACE_FLOOR = NEXT_RELEASE;

export const OPEN_VSX_REGISTRY = "https://open-vsx.org";
export const VSCODE_GALLERY = "https://marketplace.visualstudio.com";

/** The variables a marketplace's token is read from. */
export function marketplaceTokenEnv(decl: Pick<MarketplacePublishDeclaration, "marketplace" | "tokenEnv">): string[] {
  return [decl.tokenEnv ?? (decl.marketplace === "vscode" ? "VSCE_PAT" : "OVSX_PAT")];
}

/** One file of a zip archive, or null when it holds none by that name. Reads stored and deflated entries; refuses a zip64 archive. */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive: no end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("a zip64 archive, which chant does not read");
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("a malformed zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const skip = nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf-8", at + 46, at + 46 + nameLen) === name) {
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(data, data + size);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`${name} is compressed with method ${method}, which chant does not read`);
    }
    at += 46 + skip;
  }
  return null;
}

/** The publisher, name and version a `.vsix` declares. */
export function vsixIdentity(bytes: Buffer, path: string): { publisher: string; name: string; version: string } {
  let manifest: { publisher?: unknown; name?: unknown; version?: unknown };
  try {
    const entry = readZipEntry(bytes, "extension/package.json");
    if (!entry) throw new Error("it holds no extension/package.json");
    manifest = JSON.parse(entry.toString("utf-8")) as typeof manifest;
  } catch (err) {
    throw new PublishTargetError("publish-marketplace-vsix-invalid", `${path} is not a .vsix chant can read: ${err instanceof Error ? err.message : String(err)}`, "Package it with vsce package.");
  }
  const { publisher, name, version } = manifest;
  if (typeof publisher !== "string" || typeof name !== "string" || typeof version !== "string" || !publisher || !name || !version) {
    throw new PublishTargetError("publish-marketplace-vsix-invalid", `${path}'s extension/package.json needs publisher, name and version`);
  }
  return { publisher, name, version };
}

function run(bin: string, args: string[], ctx: PublishContext, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string[] }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: ctx.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => chunks.push(c.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({
        code: code ?? 1,
        output: chunks.join("").split("\n").filter((l) => l.trim() !== "").map((l) => ctx.redactor.redact(l)),
      }),
    );
  });
}

export function marketplaceTarget(decl: MarketplacePublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const tokenNames = marketplaceTokenEnv(decl);
  const label = decl.marketplace === "vscode" ? "VS Code Marketplace" : "Open VSX";
  const registry = (decl.registry ?? (decl.marketplace === "vscode" ? VSCODE_GALLERY : OPEN_VSX_REGISTRY)).replace(/\/+$/, "");

  const setup = (ctx: PublishContext) => {
    const abs = memberFile(ctx.cwd, decl.vsix);
    const bytes = readFileSync(abs);
    const digest = bytesDigest(new Uint8Array(bytes));
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, decl.vsix, [digest]);
    const id = vsixIdentity(bytes, decl.vsix);
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    if (!token) {
      throw new PublishTargetError("publish-credentials-missing", `the ${label} target reads its token from ${tokenNames[0]}, and it is not set`, `Set ${tokenNames[0]} in the job's or the shell's environment.`);
    }
    const destination =
      decl.marketplace === "vscode" ? `${registry}/items?itemName=${id.publisher}.${id.name}` : `${registry}/extension/${id.publisher}/${id.name}/${id.version}`;
    const item: PublishItem = { name: `${id.publisher}.${id.name}@${id.version}`, destination, digest };
    return { abs, bytes, digest, id, token, item };
  };

  const get = async (url: string, init: { method: string; headers: Record<string, string>; body?: string } = { method: "GET", headers: {} }) => {
    const res = await fetchImpl(url, { ...init, headers: { "user-agent": "chant", ...init.headers } });
    return { status: res.status, text: await res.text().catch(() => "") };
  };
  function fail(ctx: PublishContext, what: string, status: number, text: string): never {
    throw new PublishTargetError("publish-marketplace-failed", ctx.redactor.redact(`${what} on ${label} answered ${status}${text ? `: ${text.slice(0, 300)}` : ""}`));
  }

  /** Open VSX: the SHA-256 of what it serves for the version, or null when it has no such version. */
  const openVsxServed = async (ctx: PublishContext, id: { publisher: string; name: string; version: string }): Promise<string | null> => {
    const meta = await get(`${registry}/api/${encodeURIComponent(id.publisher)}/${encodeURIComponent(id.name)}/${encodeURIComponent(id.version)}`);
    if (meta.status === 404) return null;
    if (meta.status !== 200) fail(ctx, `reading ${id.publisher}.${id.name}@${id.version}`, meta.status, meta.text);
    const download = (JSON.parse(meta.text) as { files?: { download?: unknown } }).files?.download;
    if (typeof download !== "string") fail(ctx, `reading the download of ${id.publisher}.${id.name}@${id.version}`, meta.status, "no files.download");
    const res = await fetchImpl(download, { method: "GET", headers: { "user-agent": "chant" } });
    if (res.status !== 200) fail(ctx, `downloading ${id.publisher}.${id.name}@${id.version}`, res.status, "");
    if (!res.arrayBuffer) throw new PublishTargetError("publish-marketplace-failed", "the fetch this publish runs with can't read a response's bytes, so the download's digest can't be checked");
    return bytesDigest(new Uint8Array(await res.arrayBuffer()));
  };

  /** VS Code Marketplace: whether the gallery lists the version. */
  const galleryHas = async (ctx: PublishContext, id: { publisher: string; name: string; version: string }): Promise<boolean> => {
    const res = await get(`${registry}/_apis/public/gallery/extensionquery`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json;api-version=3.0-preview.1" },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${id.publisher}.${id.name}` }], pageNumber: 1, pageSize: 1 }], flags: 1 }),
    });
    if (res.status !== 200) fail(ctx, `asking for ${id.publisher}.${id.name}`, res.status, res.text);
    const body = JSON.parse(res.text) as { results?: Array<{ extensions?: Array<{ versions?: Array<{ version?: string }> }> }> };
    return (body.results?.[0]?.extensions?.[0]?.versions ?? []).some((v) => v.version === id.version);
  };

  const target: PublishTarget = {
    kind: "marketplace",
    name: `${label} ${decl.vsix}`,
    destination: label,
    credentialEnv: tokenNames,
    key: publishTargetKey(decl),
    async plan(ctx) {
      return [setup(ctx).item];
    },
    async stage(ctx) {
      const { id, digest, token, item } = setup(ctx);
      ctx.log(`using the token from ${token.from}`);
      const done = (present: boolean): StagedTarget => ({ target: target.name, destination: target.destination, items: [{ ...item, ...(present ? { present: true } : {}) }], state: present ? { present: "true" } : {} });
      if (decl.marketplace === "openvsx") {
        const ns = await get(`${registry}/api/${encodeURIComponent(id.publisher)}`);
        if (ns.status === 404) {
          throw new PublishTargetError("publish-marketplace-no-namespace", `Open VSX at ${registry} has no namespace ${id.publisher}`, `Create it once with: npx ovsx create-namespace ${id.publisher}`);
        }
        if (ns.status !== 200) fail(ctx, `reading namespace ${id.publisher}`, ns.status, ns.text);
        const served = await openVsxServed(ctx, id);
        if (served === null) {
          ctx.log(`${item.name} is not on Open VSX yet; it is uploaded at the reveal, since Open VSX has no draft`);
          return done(false);
        }
        if (served !== digest) {
          throw new PublishTargetError(
            "publish-marketplace-version-exists",
            `Open VSX already has ${item.name}, with digest ${served}, not ${digest}`,
            "A marketplace version can't be replaced: cut a release with a new version.",
          );
        }
        ctx.log(`${item.name} is already on Open VSX with the same bytes`);
        return done(true);
      }
      if (await galleryHas(ctx, id)) {
        ctx.log(`${item.name} is already on the VS Code Marketplace; it reports no digest to compare`);
        return done(true);
      }
      ctx.log(`${item.name} is not on the VS Code Marketplace yet; it is uploaded at the reveal, since the marketplace has no draft`);
      return done(false);
    },
    async reveal(ctx, staged) {
      const items = staged.items.map((i) => ({ name: i.name, destination: i.destination, ...(i.digest ? { digest: i.digest } : {}) }));
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: items.map((i) => ({ ...i, present: true })) };
      const { abs, bytes, id, digest, token, item } = setup(ctx);
      if (decl.marketplace === "openvsx") {
        // Run again after an upload whose record was lost, the version is there: check it rather than send it twice.
        const before = await openVsxServed(ctx, id);
        if (before === null) {
          ctx.log(`uploading ${item.name} (${bytes.byteLength} bytes) to Open VSX`);
          const res = await fetchImpl(`${registry}/api/-/publish?token=${encodeURIComponent(token.value)}`, {
            method: "POST",
            headers: { "user-agent": "chant", "content-type": "application/octet-stream" },
            body: new Uint8Array(bytes),
          });
          if (res.status !== 201 && res.status !== 200) fail(ctx, `publishing ${item.name}`, res.status, await res.text().catch(() => ""));
        }
        const served = before ?? (await openVsxServed(ctx, id));
        if (served !== digest) {
          throw new PublishTargetError("publish-marketplace-digest-mismatch", `Open VSX serves ${item.name} with digest ${served ?? "none"}, and the file published is ${digest}`);
        }
        return { target: target.name, destination: target.destination, items: before === null ? items : items.map((i) => ({ ...i, present: true })) };
      }
      if (await galleryHas(ctx, id)) {
        ctx.log(`${item.name} is already on the VS Code Marketplace`);
        return { target: target.name, destination: target.destination, items: items.map((i) => ({ ...i, present: true })) };
      }
      ctx.log(`running vsce publish --packagePath ${decl.vsix}`);
      const result = await run(deps.vsce ?? "vsce", ["publish", "--packagePath", abs], ctx, vsceEnv(ctx.env, token)).catch((err: unknown) => {
        throw new PublishTargetError("publish-marketplace-failed", `vsce could not be run: ${err instanceof Error ? err.message : String(err)}`, "Install it on the job's PATH: npm install -g @vscode/vsce");
      });
      for (const l of result.output) ctx.log(`vsce: ${l}`);
      if (result.code !== 0) {
        throw new PublishTargetError("publish-marketplace-failed", `vsce publish of ${item.name} exited ${result.code}${result.output.length ? `: ${result.output.slice(-3).join(" ")}` : ""}`);
      }
      return { target: target.name, destination: target.destination, items };
    },
  };
  return target;
}

/** The environment vsce runs with: the run's, with the token in `VSCE_PAT`. */
function vsceEnv(env: NodeJS.ProcessEnv, token: Credential): NodeJS.ProcessEnv {
  return { ...env, VSCE_PAT: token.value };
}

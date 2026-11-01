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
 *
 * Or the target authenticates with the run's identity, with no stored
 * token (#4698):
 *
 * - `auth: "azure-credential"` (VS Code Marketplace): `vsce` runs with
 *   `--azure-credential`, which gets a Microsoft Entra token from the job's
 *   Azure sign-in, such as the one `azure/login` makes from the run's OIDC
 *   token. `VSCE_PAT` is taken out of vsce's environment, since vsce prefers
 *   a PAT it finds there. The stage runs
 *   `vsce verify-pat --azure-credential <publisher>`, which signs in and asks
 *   the marketplace for the identity's role on the publisher, and changes
 *   nothing.
 * - `auth: "trusted-publishing"` (Open VSX): the run's OIDC ID token, from
 *   GitHub Actions (a job with `id-token: write`) or from `OVSX_ID_TOKEN`, is
 *   exchanged at `POST {registry}/api/-/trusted-publishing/token` for a
 *   publishing token that lasts minutes, as `ovsx publish --trusted-publishing`
 *   does. The stage makes the exchange to check that Open VSX takes this
 *   workflow as a trusted publisher of the extension, and drops the token;
 *   the reveal exchanges again for the upload.
 *
 * With `onRefusal: "warn"`, a marketplace that refuses the reveal's upload,
 * or a request around it, is a warning: the reveal returns the target with
 * its items `refused` and a `warning`, and the publish goes on. Every check
 * the stage makes still refuses, and so does a digest that differs after an
 * upload.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { readCredential, type Credential } from "./publish-credentials";
import type { MarketplacePublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, memberFile, publishTargetKey } from "./publish-targets";
import {
  PublishTargetError,
  type PublishContext,
  type PublishDeps,
  type PublishedTarget,
  type PublishFetch,
  type PublishItem,
  type PublishTarget,
  type StagedTarget,
} from "./release-publish";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant that publishes a `marketplace` target (#4676). */
export const PUBLISH_MARKETPLACE_FLOOR = "0.124.63";

/** The first chant that reads a marketplace target's `auth` (#4698). */
export const PUBLISH_MARKETPLACE_AUTH_FLOOR = NEXT_RELEASE;

/** The first chant that reads a marketplace target's `onRefusal` (#4698). */
export const PUBLISH_MARKETPLACE_ON_REFUSAL_FLOOR = NEXT_RELEASE;

export const OPEN_VSX_REGISTRY = "https://open-vsx.org";
export const VSCODE_GALLERY = "https://marketplace.visualstudio.com";

/** The variable an OIDC ID token for Open VSX is read from outside GitHub Actions, as `ovsx` reads it. */
export const OVSX_ID_TOKEN_ENV = "OVSX_ID_TOKEN";

export type MarketplaceAuth = NonNullable<MarketplacePublishDeclaration["auth"]>;

/** The declaration's `auth`, refused when the marketplace does not take it or when `tokenEnv` is set with another. */
export function marketplaceAuth(decl: Pick<MarketplacePublishDeclaration, "marketplace" | "auth" | "tokenEnv">): MarketplaceAuth {
  const auth = decl.auth ?? "token";
  const wrong =
    auth === "azure-credential" && decl.marketplace !== "vscode"
      ? "auth: azure-credential is the VS Code Marketplace's; Open VSX takes token or trusted-publishing"
      : auth === "trusted-publishing" && decl.marketplace !== "openvsx"
        ? "auth: trusted-publishing is Open VSX's; the VS Code Marketplace takes token or azure-credential"
        : auth !== "token" && decl.tokenEnv !== undefined
          ? `tokenEnv names a token, and auth: ${auth} reads none`
          : null;
  if (wrong) throw new PublishTargetError("publish-marketplace-auth-invalid", `a marketplace target for ${decl.marketplace}: ${wrong}`, "Fix the target in release.publish in chant.config.ts.");
  return auth;
}

/** The variables a marketplace's credential is read from, whose values are masked. */
export function marketplaceTokenEnv(decl: Pick<MarketplacePublishDeclaration, "marketplace" | "tokenEnv" | "auth">): string[] {
  const auth = decl.auth ?? "token";
  // vsce's Entra sign-in reads a client secret from AZURE_CLIENT_SECRET when one is set; chant reads none.
  if (auth === "azure-credential") return ["AZURE_CLIENT_SECRET"];
  if (auth === "trusted-publishing") return [OVSX_ID_TOKEN_ENV];
  return [decl.tokenEnv ?? (decl.marketplace === "vscode" ? "VSCE_PAT" : "OVSX_PAT")];
}

/** The codes a reveal turns into a warning under `onRefusal: "warn"`: the marketplace refused or failed a request. */
const REFUSALS = new Set(["publish-marketplace-failed", "publish-marketplace-trusted-publishing"]);

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
  const auth = marketplaceAuth(decl);
  const tokenNames = marketplaceTokenEnv(decl);
  const label = decl.marketplace === "vscode" ? "VS Code Marketplace" : "Open VSX";
  const registry = (decl.registry ?? (decl.marketplace === "vscode" ? VSCODE_GALLERY : OPEN_VSX_REGISTRY)).replace(/\/+$/, "");

  const setup = (ctx: PublishContext) => {
    const abs = memberFile(ctx.cwd, decl.vsix);
    const bytes = readFileSync(abs);
    const digest = bytesDigest(new Uint8Array(bytes));
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, decl.vsix, [digest]);
    const id = vsixIdentity(bytes, decl.vsix);
    let token: Credential | null = null;
    if (auth === "token") {
      token = readCredential(ctx.env, tokenNames, ctx.redactor);
      if (!token) {
        throw new PublishTargetError("publish-credentials-missing", `the ${label} target reads its token from ${tokenNames[0]}, and it is not set`, `Set ${tokenNames[0]} in the job's or the shell's environment.`);
      }
    }
    if (auth === "trusted-publishing" && !ctx.env[OVSX_ID_TOKEN_ENV] && !(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL && ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the Open VSX target publishes with trusted publishing, and this run has no OIDC ID token: not a GitHub Actions job with id-token: write, and ${OVSX_ID_TOKEN_ENV} is not set`,
        `In GitHub Actions, give the job permissions: id-token: write. Elsewhere, put an ID token whose audience is ${registry} in ${OVSX_ID_TOKEN_ENV}.`,
      );
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

  /** The run's OIDC ID token for Open VSX: `OVSX_ID_TOKEN`, else one GitHub Actions issues with the registry as its audience. */
  const idToken = async (ctx: PublishContext): Promise<string> => {
    const direct = readCredential(ctx.env, [OVSX_ID_TOKEN_ENV], ctx.redactor);
    if (direct) return direct.value;
    const url = new URL(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
    url.searchParams.set("audience", registry);
    const res = await fetchImpl(url.toString(), { method: "GET", headers: { authorization: `Bearer ${ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ""}`, accept: "application/json" } });
    const text = await res.text().catch(() => "");
    const value = res.status === 200 ? (JSON.parse(text) as { value?: unknown }).value : undefined;
    if (typeof value !== "string" || !value) {
      throw new PublishTargetError("publish-marketplace-trusted-publishing", ctx.redactor.redact(`GitHub Actions gave no OIDC ID token for ${registry}: it answered ${res.status}`), "Give the job permissions: id-token: write.");
    }
    ctx.redactor.add(value);
    return value;
  };

  /** Open VSX trusted publishing: a publishing token for the extension, exchanged for the run's ID token. It lasts minutes. */
  const trustedToken = async (ctx: PublishContext, id: { publisher: string; name: string }): Promise<string> => {
    const token = await idToken(ctx);
    const res = await get(`${registry}/api/-/trusted-publishing/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ namespace: id.publisher, extension: id.name, token }),
    });
    let body: { value?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(res.text) as typeof body;
    } catch {
      // An answer that is not JSON is reported by its status.
    }
    if (res.status < 200 || res.status > 299 || typeof body.value !== "string" || !body.value) {
      const why = typeof body.error === "string" ? body.error : `it answered ${res.status}${res.text ? `: ${res.text.slice(0, 300)}` : ""}`;
      throw new PublishTargetError(
        "publish-marketplace-trusted-publishing",
        ctx.redactor.redact(`Open VSX at ${registry} gave no trusted-publishing token for ${id.publisher}.${id.name}: ${why}`),
        `Register this workflow as a trusted publisher of ${id.publisher}.${id.name} at ${registry}/user-settings/trusted-publishers.`,
      );
    }
    ctx.redactor.add(body.value);
    return body.value;
  };

  /** Runs vsce with the target's credential: `VSCE_PAT` for a token, `--azure-credential` and no `VSCE_PAT` for an Entra identity. */
  const vsce = async (ctx: PublishContext, args: string[], token: Credential | null) => {
    const env = { ...ctx.env };
    if (token) env.VSCE_PAT = token.value;
    else delete env.VSCE_PAT;
    return run(deps.vsce ?? "vsce", token ? args : [...args, "--azure-credential"], ctx, env).catch((err: unknown) => {
      throw new PublishTargetError("publish-marketplace-vsce-missing", `vsce could not be run: ${err instanceof Error ? err.message : String(err)}`, "Install it on the job's PATH: npm install -g @vscode/vsce");
    });
  };

  /** The reveal of a target the marketplace refused, under `onRefusal: "warn"`. */
  const refusedResult = (ctx: PublishContext, items: PublishItem[], err: PublishTargetError): PublishedTarget => {
    const warning = ctx.redactor.redact(`${label} refused ${items[0]?.name ?? decl.vsix}: ${err.message}. onRefusal is warn, so the publish goes on without it, and the same publish run again tries it again`);
    return { target: target.name, destination: target.destination, items: items.map((i) => ({ ...i, refused: true })), warning };
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
      if (token) ctx.log(`using the token from ${token.from}`);
      const done = (present: boolean): StagedTarget => ({ target: target.name, destination: target.destination, items: [{ ...item, ...(present ? { present: true } : {}) }], state: present ? { present: "true" } : {} });
      if (decl.marketplace === "openvsx") {
        if (auth === "trusted-publishing") {
          await trustedToken(ctx, id);
          ctx.log(`Open VSX takes this run as a trusted publisher of ${id.publisher}.${id.name}; the reveal asks for a new token, since one lasts minutes`);
        }
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
      if (auth === "azure-credential") {
        ctx.log(`checking the job's Microsoft Entra identity may publish as ${id.publisher}: vsce verify-pat --azure-credential ${id.publisher}`);
        const check = await vsce(ctx, ["verify-pat", id.publisher], null);
        for (const l of check.output) ctx.log(`vsce: ${l}`);
        if (check.code !== 0) {
          throw new PublishTargetError(
            "publish-marketplace-azure-credential",
            `vsce could not sign in with a Microsoft Entra identity that has a role on publisher ${id.publisher}: vsce verify-pat exited ${check.code}${check.output.length ? `: ${check.output.slice(-3).join(" ")}` : ""}`,
            `Sign in to Azure in the publish's job before it runs, such as with azure/login and the run's OIDC token, as an identity added to the publisher ${id.publisher}.`,
          );
        }
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
      const refusable = async <T>(step: () => Promise<T>): Promise<T | PublishedTarget> => {
        try {
          return await step();
        } catch (err) {
          if (decl.onRefusal === "warn" && err instanceof PublishTargetError && REFUSALS.has(err.code)) return refusedResult(ctx, items, err);
          throw err;
        }
      };
      if (decl.marketplace === "openvsx") {
        // Run again after an upload whose record was lost, the version is there: check it rather than send it twice.
        const uploaded = await refusable(async () => {
          const before = await openVsxServed(ctx, id);
          if (before !== null) return before;
          const publishToken = token ? token.value : await trustedToken(ctx, id);
          ctx.log(`uploading ${item.name} (${bytes.byteLength} bytes) to Open VSX${token ? "" : " with a trusted-publishing token"}`);
          const res = await fetchImpl(`${registry}/api/-/publish?token=${encodeURIComponent(publishToken)}`, {
            method: "POST",
            headers: { "user-agent": "chant", "content-type": "application/octet-stream" },
            body: new Uint8Array(bytes),
          });
          if (res.status !== 201 && res.status !== 200) fail(ctx, `publishing ${item.name}`, res.status, await res.text().catch(() => ""));
          return null;
        });
        if (uploaded !== null && typeof uploaded === "object") return uploaded;
        const before = uploaded;
        const served = before ?? (await openVsxServed(ctx, id));
        if (served !== digest) {
          throw new PublishTargetError("publish-marketplace-digest-mismatch", `Open VSX serves ${item.name} with digest ${served ?? "none"}, and the file published is ${digest}`);
        }
        return { target: target.name, destination: target.destination, items: before === null ? items : items.map((i) => ({ ...i, present: true })) };
      }
      const outcome = await refusable(async () => {
        if (await galleryHas(ctx, id)) {
          ctx.log(`${item.name} is already on the VS Code Marketplace`);
          return true;
        }
        ctx.log(`running vsce publish --packagePath ${decl.vsix}${token ? "" : " --azure-credential"}`);
        const result = await vsce(ctx, ["publish", "--packagePath", abs], token);
        for (const l of result.output) ctx.log(`vsce: ${l}`);
        if (result.code !== 0) {
          throw new PublishTargetError("publish-marketplace-failed", `vsce publish of ${item.name} exited ${result.code}${result.output.length ? `: ${result.output.slice(-3).join(" ")}` : ""}`);
        }
        return false;
      });
      if (typeof outcome === "object") return outcome;
      return { target: target.name, destination: target.destination, items: outcome ? items.map((i) => ({ ...i, present: true })) : items };
    },
  };
  return target;
}

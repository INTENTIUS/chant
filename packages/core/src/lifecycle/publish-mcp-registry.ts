/**
 * The MCP Registry target (#5162): a `server.json` published to the official
 * MCP Registry, https://registry.modelcontextprotocol.io, so MCP clients find
 * the server. A `server.json` names the npm packages, PyPI packages or OCI
 * images that run the server, and the registry checks they exist, so this
 * target reveals after every other target (`revealsLast`).
 *
 * It speaks the registry's HTTP API directly, the requests `mcp-publisher
 * login github-oidc` and `mcp-publisher publish` make, so no tool is
 * downloaded or run:
 *
 * - `POST /v0.1/auth/github-oidc` with `{ "oidc_token": ... }` exchanges the
 *   GitHub Actions OIDC token, requested with the registry's origin
 *   (`https://registry.modelcontextprotocol.io`) as its audience, for a
 *   registry token that lasts minutes. `POST /v0.1/auth/github-at` does the
 *   same for a GitHub token (`{ "github_token": ... }`).
 * - `GET /v0.1/servers/{name}/versions/{version}` says whether a version is
 *   already published.
 * - `POST /v0.1/publish` with the `server.json` as the body and the registry
 *   token as a bearer credential publishes it.
 *
 * The registry has no draft and refuses a version it already holds, and it
 * does not let a version be replaced. So the stage sends nothing: it checks
 * the `server.json` against the release, exchanges for a token to prove the
 * credentials work, and reads whether the version is there. The reveal
 * publishes.
 *
 * The `server.json` must belong to this release: its `version` is the
 * release's label (from its first digit), and each package that names a
 * version, and each OCI image's tag, is the same. Anything else is refused in
 * the plan (`publish-mcp-registry-version-mismatch`,
 * `publish-mcp-registry-package-mismatch`), so a release can't publish a
 * listing for another version. `release.version.files` stamps the label into
 * the file.
 */

import { readFileSync } from "node:fs";
import { readCredential } from "./publish-credentials";
import type { McpRegistryPublishDeclaration } from "./publish-declaration";
import { releaseVersion } from "./publish-homebrew";
import { bytesDigest, checkReleaseDigest, memberFile, publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

export { PUBLISH_MCP_REGISTRY_FLOOR } from "../release-floors";

export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io";

/** The variable a `github-token` target reads by default. */
export const MCP_GITHUB_TOKEN_ENV = "MCP_GITHUB_TOKEN";

/** The variable a `registry-token` target reads by default. */
export const MCP_REGISTRY_TOKEN_ENV = "MCP_REGISTRY_TOKEN";

export type McpRegistryAuth = NonNullable<McpRegistryPublishDeclaration["auth"]>;

/** The declaration's `auth`, refused when `tokenEnv` is set beside the OIDC exchange, which reads none. */
export function mcpRegistryAuth(decl: Pick<McpRegistryPublishDeclaration, "auth" | "tokenEnv">): McpRegistryAuth {
  const auth = decl.auth ?? "github-oidc";
  if (auth === "github-oidc" && decl.tokenEnv !== undefined) {
    throw new PublishTargetError("publish-mcp-registry-auth-invalid", "tokenEnv names a token, and auth: github-oidc reads none", "Leave tokenEnv out, or set auth to github-token or registry-token in release.publish.");
  }
  return auth;
}

/** The variables the target's credential is read from, whose values are masked. */
export function mcpRegistryTokenEnv(decl: Pick<McpRegistryPublishDeclaration, "auth" | "tokenEnv">): string[] {
  const auth = decl.auth ?? "github-oidc";
  if (auth === "github-oidc") return ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  return [decl.tokenEnv ?? (auth === "github-token" ? MCP_GITHUB_TOKEN_ENV : MCP_REGISTRY_TOKEN_ENV)];
}

/** The registry's origin, which is the audience of the OIDC token: scheme and lowercased host. */
export function mcpRegistryAudience(registry: string): string {
  const u = new URL(registry);
  return `${u.protocol}//${u.host.toLowerCase()}`;
}

export interface ServerJson {
  name: string;
  version: string;
  packages: Array<{ registryType?: string; identifier?: string; version?: string }>;
}

/** The tag of an OCI image reference, `null` for one with a digest or no tag. */
function ociTag(identifier: string): string | null {
  if (identifier.includes("@")) return null;
  const last = identifier.slice(identifier.lastIndexOf("/") + 1);
  const colon = last.indexOf(":");
  return colon < 0 ? "" : last.slice(colon + 1);
}

/**
 * Read `text` as a `server.json` and check it is the release's: `label` is
 * the release's label. Throws {@link PublishTargetError}.
 */
export function checkServerJson(text: string, path: string, label: string | null): ServerJson {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PublishTargetError("publish-mcp-registry-server-invalid", `${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`, "Fix the file, or check it with: mcp-publisher validate");
  }
  const o = raw as { name?: unknown; version?: unknown; packages?: unknown };
  if (typeof raw !== "object" || raw === null || typeof o.name !== "string" || !o.name || typeof o.version !== "string" || !o.version) {
    throw new PublishTargetError("publish-mcp-registry-server-invalid", `${path} needs a name and a version`, "A server.json names the server as io.github.<owner>/<name> or <reversed domain>/<name>.");
  }
  if (o.packages !== undefined && !Array.isArray(o.packages)) {
    throw new PublishTargetError("publish-mcp-registry-server-invalid", `${path}'s packages is not a list`);
  }
  const version = releaseVersion(label);
  if (label === null || version === null) {
    throw new PublishTargetError("publish-mcp-registry-version-mismatch", `${path} can't be matched to this release: it has no label with a version in it`, "Cut the release with a label such as 1.4.0.");
  }
  const fix = `Stamp the label into the file with release.version.files in chant.config.ts, or set the version to ${version}.`;
  if (o.version !== version && o.version !== label) {
    throw new PublishTargetError("publish-mcp-registry-version-mismatch", `${path} has version ${o.version}, and this release is ${label}`, fix);
  }
  const packages = ((o.packages as unknown[] | undefined) ?? []).map((p) => (typeof p === "object" && p !== null ? (p as ServerJson["packages"][number]) : {}));
  packages.forEach((p, i) => {
    const where = `${path}'s packages[${i}]${p.identifier ? ` (${p.identifier})` : ""}`;
    if (p.registryType === "oci") {
      const tag = typeof p.identifier === "string" ? ociTag(p.identifier) : null;
      if (typeof p.identifier === "string" && tag !== null && tag !== version && tag !== label) {
        throw new PublishTargetError("publish-mcp-registry-package-mismatch", `${where} names the tag ${tag || "(none)"}, and this release is ${label}`, `Name the image as <image>:${version}, or by digest.`);
      }
    } else if (p.registryType === "mcpb") {
      // An mcpb package is a file at a URL; its version, when it has one, is checked below.
      if (p.version !== undefined && p.version !== version && p.version !== label) {
        throw new PublishTargetError("publish-mcp-registry-package-mismatch", `${where} has version ${p.version}, and this release is ${label}`, fix);
      }
    } else if (p.version !== version && p.version !== label) {
      throw new PublishTargetError("publish-mcp-registry-package-mismatch", `${where} has version ${p.version ?? "(none)"}, and this release is ${label}`, fix);
    }
  });
  return { name: o.name, version: o.version, packages };
}

const packageKey = (p: { registryType?: string; identifier?: string; version?: string }) => `${p.registryType ?? ""}:${p.identifier ?? ""}:${p.version ?? ""}`;

export function mcpRegistryTarget(decl: McpRegistryPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const auth = mcpRegistryAuth(decl);
  const tokenNames = mcpRegistryTokenEnv(decl);
  const path = decl.server ?? "server.json";
  const registry = (decl.registry ?? MCP_REGISTRY).replace(/\/+$/, "");

  const setup = (ctx: PublishContext) => {
    const abs = memberFile(ctx.cwd, path);
    const bytes = readFileSync(abs);
    const digest = bytesDigest(new Uint8Array(bytes));
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [digest]);
    const server = checkServerJson(bytes.toString("utf-8"), path, ctx.label);
    let token: { value: string; from: string } | null = null;
    if (auth === "github-oidc") {
      if (!(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL && ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) {
        throw new PublishTargetError(
          "publish-credentials-missing",
          "the MCP Registry target publishes with GitHub OIDC, and this run has no OIDC token: not a GitHub Actions job with id-token: write",
          "Give the job permissions: id-token: write, or set auth to github-token or registry-token.",
        );
      }
    } else {
      token = readCredential(ctx.env, tokenNames, ctx.redactor);
      if (!token) {
        throw new PublishTargetError("publish-credentials-missing", `the MCP Registry target reads its token from ${tokenNames[0]}, and it is not set`, `Set ${tokenNames[0]} in the job's or the shell's environment.`);
      }
    }
    const item: PublishItem = { name: `${server.name}@${server.version}`, destination: `${registry}/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`, digest };
    return { bytes, server, token, item };
  };

  const call = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const res = await fetchImpl(url, { ...init, headers: { "user-agent": "chant", accept: "application/json", ...init.headers } });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  };
  const why = (ctx: PublishContext, r: { status: number; text: string; json: unknown }) => {
    const j = r.json as { detail?: unknown; title?: unknown } | null;
    const said = typeof j?.detail === "string" ? j.detail : typeof j?.title === "string" ? j.title : r.text.slice(0, 300);
    return ctx.redactor.redact(`it answered ${r.status}${said ? `: ${said}` : ""}`);
  };

  /** The OIDC token for the registry's origin, from GitHub Actions' token service. */
  const oidcToken = async (ctx: PublishContext): Promise<string> => {
    const url = new URL(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
    url.searchParams.set("audience", mcpRegistryAudience(registry));
    const res = await call(url.toString(), { method: "GET", headers: { authorization: `Bearer ${ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ""}` } });
    const value = (res.json as { value?: unknown } | null)?.value;
    if (res.status !== 200 || typeof value !== "string" || !value) {
      throw new PublishTargetError("publish-mcp-registry-auth", ctx.redactor.redact(`GitHub Actions gave no OIDC token for ${mcpRegistryAudience(registry)}: it answered ${res.status}`), "Give the job permissions: id-token: write.");
    }
    ctx.redactor.add(value);
    return value;
  };

  /** A registry token: exchanged for the OIDC or GitHub token, or the one the variable holds. It lasts minutes, so each step gets its own. */
  const registryToken = async (ctx: PublishContext, token: { value: string } | null): Promise<string> => {
    if (auth === "registry-token") return token!.value;
    const exchange =
      auth === "github-oidc"
        ? { path: "/v0.1/auth/github-oidc", body: { oidc_token: await oidcToken(ctx) } }
        : { path: "/v0.1/auth/github-at", body: { github_token: token!.value } };
    const res = await call(`${registry}${exchange.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(exchange.body) });
    const value = (res.json as { registry_token?: unknown } | null)?.registry_token;
    if (res.status !== 200 || typeof value !== "string" || !value) {
      throw new PublishTargetError("publish-mcp-registry-auth", `the MCP Registry at ${registry} gave no registry token: ${why(ctx, res)}`, auth === "github-oidc" ? "The registry takes a GitHub Actions run as the owner of io.github.<owner>/*. Name the server io.github.<owner>/<name> for the repository's owner." : "Check the token, and that its owner may publish the server's namespace.");
    }
    ctx.redactor.add(value);
    return value;
  };

  /** The packages the registry holds for the version, or null when it holds none. */
  const served = async (ctx: PublishContext, server: ServerJson): Promise<string[] | null> => {
    const res = await call(`${registry}/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`, { method: "GET", headers: {} });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new PublishTargetError("publish-mcp-registry-failed", `reading ${server.name}@${server.version} on the MCP Registry: ${why(ctx, res)}`);
    const held = (res.json as { server?: { packages?: unknown } } | null)?.server?.packages;
    return (Array.isArray(held) ? (held as ServerJson["packages"]) : []).map(packageKey).sort();
  };

  const target: PublishTarget = {
    kind: "mcp-registry",
    name: `mcp-registry ${path}`,
    destination: registry,
    credentialEnv: tokenNames,
    key: publishTargetKey(decl),
    // Its stage sends nothing (the registry has no draft), so the verify commands can't see it.
    uploadsAtReveal: true,
    revealsLast: true,
    async plan(ctx) {
      return [setup(ctx).item];
    },
    async stage(ctx): Promise<StagedTarget> {
      const { server, token, item } = setup(ctx);
      if (token) ctx.log(`using the token from ${token.from}`);
      await registryToken(ctx, token);
      ctx.log(`the MCP Registry at ${registry} takes the credentials for ${server.name}; the reveal asks for a new token, since one lasts minutes`);
      const held = await served(ctx, server);
      if (held === null) {
        ctx.log(`${item.name} is not on the MCP Registry yet; it is published at the reveal, after the targets that publish its packages`);
        return { target: target.name, destination: target.destination, items: [item], state: {} };
      }
      const mine = server.packages.map(packageKey).sort();
      if (held.join("\n") !== mine.join("\n")) {
        throw new PublishTargetError(
          "publish-mcp-registry-version-exists",
          `the MCP Registry already has ${item.name} with other packages than ${path} names`,
          "A registry version can't be replaced: cut a release with a new version.",
        );
      }
      ctx.log(`${item.name} is already on the MCP Registry with the same packages`);
      return { target: target.name, destination: target.destination, items: [{ ...item, present: true }], state: { present: "true" } };
    },
    async reveal(ctx, staged) {
      const items = staged.items.map((i) => ({ name: i.name, destination: i.destination, ...(i.digest ? { digest: i.digest } : {}) }));
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: items.map((i) => ({ ...i, present: true })) };
      const { bytes, server, token, item } = setup(ctx);
      // After an upload whose record was lost the version is there already: check it rather than send it twice.
      if ((await served(ctx, server)) !== null) {
        ctx.log(`${item.name} is already on the MCP Registry`);
        return { target: target.name, destination: target.destination, items: items.map((i) => ({ ...i, present: true })) };
      }
      const bearer = await registryToken(ctx, token);
      ctx.log(`publishing ${item.name} to the MCP Registry`);
      const res = await call(`${registry}/v0.1/publish`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: bytes.toString("utf-8") });
      if (res.status < 200 || res.status > 299) {
        throw new PublishTargetError(
          "publish-mcp-registry-failed",
          `publishing ${item.name} to the MCP Registry: ${why(ctx, res)}`,
          res.status === 401 || res.status === 403 ? `The token does not cover the namespace of ${server.name}. With GitHub OIDC the name must be io.github.<owner>/<name> for the repository's owner.` : undefined,
        );
      }
      if ((await served(ctx, server)) === null) {
        throw new PublishTargetError("publish-mcp-registry-not-served", `the MCP Registry accepted ${item.name} and does not serve it`);
      }
      return { target: target.name, destination: target.destination, items };
    },
  };
  return target;
}

/**
 * The NuGet target (#5232): `.nupkg` files pushed to nuget.org, or to another
 * feed that takes NuGet's push API (`PUT <pushUrl>`, a multipart body whose
 * first part is the package, the key in `X-NuGet-ApiKey`).
 *
 * The packages are files, directories of them, or `artifact:<name>`. Each
 * file the release records must match its digest. The id and version are
 * read from the `.nuspec` at the package's root.
 *
 * A feed has no draft: a version is listed once it is pushed and validated,
 * and an id and version can never be pushed again. So the stage pushes
 * nothing. It checks the packages and the credential, and reads the feed's
 * flat container (`<base>/<id>/index.json`) for the versions it already
 * holds: such a version is `present`. nuget.org signs every package it takes
 * with its repository signature, so the bytes it serves are never the bytes
 * pushed and no digest is compared. The reveal reads the flat container
 * again and pushes the rest; a push answered 409 (the version exists) is
 * `present` too, since a version pushed moments ago is not in the flat
 * container until nuget.org has validated it.
 *
 * Credentials:
 *
 * - `auth: "token"`: an API key from `tokenEnv` (default `NUGET_API_KEY`).
 * - `auth: "trusted-publishing"`, nuget.org only: the run's OIDC ID token
 *   (audience `https://www.nuget.org`, from GitHub Actions or
 *   `NUGET_ID_TOKEN`, a GitLab job's `id_tokens`) is posted to
 *   `https://www.nuget.org/api/v2/token` with the user in `userEnv` (default
 *   `NUGET_USER`), the nuget.org profile whose trusted publishing policy
 *   names the workflow, for an API key that lasts an hour. nuget.org takes
 *   an ID token once, so the stage exchanges one only in GitHub Actions,
 *   which issues a new token each time it is asked; with `NUGET_ID_TOKEN`
 *   the reveal's exchange is the only one.
 *
 * Unset, `auth` is a token when the key's variable is set, else trusted
 * publishing when the run has an OIDC ID token.
 *
 * A status change (#5163): `chant release yank` unlists each version the
 * release pushed (`DELETE <pushUrl>/<id>/<version>`, which nuget.org reads as
 * an unlist; the version stays restorable for anyone who names it), and
 * `restore` lists it again (`POST`). NuGet's API has no deprecation, so
 * `deprecate` changes nothing.
 *
 * Under the `supply-chain` group a package that carries no SBOM (an
 * `.spdx.json`, `.cdx.json` or `.cyclonedx.json` file, or `_manifest/spdx_*`
 * as Microsoft's sbom-tool writes it) is refused unless `sbom` is `false`.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readCredential, type Credential } from "./publish-credentials";
import type { NugetPublishDeclaration } from "./publish-declaration";
import { releaseVersion } from "./publish-index";
import { packageFiles } from "./publish-package-files";
import { zipEntry, zipEntryNames } from "./publish-pypi";
import { bytesDigest, checkReleaseDigest, hasIdToken, publishTargetKey, runIdToken } from "./publish-targets";
import { trainName, waitUntilServed } from "./publish-train-names";
import { NEXT_RELEASE } from "../release-floors";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget, type StatusAction, type StatusContext } from "./release-publish";

/** The first chant that publishes a `nuget` target (#5232). */
export const PUBLISH_NUGET_FLOOR = NEXT_RELEASE;

export const NUGET_ORG = { label: "nuget.org", site: "https://www.nuget.org", push: "https://www.nuget.org/api/v2/package", flat: "https://api.nuget.org/v3-flatcontainer/", token: "https://www.nuget.org/api/v2/token" } as const;
/** The audience nuget.org takes an OIDC ID token for. */
export const NUGET_AUDIENCE = "https://www.nuget.org";
/** The variable an OIDC ID token for nuget.org is read from outside GitHub Actions, as nuget.org's docs name it for GitLab. */
export const NUGET_ID_TOKEN_ENV = "NUGET_ID_TOKEN";

/** The feed a declaration pushes to. */
export function nugetFeed(decl: Pick<NugetPublishDeclaration, "pushUrl" | "flatContainerUrl">): { label: string; nugetOrg: boolean; push: string; flat: string } {
  if (decl.pushUrl && decl.flatContainerUrl) {
    return { label: new URL(decl.pushUrl).host, nugetOrg: false, push: decl.pushUrl.replace(/\/+$/, ""), flat: decl.flatContainerUrl.endsWith("/") ? decl.flatContainerUrl : `${decl.flatContainerUrl}/` };
  }
  return { label: NUGET_ORG.label, nugetOrg: true, push: NUGET_ORG.push, flat: NUGET_ORG.flat };
}

export const nugetTokenEnv = (decl: Pick<NugetPublishDeclaration, "tokenEnv">): string => decl.tokenEnv ?? "NUGET_API_KEY";
export const nugetUserEnv = (decl: Pick<NugetPublishDeclaration, "userEnv">): string => decl.userEnv ?? "NUGET_USER";

/** How the target authenticates in `env`. */
export function nugetAuth(decl: NugetPublishDeclaration, env: NodeJS.ProcessEnv): "token" | "trusted-publishing" {
  if (decl.auth) return decl.auth;
  if (env[nugetTokenEnv(decl)]) return "token";
  return nugetFeed(decl).nugetOrg && hasIdToken(env, NUGET_ID_TOKEN_ENV) ? "trusted-publishing" : "token";
}

/**
 * A NuGet version as the flat container lists it: lowercased, no build
 * metadata, no leading zeros, and a fourth part of `0` left off.
 */
export function normalizeNugetVersion(version: string): string {
  const v = version.trim().toLowerCase().replace(/\+.*$/, "");
  const dash = v.indexOf("-");
  const core = dash < 0 ? v : v.slice(0, dash);
  const pre = dash < 0 ? "" : v.slice(dash);
  const parts = core.split(".").map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p));
  while (parts.length < 3) parts.push("0");
  if (parts.length === 4 && parts[3] === "0") parts.pop();
  return `${parts.join(".")}${pre}`;
}

/** One `.nupkg`, read. */
export interface NugetPackage {
  path: string;
  file: string;
  bytes: Buffer;
  digest: string;
  id: string;
  version: string;
  /** The package ids its `.nuspec` depends on. */
  dependencies: string[];
  /** The SBOM entry it carries, if any. */
  sbom: string | null;
}

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** Read one `.nupkg`: its `.nuspec`'s id, version and dependencies. */
export function readNupkg(path: string, abs: string): NugetPackage {
  const bytes = readFileSync(abs);
  const file = abs.split(/[\\/]/).pop()!;
  const bad = (why: string) => new PublishTargetError("publish-nuget-not-a-package", `${path} is not a NuGet package chant can read: ${why}`, "Name the .nupkg files dotnet pack writes.");
  let names: string[];
  try {
    names = zipEntryNames(bytes);
  } catch (err) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  const spec = names.find((n) => /^[^/]+\.nuspec$/i.test(n));
  if (!spec) throw bad("it holds no .nuspec at its root");
  let text: string;
  try {
    text = zipEntry(bytes, spec)?.toString("utf-8") ?? "";
  } catch (err) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  const metadata = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i.exec(text)?.[1] ?? "";
  const id = /<id>([^<]+)<\/id>/i.exec(metadata)?.[1];
  const version = /<version>([^<]+)<\/version>/i.exec(metadata)?.[1];
  if (!id || !version) throw bad(`${spec} has no <id> or <version>`);
  const dependencies = [...new Set([...metadata.matchAll(/<dependency\b[^>]*\bid="([^"]+)"/gi)].map((m) => xmlText(m[1]!)))];
  const sbom = names.find((n) => /(^|\/)_manifest\/spdx_[^/]+\/[^/]+\.json$/i.test(n) || /\.(spdx|cdx|cyclonedx)\.json$/i.test(n)) ?? null;
  return { path, file, bytes, digest: bytesDigest(new Uint8Array(bytes)), id: xmlText(id), version: xmlText(version), dependencies, sbom };
}

export function nugetTarget(decl: NugetPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const feed = nugetFeed(decl);
  const tokenName = nugetTokenEnv(decl);
  const userName = nugetUserEnv(decl);

  const packages = (ctx: PublishContext): NugetPackage[] => {
    const out = packageFiles(ctx, decl.packages, ".nupkg", "publish-nuget", "Build the packages before publishing, such as with dotnet pack -o dist/nuget.").map(({ path, abs }) => {
      const p = readNupkg(path, abs);
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [p.digest]);
      return p;
    });
    if (ctx.requireSbom && decl.sbom !== false) {
      const without = out.find((p) => p.sbom === null);
      if (without) {
        throw new PublishTargetError(
          "publish-sbom-missing",
          `${without.file} carries no SBOM: a feed keeps no file beside a package, so a package carries its SBOM, such as _manifest/spdx_2.2/manifest.spdx.json`,
          "Build packages that carry an SBOM, such as with Microsoft's sbom-tool, or set sbom: false to publish without one.",
        );
      }
    }
    return out;
  };

  const item = (p: Pick<NugetPackage, "id" | "version" | "digest" | "sbom">): PublishItem => ({
    name: `${p.id}@${p.version}`,
    destination: feed.nugetOrg ? `${NUGET_ORG.site}/packages/${p.id}/${p.version}` : `${feed.flat}${p.id.toLowerCase()}/`,
    digest: p.digest,
    ...(p.sbom ? { sbom: p.sbom } : {}),
  });

  const fail = (ctx: PublishContextBase, code: string, what: string, status: number, text: string, fix?: string): never => {
    throw new PublishTargetError(code, ctx.redactor.redact(`${what} on ${feed.label} answered ${status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`), fix);
  };

  /** The versions the feed lists for an id, normalized; empty when it has no such package. */
  const versions = async (ctx: PublishContextBase, id: string, key: string | null): Promise<Set<string>> => {
    const url = `${feed.flat}${id.toLowerCase()}/index.json`;
    const res = await fetchImpl(url, { method: "GET", headers: { "user-agent": "chant", accept: "application/json", ...(!feed.nugetOrg && key ? { "x-nuget-apikey": key } : {}) } });
    const text = await res.text().catch(() => "");
    if (res.status === 404) return new Set();
    if (res.status !== 200) fail(ctx, "publish-nuget-failed", `reading ${url}`, res.status, text);
    try {
      const list = (JSON.parse(text) as { versions?: unknown }).versions;
      return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === "string").map(normalizeNugetVersion) : []);
    } catch {
      return fail(ctx, "publish-nuget-failed", `reading ${url}`, res.status, "not JSON");
    }
  };

  const presence = async (ctx: PublishContextBase, pkgs: ReadonlyArray<Pick<NugetPackage, "id" | "version">>, key: string | null): Promise<Map<string, boolean>> => {
    const byId = new Map<string, Set<string>>();
    const out = new Map<string, boolean>();
    for (const p of pkgs) {
      const k = p.id.toLowerCase();
      if (!byId.has(k)) byId.set(k, await versions(ctx, p.id, key));
      out.set(`${p.id}@${p.version}`, byId.get(k)!.has(normalizeNugetVersion(p.version)));
    }
    return out;
  };

  /** The API key, or null under trusted publishing; refuses a run with neither. */
  const credential = (ctx: PublishContextBase): { auth: "token" | "trusted-publishing"; key: Credential | null; user: string | null } => {
    const auth = nugetAuth(decl, ctx.env);
    if (auth === "token") {
      const key = readCredential(ctx.env, [tokenName], ctx.redactor);
      if (!key) {
        throw new PublishTargetError(
          "publish-credentials-missing",
          `the ${feed.label} target reads its API key from ${tokenName}, and it is not set${feed.nugetOrg ? ", and this run has no OIDC ID token for trusted publishing" : ""}`,
          feed.nugetOrg ? `Set ${tokenName} to a nuget.org API key that may push the packages, or publish from a CI job with an OIDC ID token and a trusted publishing policy on nuget.org.` : `Set ${tokenName} to a key the feed takes.`,
        );
      }
      return { auth, key, user: null };
    }
    if (!hasIdToken(ctx.env, NUGET_ID_TOKEN_ENV)) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the nuget.org target publishes with trusted publishing, and this run has no OIDC ID token: not a GitHub Actions job with id-token: write, and ${NUGET_ID_TOKEN_ENV} is not set`,
        `In GitHub Actions, give the job permissions: id-token: write. In GitLab CI, declare ${NUGET_ID_TOKEN_ENV} under the job's id_tokens with aud: ${NUGET_AUDIENCE}.`,
      );
    }
    const user = readCredential(ctx.env, [userName], ctx.redactor);
    if (!user) throw new PublishTargetError("publish-credentials-missing", `trusted publishing on nuget.org names the user whose policy trusts this workflow, and ${userName} is not set`, `Set ${userName} to that nuget.org profile name (not the email address).`);
    return { auth, key: null, user: user.value };
  };

  /** Trusted publishing: an API key for this run, for its OIDC ID token. It lasts an hour. */
  const exchange = async (ctx: PublishContextBase, user: string): Promise<string> => {
    const jwt = await runIdToken(ctx, fetchImpl, NUGET_AUDIENCE, NUGET_ID_TOKEN_ENV, "publish-nuget-trusted-publishing");
    const res = await fetchImpl(NUGET_ORG.token, { method: "POST", headers: { "user-agent": "chant", "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ username: user, tokenType: "ApiKey" }) });
    const text = await res.text().catch(() => "");
    let body: { apiKey?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // Reported by its status.
    }
    if (res.status !== 200 || typeof body.apiKey !== "string" || !body.apiKey) {
      throw new PublishTargetError(
        "publish-nuget-trusted-publishing",
        ctx.redactor.redact(`nuget.org gave no API key for this run's OIDC ID token: it answered ${res.status}${typeof body.error === "string" ? `: ${body.error}` : text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`),
        `Add a trusted publishing policy on nuget.org for this repository and workflow file, and set ${userName} to the profile name of the user who created it.`,
      );
    }
    ctx.redactor.add(body.apiKey);
    return body.apiKey;
  };

  /** Whether the stage can exchange without spending the reveal's ID token: GitHub Actions issues one per request. */
  const canCheckExchange = (env: NodeJS.ProcessEnv) => !env[NUGET_ID_TOKEN_ENV] && Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

  const push = async (ctx: PublishContext, p: NugetPackage, key: string): Promise<"sent" | "present"> => {
    const boundary = `chant-${randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="${p.file}"\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf-8"),
      p.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
    ]);
    ctx.log(`pushing ${p.file} (${p.bytes.byteLength} bytes) to ${feed.label}`);
    const res = await fetchImpl(feed.push, {
      method: "PUT",
      headers: { "user-agent": "chant", "content-type": `multipart/form-data; boundary=${boundary}`, "x-nuget-apikey": key, "x-nuget-protocol-version": "4.1.0" },
      body: new Uint8Array(body),
    });
    const text = await res.text().catch(() => "");
    if (res.status === 200 || res.status === 201 || res.status === 202) return "sent";
    if (res.status === 409) return "present";
    if (res.status === 400) return fail(ctx, "publish-nuget-invalid", `pushing ${p.file}`, res.status, text, "Fix the package: the feed refused it as invalid.");
    return fail(ctx, "publish-nuget-failed", `pushing ${p.file}`, res.status, text, res.status === 401 || res.status === 403 ? `Check that the key may push ${p.id}: on nuget.org, its scope and glob pattern, or the trusted publishing policy's.` : undefined);
  };

  const target: PublishTarget = {
    kind: "nuget",
    name: `${feed.label} ${decl.packages.join(", ")}`,
    destination: feed.label,
    credentialEnv: [tokenName, userName, NUGET_ID_TOKEN_ENV],
    key: publishTargetKey(decl),
    uploadsAtReveal: true,
    async names(ctx) {
      const pkgs = packages(ctx);
      const provides = [...new Set(pkgs.map((p) => trainName("nuget", p.id)))];
      const needs = new Set(pkgs.flatMap((p) => p.dependencies.map((d) => trainName("nuget", d))));
      return { provides, needs: [...needs].filter((n) => !provides.includes(n)) };
    },
    /** #5165: whether the feed lists each package at the release's version. */
    async published(ctx) {
      const version = releaseVersion(ctx.label);
      if (!version) return null;
      let pkgs: NugetPackage[];
      try {
        pkgs = packages(ctx);
      } catch {
        return null;
      }
      const key = readCredential(ctx.env, [tokenName], ctx.redactor)?.value ?? null;
      const present = await presence(ctx, pkgs.map((p) => ({ id: p.id, version })), key);
      return [...present.values()].every(Boolean);
    },
    /** #5165: wait until the flat container lists each version the reveal pushed. nuget.org validates and indexes a package first, which takes minutes. */
    async visible(ctx, published) {
      const pkgs = published.items.filter((i) => i.attachment === undefined && !i.refused).map((i) => /^(.+)@([^@]+)$/.exec(i.name)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ id: m[1]!, version: m[2]! }));
      if (pkgs.length === 0) return;
      const key = readCredential(ctx.env, [tokenName], ctx.redactor)?.value ?? null;
      await waitUntilServed(ctx, deps, {
        what: feed.label,
        code: "publish-nuget-not-served",
        check: async () => {
          const present = await presence(ctx, pkgs, key);
          return [...present.entries()].filter(([, v]) => !v).map(([k]) => k);
        },
      });
    },
    async plan(ctx) {
      const pkgs = packages(ctx);
      credential(ctx);
      return pkgs.map(item);
    },
    async stage(ctx) {
      const pkgs = packages(ctx);
      const cred = credential(ctx);
      if (cred.key) ctx.log(`using the API key from ${cred.key.from}; ${feed.label} has no read-only check of a key, so whether it may push shows at the reveal`);
      else if (canCheckExchange(ctx.env)) {
        await exchange(ctx, cred.user!);
        ctx.log("nuget.org takes this run as a trusted publisher; the reveal asks for a new key");
      } else ctx.log(`nuget.org takes an ID token once, so the reveal makes the trusted-publishing exchange with ${NUGET_ID_TOKEN_ENV}`);
      const present = await presence(ctx, pkgs, cred.key?.value ?? null);
      const items = pkgs.map((p) => (present.get(`${p.id}@${p.version}`) ? { ...item(p), present: true } : item(p)));
      const waiting = items.filter((i) => !i.present).map((i) => i.name);
      ctx.log(waiting.length === 0 ? `${feed.label} already lists every package at its version` : `${waiting.join(", ")} ${waiting.length === 1 ? "is" : "are"} pushed at the reveal, since ${feed.label} has no draft`);
      const staged: StagedTarget = { target: target.name, destination: target.destination, items, state: waiting.length === 0 ? { present: "true" } : {} };
      return staged;
    },
    async reveal(ctx, staged) {
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: staged.items.map((i) => ({ ...i, present: true })) };
      const pkgs = packages(ctx);
      const cred = credential(ctx);
      // Read again: a reveal run after a push whose record was lost finds the version there.
      const present = await presence(ctx, pkgs, cred.key?.value ?? null);
      let key = cred.key?.value ?? null;
      const done: string[] = [];
      const items: PublishItem[] = [];
      for (const p of pkgs) {
        const name = `${p.id}@${p.version}`;
        if (present.get(name)) {
          items.push({ ...item(p), present: true });
          continue;
        }
        key ??= await exchange(ctx, cred.user!);
        let r: "sent" | "present";
        try {
          r = await push(ctx, p, key);
        } catch (err) {
          if (err instanceof PublishTargetError && done.length > 0) throw new PublishTargetError(err.code, `${err.message}. Pushed before it: ${done.join(", ")}; the same publish run again pushes only the rest`, err.fix);
          throw err;
        }
        if (r === "present") ctx.log(`${feed.label} already has ${name}; it signs what it takes, so the bytes are not compared`);
        else done.push(name);
        items.push(r === "present" ? { ...item(p), present: true } : item(p));
      }
      return { target: target.name, destination: target.destination, items };
    },
    /**
     * #5163: a yank unlists each version the release pushed, a restore lists
     * it again. NuGet's API has no deprecation.
     */
    async setStatus(ctx: StatusContext): Promise<StatusAction[]> {
      if (ctx.status === "deprecated") return [{ what: `${feed.label} unchanged: NuGet's API has no deprecation; yank unlists the versions`, already: true }];
      const relist = ctx.status === "active";
      const pkgs = ctx.revealed.filter((i) => i.attachment === undefined && !i.refused && i.name.lastIndexOf("@") > 0).map((i) => ({ id: i.name.slice(0, i.name.lastIndexOf("@")), version: i.name.slice(i.name.lastIndexOf("@") + 1) }));
      const what = (p: { id: string; version: string }) => `${relist ? "POST" : "DELETE"} ${feed.push}/${p.id}/${p.version} (${relist ? "list" : "unlist"} ${p.id}@${p.version})`;
      if (!ctx.apply) return pkgs.map((p) => ({ what: what(p) }));
      const cred = credential(ctx);
      const key = cred.key?.value ?? (await exchange(ctx, cred.user!));
      const actions: StatusAction[] = [];
      for (const p of pkgs) {
        ctx.log(`${relist ? "listing" : "unlisting"} ${p.id}@${p.version} on ${feed.label}`);
        const res = await fetchImpl(`${feed.push}/${encodeURIComponent(p.id)}/${encodeURIComponent(p.version)}`, { method: relist ? "POST" : "DELETE", headers: { "user-agent": "chant", "x-nuget-apikey": key, "x-nuget-protocol-version": "4.1.0" } });
        const text = await res.text().catch(() => "");
        if (res.status === 404) {
          actions.push({ what: `${p.id}@${p.version} is not on ${feed.label}; nothing to ${relist ? "restore" : "yank"}`, already: true });
          continue;
        }
        if (res.status < 200 || res.status > 299) fail(ctx, "release-status-nuget-failed", what(p), res.status, text, `Unlisting needs a key that may unlist ${p.id}.`);
        actions.push({ what: what(p) });
      }
      return actions;
    },
  };
  return target;
}

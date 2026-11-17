/**
 * The RubyGems target (#5232): `.gem` files pushed to RubyGems.org, or to
 * another host that takes its API (`POST /api/v1/gems`, the gem as the body,
 * the key in `Authorization`).
 *
 * The gems are files, directories of them, or `artifact:<name>`. Each file
 * the release records must match its digest. The name, version and platform
 * are read from the gem's own `metadata.gz`.
 *
 * A host has no draft: a version is visible once it is pushed, and a name,
 * version and platform can never be pushed again, even after a yank. So the
 * stage pushes nothing. It checks the gems and the credential, and reads
 * `/api/v1/versions/<name>.json`: a version the host lists for the platform
 * with the same SHA-256 is `present`; one it lists with another is refused
 * (`publish-rubygems-version-exists`). The reveal reads it again and pushes
 * the rest, so a reveal run again after a push whose record was lost sends
 * nothing twice.
 *
 * Credentials:
 *
 * - `auth: "token"`: an API key from `tokenEnv` (default `GEM_HOST_API_KEY`,
 *   the variable `gem push` reads), with the push scope.
 * - `auth: "trusted-publishing"`, RubyGems.org only: the run's OIDC ID token
 *   (audience `rubygems.org`, from GitHub Actions or `RUBYGEMS_ID_TOKEN`) is
 *   exchanged at `POST /api/v1/oidc/trusted_publisher/exchange_token` for a
 *   key that lasts minutes. The stage exchanges to check that RubyGems.org
 *   takes this workflow as a trusted publisher, and drops the key; the
 *   reveal exchanges again.
 *
 * Unset, `auth` is a token when the key's variable is set, else trusted
 * publishing when the run has an OIDC ID token.
 *
 * A status change (#5163): `chant release yank` yanks each version the
 * release pushed (`DELETE /api/v1/gems/yank`), with a key in `tokenEnv` that
 * may yank. RubyGems.org takes no yank back, so `restore` is refused, and it
 * has no deprecation, so `deprecate` changes nothing.
 *
 * A host keeps no file beside a gem, so nothing is attached. Under the
 * `supply-chain` group the target is refused (`publish-sbom-missing`) unless
 * `sbom` is `false`.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readCredential } from "./publish-credentials";
import type { RubygemsPublishDeclaration } from "./publish-declaration";
import { releaseVersion } from "./publish-index";
import { packageFiles } from "./publish-package-files";
import { tarEntries } from "./publish-pypi";
import { bytesDigest, checkReleaseDigest, hasIdToken, publishTargetKey, runIdToken } from "./publish-targets";
import { trainName, waitUntilServed } from "./publish-train-names";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget, type StatusAction, type StatusContext } from "./release-publish";

/** The first chant that publishes a `rubygems` target (#5232). */
export const PUBLISH_RUBYGEMS_FLOOR = "0.124.102";

export const RUBYGEMS_ORG = "https://rubygems.org";
/** The audience RubyGems.org takes an OIDC ID token for. */
export const RUBYGEMS_AUDIENCE = "rubygems.org";
/** The variable an OIDC ID token for RubyGems.org is read from outside GitHub Actions. */
export const RUBYGEMS_ID_TOKEN_ENV = "RUBYGEMS_ID_TOKEN";

export const rubygemsHost = (decl: Pick<RubygemsPublishDeclaration, "host">): string => (decl.host ?? RUBYGEMS_ORG).replace(/\/+$/, "");
export const rubygemsTokenEnv = (decl: Pick<RubygemsPublishDeclaration, "tokenEnv">): string => decl.tokenEnv ?? "GEM_HOST_API_KEY";

/** How the target authenticates in `env`. */
export function rubygemsAuth(decl: RubygemsPublishDeclaration, env: NodeJS.ProcessEnv): "token" | "trusted-publishing" {
  if (decl.auth) return decl.auth;
  if (env[rubygemsTokenEnv(decl)]) return "token";
  return decl.host === undefined && hasIdToken(env, RUBYGEMS_ID_TOKEN_ENV) ? "trusted-publishing" : "token";
}

/** One `.gem`, read. */
export interface RubyGem {
  path: string;
  file: string;
  bytes: Buffer;
  digest: string;
  name: string;
  version: string;
  platform: string;
  /** The gems it needs at run time. */
  dependencies: string[];
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

/** A gemspec's name, version, platform and runtime dependencies, from the YAML `gem build` writes into `metadata.gz`. */
export function parseGemMetadata(yaml: string): { name: string | null; version: string | null; platform: string; dependencies: string[] } {
  const name = /^name: *(.+)$/m.exec(yaml)?.[1];
  const version = /^version: *!ruby\/object:Gem::Version\s*\n\s+version: *(.+)$/m.exec(yaml)?.[1] ?? /^version: *([^!\s].*)$/m.exec(yaml)?.[1];
  const platform = /^platform: *(.+)$/m.exec(yaml)?.[1];
  const deps = /^dependencies: *\n([\s\S]*?)(?=^[^\s-])/m.exec(`${yaml}\n.`)?.[1] ?? "";
  const dependencies = deps
    .split(/^- !ruby\/object:Gem::Dependency\s*$/m)
    .map((block) => ({ name: /^ {2}name: *(.+)$/m.exec(block)?.[1], type: /^ {2}type: *:?(\w+)/m.exec(block)?.[1] }))
    .filter((d): d is { name: string; type: string | undefined } => d.name !== undefined && d.type !== "development")
    .map((d) => unquote(d.name));
  return { name: name ? unquote(name) : null, version: version ? unquote(version) : null, platform: platform ? unquote(platform) : "ruby", dependencies: [...new Set(dependencies)] };
}

/** Read one `.gem`: a tar holding `metadata.gz`. */
export function readGem(path: string, abs: string): RubyGem {
  const bytes = readFileSync(abs);
  const file = abs.split(/[\\/]/).pop()!;
  const bad = (why: string) => new PublishTargetError("publish-rubygems-not-a-gem", `${path} is not a gem chant can read: ${why}`, "Name the .gem files gem build writes.");
  let meta: ReturnType<typeof parseGemMetadata>;
  try {
    const gz = tarEntries(bytes).get("metadata.gz");
    if (!gz) throw new Error("it holds no metadata.gz");
    meta = parseGemMetadata(gunzipSync(gz).toString("utf-8"));
  } catch (err) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  if (!meta.name || !meta.version) throw bad("its metadata has no name or version");
  return { path, file, bytes, digest: bytesDigest(new Uint8Array(bytes)), name: meta.name, version: meta.version, platform: meta.platform, dependencies: meta.dependencies };
}

const full = (g: Pick<RubyGem, "name" | "version" | "platform">) => `${g.name}-${g.version}${g.platform === "ruby" ? "" : `-${g.platform}`}`;

/** An item's name: `<name>@<version>`, with `-<platform>` for a platform gem. A gem version holds no `-`. */
export const gemItemName = (g: Pick<RubyGem, "name" | "version" | "platform">) => `${g.name}@${g.version}${g.platform === "ruby" ? "" : `-${g.platform}`}`;

/** The gem an item names. */
export function parseGemItemName(name: string): { name: string; version: string; platform: string } | null {
  const at = name.lastIndexOf("@");
  if (at <= 0) return null;
  const rest = name.slice(at + 1);
  const dash = rest.indexOf("-");
  return { name: name.slice(0, at), version: dash < 0 ? rest : rest.slice(0, dash), platform: dash < 0 ? "ruby" : rest.slice(dash + 1) };
}

export function rubygemsTarget(decl: RubygemsPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const host = rubygemsHost(decl);
  const label = decl.host ? new URL(host).host : "RubyGems.org";
  const tokenName = rubygemsTokenEnv(decl);

  const gems = (ctx: PublishContext): RubyGem[] => {
    if (ctx.requireSbom && decl.sbom !== false) {
      throw new PublishTargetError("publish-sbom-missing", `${label} keeps no file beside a gem, so the gems this target publishes carry no SBOM`, "Attach the SBOM to the release elsewhere, such as with a forge target, and set sbom: false on this target.");
    }
    return packageFiles(ctx, decl.gems, ".gem", "publish-rubygems", "Build the gems before publishing, such as with gem build.").map(({ path, abs }) => {
      const g = readGem(path, abs);
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [g.digest]);
      return g;
    });
  };

  const item = (g: RubyGem): PublishItem => ({ name: gemItemName(g), destination: `${host}/gems/${g.name}/versions/${g.version}${g.platform === "ruby" ? "" : `-${g.platform}`}`, digest: g.digest });

  const fail = (ctx: PublishContextBase, code: string, what: string, status: number, text: string, fix?: string): never => {
    throw new PublishTargetError(code, ctx.redactor.redact(`${what} on ${label} answered ${status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`), fix);
  };

  /** Each version the host lists for a gem, `<version>-<platform>` to its SHA-256 in hex (or null); empty when it has no such gem. */
  const listed = async (ctx: PublishContextBase, name: string): Promise<Map<string, string | null>> => {
    const url = `${host}/api/v1/versions/${encodeURIComponent(name)}.json`;
    const res = await fetchImpl(url, { method: "GET", headers: { "user-agent": "chant", accept: "application/json" } });
    const text = await res.text().catch(() => "");
    if (res.status === 404) return new Map();
    if (res.status !== 200) fail(ctx, "publish-rubygems-failed", `reading ${url}`, res.status, text);
    const out = new Map<string, string | null>();
    try {
      for (const v of JSON.parse(text) as Array<{ number?: unknown; platform?: unknown; sha?: unknown }>) {
        if (typeof v.number === "string") out.set(`${v.number}-${typeof v.platform === "string" ? v.platform : "ruby"}`, typeof v.sha === "string" ? v.sha.toLowerCase() : null);
      }
    } catch {
      fail(ctx, "publish-rubygems-failed", `reading ${url}`, res.status, "not a JSON list");
    }
    return out;
  };

  /** Each gem: `present` when the host lists it with the same bytes; refused when it lists it with others. */
  const presence = async (ctx: PublishContextBase, list: RubyGem[]): Promise<Map<string, boolean>> => {
    const byName = new Map<string, Map<string, string | null>>();
    const out = new Map<string, boolean>();
    for (const g of list) {
      if (!byName.has(g.name)) byName.set(g.name, await listed(ctx, g.name));
      const versions = byName.get(g.name)!;
      const key = `${g.version}-${g.platform}`;
      if (!versions.has(key)) {
        out.set(g.file, false);
        continue;
      }
      const sha = versions.get(key);
      if (sha && `sha256:${sha}` !== g.digest) {
        throw new PublishTargetError("publish-rubygems-version-exists", `${label} already has ${full(g)}, with sha256:${sha}, not ${g.digest}`, "A gem host never takes a version twice: cut a release with a new version.");
      }
      out.set(g.file, true);
    }
    return out;
  };

  const credential = (ctx: PublishContextBase): { auth: "token" | "trusted-publishing"; key: string | null; from: string | null } => {
    const auth = rubygemsAuth(decl, ctx.env);
    if (auth === "trusted-publishing") {
      if (!hasIdToken(ctx.env, RUBYGEMS_ID_TOKEN_ENV)) {
        throw new PublishTargetError(
          "publish-credentials-missing",
          `the RubyGems.org target publishes with trusted publishing, and this run has no OIDC ID token: not a GitHub Actions job with id-token: write, and ${RUBYGEMS_ID_TOKEN_ENV} is not set`,
          "In GitHub Actions, give the job permissions: id-token: write.",
        );
      }
      return { auth, key: null, from: null };
    }
    const cred = readCredential(ctx.env, [tokenName], ctx.redactor);
    if (!cred) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `the ${label} target reads its API key from ${tokenName}, and it is not set${decl.host ? "" : ", and this run has no OIDC ID token for trusted publishing"}`,
        decl.host ? `Set ${tokenName} to a key the host takes.` : `Set ${tokenName} to a RubyGems.org API key with the push scope, or publish from a GitHub Actions job with id-token: write and a trusted publisher on RubyGems.org.`,
      );
    }
    return { auth, key: cred.value, from: cred.from };
  };

  /** Trusted publishing: a key for this run, for its OIDC ID token. */
  const exchange = async (ctx: PublishContextBase): Promise<string> => {
    const jwt = await runIdToken(ctx, fetchImpl, RUBYGEMS_AUDIENCE, RUBYGEMS_ID_TOKEN_ENV, "publish-rubygems-trusted-publishing");
    const res = await fetchImpl(`${host}/api/v1/oidc/trusted_publisher/exchange_token`, { method: "POST", headers: { "user-agent": "chant", "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jwt }) });
    const text = await res.text().catch(() => "");
    let body: { rubygems_api_key?: unknown; error?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // Reported by its status.
    }
    if (res.status < 200 || res.status > 299 || typeof body.rubygems_api_key !== "string" || !body.rubygems_api_key) {
      throw new PublishTargetError(
        "publish-rubygems-trusted-publishing",
        ctx.redactor.redact(`RubyGems.org gave no API key for this run's OIDC ID token: it answered ${res.status}${typeof body.error === "string" ? `: ${body.error}` : text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}`),
        "Add this repository and workflow as a trusted publisher of the gem on RubyGems.org (a pending trusted publisher for a gem that does not exist yet).",
      );
    }
    ctx.redactor.add(body.rubygems_api_key);
    return body.rubygems_api_key;
  };

  const push = async (ctx: PublishContext, g: RubyGem, key: string): Promise<"sent" | "present"> => {
    ctx.log(`pushing ${g.file} (${g.bytes.byteLength} bytes) to ${label}`);
    const res = await fetchImpl(`${host}/api/v1/gems`, { method: "POST", headers: { "user-agent": "chant", "content-type": "application/octet-stream", authorization: key }, body: new Uint8Array(g.bytes) });
    const text = await res.text().catch(() => "");
    if (res.status === 200 || res.status === 201) return "sent";
    if (res.status === 409 || /repushing|already been pushed/i.test(text)) {
      // Another push of this version won the race, or a record was lost: the host keeps the first bytes it took.
      const now = await presence(ctx, [g]).catch((err: unknown) => {
        if (err instanceof PublishTargetError) throw err;
        return new Map<string, boolean>();
      });
      if (now.get(g.file)) return "present";
      throw new PublishTargetError("publish-rubygems-version-exists", ctx.redactor.redact(`${label} refused ${g.file}: ${text.replace(/\s+/g, " ").slice(0, 300)}`), "A gem host never takes a version twice, even after a yank: cut a release with a new version.");
    }
    return fail(
      ctx,
      "publish-rubygems-failed",
      `pushing ${g.file}`,
      res.status,
      text,
      /otp|multi.?factor|mfa/i.test(text)
        ? "The account asks for a one-time password on API pushes: publish with trusted publishing, or set its MFA level to UI and gem signin."
        : res.status === 401 || res.status === 403
          ? `Check that the key has the push scope and that its owner owns ${g.name}.`
          : undefined,
    );
  };

  const target: PublishTarget = {
    kind: "rubygems",
    name: `${label} ${decl.gems.join(", ")}`,
    destination: label,
    credentialEnv: [tokenName, RUBYGEMS_ID_TOKEN_ENV],
    key: publishTargetKey(decl),
    uploadsAtReveal: true,
    async names(ctx) {
      const list = packageFiles(ctx, decl.gems, ".gem", "publish-rubygems", "Build the gems before publishing.").map(({ path, abs }) => readGem(path, abs));
      const provides = [...new Set(list.map((g) => trainName("rubygems", g.name)))];
      const needs = new Set(list.flatMap((g) => g.dependencies.map((d) => trainName("rubygems", d))));
      return { provides, needs: [...needs].filter((n) => !provides.includes(n)) };
    },
    /** #5165: whether the host lists each gem at the release's version. */
    async published(ctx) {
      const version = releaseVersion(ctx.label);
      if (!version) return null;
      let list: RubyGem[];
      try {
        list = packageFiles(ctx, decl.gems, ".gem", "publish-rubygems", "").map(({ path, abs }) => readGem(path, abs));
      } catch {
        return null;
      }
      for (const g of list) {
        const versions = await listed(ctx, g.name);
        if (!versions.has(`${version}-${g.platform}`)) return false;
      }
      return true;
    },
    /** #5165: wait until the host lists each gem the reveal pushed. */
    async visible(ctx, published) {
      const list = published.items.filter((i) => i.attachment === undefined && !i.refused).map((i) => parseGemItemName(i.name)).filter((g): g is NonNullable<typeof g> => g !== null);
      if (list.length === 0) return;
      await waitUntilServed(ctx, deps, {
        what: label,
        code: "publish-rubygems-not-served",
        check: async () => {
          const missing: string[] = [];
          for (const g of list) if (!(await listed(ctx, g.name)).has(`${g.version}-${g.platform}`)) missing.push(full(g));
          return missing;
        },
      });
    },
    async plan(ctx) {
      const list = gems(ctx);
      credential(ctx);
      return list.map(item);
    },
    async stage(ctx) {
      const list = gems(ctx);
      const cred = credential(ctx);
      if (cred.key) ctx.log(`using the API key from ${cred.from}; ${label} has no read-only check of a key, so whether it may push shows at the reveal`);
      else {
        await exchange(ctx);
        ctx.log("RubyGems.org takes this run as a trusted publisher; the reveal asks for a new key, since one lasts minutes");
      }
      const present = await presence(ctx, list);
      const items = list.map((g) => (present.get(g.file) ? { ...item(g), present: true } : item(g)));
      const waiting = items.filter((i) => !i.present).map((i) => i.name);
      ctx.log(waiting.length === 0 ? `${label} already has every gem with the same bytes` : `${waiting.join(", ")} ${waiting.length === 1 ? "is" : "are"} pushed at the reveal, since ${label} has no draft`);
      const staged: StagedTarget = { target: target.name, destination: target.destination, items, state: waiting.length === 0 ? { present: "true" } : {} };
      return staged;
    },
    async reveal(ctx, staged) {
      if (staged.state.present === "true") return { target: target.name, destination: target.destination, items: staged.items.map((i) => ({ ...i, present: true })) };
      const list = gems(ctx);
      const cred = credential(ctx);
      // Read again: a reveal run after a push whose record was lost finds the gem there.
      const present = await presence(ctx, list);
      let key = cred.key;
      const done: string[] = [];
      const items: PublishItem[] = [];
      for (const g of list) {
        if (present.get(g.file)) {
          items.push({ ...item(g), present: true });
          continue;
        }
        key ??= await exchange(ctx);
        let r: "sent" | "present";
        try {
          r = await push(ctx, g, key);
        } catch (err) {
          if (err instanceof PublishTargetError && done.length > 0) throw new PublishTargetError(err.code, `${err.message}. Pushed before it: ${done.join(", ")}; the same publish run again pushes only the rest`, err.fix);
          throw err;
        }
        if (r === "sent") done.push(g.file);
        items.push(r === "present" ? { ...item(g), present: true } : item(g));
      }
      return { target: target.name, destination: target.destination, items };
    },
    /** #5163: yank each version the release pushed. A yank can't be undone, and there is no deprecation. */
    async setStatus(ctx: StatusContext): Promise<StatusAction[]> {
      if (ctx.status === "deprecated") return [{ what: `${label} unchanged: a gem version has no deprecation; yank takes it out of resolution`, already: true }];
      const pushed = ctx.revealed
        .filter((i) => i.attachment === undefined && !i.refused)
        .map((i) => parseGemItemName(i.name))
        .filter((g): g is NonNullable<typeof g> => g !== null);
      if (ctx.status === "active") {
        return pushed.map((g) => ({ what: `restore ${full(g)}`, refused: { code: "release-status-unsupported", message: `${label} takes no yank back`, fix: "Cut a release with a new version." } }));
      }
      const what = (g: { name: string; version: string; platform: string }) => `DELETE ${host}/api/v1/gems/yank gem_name=${g.name} version=${g.version}${g.platform === "ruby" ? "" : ` platform=${g.platform}`}`;
      if (!ctx.apply) return pushed.map((g) => ({ what: what(g) }));
      const cred = readCredential(ctx.env, [tokenName], ctx.redactor);
      if (!cred) throw new PublishTargetError("publish-credentials-missing", `the ${label} target reads its API key from ${tokenName}, and it is not set`, `Set ${tokenName} to a key of ${label} with the yank scope.`);
      const actions: StatusAction[] = [];
      for (const g of pushed) {
        if (!(await listed(ctx, g.name)).has(`${g.version}-${g.platform}`)) {
          actions.push({ what: `${full(g)} is not listed on ${label}; it is yanked already, or was never pushed`, already: true });
          continue;
        }
        const form = new URLSearchParams({ gem_name: g.name, version: g.version, ...(g.platform === "ruby" ? {} : { platform: g.platform }) }).toString();
        ctx.log(`yanking ${full(g)} on ${label}`);
        const res = await fetchImpl(`${host}/api/v1/gems/yank`, { method: "DELETE", headers: { "user-agent": "chant", "content-type": "application/x-www-form-urlencoded", authorization: cred.value }, body: form });
        const text = await res.text().catch(() => "");
        if (res.status < 200 || res.status > 299) fail(ctx, "release-status-rubygems-failed", what(g), res.status, text, `Yanking needs a key with the yank scope whose owner owns ${g.name}.`);
        actions.push({ what: what(g) });
      }
      return actions;
    },
  };
  return target;
}

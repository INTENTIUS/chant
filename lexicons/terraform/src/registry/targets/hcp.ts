/**
 * HCP Terraform's private module registry as a module target (chant#4604),
 * on the API flow terragucci#1292's ruling settled for every tier, with no
 * VCS connection:
 *
 *   1. GET  /api/v2/organizations/:org/registry-modules/private/:org/:name/:provider
 *      and, only when that answers 404,
 *      POST /api/v2/organizations/:org/registry-modules
 *           {type: registry-modules, attributes: {name, provider, registry-name: private}}
 *   2. POST /api/v2/organizations/:org/registry-modules/private/:org/:name/:provider/versions
 *           {type: registry-module-versions, attributes: {version, commit-sha}}
 *      whose 201 carries `links.upload`
 *   3. PUT  <links.upload>, Content-Type: application/octet-stream, the gzip tarball
 *
 * (developer.hashicorp.com/terraform/cloud-docs/api-docs/private-registry/modules).
 * The archive is the one the bucket registry serves and the attestation signs
 * (terragucci#1290 ruling B), and `commit-sha` carries the revision.
 *
 * `stage` makes the three calls. A module already there is not created
 * again, and a version already there is judged by its content (`held`): the
 * same content comes back `present` with nothing sent, other content is
 * refused. HCP lists a version as soon as it is created, so there is nothing
 * to hide before a reveal; `reveal` reads the module until the version's
 * status is `ok`, through the contract's `sleep` and `now`, and a version
 * still parsing when the wait runs out is reported in a line, without failing.
 *
 * The token is `TFE_TOKEN` (or the declaration's `tokenEnv`), else the one
 * Terraform sends the host: `TF_TOKEN_<host>` or a credentials block
 * (core's terraform/credentials). It goes in `Authorization: Bearer` to the
 * API host only. The upload link is a signed archivist URL, so the token is
 * not sent there, as go-tfe's upload sends none.
 *
 * Every call is retried on a 429 after `Retry-After`, else with a doubling
 * backoff, up to {@link HCP_RATE_RETRIES} times; HCP's API allows 30 requests
 * a second per user. A 404 on a create names the two causes the docs give:
 * a token whose team lacks the Manage modules permission, or an organization
 * without the private registry entitlement.
 *
 * Deprecation: the HCP docs read for this target (the private registry
 * modules API and the publish page) give no call to deprecate a version, so
 * HCP shows none and the bucket catalog carries it. Left for the maintainer
 * run, as terragucci#1292 left them open: which token types work (team,
 * user, organization), moving a module between API and VCS publishing, any
 * archive size ceiling, and whether the upload link wants the token.
 */
import { PublishTargetError, type PublishContextBase, type PublishItem, type PublishedTarget, type StagedTarget } from "@intentius/chant/lifecycle/release-publish";
import { terraformCredential, tokenVariable } from "@intentius/chant/terraform/credentials";
import { createHash } from "node:crypto";
import { RegistryError, fetchTarball, registryLocation, type RegistryReadOptions } from "../reader";
import { compareSemver, parseSemver } from "../semver";
import {
  answerError,
  checkModuleVersion,
  contentDigest,
  defaultPublishFetch,
  versionHeldError,
  type HeldVersion,
  type ModuleAddress,
  type ModulePublishTarget,
  type ModuleTargetDeps,
  type ModuleVersionContext,
} from "./module-target";

/** How an HCP Terraform (or Terraform Enterprise) module target is declared. */
export interface HcpModuleTargetOptions {
  /** The organization, which is also the namespace private module sources name. */
  organization: string;
  /** The host. Default app.terraform.io; a Terraform Enterprise host otherwise. */
  host?: string;
  /** The variable the token is read from first, in place of `TFE_TOKEN`. */
  tokenEnv?: string;
  /** How long a reveal waits for the version's status to be `ok`. Default {@link HCP_PARSE_WAIT_MS}. */
  waitMs?: number;
  /** How long a reveal waits between reads. Default {@link HCP_POLL_MS}. */
  pollMs?: number;
}

export const HCP_DEFAULT_HOST = "app.terraform.io";
/** How many times a call answered 429 is sent again. */
export const HCP_RATE_RETRIES = 5;
/** The first backoff after a 429 with no `Retry-After`, doubled on each retry. */
export const HCP_BACKOFF_MS = 1000;
export const HCP_PARSE_WAIT_MS = 120_000;
export const HCP_POLL_MS = 2000;

const JSON_API = "application/vnd.api+json";

/** The variables a target names as its credentials: the token variable, and the host's `TF_TOKEN_` form. */
export function hcpTokenEnv(o: Pick<HcpModuleTargetOptions, "tokenEnv" | "host">): string[] {
  const host = o.host ?? HCP_DEFAULT_HOST;
  return [o.tokenEnv ?? "TFE_TOKEN", tokenVariable(host)].filter((v): v is string => !!v);
}

/** The text of a 404 from a create: the two causes HCP's docs give. */
export const hcpNotFoundText = (org: string, host: string): string =>
  `${host} answered 404 for organization ${org}: either the token's team lacks the Manage modules permission, or the organization has no private module registry entitlement`;

/** How long to wait before the next try after a 429: `Retry-After` in seconds or as a date, else the backoff. */
export function retryDelay(retryAfter: string | null, attempt: number, now: number): number {
  if (retryAfter) {
    const secs = Number(retryAfter.trim());
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return HCP_BACKOFF_MS * 2 ** attempt;
}

interface Answer {
  status: number;
  json: unknown;
  text: string;
}

interface ModuleDoc {
  versions: { version: string; status: string }[];
}

export function hcpModuleTarget(options: HcpModuleTargetOptions, deps: ModuleTargetDeps = {}): ModulePublishTarget<"hcp"> {
  const fetch = deps.fetch ?? defaultPublishFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const host = (options.host ?? HCP_DEFAULT_HOST).toLowerCase();
  const org = options.organization;
  const api = `https://${host}/api/v2`;
  const tokenEnv = hcpTokenEnv(options);
  const first = options.tokenEnv ?? "TFE_TOKEN";
  const key = `hcp:${createHash("sha256")
    .update(JSON.stringify({ organization: org, host, tokenEnv: options.tokenEnv ?? null }))
    .digest("hex")
    .slice(0, 16)}`;

  const addressOf = (a: ModuleAddress): ModuleAddress => ({ ...a, namespace: org });
  const sourceOf = (a: ModuleAddress) => `${host}/${org}/${a.name}/${a.system}`;
  const moduleUrl = (a: ModuleAddress) => `${api}/organizations/${encodeURIComponent(org)}/registry-modules/private/${encodeURIComponent(org)}/${encodeURIComponent(a.name)}/${encodeURIComponent(a.system)}`;

  const token = (ctx: Pick<PublishContextBase, "env" | "redactor">): { value: string; from: string } | null => {
    const direct = ctx.env[first];
    const found = direct ? { value: direct, from: first } : (() => {
      const c = terraformCredential(host, { env: ctx.env });
      return c ? { value: c.token, from: c.from } : null;
    })();
    if (found) ctx.redactor.add(found.value);
    return found;
  };
  const needToken = (ctx: Pick<PublishContextBase, "env" | "redactor">) => {
    const t = token(ctx);
    if (!t) {
      throw new PublishTargetError(
        "publish-credentials-missing",
        `no token for ${host}: set ${tokenEnv.join(" or ")}, or a credentials "${host}" block`,
        "Use a team token whose team has the Manage modules permission.",
      );
    }
    return t;
  };

  /** One call, sent again on a 429 up to the limit. `auth` false sends no token (the upload link). */
  const call = async (ctx: Pick<PublishContextBase, "env" | "redactor" | "log">, method: string, url: string, body?: Uint8Array | string, auth = true): Promise<Answer> => {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${needToken(ctx).value}`;
    if (typeof body === "string") headers["content-type"] = JSON_API;
    else if (body) headers["content-type"] = "application/octet-stream";
    if (auth) headers.accept = JSON_API;
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
      } catch (e) {
        throw answerError(ctx, "publish-upload-failed", `${method} ${url.split("?")[0]}: ${(e as Error).message}`);
      }
      const text = await res.text().catch(() => "");
      if (res.status === 429) {
        if (attempt >= HCP_RATE_RETRIES) {
          throw answerError(ctx, "publish-rate-limited", `${host} answered 429 to ${method} ${url.split("?")[0]} ${attempt + 1} times`, "HCP allows 30 requests a second per user; run the publish again later, and it sends only what is missing.");
        }
        const ms = retryDelay(res.headers.get("retry-after"), attempt, now());
        ctx.log(`${host} answered 429; trying again in ${Math.ceil(ms / 1000)}s`);
        await sleep(ms);
        continue;
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    }
  };

  const refusedToken = (ctx: Pick<PublishContextBase, "env" | "redactor">, status: number, what: string): PublishTargetError => {
    const t = token(ctx);
    return answerError(ctx, "publish-credentials-refused", `${host} answered ${status} to ${what}: it refused the token from ${t?.from ?? first}`, "Use a team token whose team has the Manage modules permission.");
  };
  const failed = (ctx: Pick<PublishContextBase, "redactor">, a: Answer, what: string): PublishTargetError =>
    answerError(ctx, "publish-upload-failed", `${host} answered ${a.status} to ${what}: ${a.text.slice(0, 300)}`);

  /** The module's versions and their statuses, or undefined when HCP answers 404. */
  const readModule = async (ctx: Pick<PublishContextBase, "env" | "redactor" | "log">, a: ModuleAddress): Promise<ModuleDoc | undefined> => {
    const res = await call(ctx, "GET", moduleUrl(a));
    if (res.status === 404) return undefined;
    if (res.status === 401 || res.status === 403) throw refusedToken(ctx, res.status, `reading ${sourceOf(a)}`);
    if (res.status !== 200) throw failed(ctx, res, `reading ${sourceOf(a)}`);
    const attrs = (res.json as { data?: { attributes?: Record<string, unknown> } } | null)?.data?.attributes ?? {};
    const raw = Array.isArray(attrs["version-statuses"]) ? (attrs["version-statuses"] as { version?: unknown; status?: unknown }[]) : [];
    return { versions: raw.filter((v) => typeof v.version === "string").map((v) => ({ version: v.version as string, status: typeof v.status === "string" ? v.status : "" })) };
  };

  const versions = async (address: ModuleAddress, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<string[]> => {
    const doc = await readModule({ ...ctx, log: () => {} }, addressOf(address));
    const vs = (doc?.versions ?? []).map((v) => v.version);
    return vs.sort((x, y) => {
      const a = parseSemver(x);
      const b = parseSemver(y);
      return a && b ? compareSemver(a, b) : x.localeCompare(y);
    });
  };

  /** The archive of an `ok` version, read the way Terraform reads it: discovery, download, the tarball. */
  const download = async (ctx: Pick<PublishContextBase, "env" | "redactor">, a: ModuleAddress, version: string): Promise<string> => {
    const t = needToken(ctx);
    const o: RegistryReadOptions = { token: t.value, ...(deps.registryFetch ? { fetch: deps.registryFetch } : {}) };
    try {
      const location = await registryLocation(sourceOf(a), version, o);
      // The location is another host (archivist); the API token is not sent there.
      const bytes = await fetchTarball(location, { credentials: { env: ctx.env }, ...(deps.registryFetch ? { fetch: deps.registryFetch } : {}) });
      return contentDigest(bytes);
    } catch (e) {
      if (e instanceof RegistryError) throw answerError(ctx, "publish-read-failed", e.message.replace(/(https?:\/\/[^\s?]+)\?[^\s)"']*/g, "$1?[query]"));
      throw e;
    }
  };

  const heldIn = async (ctx: Pick<PublishContextBase, "env" | "redactor">, a: ModuleAddress, version: string, doc: ModuleDoc | undefined): Promise<HeldVersion | undefined> => {
    const v = doc?.versions.find((x) => x.version === version);
    if (!v) return undefined;
    if (v.status !== "ok") return { content: "", status: v.status || "unknown" };
    return { content: await download(ctx, a, version) };
  };
  const held = async (address: ModuleAddress, version: string, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<HeldVersion | undefined> => {
    const a = addressOf(address);
    return heldIn(ctx, a, version, await readModule({ ...ctx, log: () => {} }, a));
  };

  const item = (ctx: ModuleVersionContext, present?: boolean): PublishItem => {
    const a = addressOf(ctx.address);
    return { name: `${org}/${a.name}/${a.system} ${ctx.version}`, destination: sourceOf(a), digest: ctx.content, ...(present ? { present: true } : {}) };
  };

  return {
    kind: "hcp",
    name: `HCP Terraform registry (${org})`,
    destination: `${host}/${org}`,
    credentialEnv: tokenEnv,
    key,
    versions,
    held,

    async plan(ctx) {
      checkModuleVersion(ctx);
      needToken(ctx);
      return [item(ctx)];
    },

    async stage(ctx): Promise<StagedTarget> {
      checkModuleVersion(ctx);
      needToken(ctx);
      const a = addressOf(ctx.address);
      const source = sourceOf(a);
      const staged = (present: boolean): StagedTarget => ({ target: "hcp", destination: source, items: [item(ctx, present)], state: { organization: org, host, version: ctx.version } });

      // 1. The module, created only when absent.
      let doc = await readModule(ctx, a);
      if (!doc) {
        const res = await call(ctx, "POST", `${api}/organizations/${encodeURIComponent(org)}/registry-modules`, JSON.stringify({ data: { type: "registry-modules", attributes: { name: a.name, provider: a.system, "registry-name": "private" } } }));
        if (res.status === 404) throw answerError(ctx, "publish-not-found", hcpNotFoundText(org, host), "Give the token's team the Manage modules permission, and check the organization's plan includes the private registry.");
        if (res.status === 401 || res.status === 403) throw refusedToken(ctx, res.status, `creating ${source}`);
        if (res.status === 422) {
          // Another run created it between the read and the create.
          doc = await readModule(ctx, a);
          if (!doc) throw failed(ctx, res, `creating ${source}`);
        } else if (res.status !== 201) throw failed(ctx, res, `creating ${source}`);
        else {
          ctx.log(`created ${source} in the private registry`);
          doc = { versions: [] };
        }
      }

      // A version already there: judged by its content, never sent again.
      const judge = (h: HeldVersion): StagedTarget => {
        if (h.status) {
          throw answerError(
            ctx,
            "publish-version-unfinished",
            `${source} ${ctx.version} is on ${host} with status ${h.status}, so its content can't be read`,
            h.status === "pending" ? "An earlier run created the version and its upload did not finish; delete the version in HCP Terraform's registry and publish again." : "Look at the version in HCP Terraform's registry; delete it and publish again.",
          );
        }
        if (h.content !== ctx.content) throw versionHeldError(source, ctx, h);
        ctx.log(`${source} ${ctx.version} is already on ${host} with this content; nothing sent`);
        return staged(true);
      };
      const before = await heldIn(ctx, a, ctx.version, doc);
      if (before) return judge(before);

      // 2. The version, carrying the revision.
      const created = await call(
        ctx,
        "POST",
        `${moduleUrl(a)}/versions`,
        JSON.stringify({ data: { type: "registry-module-versions", attributes: { version: ctx.version, "commit-sha": ctx.revision || null } } }),
      );
      if (created.status === 404) throw answerError(ctx, "publish-not-found", hcpNotFoundText(org, host), "Give the token's team the Manage modules permission, and check the organization's plan includes the private registry.");
      if (created.status === 401 || created.status === 403) throw refusedToken(ctx, created.status, `creating ${source} ${ctx.version}`);
      if (created.status === 422) {
        const again = await heldIn(ctx, a, ctx.version, await readModule(ctx, a));
        if (again) return judge(again);
        throw failed(ctx, created, `creating ${source} ${ctx.version}`);
      }
      if (created.status !== 201) throw failed(ctx, created, `creating ${source} ${ctx.version}`);
      const upload = (created.json as { data?: { links?: { upload?: unknown } } } | null)?.data?.links?.upload;
      if (typeof upload !== "string" || !upload) throw answerError(ctx, "publish-upload-failed", `${host} created ${source} ${ctx.version} and gave no upload link`);

      // 3. The archive, to the signed upload link, with no token.
      const put = await call(ctx, "PUT", upload, ctx.archive, false);
      if (put.status < 200 || put.status >= 300) {
        throw answerError(
          ctx,
          "publish-upload-failed",
          `the upload of ${source} ${ctx.version} answered ${put.status}: ${put.text.slice(0, 300)}`,
          "The version exists with status pending; delete it in HCP Terraform's registry and publish again.",
        );
      }
      ctx.log(`uploaded ${source} ${ctx.version}`);
      return staged(false);
    },

    async reveal(ctx, staged): Promise<PublishedTarget> {
      const a = addressOf(ctx.address);
      const wait = options.waitMs ?? HCP_PARSE_WAIT_MS;
      const poll = options.pollMs ?? HCP_POLL_MS;
      const start = now();
      for (;;) {
        const doc = await readModule(ctx, a);
        const status = doc?.versions.find((v) => v.version === ctx.version)?.status;
        if (status === "ok") return { target: staged.target, destination: staged.destination, items: staged.items };
        // The docs name pending and ok; a status that says it failed stops the wait, any other keeps it.
        if (status && /error|fail/i.test(status)) {
          throw answerError(ctx, "publish-reveal-failed", `${staged.destination} ${ctx.version} has status ${status} on ${host}, so HCP did not take the archive`, "Look at the version in HCP Terraform's registry; delete it and publish again.");
        }
        if (now() - start >= wait) {
          ctx.log(`${staged.destination} ${ctx.version} is still ${status ?? "not listed"} on ${host} after ${Math.round(wait / 1000)}s; HCP lists it once it has parsed the archive`);
          return { target: staged.target, destination: staged.destination, items: staged.items };
        }
        await sleep(poll);
      }
    },
  };
}

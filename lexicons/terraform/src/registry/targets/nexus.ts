/**
 * A Sonatype Nexus Repository hosted Terraform repository as a module target
 * (chant#4605), from the research on terragucci#1299 and its ruling.
 *
 * Nexus has a Terraform format from 3.88 and hosted Terraform repositories
 * from 3.89, which is this target's floor. The one write is the documented
 * module upload (help.sonatype.com, CLI usage and options):
 *
 *   PUT <url>/repository/<repo>/v1/modules/<namespace>/<name>/<system>/<version>/<name>-<version>.zip
 *
 * with `Content-Type: application/zip`, basic `user:token` credentials
 * (ruling B) and the zip of the attested archive as the body (ruling A,
 * ./zip.ts). The user is `NEXUS_USER` (or the declaration's `user` or
 * `userEnv`) and the token `NEXUS_TOKEN` (or `tokenEnv`), a user token's
 * pass code or the user's password.
 *
 * Nexus has no single registry host to discover from: a consumer declares a
 * CLI `host "<name>"` block mapping `modules.v1` to the repository's
 * `<url>/repository/<repo>/v1/modules/`, and writes
 * `<name>/<namespace>/<name>/<system>`. `nexusHostBlock` gives that block.
 * `versions` and `reveal` read the module the same way, with the block held
 * in memory as the reader's `services` map (ruling C), so no CLI config file
 * is written. The reads send `TF_TOKEN_<nexus host>` when it is set, else the
 * bearer token Nexus 3.95 and later issue at `<repo>/v1/api/token` for the
 * basic credentials, else the basic credentials themselves, which Nexus
 * takes as header authentication before 3.95. Nexus before 3.95 kept a "not
 * found" answer in its cache, so `reveal` waits for the version to be
 * listed, up to `waitMs` (default 30s).
 *
 * `held` GETs the uploaded zip at its path. A chant zip names the attested
 * content in its archive comment, so the same content comes back `present`
 * with nothing sent and other content is refused.
 *
 * Not confirmed by the docs (terragucci#1299): Sonatype's page on creating a
 * Terraform repository says GPG signing is mandatory for hosted repositories
 * and also that it is optional for modules, so what a module upload does on
 * a repository with no signing key is unknown; whether a second upload of a
 * version is refused; whether a hosted repository serves
 * `/.well-known/terraform.json` (this target never asks for it); and the
 * answer shape of the 3.95 token call (this reads a JSON `token` field, else
 * the body as text). Nexus shows no deprecation for a module version, so the
 * bucket catalog carries it.
 */
import { PublishTargetError, type PublishContextBase, type PublishItem, type StagedTarget } from "@intentius/chant/lifecycle/release-publish";
import { terraformCredential } from "@intentius/chant/terraform/credentials";
import { createHash } from "node:crypto";
import { RegistryError, registryLocation, registryVersions, type RegistryReadOptions } from "../reader";
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
import {
  HOSTED_LIST_WAIT_MS,
  HOSTED_POLL_MS,
  defaultRegistryFetch,
  getBytes,
  locationContent,
  needBasicCredential,
  readBasicCredential,
  revealMismatch,
  waitListed,
  writeRefused,
  type BasicCredential,
  type BasicCredentialEnv,
} from "./hosted";
import { heldContentOf, moduleZip } from "./zip";

/** How a Nexus module target is declared. */
export interface NexusModuleTargetOptions {
  /** The Nexus base, such as `https://nexus.example.com`. */
  url: string;
  /** The hosted Terraform repository's name. */
  repo: string;
  /**
   * The label of the consumers' CLI `host` block, which their sources start
   * with. Default: the repository's name, lower-cased. It must be a valid host name.
   */
  host?: string;
  /** The variable the token (a user token's pass code, or the password) is read from. Default `NEXUS_TOKEN`. */
  tokenEnv?: string;
  /** The variable the user name (a user token's name code, or the user) is read from. Default `NEXUS_USER`. */
  userEnv?: string;
  /** The user name, in place of `userEnv`. */
  user?: string;
  /** How long `reveal` waits for Nexus to list the version. Default 30s. */
  waitMs?: number;
  /** How often it asks while it waits. Default 2s. */
  pollMs?: number;
}

export const NEXUS_TOKEN_ENV = "NEXUS_TOKEN";
export const NEXUS_USER_ENV = "NEXUS_USER";
/** The first Nexus release with hosted Terraform repositories. */
export const NEXUS_HOSTED_FLOOR = "3.89.0";
/** The first Nexus release with the bearer token call and the archive and cache fixes the research names. */
export const NEXUS_BEARER_FLOOR = "3.95.0";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The Nexus base, without a trailing slash. */
export function nexusBase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new PublishTargetError("publish-config-invalid", `${url} is not a URL`, "Set url to the Nexus base, such as https://nexus.example.com.");
  }
}

/** The repository's modules.v1 URL, ending in `/`. */
export const nexusModulesUrl = (base: string, repo: string): string => `${base}/repository/${encodeURIComponent(repo)}/v1/modules/`;

/** The upload path of one version's zip. */
export function nexusUploadUrl(base: string, repo: string, a: ModuleAddress, version: string): string {
  const seg = [a.namespace, a.name, a.system, version].map(encodeURIComponent).join("/");
  return `${nexusModulesUrl(base, repo)}${seg}/${encodeURIComponent(`${a.name}-${version}.zip`)}`;
}

/** The label of the consumers' `host` block. */
export function nexusHostLabel(o: Pick<NexusModuleTargetOptions, "repo" | "host">): string {
  const label = (o.host ?? o.repo).toLowerCase();
  if (!HOST_LABEL.test(label)) {
    throw new PublishTargetError("publish-config-invalid", `${JSON.stringify(label)} is not a host name a CLI host block can carry`, "Set the declaration's host to a name of letters, digits and -, such as the repository's name without _.");
  }
  return label;
}

/** The source consumers write for a module in the repository: `<host label>/<namespace>/<name>/<system>`. */
export const nexusSource = (label: string, a: ModuleAddress): string => `${label}/${a.namespace}/${a.name}/${a.system}`;

/** The CLI configuration block a consumer adds so its sources reach the repository. */
export function nexusHostBlock(o: Pick<NexusModuleTargetOptions, "url" | "repo" | "host">): string {
  return `host "${nexusHostLabel(o)}" {\n  services = {\n    "modules.v1" = "${nexusModulesUrl(nexusBase(o.url), o.repo)}"\n  }\n}\n`;
}

export function nexusModuleTarget(options: NexusModuleTargetOptions, deps: ModuleTargetDeps = {}): ModulePublishTarget<"nexus"> {
  const put = deps.fetch ?? defaultPublishFetch;
  const get = deps.registryFetch ?? defaultRegistryFetch;
  const names: BasicCredentialEnv = { tokenEnv: options.tokenEnv ?? NEXUS_TOKEN_ENV, userEnv: options.userEnv ?? NEXUS_USER_ENV, ...(options.user ? { user: options.user } : {}) };
  const wait = {
    waitMs: options.waitMs ?? HOSTED_LIST_WAIT_MS,
    pollMs: options.pollMs ?? HOSTED_POLL_MS,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
  const key = `nexus:${createHash("sha256")
    .update(JSON.stringify({ url: options.url, repo: options.repo, host: options.host ?? null, tokenEnv: names.tokenEnv, userEnv: names.userEnv, user: options.user ?? null }))
    .digest("hex")
    .slice(0, 16)}`;

  const where = () => {
    const base = nexusBase(options.url);
    const label = nexusHostLabel(options);
    return { base, label, nexusHost: new URL(base).host.toLowerCase(), modules: nexusModulesUrl(base, options.repo) };
  };
  const fix = `Use a user token, or a user, that may add and edit components in the repository ${options.repo}.`;
  const needCredential = (ctx: Pick<PublishContextBase, "env" | "redactor">) => needBasicCredential(ctx, names, "Nexus", fix);

  /** The bearer token from Nexus 3.95's token call, per credential; null when the call is not there. */
  const issued = new Map<string, string | null>();
  const issuedToken = async (ctx: Pick<PublishContextBase, "redactor">, basic: BasicCredential): Promise<string | null> => {
    if (issued.has(basic.header)) return issued.get(basic.header)!;
    const { base } = where();
    const url = `${base}/repository/${encodeURIComponent(options.repo)}/v1/api/token`;
    const { status, bytes } = await getBytes(ctx, get, url, basic.header);
    let token: string | null = null;
    if (status >= 200 && status <= 299) {
      const text = Buffer.from(bytes).toString("utf-8").trim();
      try {
        const doc = JSON.parse(text) as { token?: unknown };
        token = typeof doc.token === "string" && doc.token ? doc.token : null;
      } catch {
        token = text || null;
      }
    }
    ctx.redactor.add(token);
    issued.set(basic.header, token);
    return token;
  };

  /** How the reads authenticate: the CLIs' token for the Nexus host, else the issued bearer token, else basic. */
  const readAuth = async (ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<string | undefined> => {
    const { nexusHost } = where();
    const cli = terraformCredential(nexusHost, { env: ctx.env })?.token;
    if (cli) {
      ctx.redactor.add(cli);
      return `Bearer ${cli}`;
    }
    const basic = readBasicCredential(ctx, names);
    if (!basic) return undefined;
    const bearer = await issuedToken(ctx, basic);
    return bearer ? `Bearer ${bearer}` : basic.header;
  };
  const readOptions = async (ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<RegistryReadOptions> => {
    const { label, modules } = where();
    const authorization = await readAuth(ctx);
    return { services: { [label]: modules }, token: false, fetch: get, ...(authorization ? { authorization } : {}) };
  };
  const read = async <T>(ctx: Pick<PublishContextBase, "redactor">, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof RegistryError) throw answerError(ctx, "publish-read-failed", e.message);
      throw e;
    }
  };

  const versions = async (address: ModuleAddress, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<string[]> => {
    const o = await readOptions(ctx);
    return read(ctx, () => registryVersions(nexusSource(where().label, address), o));
  };

  const held = async (address: ModuleAddress, version: string, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<HeldVersion | undefined> => {
    const { base } = where();
    const url = nexusUploadUrl(base, options.repo, address, version);
    const { status, bytes } = await getBytes(ctx, get, url, await readAuth(ctx));
    if (status === 404) return undefined;
    if (status === 401 || status === 403) {
      throw answerError(ctx, "publish-credentials-refused", `Nexus answered ${status} to a read of ${url}`, `Set ${names.userEnv} and ${names.tokenEnv} to a user with read access to ${options.repo}.`);
    }
    if (status < 200 || status > 299) throw answerError(ctx, "publish-read-failed", `Nexus answered ${status} to a read of ${url}`);
    return heldContentOf(bytes, contentDigest);
  };

  const item = (ctx: ModuleVersionContext, present?: boolean): PublishItem => {
    const { label } = where();
    const a = ctx.address;
    return { name: `${a.namespace}/${a.name}/${a.system} ${ctx.version}`, destination: nexusSource(label, a), digest: ctx.content, ...(present ? { present: true } : {}) };
  };

  return {
    kind: "nexus",
    name: "Nexus Terraform repository",
    destination: `${options.url} ${options.repo}`,
    credentialEnv: [names.tokenEnv, ...(options.user ? [] : [names.userEnv])],
    key,
    versions,
    held,

    async plan(ctx) {
      checkModuleVersion(ctx);
      where();
      needCredential(ctx);
      return [item(ctx)];
    },

    async stage(ctx): Promise<StagedTarget> {
      checkModuleVersion(ctx);
      const credential = needCredential(ctx);
      const { base, label } = where();
      const source = nexusSource(label, ctx.address);
      const staged = (present: boolean): StagedTarget => ({ target: "nexus", destination: source, items: [item(ctx, present)], state: { repo: options.repo, url: base, version: ctx.version } });

      const before = await held(ctx.address, ctx.version, ctx);
      if (before) {
        if (before.content !== ctx.content) throw versionHeldError(source, ctx, before);
        ctx.log(`${source} ${ctx.version} is already in ${options.repo} with this content; nothing sent`);
        return staged(true);
      }

      const zip = moduleZip(ctx.archive, ctx.content, ctx.revision);
      const url = nexusUploadUrl(base, options.repo, ctx.address, ctx.version);
      let res: Awaited<ReturnType<typeof put>>;
      try {
        res = await put(url, { method: "PUT", headers: { authorization: credential.header, "content-type": "application/zip" }, body: zip });
      } catch (e) {
        throw answerError(ctx, "publish-upload-failed", `PUT ${url}: ${(e as Error).message}`);
      }
      const text = await res.text().catch(() => "");
      if (res.ok) {
        ctx.log(`uploaded ${source} ${ctx.version} to ${options.repo}`);
        return staged(false);
      }
      if (res.status === 400 || res.status === 403 || res.status === 409) {
        // A deployment policy that refuses a redeploy, or another run uploading first: judge what the repository holds.
        const now = await held(ctx.address, ctx.version, ctx).catch(() => undefined);
        if (now && now.content === ctx.content) return staged(true);
        if (now) throw versionHeldError(source, ctx, now);
      }
      if (res.status === 401 || res.status === 403) throw writeRefused(ctx, "Nexus", res.status, `${source} ${ctx.version}`, credential, names, fix);
      throw answerError(
        ctx,
        "publish-upload-failed",
        `Nexus answered ${res.status} to the upload of ${source} ${ctx.version}: ${text.slice(0, 300)}`,
        `Hosted Terraform repositories need Nexus ${NEXUS_HOSTED_FLOOR} or later; check that ${options.repo} is a hosted Terraform repository with a signing key.`,
      );
    },

    async reveal(ctx, staged) {
      const listed = await waitListed(() => versions(ctx.address, ctx), ctx.version, wait);
      if (!listed) {
        throw answerError(
          ctx,
          "publish-reveal-missing",
          `${staged.destination} lists no ${ctx.version} ${Math.round(wait.waitMs / 1000)}s after the upload`,
          `Nexus before ${NEXUS_BEARER_FLOOR} can keep an earlier "not found" in its cache; run the publish again once it has expired.`,
        );
      }
      const o = await readOptions(ctx);
      const location = await read(ctx, () => registryLocation(staged.destination, ctx.version, o));
      const got = await locationContent(ctx, get, location, where().nexusHost, o.authorization);
      if (got.content !== ctx.content) throw revealMismatch(ctx, staged.destination, ctx.version, got.content, ctx.content);
      return { target: staged.target, destination: staged.destination, items: staged.items };
    },
  };
}

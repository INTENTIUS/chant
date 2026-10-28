/**
 * A JFrog Artifactory Terraform module repository as a module target
 * (chant#4605), from the research on terragucci#1299 and its ruling.
 *
 * The repository is a local Terraform repository (Module/Provider registry
 * type, layout `terraform-module-default`). The one write is the documented
 * deploy (docs.jfrog.com, Terraform repositories):
 *
 *   PUT <url>/<repo>/<namespace>/<name>/<system>/<version>.zip
 *
 * with basic `user:token` credentials, as the docs show them (ruling B), and
 * the zip of the attested archive as the body (ruling A, ./zip.ts). The user
 * is `JFROG_USER` (or the declaration's `user` or `userEnv`) and the token
 * `JFROG_ACCESS_TOKEN` (or `tokenEnv`). `<url>` is the Artifactory base,
 * `https://<host>/artifactory`; a URL with no path gets `/artifactory`.
 *
 * Consumers write `<host>/<repo>__<namespace>/<name>/<system>`: the
 * repository key and the namespace joined by a double underscore. `versions`
 * and `reveal` read that source through the lexicon's registry reader
 * (discovery, versions, download) with `TF_TOKEN_<host>` (chant#4563), else
 * the access token as a bearer token. Artifactory indexes a deploy after
 * the PUT answers, so `reveal` waits for the version to be listed, through
 * the contract's `sleep` and `now`, up to `waitMs` (default 30s), then
 * downloads it from the location the registry gives and checks it is the
 * zip of the attested archive.
 *
 * `held` GETs the zip at its deploy path. A chant zip names the attested
 * content in its archive comment; a version deployed some other way is
 * judged by its own bytes, so it never passes for the release's. A version
 * already there with the same content comes back `present` with nothing
 * sent; with other content it is refused. A 403 or 409 to the PUT (a
 * repository whose deploy policy refuses a redeploy) is judged the same way
 * by reading the version again.
 *
 * Not confirmed by the docs (terragucci#1299): which editions carry
 * Terraform repositories, the PUT's `Content-Type` (this sends
 * `application/zip`), whether a deploy takes a bearer access token in place
 * of basic credentials, and the overwrite rule. Artifactory's Terraform
 * docs show no call to deprecate a module version, so Artifactory shows no
 * deprecation and the bucket catalog carries it.
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
  type BasicCredentialEnv,
} from "./hosted";
import { heldContentOf, moduleZip } from "./zip";

/** How an Artifactory module target is declared. */
export interface ArtifactoryModuleTargetOptions {
  /** The Artifactory base, such as `https://acme.jfrog.io/artifactory`. A URL with no path gets `/artifactory`. */
  url: string;
  /** The local Terraform repository's key, such as `terraform-local`. */
  repo: string;
  /** The variable the access token is read from. Default `JFROG_ACCESS_TOKEN`. */
  tokenEnv?: string;
  /** The variable the user name is read from. Default `JFROG_USER`. */
  userEnv?: string;
  /** The user name, in place of `userEnv`. */
  user?: string;
  /** How long `reveal` waits for Artifactory to list the version. Default 30s. */
  waitMs?: number;
  /** How often it asks while it waits. Default 2s. */
  pollMs?: number;
}

export const ARTIFACTORY_TOKEN_ENV = "JFROG_ACCESS_TOKEN";
export const ARTIFACTORY_USER_ENV = "JFROG_USER";

/** The Artifactory base a target deploys under, without a trailing slash. */
export function artifactoryBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PublishTargetError("publish-config-invalid", `${url} is not a URL`, "Set url to the Artifactory base, such as https://acme.jfrog.io/artifactory.");
  }
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path || "/artifactory"}`;
}

/** The source consumers write for a module in the repository: `<host>/<repo>__<namespace>/<name>/<system>`. */
export const artifactorySource = (host: string, repo: string, a: ModuleAddress): string => `${host}/${repo}__${a.namespace}/${a.name}/${a.system}`;

/** The deploy path of one version's zip. */
export function artifactoryDeployUrl(base: string, repo: string, a: ModuleAddress, version: string): string {
  const seg = [repo, a.namespace, a.name, a.system].map(encodeURIComponent).join("/");
  return `${base}/${seg}/${encodeURIComponent(version)}.zip`;
}

const REPO_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function artifactoryModuleTarget(options: ArtifactoryModuleTargetOptions, deps: ModuleTargetDeps = {}): ModulePublishTarget<"artifactory"> {
  const put = deps.fetch ?? defaultPublishFetch;
  const get = deps.registryFetch ?? defaultRegistryFetch;
  const names: BasicCredentialEnv = { tokenEnv: options.tokenEnv ?? ARTIFACTORY_TOKEN_ENV, userEnv: options.userEnv ?? ARTIFACTORY_USER_ENV, ...(options.user ? { user: options.user } : {}) };
  const wait = {
    waitMs: options.waitMs ?? HOSTED_LIST_WAIT_MS,
    pollMs: options.pollMs ?? HOSTED_POLL_MS,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
  const key = `artifactory:${createHash("sha256")
    .update(JSON.stringify({ url: options.url, repo: options.repo, tokenEnv: names.tokenEnv, userEnv: names.userEnv, user: options.user ?? null }))
    .digest("hex")
    .slice(0, 16)}`;

  const where = () => {
    if (!REPO_KEY.test(options.repo)) throw new PublishTargetError("publish-config-invalid", `${JSON.stringify(options.repo)} is not an Artifactory repository key`);
    const base = artifactoryBase(options.url);
    const u = new URL(base);
    return { base, host: u.host.toLowerCase(), scheme: (u.protocol === "http:" ? "http" : "https") as "http" | "https" };
  };
  const fix = `Use an identity token or API key with Deploy permission on the repository ${options.repo}, with the user it belongs to.`;
  const needCredential = (ctx: Pick<PublishContextBase, "env" | "redactor">) => needBasicCredential(ctx, names, "Artifactory", fix);

  /** The reader's options: the CLIs' token for the host, else the access token as a bearer token. */
  const readOptions = (ctx: Pick<PublishContextBase, "env" | "redactor">): RegistryReadOptions & { host: string } => {
    const { host, scheme } = where();
    const cli = terraformCredential(host, { env: ctx.env });
    const token = cli?.token ?? ctx.env[names.tokenEnv] ?? undefined;
    ctx.redactor.add(token);
    return { host, scheme, token: token || false, fetch: get };
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
    const o = readOptions(ctx);
    return read(ctx, () => registryVersions(artifactorySource(o.host, options.repo, address), o));
  };

  const held = async (address: ModuleAddress, version: string, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<HeldVersion | undefined> => {
    const { base } = where();
    const url = artifactoryDeployUrl(base, options.repo, address, version);
    const basic = readBasicCredential(ctx, names);
    const bearer = readOptions(ctx).token;
    const { status, bytes } = await getBytes(ctx, get, url, basic?.header ?? (bearer ? `Bearer ${bearer}` : undefined));
    if (status === 404) return undefined;
    if (status === 401 || status === 403) {
      throw answerError(ctx, "publish-credentials-refused", `Artifactory answered ${status} to a read of ${url}`, `Set ${names.userEnv} and ${names.tokenEnv} to a user with Read permission on ${options.repo}.`);
    }
    if (status < 200 || status > 299) throw answerError(ctx, "publish-read-failed", `Artifactory answered ${status} to a read of ${url}`);
    return heldContentOf(bytes, contentDigest);
  };

  const item = (ctx: ModuleVersionContext, present?: boolean): PublishItem => {
    const { host } = where();
    return {
      name: `${options.repo}__${ctx.address.namespace}/${ctx.address.name}/${ctx.address.system} ${ctx.version}`,
      destination: artifactorySource(host, options.repo, ctx.address),
      digest: ctx.content,
      ...(present ? { present: true } : {}),
    };
  };

  return {
    kind: "artifactory",
    name: "Artifactory Terraform repository",
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
      const { base, host } = where();
      const source = artifactorySource(host, options.repo, ctx.address);
      const staged = (present: boolean): StagedTarget => ({ target: "artifactory", destination: source, items: [item(ctx, present)], state: { repo: options.repo, host, version: ctx.version } });

      const before = await held(ctx.address, ctx.version, ctx);
      if (before) {
        if (before.content !== ctx.content) throw versionHeldError(source, ctx, before);
        ctx.log(`${source} ${ctx.version} is already in ${options.repo} with this content; nothing sent`);
        return staged(true);
      }

      const zip = moduleZip(ctx.archive, ctx.content, ctx.revision);
      const url = artifactoryDeployUrl(base, options.repo, ctx.address, ctx.version);
      let res: Awaited<ReturnType<typeof put>>;
      try {
        res = await put(url, { method: "PUT", headers: { authorization: credential.header, "content-type": "application/zip" }, body: zip });
      } catch (e) {
        throw answerError(ctx, "publish-upload-failed", `PUT ${url}: ${(e as Error).message}`);
      }
      const text = await res.text().catch(() => "");
      if (res.ok) {
        ctx.log(`deployed ${source} ${ctx.version} to ${options.repo}`);
        return staged(false);
      }
      if (res.status === 403 || res.status === 409) {
        // A deploy policy that refuses a redeploy, or another run deploying first: judge what the repository holds.
        const now = await held(ctx.address, ctx.version, ctx).catch(() => undefined);
        if (now && now.content === ctx.content) return staged(true);
        if (now) throw versionHeldError(source, ctx, now);
      }
      if (res.status === 401 || res.status === 403) throw writeRefused(ctx, "Artifactory", res.status, `${source} ${ctx.version}`, credential, names, fix);
      throw answerError(ctx, "publish-upload-failed", `Artifactory answered ${res.status} to the deploy of ${source} ${ctx.version}: ${text.slice(0, 300)}`);
    },

    async reveal(ctx, staged) {
      const listed = await waitListed(() => versions(ctx.address, ctx), ctx.version, wait);
      if (!listed) {
        throw answerError(
          ctx,
          "publish-reveal-missing",
          `${staged.destination} lists no ${ctx.version} ${Math.round(wait.waitMs / 1000)}s after the deploy`,
          `Artifactory may not have indexed the deploy yet: an admin can run Recalculate Index on ${options.repo}, then run the publish again.`,
        );
      }
      const o = readOptions(ctx);
      const location = await read(ctx, () => registryLocation(staged.destination, ctx.version, o));
      const got = await locationContent(ctx, get, location, o.host, o.token ? `Bearer ${o.token}` : undefined);
      if (got.content !== ctx.content) throw revealMismatch(ctx, staged.destination, ctx.version, got.content, ctx.content);
      return { target: staged.target, destination: staged.destination, items: staged.items };
    },
  };
}

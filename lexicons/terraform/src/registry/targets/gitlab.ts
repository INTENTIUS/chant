/**
 * GitLab's Terraform module registry as a module target (chant#4603).
 *
 * The one write is GitLab's documented upload
 * (docs.gitlab.com/api/packages/terraform-modules/):
 *
 *   PUT /projects/:id/packages/terraform/modules/:name/:system/:version/file
 *
 * with the archive as the body. The token follows chant's forge target
 * (core lifecycle/publish-forge.ts `forgeTokenEnv`): the variable the
 * declaration names, else `GITLAB_TOKEN`, then `CI_JOB_TOKEN`. A job token
 * goes in `JOB-TOKEN` and any other in `PRIVATE-TOKEN`. The API root is the
 * declaration's, else `CI_API_V4_URL`, else gitlab.com's; the project is the
 * declaration's (an id or a full path), else `CI_PROJECT_ID`.
 *
 * GitLab lists a version as soon as it is uploaded, so there is no staging
 * step to hide it: `stage` uploads, and `reveal` reads the version back the
 * way Terraform and OpenTofu do (discovery, versions, download) with the
 * lexicon's registry reader, sending `TF_TOKEN_<host>` (chant#4563), else the
 * upload token, which GitLab also takes as a bearer token on these reads.
 * `held` downloads the version's archive and compares its content digest, so
 * a version holding other content is refused and the same content comes back
 * `present` with nothing sent.
 *
 * GitLab's module API has no call to deprecate a version, so a deprecation
 * stays in the bucket catalog and GitLab shows none. The namespace a GitLab
 * source names is the project's top-level group (`CI_PROJECT_ROOT_NAMESPACE`
 * in CI): the declaration's `namespace`, else the context's.
 */
import { readCredential, type Credential } from "@intentius/chant/lifecycle/publish-credentials";
import { PublishTargetError, type PublishContextBase, type PublishItem, type StagedTarget } from "@intentius/chant/lifecycle/release-publish";
import { terraformCredential } from "@intentius/chant/terraform/credentials";
import { createHash } from "node:crypto";
import { RegistryError, fetchTarball, registryLocation, registryVersions, type RegistryReadOptions } from "../reader";
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

/** How a GitLab module target is declared. Every field is optional in GitLab CI. */
export interface GitlabModuleTargetOptions {
  /** The project the module is uploaded to: its id or its full path. Default `CI_PROJECT_ID`. */
  project?: string;
  /** The API root, such as `https://gitlab.example.com/api/v4`. Default `CI_API_V4_URL`, else gitlab.com's. */
  api?: string;
  /** The variable the token is read from, in place of `GITLAB_TOKEN` then `CI_JOB_TOKEN`. */
  tokenEnv?: string;
  /** The namespace sources name: the project's top-level group. Default: the context's. */
  namespace?: string;
}

export const GITLAB_DEFAULT_API = "https://gitlab.com/api/v4";

/** The variables the upload token is read from, in order. */
export const gitlabTokenEnv = (o: Pick<GitlabModuleTargetOptions, "tokenEnv">): string[] => (o.tokenEnv ? [o.tokenEnv] : ["GITLAB_TOKEN", "CI_JOB_TOKEN"]);

/** The API root a target uploads to, without a trailing slash. */
export const gitlabApi = (o: Pick<GitlabModuleTargetOptions, "api">, env: NodeJS.ProcessEnv): string => (o.api ?? env.CI_API_V4_URL ?? GITLAB_DEFAULT_API).replace(/\/+$/, "");

/** The headers a GitLab token goes in: `JOB-TOKEN` for a CI job token, `PRIVATE-TOKEN` for any other. */
export const gitlabAuthHeader = (token: Credential): Record<string, string> => (token.from === "CI_JOB_TOKEN" ? { "job-token": token.value } : { "private-token": token.value });

/** The upload URL for one version. */
export function gitlabUploadUrl(api: string, project: string, address: Pick<ModuleAddress, "name" | "system">, version: string): string {
  const id = /^\d+$/.test(project) ? project : encodeURIComponent(project);
  return `${api}/projects/${id}/packages/terraform/modules/${encodeURIComponent(address.name)}/${encodeURIComponent(address.system)}/${encodeURIComponent(version)}/file`;
}

/** A signed URL's query (GitLab's download link carries a token in it) cut from a message. */
const withoutQueries = (text: string): string => text.replace(/(https?:\/\/[^\s?]+)\?[^\s)"']*/g, "$1?[query]");

export function gitlabModuleTarget(options: GitlabModuleTargetOptions = {}, deps: ModuleTargetDeps = {}): ModulePublishTarget<"gitlab"> {
  const fetch = deps.fetch ?? defaultPublishFetch;
  const tokenEnv = gitlabTokenEnv(options);
  const key = `gitlab:${createHash("sha256")
    .update(JSON.stringify({ project: options.project ?? null, api: options.api ?? null, tokenEnv: options.tokenEnv ?? null, namespace: options.namespace ?? null }))
    .digest("hex")
    .slice(0, 16)}`;

  const where = (env: NodeJS.ProcessEnv) => {
    const api = gitlabApi(options, env);
    let u: URL;
    try {
      u = new URL(api);
    } catch {
      throw new PublishTargetError("publish-config-invalid", `${api} is not a URL`, "Set the declaration's api, or CI_API_V4_URL, to the API root, such as https://gitlab.example.com/api/v4.");
    }
    return { api, host: u.host.toLowerCase(), scheme: (u.protocol === "http:" ? "http" : "https") as "http" | "https" };
  };
  const addressOf = (address: ModuleAddress): ModuleAddress => ({ ...address, namespace: options.namespace ?? address.namespace });
  const sourceOf = (host: string, a: ModuleAddress) => `${host}/${a.namespace}/${a.name}/${a.system}`;

  const uploadToken = (ctx: Pick<PublishContextBase, "env" | "redactor">): Credential | null => readCredential(ctx.env, tokenEnv, ctx.redactor);
  const needToken = (ctx: Pick<PublishContextBase, "env" | "redactor">): Credential => {
    const t = uploadToken(ctx);
    if (!t) throw answerError(ctx, "publish-credentials-missing", `no GitLab token: set ${tokenEnv.join(" or ")}`, "In GitLab CI the job's CI_JOB_TOKEN can upload to its own project; elsewhere use a token with the api scope.");
    return t;
  };
  const projectOf = (env: NodeJS.ProcessEnv): string => {
    const p = options.project ?? env.CI_PROJECT_ID;
    if (!p) throw new PublishTargetError("publish-config-invalid", "no GitLab project to upload to", "Name the project (its id or full path) in the declaration, or run in GitLab CI, which sets CI_PROJECT_ID.");
    return p;
  };

  /** The reader's options: the CLIs' token for the host, else the upload token. */
  const readOptions = (ctx: Pick<PublishContextBase, "env" | "redactor">): RegistryReadOptions & { host: string } => {
    const { host, scheme } = where(ctx.env);
    const cli = terraformCredential(host, { env: ctx.env });
    const token = cli?.token ?? uploadToken(ctx)?.value;
    ctx.redactor.add(token);
    return { host, scheme, token: token ?? false, ...(deps.registryFetch ? { fetch: deps.registryFetch } : {}) };
  };
  const read = async <T>(ctx: Pick<PublishContextBase, "redactor">, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof RegistryError) throw answerError(ctx, "publish-read-failed", withoutQueries(e.message));
      throw e;
    }
  };

  const versions = async (address: ModuleAddress, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<string[]> => {
    const o = readOptions(ctx);
    return read(ctx, () => registryVersions(sourceOf(o.host, addressOf(address)), o));
  };
  const held = async (address: ModuleAddress, version: string, ctx: Pick<PublishContextBase, "env" | "redactor">): Promise<HeldVersion | undefined> => {
    if (!(await versions(address, ctx)).includes(version)) return undefined;
    const o = readOptions(ctx);
    const source = sourceOf(o.host, addressOf(address));
    return read(ctx, async () => {
      const location = await registryLocation(source, version, o);
      return { content: contentDigest(await fetchTarball(location, o)) };
    });
  };

  const item = (ctx: ModuleVersionContext, present?: boolean): PublishItem => {
    const { host } = where(ctx.env);
    const a = addressOf(ctx.address);
    return { name: `${a.namespace}/${a.name}/${a.system} ${ctx.version}`, destination: sourceOf(host, a), digest: ctx.content, ...(present ? { present: true } : {}) };
  };

  return {
    kind: "gitlab",
    name: "GitLab module registry",
    destination: gitlabApi(options, process.env),
    credentialEnv: tokenEnv,
    key,
    versions,
    held,

    async plan(ctx) {
      checkModuleVersion(ctx);
      needToken(ctx);
      projectOf(ctx.env);
      return [item(ctx)];
    },

    async stage(ctx): Promise<StagedTarget> {
      checkModuleVersion(ctx);
      const token = needToken(ctx);
      const project = projectOf(ctx.env);
      const { api, host } = where(ctx.env);
      const a = addressOf(ctx.address);
      const source = sourceOf(host, a);
      const staged = (present: boolean): StagedTarget => ({ target: "gitlab", destination: source, items: [item(ctx, present)], state: { project, host, version: ctx.version } });

      const before = await held(ctx.address, ctx.version, ctx);
      if (before) {
        if (before.content !== ctx.content) throw versionHeldError(source, ctx, before);
        ctx.log(`${source} ${ctx.version} is already on GitLab with this content; nothing sent`);
        return staged(true);
      }

      const url = gitlabUploadUrl(api, project, a, ctx.version);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(url, { method: "PUT", headers: { ...gitlabAuthHeader(token), "content-type": "application/octet-stream" }, body: ctx.archive });
      } catch (e) {
        throw answerError(ctx, "publish-upload-failed", `PUT ${url}: ${(e as Error).message}`);
      }
      const text = await res.text().catch(() => "");
      if (res.ok) {
        ctx.log(`uploaded ${source} ${ctx.version} to project ${project}`);
        return staged(false);
      }
      if (/already exists/i.test(text)) {
        // Another run uploaded it between the read and the upload: judge what it holds.
        const now = await held(ctx.address, ctx.version, ctx);
        if (now && now.content === ctx.content) return staged(true);
        if (now) throw versionHeldError(source, ctx, now);
      }
      if (res.status === 401 || res.status === 403) {
        throw answerError(
          ctx,
          "publish-credentials-refused",
          `GitLab answered ${res.status} to the upload of ${source} ${ctx.version}: it refused the token in ${token.from}`,
          token.from === "CI_JOB_TOKEN"
            ? "A job token uploads only to its own project; name another project's token in the declaration's tokenEnv."
            : `Give the token in ${token.from} the api scope and at least the Developer role on project ${project}.`,
        );
      }
      throw answerError(ctx, "publish-upload-failed", `GitLab answered ${res.status} to the upload of ${source} ${ctx.version}: ${withoutQueries(text.slice(0, 300))}`);
    },

    async reveal(ctx, staged) {
      const listed = await versions(ctx.address, ctx);
      if (!listed.includes(ctx.version)) {
        throw answerError(ctx, "publish-reveal-missing", `${staged.destination} lists no ${ctx.version} after the upload`, "Check the project's package registry; run the publish again to upload it.");
      }
      const o = readOptions(ctx);
      await read(ctx, () => registryLocation(staged.destination, ctx.version, o));
      return { target: staged.target, destination: staged.destination, items: staged.items };
    },
  };
}

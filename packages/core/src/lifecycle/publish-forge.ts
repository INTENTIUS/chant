/**
 * The forge release-asset target (#4047): files attached to the release a
 * GitHub, GitLab or Forgejo repository has for the release's tag, made when
 * there is none, through each forge's REST API and an injectable `fetch`.
 *
 * The tag is the declaration's `tag`, else the one the cut made
 * (`release/<label>`, or `release/<member>/<label>`), so a release with no
 * label and no declared tag is refused. The forge release is created at the
 * release's commit when the tag has none; GitHub and Forgejo create the tag
 * on the forge then if it was not pushed.
 *
 * - GitHub: `GET /repos/{repo}/releases/tags/{tag}`, else
 *   `POST /repos/{repo}/releases`; each asset is a `POST` to the release's
 *   `upload_url`. An asset of the same name whose `digest` matches is left as
 *   it is; one that differs is refused.
 * - Forgejo: the same paths under its `/api/v1` root, and each asset a
 *   multipart `POST /repos/{repo}/releases/{id}/assets`.
 * - GitLab: `GET /projects/{id}/releases/{tag}`, else
 *   `POST /projects/{id}/releases`; each asset is put in the project's
 *   generic package registry (package `release`, version the label) and
 *   linked to the release.
 *
 * Forgejo and GitLab report no digest for an asset, so one of the same name
 * is refused there (`publish-forge-asset-exists`).
 *
 * The token is read from `tokenEnv`, else `GITHUB_TOKEN`, `GITLAB_TOKEN`
 * then `CI_JOB_TOKEN`, or `FORGEJO_TOKEN`, and is masked in all output.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readCredential, type Credential } from "./publish-credentials";
import type { ForgePublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, memberFile } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget } from "./release-publish";

/** The variables a forge's token is read from, in order. */
export function forgeTokenEnv(decl: Pick<ForgePublishDeclaration, "forge" | "tokenEnv">): string[] {
  if (decl.tokenEnv) return [decl.tokenEnv];
  if (decl.forge === "github") return ["GITHUB_TOKEN"];
  if (decl.forge === "gitlab") return ["GITLAB_TOKEN", "CI_JOB_TOKEN"];
  return ["FORGEJO_TOKEN"];
}

/** The API root a forge is reached at. */
export function forgeApi(decl: Pick<ForgePublishDeclaration, "forge" | "api">, env: NodeJS.ProcessEnv): string | null {
  const root = decl.api ?? (decl.forge === "github" ? (env.GITHUB_API_URL ?? "https://api.github.com") : decl.forge === "gitlab" ? (env.CI_API_V4_URL ?? "https://gitlab.com/api/v4") : (env.GITHUB_API_URL ?? null));
  return root ? root.replace(/\/+$/, "") : null;
}

interface Asset {
  path: string;
  name: string;
  bytes: Uint8Array;
  digest: string;
}

interface ForgeRelease {
  id: string;
  /** Asset names on the release, with the digest the forge reports when it reports one. */
  assets: Map<string, string | null>;
  uploadUrl?: string;
}

class ForgeClient {
  constructor(
    private readonly decl: ForgePublishDeclaration,
    private readonly api: string,
    private readonly token: Credential,
    private readonly fetch: PublishFetch,
    private readonly ctx: PublishContext,
  ) {}

  private headers(): Record<string, string> {
    const t = this.token.value;
    if (this.decl.forge === "github") return { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "user-agent": "chant" };
    if (this.decl.forge === "forgejo") return { authorization: `token ${t}`, accept: "application/json" };
    return this.token.from === "CI_JOB_TOKEN" ? { "job-token": t } : { "private-token": t };
  }

  async call(method: string, url: string, body?: Uint8Array | string, extra: Record<string, string> = {}): Promise<{ status: number; json: unknown; text: string }> {
    const headers = { ...this.headers(), ...(typeof body === "string" ? { "content-type": "application/json" } : {}), ...extra };
    const res = await this.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  fail(what: string, status: number, text: string): never {
    throw new PublishTargetError("publish-forge-failed", this.ctx.redactor.redact(`${what} on ${this.decl.forge} ${this.decl.repo} answered ${status}${text ? `: ${text.slice(0, 300)}` : ""}`));
  }

  private get repoPath(): string {
    return this.decl.forge === "gitlab" ? `${this.api}/projects/${encodeURIComponent(this.decl.repo)}` : `${this.api}/repos/${this.decl.repo}`;
  }

  /** The release for `tag`, created at `commit` when there is none. */
  async release(tag: string, commit: string, name: string): Promise<ForgeRelease> {
    const enc = encodeURIComponent(tag);
    const found = await this.call("GET", this.decl.forge === "gitlab" ? `${this.repoPath}/releases/${enc}` : `${this.repoPath}/releases/tags/${enc}`);
    let body = found.json as Record<string, unknown> | null;
    if (found.status === 404) {
      this.ctx.log(`creating the ${this.decl.forge} release ${tag} at ${commit.slice(0, 12)}`);
      const create =
        this.decl.forge === "gitlab"
          ? await this.call("POST", `${this.repoPath}/releases`, JSON.stringify({ tag_name: tag, ref: commit, name }))
          : await this.call("POST", `${this.repoPath}/releases`, JSON.stringify({ tag_name: tag, target_commitish: commit, name }));
      if (create.status !== 201) this.fail(`creating release ${tag}`, create.status, create.text);
      body = create.json as Record<string, unknown>;
    } else if (found.status !== 200) {
      this.fail(`reading release ${tag}`, found.status, found.text);
    }
    if (!body) this.fail(`reading release ${tag}`, found.status, "with no body");
    const assets = new Map<string, string | null>();
    if (this.decl.forge === "gitlab") {
      const links = ((body.assets as { links?: Array<{ name: string }> } | undefined)?.links ?? []);
      for (const l of links) assets.set(l.name, null);
    } else {
      for (const a of (body.assets as Array<{ name: string; digest?: string | null }> | undefined) ?? []) assets.set(a.name, typeof a.digest === "string" ? a.digest : null);
    }
    return { id: String(body.id ?? body.tag_name ?? tag), assets, ...(typeof body.upload_url === "string" ? { uploadUrl: body.upload_url } : {}) };
  }

  /** Upload one asset to `rel`, returning where it can be downloaded. */
  async upload(rel: ForgeRelease, tag: string, version: string, asset: Asset): Promise<string> {
    if (this.decl.forge === "github") {
      const base = (rel.uploadUrl ?? `${this.repoPath}/releases/${rel.id}/assets`).replace(/\{[^}]*\}$/, "");
      const res = await this.call("POST", `${base}?name=${encodeURIComponent(asset.name)}`, asset.bytes, { "content-type": "application/octet-stream" });
      if (res.status !== 201) this.fail(`uploading ${asset.name}`, res.status, res.text);
      return String((res.json as { browser_download_url?: string } | null)?.browser_download_url ?? asset.name);
    }
    if (this.decl.forge === "forgejo") {
      const boundary = `chant-${bytesDigest(asset.bytes).slice(7, 31)}`;
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${asset.name.replace(/"/g, "")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(Buffer.concat([head, Buffer.from(asset.bytes), tail]));
      const res = await this.call("POST", `${this.repoPath}/releases/${rel.id}/assets?name=${encodeURIComponent(asset.name)}`, body, { "content-type": `multipart/form-data; boundary=${boundary}` });
      if (res.status !== 201) this.fail(`uploading ${asset.name}`, res.status, res.text);
      return String((res.json as { browser_download_url?: string } | null)?.browser_download_url ?? asset.name);
    }
    const url = `${this.repoPath}/packages/generic/release/${encodeURIComponent(version)}/${encodeURIComponent(asset.name)}`;
    const put = await this.call("PUT", url, asset.bytes, { "content-type": "application/octet-stream" });
    if (put.status !== 201 && put.status !== 200) this.fail(`uploading ${asset.name} to the generic package registry`, put.status, put.text);
    const link = await this.call("POST", `${this.repoPath}/releases/${encodeURIComponent(tag)}/assets/links`, JSON.stringify({ name: asset.name, url, link_type: "package" }));
    if (link.status !== 201) this.fail(`linking ${asset.name} to release ${tag}`, link.status, link.text);
    return url;
  }
}

/** A GitLab generic package version: the label with what GitLab refuses replaced. */
export function gitlabPackageVersion(label: string): string {
  return label.replace(/[^0-9A-Za-z.\-_+]/g, "-");
}

export function forgeTarget(decl: ForgePublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const tokenNames = forgeTokenEnv(decl);
  const setup = (ctx: PublishContext) => {
    const tag = decl.tag ?? ctx.releaseTag;
    if (!tag) {
      throw new PublishTargetError("publish-forge-no-tag", `a ${decl.forge} release is named by a tag, and release ${ctx.release.releaseDigest} has no label`, "Cut the release with a label, or set tag in the declaration.");
    }
    const api = forgeApi(decl, ctx.env);
    if (!api) throw new PublishTargetError("publish-forge-no-api", "a Forgejo target needs its API root, and neither api nor GITHUB_API_URL is set", "Set api, such as https://forgejo.example/api/v1.");
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    if (!token) {
      throw new PublishTargetError("publish-credentials-missing", `the ${decl.forge} target reads its token from ${tokenNames.join(" or ")}, and none is set`, `Set ${tokenNames[0]} in the job's or the shell's environment.`);
    }
    const assets: Asset[] = decl.assets.map((p) => {
      const abs = memberFile(ctx.cwd, p);
      const bytes = new Uint8Array(readFileSync(abs));
      const digest = bytesDigest(bytes);
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, p, [digest]);
      return { path: p, name: basename(p), bytes, digest };
    });
    const names = new Set<string>();
    for (const a of assets) {
      if (names.has(a.name)) throw new PublishTargetError("publish-forge-asset-name-taken", `two assets are named ${a.name}, and a release holds one asset per name`);
      names.add(a.name);
    }
    return { tag, api, token, assets };
  };
  const where = (tag: string, name: string) => `${decl.forge} ${decl.repo} release ${tag}, asset ${name}`;
  return {
    kind: "forge",
    name: `${decl.forge} release assets ${decl.repo}`,
    destination: `${decl.forge} ${decl.repo}`,
    credentialEnv: tokenNames,
    async plan(ctx) {
      const { tag, assets } = setup(ctx);
      return assets.map((a) => ({ name: a.path, destination: where(tag, a.name), digest: a.digest }));
    },
    async publish(ctx) {
      const { tag, api, token, assets } = setup(ctx);
      ctx.log(`using the token from ${token.from}`);
      const client = new ForgeClient(decl, api, token, fetchImpl, ctx);
      const rel = await client.release(tag, ctx.release.commit, ctx.label ?? tag);
      const items: PublishItem[] = [];
      for (const a of assets) {
        if (rel.assets.has(a.name)) {
          const theirs = rel.assets.get(a.name);
          if (theirs === a.digest) {
            items.push({ name: a.path, destination: where(tag, a.name), digest: a.digest, present: true });
            ctx.log(`${a.name} is already on release ${tag}`);
            continue;
          }
          throw new PublishTargetError(
            "publish-forge-asset-exists",
            `release ${tag} on ${decl.forge} ${decl.repo} already has an asset named ${a.name}${theirs ? ` with digest ${theirs}, not ${a.digest}` : ", and the forge reports no digest to compare"}${items.length > 0 ? `; ${items.map((i) => i.name).join(", ")} were published before it` : ""}`,
            "Delete the asset on the forge, or cut a new release.",
          );
        }
        ctx.log(`uploading ${a.name} (${a.bytes.byteLength} bytes)`);
        const url = await client.upload(rel, tag, gitlabPackageVersion(ctx.label ?? tag), a);
        items.push({ name: a.path, destination: url, digest: a.digest });
      }
      return { target: this.name, destination: this.destination, items };
    },
  };
}

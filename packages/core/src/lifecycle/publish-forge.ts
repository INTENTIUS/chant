/**
 * The forge release-asset target (#4047): files attached to the release a
 * GitHub, GitLab or Forgejo repository has for the release's tag, through
 * each forge's REST API and an injectable `fetch`.
 *
 * The tag is the declaration's `tag`, else the one the cut made
 * (`release/<label>`, or `release/<member>/<label>`), so a release with no
 * label and no declared tag is refused.
 *
 * A publish is two steps (#4048), so a consumer never sees a release with
 * some of its assets:
 *
 * - GitHub and Forgejo stage on a draft release: the draft for the tag that
 *   `GET /repos/{repo}/releases` lists, else a new one,
 *   `POST /repos/{repo}/releases` with `draft: true` at the release's commit.
 *   GitHub uploads each asset to the draft's `upload_url`, Forgejo with a
 *   multipart `POST /repos/{repo}/releases/{id}/assets`. The reveal publishes
 *   the draft, `PATCH /repos/{repo}/releases/{id}` with `draft: false`, and
 *   the forge creates the tag then if it was not pushed.
 * - GitLab has no draft release, so its stage puts each asset in the
 *   project's generic package registry (package `release`, version the
 *   label) and makes no release. The reveal creates the release at the
 *   commit with a link to each asset, in one `POST /projects/{id}/releases`.
 *
 * An asset already on the draft with the same name is left as it is when
 * its `digest` matches (GitHub), so a stage run again uploads only the rest;
 * one that differs, or one on a forge that reports no digest (Forgejo), is
 * refused (`publish-forge-asset-exists`). A release already published for
 * the tag is refused (`publish-forge-release-published`), since assets
 * uploaded to it would show one at a time, unless it already holds every
 * asset, which is what a publish revealed earlier leaves (on Forgejo and
 * GitLab, which report no digest, by name).
 *
 * The token is read from `tokenEnv`, else `GITHUB_TOKEN`, `GITLAB_TOKEN`
 * then `CI_JOB_TOKEN`, or `FORGEJO_TOKEN`, and is masked in all output.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readCredential, type Credential } from "./publish-credentials";
import type { ForgePublishDeclaration } from "./publish-declaration";
import { bytesDigest, checkReleaseDigest, memberFile, publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

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
  /** True for a GitHub or Forgejo draft, which no consumer sees. */
  draft: boolean;
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

  private toRelease(body: Record<string, unknown>, tag: string): ForgeRelease {
    const assets = new Map<string, string | null>();
    if (this.decl.forge === "gitlab") {
      const links = (body.assets as { links?: Array<{ name: string }> } | undefined)?.links ?? [];
      for (const l of links) assets.set(l.name, null);
    } else {
      for (const a of (body.assets as Array<{ name: string; digest?: string | null }> | undefined) ?? []) assets.set(a.name, typeof a.digest === "string" ? a.digest : null);
    }
    return { id: String(body.id ?? body.tag_name ?? tag), draft: body.draft === true, assets, ...(typeof body.upload_url === "string" ? { uploadUrl: body.upload_url } : {}) };
  }

  /** The published release for `tag`, or null when the forge has none. A draft is not found here. */
  async published(tag: string): Promise<ForgeRelease | null> {
    const enc = encodeURIComponent(tag);
    const found = await this.call("GET", this.decl.forge === "gitlab" ? `${this.repoPath}/releases/${enc}` : `${this.repoPath}/releases/tags/${enc}`);
    if (found.status === 404) return null;
    if (found.status !== 200 || !found.json) this.fail(`reading release ${tag}`, found.status, found.text);
    return this.toRelease(found.json as Record<string, unknown>, tag);
  }

  /** GitHub and Forgejo: the draft release for `tag`, made at `commit` when there is none. */
  async draft(tag: string, commit: string, name: string): Promise<ForgeRelease> {
    const list = await this.call("GET", `${this.repoPath}/releases?per_page=100`);
    if (list.status !== 200) this.fail("listing releases", list.status, list.text);
    const drafts = Array.isArray(list.json) ? (list.json as Array<Record<string, unknown>>) : [];
    const mine = drafts.find((r) => r.draft === true && r.tag_name === tag);
    if (mine) {
      this.ctx.log(`using the draft ${this.decl.forge} release for ${tag}`);
      return this.toRelease(mine, tag);
    }
    this.ctx.log(`creating a draft ${this.decl.forge} release for ${tag} at ${commit.slice(0, 12)}`);
    const create = await this.call("POST", `${this.repoPath}/releases`, JSON.stringify({ tag_name: tag, target_commitish: commit, name, draft: true }));
    if (create.status !== 201 || !create.json) this.fail(`creating a draft release ${tag}`, create.status, create.text);
    return this.toRelease(create.json as Record<string, unknown>, tag);
  }

  /** GitHub and Forgejo: publish the draft `id`. */
  async publishDraft(id: string, tag: string): Promise<void> {
    const res = await this.call("PATCH", `${this.repoPath}/releases/${id}`, JSON.stringify({ draft: false }));
    if (res.status !== 200) this.fail(`publishing the draft release ${tag}`, res.status, res.text);
  }

  /** GitLab: create the release for `tag` at `commit` with a link to each asset. */
  async createWithLinks(tag: string, commit: string, name: string, links: Array<{ name: string; url: string }>): Promise<void> {
    const res = await this.call(
      "POST",
      `${this.repoPath}/releases`,
      JSON.stringify({ tag_name: tag, ref: commit, name, assets: { links: links.map((l) => ({ ...l, link_type: "package" })) } }),
    );
    if (res.status !== 201) this.fail(`creating release ${tag}`, res.status, res.text);
  }

  /** Upload one asset to `rel`, returning where it can be downloaded. */
  async upload(rel: ForgeRelease | null, version: string, asset: Asset): Promise<string> {
    if (this.decl.forge === "github") {
      const base = (rel?.uploadUrl ?? `${this.repoPath}/releases/${rel?.id}/assets`).replace(/\{[^}]*\}$/, "");
      const res = await this.call("POST", `${base}?name=${encodeURIComponent(asset.name)}`, asset.bytes, { "content-type": "application/octet-stream" });
      if (res.status !== 201) this.fail(`uploading ${asset.name}`, res.status, res.text);
      return String((res.json as { browser_download_url?: string } | null)?.browser_download_url ?? asset.name);
    }
    if (this.decl.forge === "forgejo") {
      const boundary = `chant-${bytesDigest(asset.bytes).slice(7, 31)}`;
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${asset.name.replace(/"/g, "")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = new Uint8Array(Buffer.concat([head, Buffer.from(asset.bytes), tail]));
      const res = await this.call("POST", `${this.repoPath}/releases/${rel?.id}/assets?name=${encodeURIComponent(asset.name)}`, body, { "content-type": `multipart/form-data; boundary=${boundary}` });
      if (res.status !== 201) this.fail(`uploading ${asset.name}`, res.status, res.text);
      return String((res.json as { browser_download_url?: string } | null)?.browser_download_url ?? asset.name);
    }
    const url = `${this.repoPath}/packages/generic/release/${encodeURIComponent(version)}/${encodeURIComponent(asset.name)}`;
    const put = await this.call("PUT", url, asset.bytes, { "content-type": "application/octet-stream" });
    if (put.status !== 201 && put.status !== 200) this.fail(`uploading ${asset.name} to the generic package registry`, put.status, put.text);
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
  const exists = (tag: string, a: Asset, theirs: string | null | undefined, before: PublishItem[]) =>
    new PublishTargetError(
      "publish-forge-asset-exists",
      `release ${tag} on ${decl.forge} ${decl.repo} already has an asset named ${a.name}${theirs ? ` with digest ${theirs}, not ${a.digest}` : ", and the forge reports no digest to compare"}${before.length > 0 ? `; ${before.map((i) => i.name).join(", ")} were staged before it` : ""}`,
      "Delete the asset on the forge, or cut a new release.",
    );
  return {
    kind: "forge",
    name: `${decl.forge} release assets ${decl.repo}`,
    destination: `${decl.forge} ${decl.repo}`,
    credentialEnv: tokenNames,
    key: publishTargetKey(decl),
    async plan(ctx) {
      const { tag, assets } = setup(ctx);
      return assets.map((a) => ({ name: a.path, destination: where(tag, a.name), digest: a.digest }));
    },
    async stage(ctx): Promise<StagedTarget> {
      const { tag, api, token, assets } = setup(ctx);
      ctx.log(`using the token from ${token.from}`);
      const client = new ForgeClient(decl, api, token, fetchImpl, ctx);
      const done = (items: PublishItem[], state: Record<string, string>): StagedTarget => ({ target: this.name, destination: this.destination, items, state });

      // A release already published: done when it holds every asset, else refused, since uploads to it would show one at a time.
      const published = await client.published(tag);
      if (published) {
        const items: PublishItem[] = [];
        for (const a of assets) {
          if (!published.assets.has(a.name)) {
            throw new PublishTargetError(
              "publish-forge-release-published",
              `release ${tag} on ${decl.forge} ${decl.repo} is already published without ${a.name}, so the assets uploaded to it would show one at a time`,
              "Delete the forge release so the publish makes it whole, or set tag in the declaration to a tag with no release.",
            );
          }
          const theirs = published.assets.get(a.name);
          if (theirs !== a.digest && !(decl.forge !== "github" && theirs === null)) throw exists(tag, a, theirs, items);
          items.push({ name: a.path, destination: where(tag, a.name), digest: a.digest, present: true });
        }
        ctx.log(`release ${tag} is already published with every asset`);
        return done(items, { published: "true" });
      }

      const version = gitlabPackageVersion(ctx.label ?? tag);
      if (decl.forge === "gitlab") {
        // No draft on GitLab: the assets go to the package registry, and the release is made at the reveal.
        const items: PublishItem[] = [];
        for (const a of assets) {
          ctx.log(`uploading ${a.name} (${a.bytes.byteLength} bytes) to the generic package registry`);
          items.push({ name: a.path, destination: await client.upload(null, version, a), digest: a.digest });
        }
        return done(items, {});
      }

      const rel = await client.draft(tag, ctx.release.commit, ctx.label ?? tag);
      const items: PublishItem[] = [];
      for (const a of assets) {
        if (rel.assets.has(a.name)) {
          const theirs = rel.assets.get(a.name);
          if (theirs !== a.digest) throw exists(tag, a, theirs, items);
          items.push({ name: a.path, destination: where(tag, a.name), digest: a.digest, present: true });
          ctx.log(`${a.name} is already on the draft release ${tag}`);
          continue;
        }
        ctx.log(`uploading ${a.name} (${a.bytes.byteLength} bytes) to the draft`);
        items.push({ name: a.path, destination: await client.upload(rel, version, a), digest: a.digest });
      }
      return done(items, { releaseId: rel.id });
    },
    async reveal(ctx, staged) {
      const { tag, api, token } = setup(ctx);
      const client = new ForgeClient(decl, api, token, fetchImpl, ctx);
      const items = staged.items.map((i) => ({ name: i.name, destination: i.destination, ...(i.digest ? { digest: i.digest } : {}) }));
      if (staged.state.published === "true") return { target: this.name, destination: this.destination, items: items.map((i) => ({ ...i, present: true })) };
      if (decl.forge === "gitlab") {
        ctx.log(`creating the gitlab release ${tag} at ${ctx.release.commit.slice(0, 12)} with ${items.length} asset link(s)`);
        await client.createWithLinks(tag, ctx.release.commit, ctx.label ?? tag, items.map((i) => ({ name: basename(i.name), url: i.destination })));
      } else {
        const id = staged.state.releaseId;
        if (!id) throw new PublishTargetError("publish-forge-failed", `the staged ${decl.forge} release for ${tag} has no draft id to publish`);
        ctx.log(`publishing the draft ${decl.forge} release ${tag}`);
        await client.publishDraft(id, tag);
      }
      return { target: this.name, destination: this.destination, items };
    },
  };
}

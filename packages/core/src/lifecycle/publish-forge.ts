/**
 * The forge release-asset target (#4047): files attached to the release a
 * GitHub, GitLab or Forgejo repository has for the release's tag, through
 * each forge's REST API and an injectable `fetch`.
 *
 * The tag is the declaration's `tag`, else the one the cut made
 * (`release.tag`, #5150; `release/<label>` or `release/<member>/<label>`
 * when unset), so a release with no
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
 *   the forge creates the tag then if it was not pushed. On GitHub, a
 *   declared `latest` goes in the same request as `make_latest` (#4676), so
 *   the release becomes the repository's latest, or doesn't, as it appears.
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
 * With the declared assets the stage attaches two more files (#4049): the
 * SBOM (the file `sbom` names, else `sbom.spdx.json` written from the
 * member's lockfile) and `release.intoto.json`, the release's provenance
 * statement over the assets' digests, which carries the cut's signature
 * (./publish-attachments.ts). They go on the draft with the assets, so
 * nothing is visible before they are attached.
 *
 * The release's notes (#4658, #5153) are a section of a file in the member,
 * notes generated for the release, or both, between `before` and `after`.
 * Generated notes are the forge's own (GitHub's `generate-notes`, GitLab's
 * changelog API) or chant's, from the conventional commits in the member
 * since its previous release. The stage decides them: the draft is made
 * with them, or edited to them when it already exists, and they are kept in
 * the publish record, so the reveal publishes what the draft showed, and a
 * resumed reveal does not ask the forge again.
 *
 * When the publish signs (#5164, ./publish-signing.ts), the stage also
 * uploads `<file>.sigstore.json` beside each file and
 * `release.slsa.sigstore.json`, SLSA provenance over the declared assets. A
 * bundle already on the draft is kept, since signing again gives other bytes.
 *
 * The token is read from `tokenEnv`, else `GITHUB_TOKEN`, `GITLAB_TOKEN`
 * then `CI_JOB_TOKEN`, or `FORGEJO_TOKEN`, and is masked in all output.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { memberSbom, releaseProvenance } from "./publish-attachments";
import { SIGSTORE_BUNDLE_SUFFIX, SLSA_BUNDLE_FILE, SLSA_PROVENANCE_PREDICATE, slsaProvenanceStatement } from "./publish-signing";
import { releaseVersion } from "./publish-homebrew";
import { readCredential, type Credential } from "./publish-credentials";
import type { ForgePublishDeclaration } from "./publish-declaration";
import { NEXT_RELEASE } from "../release-floors";
import { changelogNotes, type ChangelogCommit } from "./release-changelog";
import { bytesDigest, checkReleaseDigest, expandArtifactAssets, memberFile, publishTargetKey } from "./publish-targets";
import { trainName, waitUntilServed } from "./publish-train-names";
import { PublishTargetError, type PublishContext, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget, type StatusAction, type StatusContext } from "./release-publish";
import { prereleaseOf } from "./release-prerelease";

/** The first chant that reads `latest` on a forge target and sends it as GitHub's `make_latest` (#4676). */
export const PUBLISH_FORGE_LATEST_FLOOR = "0.124.63";

/** The first chant whose forge target reads `notes` and may have no assets (#4658). Products feature-detect on it. */
export const PUBLISH_FORGE_NOTES_FLOOR = "0.124.71";

/** The first chant whose forge target generates notes, `notes.generate` (#5153). Products feature-detect on it. */
export const PUBLISH_FORGE_GENERATED_NOTES_FLOOR = "0.124.101";

/** The first chant whose forge target's notes from commits take `exclude` and `nonConventional` (#5270). */
export const PUBLISH_FORGE_NOTES_EXCLUDE_FLOOR = NEXT_RELEASE;

/** `text` with `{label}`, `{version}` and `{tag}` filled in. */
function fillNotesText(text: string, values: { label: string; version: string; tag: string }): string {
  return text.replaceAll("{label}", values.label).replaceAll("{version}", values.version).replaceAll("{tag}", values.tag);
}

/**
 * The section of `page` that starts at the heading `heading` names (#4658),
 * up to the next heading of the same level or higher, trimmed. A heading
 * matches when it is the pattern, or the pattern and then whitespace, so
 * `## [1.2.3] - 2026-11-07` matches `## [1.2.3]`, and neither `## 1.2.30`
 * nor `## 1.2.3-rc.1` matches `## 1.2.3`. Links that start with `/` are
 * made absolute against `linkBase`. Throws when there is no such heading or
 * the section is empty.
 */
export function releaseNotesSection(page: string, heading: string, linkBase?: string): string {
  const level = /^(#+)/.exec(heading)![1]!.length;
  const lines = page.split("\n");
  const matches = (l: string): boolean => {
    const t = l.trimEnd();
    return t === heading || (t.startsWith(heading) && /^\s/.test(t.slice(heading.length)));
  };
  const start = lines.findIndex(matches);
  if (start < 0) throw new Error(`it has no heading "${heading}"`);
  // A `#` line inside a fenced code block is code, not a heading.
  let end = lines.length;
  let fence: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const f = /^\s*(```|~~~)/.exec(lines[i]!);
    if (f) fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
    if (fence !== null || f) continue;
    const m = /^(#{1,6}) /.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) throw new Error(`its "${heading}" section is empty`);
  if (!linkBase) return body;
  const base = linkBase.replace(/\/+$/, "");
  return body.replace(/\]\((\/(?!\/)[^)\s]*)/g, (_, path: string) => `](${base}${path}`);
}

/**
 * The section of the notes file a forge target names, for `values`, or
 * undefined when its notes name no file. Throws `publish-forge-notes-missing`
 * when the file or the heading is not there. The publish plans with it, and
 * the cut checks with it before it tags (#5319).
 */
function forgeNotesFileSection(decl: ForgePublishDeclaration, cwd: string, values: { label: string; version: string; tag: string }): string | undefined {
  const n = decl.notes;
  if (!n?.file || !n.heading) return undefined;
  const heading = fillNotesText(n.heading, values);
  try {
    return releaseNotesSection(readFileSync(memberFile(cwd, n.file), "utf8"), heading, n.linkBase);
  } catch (err) {
    const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "it does not exist" : (err as Error).message;
    throw new PublishTargetError("publish-forge-notes-missing", `the ${decl.forge} release's notes come from ${n.file}, and ${why}`, `Write the "${heading}" section in ${n.file}, or change notes.heading.`);
  }
}

/**
 * Refuses a cut of `label` when a forge target's notes name a file with no
 * section for it (#5319). Run by the cut before anything is recorded or
 * tagged, and by the train cut for each member. `tagOf` gives the tag the cut
 * will make for the label, which a heading may name as `{tag}`.
 */
export function checkForgeNotesFiles(decls: ReadonlyArray<{ type: string }>, cwd: string, label: string, tagOf: (label: string) => string): void {
  for (const d of decls) {
    if (d.type !== "forge") continue;
    const decl = d as ForgePublishDeclaration;
    if (!decl.notes?.file) continue;
    forgeNotesFileSection(decl, cwd, { label, version: releaseVersion(label) ?? label, tag: decl.tag ?? tagOf(label) });
  }
}

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
  /** Set on the SBOM and the provenance statement chant attaches (#4049). */
  attachment?: "sbom" | "provenance";
}

/** A Sigstore bundle the stage signs and uploads beside the files (#5164). */
interface PlannedSignature {
  name: string;
  attachment: "signature" | "attestation";
  signs: Array<{ name: string; digest: string }>;
  predicateType?: string;
  make(): Promise<Uint8Array>;
}

interface ForgeRelease {
  id: string;
  /** True for a GitHub or Forgejo draft, which no consumer sees. */
  draft: boolean;
  /** True for a GitHub or Forgejo prerelease. */
  prerelease?: boolean;
  /** Asset names on the release, with the digest the forge reports when it reports one. */
  assets: Map<string, string | null>;
  uploadUrl?: string;
  /** The release's page (`html_url`), which a draft's verify commands get as `CHANT_STAGED_RELEASE_URL` (#5157). */
  url?: string;
  /** GitHub and Forgejo: the release's notes as the forge holds them. */
  body?: string;
}

class ForgeClient {
  constructor(
    private readonly decl: ForgePublishDeclaration,
    private readonly api: string,
    private readonly token: Credential,
    private readonly fetch: PublishFetch,
    private readonly ctx: PublishContextBase,
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
    return {
      id: String(body.id ?? body.tag_name ?? tag),
      draft: body.draft === true,
      prerelease: body.prerelease === true,
      assets,
      ...(typeof body.upload_url === "string" ? { uploadUrl: body.upload_url } : {}),
      ...(typeof body.html_url === "string" ? { url: body.html_url } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
    };
  }

  /** The published release for `tag`, or null when the forge has none. A draft is not found here. */
  async published(tag: string): Promise<ForgeRelease | null> {
    const enc = encodeURIComponent(tag);
    const found = await this.call("GET", this.decl.forge === "gitlab" ? `${this.repoPath}/releases/${enc}` : `${this.repoPath}/releases/tags/${enc}`);
    if (found.status === 404) return null;
    if (found.status !== 200 || !found.json) this.fail(`reading release ${tag}`, found.status, found.text);
    return this.toRelease(found.json as Record<string, unknown>, tag);
  }

  /** GitHub and Forgejo: the draft release for `tag`, or null (#5163). */
  async draftFor(tag: string): Promise<ForgeRelease | null> {
    const list = await this.call("GET", `${this.repoPath}/releases?per_page=100`);
    if (list.status !== 200) this.fail("listing releases", list.status, list.text);
    const found = (Array.isArray(list.json) ? (list.json as Array<Record<string, unknown>>) : []).find((r) => r.draft === true && r.tag_name === tag);
    return found ? this.toRelease(found, tag) : null;
  }

  /** GitHub and Forgejo: change the release `id` (#5163): `prerelease`, `draft`, GitHub's `make_latest`. */
  async edit(id: string, tag: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.call("PATCH", `${this.repoPath}/releases/${id}`, JSON.stringify(body));
    if (res.status !== 200) this.fail(`changing release ${tag}`, res.status, res.text);
  }

  /** Delete the release for `tag` (#5163). Its tag and, on GitLab, its packages stay. */
  async remove(rel: ForgeRelease, tag: string): Promise<void> {
    const url = this.decl.forge === "gitlab" ? `${this.repoPath}/releases/${encodeURIComponent(tag)}` : `${this.repoPath}/releases/${rel.id}`;
    const res = await this.call("DELETE", url);
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) this.fail(`deleting release ${tag}`, res.status, res.text);
  }

  /** GitHub and Forgejo: the draft release for `tag`, made at `commit` when there is none. */
  async draft(tag: string, commit: string, name: string, body?: string): Promise<ForgeRelease> {
    const list = await this.call("GET", `${this.repoPath}/releases?per_page=100`);
    if (list.status !== 200) this.fail("listing releases", list.status, list.text);
    const drafts = Array.isArray(list.json) ? (list.json as Array<Record<string, unknown>>) : [];
    const mine = drafts.find((r) => r.draft === true && r.tag_name === tag);
    if (mine) {
      this.ctx.log(`using the draft ${this.decl.forge} release for ${tag}`);
      const rel = this.toRelease(mine, tag);
      // #5153: the draft shows the notes the reveal will publish, so a draft made by an earlier stage gets them too.
      if (body !== undefined && (rel.body ?? "") !== body) {
        this.ctx.log(`setting the notes of the draft ${this.decl.forge} release for ${tag}`);
        const edit = await this.call("PATCH", `${this.repoPath}/releases/${rel.id}`, JSON.stringify({ body }));
        if (edit.status !== 200) this.fail(`setting the notes of the draft release ${tag}`, edit.status, edit.text);
        rel.body = body;
      }
      return rel;
    }
    this.ctx.log(`creating a draft ${this.decl.forge} release for ${tag} at ${commit.slice(0, 12)}`);
    const create = await this.call("POST", `${this.repoPath}/releases`, JSON.stringify({ tag_name: tag, target_commitish: commit, name, draft: true, ...(body !== undefined ? { body } : {}) }));
    if (create.status !== 201 || !create.json) this.fail(`creating a draft release ${tag}`, create.status, create.text);
    return this.toRelease(create.json as Record<string, unknown>, tag);
  }

  /**
   * GitHub and Forgejo: publish the draft `id` with its notes. GitHub gets
   * `make_latest`: the declared `latest`, else `false` for a release cut to a
   * channel and `true` for any other (#4658). A release whose label is a
   * semver prerelease is marked a prerelease, on GitHub too, and is never
   * latest. Forgejo has no latest setting and takes the newest release that
   * is not a prerelease, so a channel's release is marked a prerelease there.
   */
  async publishDraft(id: string, tag: string, o: { notes?: string; channel: boolean; prerelease?: boolean }): Promise<void> {
    const body: Record<string, unknown> = { draft: false, ...(o.notes !== undefined ? { body: o.notes } : {}) };
    if (this.decl.forge === "github") {
      body.make_latest = o.prerelease ? "false" : String(this.decl.latest ?? !o.channel);
      if (o.prerelease) body.prerelease = true;
    } else if (o.channel || o.prerelease) body.prerelease = true;
    const res = await this.call("PATCH", `${this.repoPath}/releases/${id}`, JSON.stringify(body));
    if (res.status !== 200) this.fail(`publishing the draft release ${tag}`, res.status, res.text);
  }

  /**
   * The forge's own notes for `tag` at `commit` (#5153): GitHub's
   * `POST /repos/{repo}/releases/generate-notes`, since `previousTag` when
   * one is known, else since the release GitHub picks; GitLab's
   * `GET /projects/{id}/repository/changelog`, from the `Changelog:`
   * trailers of the commits since `previousCommit`.
   */
  async generatedNotes(tag: string, commit: string, version: string, previous: { tag: string | null; commit: string } | null): Promise<string> {
    if (this.decl.forge === "gitlab") {
      const q = new URLSearchParams({ version, to: commit, ...(previous ? { from: previous.commit } : {}) });
      const res = await this.call("GET", `${this.repoPath}/repository/changelog?${q.toString()}`);
      if (res.status !== 200) this.fail(`generating the changelog for ${tag}`, res.status, res.text);
      return String((res.json as { notes?: unknown } | null)?.notes ?? "").trim();
    }
    const res = await this.call("POST", `${this.repoPath}/releases/generate-notes`, JSON.stringify({ tag_name: tag, target_commitish: commit, ...(previous?.tag ? { previous_tag_name: previous.tag } : {}) }));
    if (res.status !== 200) this.fail(`generating the notes for ${tag}`, res.status, res.text);
    return String((res.json as { body?: unknown } | null)?.body ?? "").trim();
  }

  /** GitLab: create the release for `tag` at `commit` with a link to each asset. */
  async createWithLinks(tag: string, commit: string, name: string, links: Array<{ name: string; url: string }>, notes?: string): Promise<void> {
    const res = await this.call(
      "POST",
      `${this.repoPath}/releases`,
      JSON.stringify({ tag_name: tag, ref: commit, name, ...(notes !== undefined ? { description: notes } : {}), assets: { links: links.map((l) => ({ ...l, link_type: "package" })) } }),
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

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * The member's previous release (#5153): the release of it cut from the
 * nearest ancestor of this release's commit, as the cut finds it, with its
 * label. Null for the member's first release. Refuses when the history the
 * notes are generated from is not in the checkout.
 */
export async function previousMemberRelease(ctx: Pick<PublishContext, "cwd" | "release">, forge: string): Promise<{ commit: string; label: string | null } | null> {
  const top = git(ctx.cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) {
    throw new PublishTargetError("publish-forge-notes-history", `the ${forge} release's notes are generated from the history since the member's previous release, and ${ctx.cwd} is not in a git checkout`, "Publish from a checkout of the release's commit.");
  }
  if (git(ctx.cwd, ["rev-parse", "--is-shallow-repository"])?.trim() === "true") {
    throw new PublishTargetError(
      "publish-forge-notes-history",
      `the ${forge} release's notes are generated from the history since the member's previous release, and this checkout is shallow`,
      "Check out the full history: fetch-depth: 0 on actions/checkout, GIT_DEPTH: 0 on GitLab.",
    );
  }
  const { previousRelease } = await import("./release-cut");
  const { readCuts, labelsByDigest } = await import("./release-store");
  const prev = await previousRelease(top, ctx.release.commit, ctx.cwd);
  if (!prev) return null;
  return { commit: prev.commit, label: labelsByDigest((await readCuts({ cwd: ctx.cwd })).cuts).get(prev.releaseDigest) ?? null };
}

/**
 * The tag the member's previous release has (#5150): its label through
 * `release.tag`. A context that does not carry the template reads it off
 * this release's tag, as the label's suffix, or not at all.
 */
export function previousReleaseTag(ctx: Pick<PublishContext, "label" | "releaseTag" | "releaseTagOf">, label: string): string | null {
  if (ctx.releaseTagOf) return ctx.releaseTagOf(label);
  return ctx.label !== null && ctx.releaseTag?.endsWith(ctx.label) ? `${ctx.releaseTag.slice(0, -ctx.label.length)}${label}` : null;
}

/** The commits in the member's directory after `from` (all of them when null) up to the release's commit, newest first, merges left out. */
export function memberCommits(ctx: Pick<PublishContext, "cwd" | "release">, from: string | null, forge: string): ChangelogCommit[] {
  const range = from ? `${from}..${ctx.release.commit}` : ctx.release.commit;
  const out = git(ctx.cwd, ["log", "--no-merges", "--format=%H%x00%B%x1e", range, "--", "."]);
  if (out === null) {
    throw new PublishTargetError("publish-forge-notes-history", `the ${forge} release's notes are generated from the commits ${range}, and git could not list them here`, "Publish from a full checkout that holds the release's commit.");
  }
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.includes("\0"))
    .map((r) => {
      const [sha, message] = r.split("\0") as [string, string];
      return { sha, message: message.trim() };
    });
}

/**
 * Notes from the intent files the release's cuts consumed (#5159), read at
 * the release's commit: their summaries, the highest level first. Empty
 * when the cuts consumed none. A file the commit does not hold, or that
 * can't be read, is left out.
 */
export async function consumedIntentNotes(ctx: Pick<PublishContext, "cwd" | "release">): Promise<string> {
  const { readCuts } = await import("./release-store");
  const { parseIntent, intentNotes } = await import("./release-intents");
  const consumed = (await readCuts({ cwd: ctx.cwd })).cuts.filter((c) => c.releaseDigest === ctx.release.releaseDigest).flatMap((c) => c.intents ?? []);
  if (consumed.length === 0) return "";
  const top = git(ctx.cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return "";
  const read: Array<{ bump: "major" | "minor" | "patch"; summary: string }> = [];
  for (const i of consumed) {
    const text = git(top, ["show", `${ctx.release.commit}:${i.path}`]);
    if (text === null) continue;
    try {
      read.push({ bump: i.bump, summary: parseIntent(i.path, text).summary });
    } catch {
      // A file that can't be read gives no note; the cut read it when it consumed it.
    }
  }
  return intentNotes(read);
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
    if (decl.latest !== undefined && decl.forge !== "github") {
      throw new PublishTargetError("publish-forge-latest-unsupported", `latest is GitHub's make_latest, and ${decl.forge} has no setting for which release is latest`, "Remove latest from the declaration.");
    }
    const api = forgeApi(decl, ctx.env);
    if (!api) throw new PublishTargetError("publish-forge-no-api", "a Forgejo target needs its API root, and neither api nor GITHUB_API_URL is set", "Set api, such as https://forgejo.example/api/v1.");
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    if (!token) {
      throw new PublishTargetError("publish-credentials-missing", `the ${decl.forge} target reads its token from ${tokenNames.join(" or ")}, and none is set`, `Set ${tokenNames[0]} in the job's or the shell's environment.`);
    }
    const assets: Asset[] = expandArtifactAssets(ctx.release, decl.assets).map((p) => {
      const abs = memberFile(ctx.cwd, p);
      const bytes = new Uint8Array(readFileSync(abs));
      const digest = bytesDigest(bytes);
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, p, [digest]);
      return { path: p, name: basename(p), bytes, digest };
    });
    // #4049: the SBOM and the provenance statement over the assets go on the release with them. A release of notes alone has no asset to state.
    const sbom = memberSbom(ctx, decl.sbom, `${decl.repo}@${tag}`, `the ${decl.forge} target`);
    const provenance =
      assets.length > 0
        ? releaseProvenance(
            ctx,
            assets.map((a) => ({ name: a.name, digest: a.digest })),
          )
        : null;
    const declared = assets.map((a) => ({ name: a.name, digest: a.digest }));
    for (const a of [sbom, provenance]) if (a) assets.push({ path: a.name, name: a.name, bytes: a.bytes, digest: a.digest, attachment: a.kind });
    // #5164: a bundle beside each file, and SLSA provenance over the declared assets, signed in the stage.
    const signing = ctx.signing;
    const signatures: PlannedSignature[] = signing
      ? [
          ...assets.map((a) => ({ name: `${a.name}${SIGSTORE_BUNDLE_SUFFIX}`, attachment: "signature" as const, signs: [{ name: a.name, digest: a.digest }], make: () => signing.signer.signBlob(a.bytes, a.name) })),
          ...(declared.length > 0
            ? [{ name: SLSA_BUNDLE_FILE, attachment: "attestation" as const, signs: declared, predicateType: SLSA_PROVENANCE_PREDICATE, make: () => signing.signer.signStatement(slsaProvenanceStatement(ctx, declared)) }]
            : []),
        ]
      : [];
    const names = new Set<string>();
    for (const n of [...assets.map((a) => a.name), ...signatures.map((x) => x.name)]) {
      if (names.has(n)) throw new PublishTargetError("publish-forge-asset-name-taken", `two assets are named ${n}, and a release holds one asset per name`);
      names.add(n);
    }
    return { tag, api, token, assets, signatures, section: notesSection(ctx, tag) };
  };
  // #4658: the file's section is read when the target is planned, so a missing or empty section refuses before any target publishes.
  const notesSection = (ctx: PublishContext, tag: string): string | undefined => {
    const n = decl.notes;
    if (n?.generate === "forge" && decl.forge === "forgejo") {
      throw new PublishTargetError(
        "publish-forge-notes-unsupported",
        "notes.generate is forge, and Forgejo has no API that generates a release's notes",
        'Set notes.generate to "commits" for notes from the conventional commits since the previous release.',
      );
    }
    return forgeNotesFileSection(decl, ctx.cwd, notesValues(ctx, tag));
  };
  const notesValues = (ctx: PublishContext, tag: string) => {
    const label = ctx.label ?? tag;
    return { label, version: releaseVersion(ctx.label) ?? label, tag };
  };
  /**
   * The notes: `before`, the file's section, the generated notes, then
   * `after`, a blank line between each. `client` null is a plan, which asks
   * the forge nothing, so the forge's own notes are named rather than
   * fetched there.
   */
  const releaseNotes = async (ctx: PublishContext, tag: string, section: string | undefined, client: ForgeClient | null): Promise<string | undefined> => {
    const n = decl.notes;
    if (!n) return undefined;
    const values = notesValues(ctx, tag);
    let generated: string | undefined;
    if (n.generate) {
      const previous = await previousMemberRelease(ctx, decl.forge);
      if (n.generate === "commits") {
        // #5159: the summaries of the intent files the cut consumed come first.
        generated = [await consumedIntentNotes(ctx), changelogNotes(memberCommits(ctx, previous?.commit ?? null, decl.forge), { ...(n.types ? { types: n.types } : {}), ...(n.exclude ? { exclude: n.exclude } : {}), ...(n.nonConventional !== undefined ? { nonConventional: n.nonConventional } : {}) })].filter((p) => p.length > 0).join("\n\n");
      } else {
        // #5150: the previous release's tag is the one release.tag gives its label, as the cut made it.
        const previousTag = previous && previous.label !== null && !decl.tag ? previousReleaseTag(ctx, previous.label) : null;
        generated = client
          ? await client.generatedNotes(tag, ctx.release.commit, values.version, previous ? { tag: previousTag, commit: previous.commit } : null)
          : `(${decl.forge === "github" ? "GitHub" : "GitLab"}'s generated notes${previousTag ? ` since ${previousTag}` : ""}, made when the release stages)`;
      }
    }
    const parts = [n.before ? fillNotesText(n.before, values) : "", section ?? "", generated ?? "", n.after ? fillNotesText(n.after, values) : ""].filter((p) => p.length > 0);
    return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
  };
  const att = (a: Asset): Pick<PublishItem, "attachment"> => (a.attachment ? { attachment: a.attachment } : {});
  const where = (tag: string, name: string) => `${decl.forge} ${decl.repo} release ${tag}, asset ${name}`;
  const sigItem = (ctx: PublishContext, tag: string, x: PlannedSignature, o: { destination?: string; digest?: string | null; present?: boolean } = {}): PublishItem => ({
    name: x.name,
    destination: o.destination ?? `${where(tag, x.name)}${o.digest === undefined && !o.present ? ", signed when staged" : ""}`,
    ...(o.digest ? { digest: o.digest } : {}),
    attachment: x.attachment,
    signs: x.signs,
    ...(x.predicateType ? { predicateType: x.predicateType } : {}),
    ...(ctx.signing ? { sigstore: ctx.signing.identity } : {}),
    ...(o.present ? { present: true } : {}),
  });
  /** Sign `x` and upload its bundle. */
  const signAndUpload = async (ctx: PublishContext, client: ForgeClient, rel: ForgeRelease | null, version: string, tag: string, x: PlannedSignature): Promise<PublishItem> => {
    ctx.log(`signing ${x.signs.length === 1 ? x.signs[0]!.name : `${x.signs.length} assets`} with ${ctx.signing!.signer.name}: ${x.name}`);
    const bytes = await x.make();
    const digest = bytesDigest(bytes);
    const destination = await client.upload(rel, version, { path: x.name, name: x.name, bytes, digest });
    return sigItem(ctx, tag, x, { destination: decl.forge === "gitlab" ? destination : where(tag, x.name), digest });
  };
  const exists = (tag: string, a: Asset, theirs: string | null | undefined, before: PublishItem[]) =>
    new PublishTargetError(
      "publish-forge-asset-exists",
      `release ${tag} on ${decl.forge} ${decl.repo} already has an asset named ${a.name}${theirs ? ` with digest ${theirs}, not ${a.digest}` : ", and the forge reports no digest to compare"}${before.length > 0 ? `; ${before.map((i) => i.name).join(", ")} were staged before it` : ""}`,
      "Delete the asset on the forge, or cut a new release.",
    );
  /** #5165: the release's tag and a client, read without the checkout's files; null when the tag, the API root or the token is missing. */
  const reader = (ctx: PublishContext): { tag: string; client: ForgeClient } | null => {
    const tag = decl.tag ?? ctx.releaseTag;
    const api = forgeApi(decl, ctx.env);
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    return tag && api && token ? { tag, client: new ForgeClient(decl, api, token, fetchImpl, ctx) } : null;
  };
  return {
    kind: "forge",
    name: `${decl.forge} release assets ${decl.repo}`,
    destination: `${decl.forge} ${decl.repo}`,
    credentialEnv: tokenNames,
    key: publishTargetKey(decl),
    /** #5165: the repository whose releases it publishes; it needs nothing a train orders by. */
    async names() {
      return { provides: [trainName("forge", `${decl.forge}/${decl.repo}`)], needs: [] };
    },
    /** #5165: whether the forge has a published release, not a draft, for the release's tag. */
    async published(ctx) {
      const r = reader(ctx);
      if (!r) return null;
      return (await r.client.published(r.tag)) !== null;
    },
    /** #5165: wait until the forge serves the release for the tag as published. */
    async visible(ctx) {
      const r = reader(ctx);
      if (!r) return;
      await waitUntilServed(ctx, deps, {
        what: `${decl.forge} ${decl.repo}`,
        code: "publish-forge-not-served",
        check: async () => ((await r.client.published(r.tag)) === null ? [`release ${r.tag}`] : []),
      });
    },
    /**
     * #5163: a forge release has no deprecation, so deprecate does nothing
     * here. A yank marks the release a prerelease, makes it a draft again, or
     * deletes it (`--forge-release`), and on GitHub makes the head release
     * the latest again; GitLab has neither prerelease nor draft, so it only
     * deletes. A restore publishes it again: it clears the prerelease mark
     * (not on Forgejo for a channel's release, which is a prerelease by
     * design) or publishes the draft. A deleted release can't be restored.
     */
    async setStatus(ctx: StatusContext): Promise<StatusAction[]> {
      const tag = decl.tag ?? ctx.releaseTag;
      const forge = `${decl.forge} ${decl.repo}`;
      if (!tag) return [{ what: `${forge} unchanged: the release has no label, so it has no forge release`, already: true }];
      if (ctx.status === "deprecated") return [{ what: `${forge} release ${tag} unchanged: a forge release has no deprecation; yank marks it` }];
      const channel = ctx.tag !== null;
      // #5166: a prerelease label was published as a prerelease, never the latest, and a restore keeps it one.
      const prerelease = prereleaseOf(ctx.label) !== null;
      const isHead = ctx.head?.releaseDigest === ctx.release.releaseDigest;
      const headTag = ctx.head && !isHead ? (decl.tag ?? ctx.head.releaseTag) : null;
      const moveLatest = decl.forge === "github" && decl.latest !== false && !channel && !prerelease;
      if (ctx.status === "yanked" && prerelease && ctx.forgeYank === "prerelease" && decl.forge !== "gitlab") {
        return [{
          what: `${forge} release ${tag} stays a prerelease`,
          refused: { code: "release-status-forge-prerelease", message: `${ctx.label} is a prerelease, so its ${decl.forge} release is marked one already and marking it again withdraws nothing`, fix: "Pass --forge-release draft or --forge-release delete to withdraw it." },
        }];
      }
      if (ctx.status === "yanked" && decl.forge === "gitlab" && ctx.forgeYank !== "delete") {
        return [{
          what: `${forge} release ${tag} stays published`,
          refused: { code: "release-status-forge-unsupported", message: `a GitLab release has no prerelease or draft state to move release ${tag} to`, fix: "Pass --forge-release delete to delete the GitLab release; its tag and packages stay." },
        }];
      }
      const plan: StatusAction[] =
        ctx.status === "yanked"
          ? [
              { what: ctx.forgeYank === "prerelease" ? `mark ${forge} release ${tag} a prerelease` : ctx.forgeYank === "draft" ? `make ${forge} release ${tag} a draft again` : `delete ${forge} release ${tag} (its tag stays)` },
              ...(moveLatest && headTag && headTag !== tag ? [{ what: `make ${forge} release ${headTag} the latest` }] : []),
            ]
          : [{ what: `publish ${forge} release ${tag} again${moveLatest && isHead ? ", as the latest" : ""}` }];
      if (!ctx.apply) return plan;
      const api = forgeApi(decl, ctx.env);
      if (!api) throw new PublishTargetError("publish-forge-no-api", "a Forgejo target needs its API root, and neither api nor GITHUB_API_URL is set", "Set api, such as https://forgejo.example/api/v1.");
      const token = readCredential(ctx.env, tokenNames, ctx.redactor);
      if (!token) throw new PublishTargetError("publish-credentials-missing", `the ${decl.forge} target reads its token from ${tokenNames.join(" or ")}, and none is set`, `Set ${tokenNames[0]} in the job's or the shell's environment.`);
      const client = new ForgeClient(decl, api, token, fetchImpl, ctx);
      const rel = await client.published(tag);
      const actions: StatusAction[] = [];
      if (ctx.status === "yanked") {
        if (!rel) {
          actions.push({ what: `${forge} has no published release ${tag}; nothing to yank there`, already: true });
        } else if (ctx.forgeYank === "prerelease") {
          if (rel.prerelease) actions.push({ what: `${forge} release ${tag} is already a prerelease`, already: true });
          else {
            await client.edit(rel.id, tag, { prerelease: true, ...(decl.forge === "github" ? { make_latest: "false" } : {}) });
            actions.push(plan[0]!);
          }
        } else if (ctx.forgeYank === "draft") {
          await client.edit(rel.id, tag, { draft: true });
          actions.push(plan[0]!);
        } else {
          await client.remove(rel, tag);
          actions.push(plan[0]!);
        }
        if (moveLatest && headTag && headTag !== tag) {
          const head = await client.published(headTag);
          if (head) {
            await client.edit(head.id, headTag, { make_latest: "true" });
            actions.push({ what: `make ${forge} release ${headTag} the latest` });
          } else {
            actions.push({ what: `${forge} has no published release ${headTag} to make the latest`, already: true });
          }
        }
        return actions;
      }
      const latest = moveLatest && isHead ? { make_latest: "true" } : {};
      if (rel) {
        if (rel.prerelease && !prerelease && !(decl.forge === "forgejo" && channel)) {
          await client.edit(rel.id, tag, { prerelease: false, ...latest });
          return [{ what: `clear the prerelease mark of ${forge} release ${tag}${moveLatest && isHead ? ", as the latest" : ""}` }];
        }
        return [{ what: `${forge} release ${tag} is published`, already: true }];
      }
      const draft = decl.forge === "gitlab" ? null : await client.draftFor(tag);
      if (draft) {
        await client.edit(draft.id, tag, { draft: false, ...latest });
        return [{ what: `publish the draft ${forge} release ${tag}${moveLatest && isHead ? ", as the latest" : ""}` }];
      }
      return [{
        what: `${forge} release ${tag} stays deleted`,
        refused: { code: "release-status-forge-deleted", message: `${forge} has no release ${tag}, published or draft, so a yank deleted it and there is nothing to publish again`, fix: `Make the release again by hand from tag ${tag}, or cut a new release.` },
      }];
    },
    async plan(ctx) {
      const { tag, assets, signatures, section } = setup(ctx);
      const notes = await releaseNotes(ctx, tag, section, null);
      return [
        ...assets.map((a) => ({ name: a.path, destination: where(tag, a.name), digest: a.digest, ...att(a) })),
        ...signatures.map((x) => sigItem(ctx, tag, x)),
        ...(notes !== undefined ? [{ name: decl.notes!.file ?? "generated notes", destination: `${decl.forge} ${decl.repo} release ${tag}, notes`, notes }] : []),
      ];
    },
    async stage(ctx): Promise<StagedTarget> {
      const { tag, api, token, assets, signatures, section } = setup(ctx);
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
          items.push({ name: a.path, destination: where(tag, a.name), digest: a.digest, ...att(a), present: true });
        }
        // #5164: a bundle signed by an earlier run is kept; signing again gives other bytes.
        for (const x of signatures) {
          if (!published.assets.has(x.name)) {
            throw new PublishTargetError(
              "publish-forge-release-published",
              `release ${tag} on ${decl.forge} ${decl.repo} is already published without ${x.name}, so the signatures uploaded to it would show after its assets`,
              "Delete the forge release so the publish makes it whole, or set release.signing: false.",
            );
          }
          items.push(sigItem(ctx, tag, x, { digest: published.assets.get(x.name) ?? null, present: true }));
        }
        ctx.log(`release ${tag} is already published with every asset`);
        return done(items, { published: "true" });
      }

      // #5153: the notes are decided here and kept in the record, so the reveal publishes what the draft shows.
      const notes = await releaseNotes(ctx, tag, section, client);
      const kept: Record<string, string> = notes !== undefined ? { notes } : {};
      const version = gitlabPackageVersion(ctx.label ?? tag);
      if (decl.forge === "gitlab") {
        // No draft on GitLab: the assets go to the package registry, and the release is made at the reveal.
        const items: PublishItem[] = [];
        for (const a of assets) {
          ctx.log(`uploading ${a.name} (${a.bytes.byteLength} bytes) to the generic package registry`);
          items.push({ name: a.path, destination: await client.upload(null, version, a), digest: a.digest, ...att(a) });
        }
        for (const x of signatures) items.push(await signAndUpload(ctx, client, null, version, tag, x));
        return done(items, kept);
      }

      const rel = await client.draft(tag, ctx.release.commit, ctx.label ?? tag, notes);
      const items: PublishItem[] = [];
      for (const a of assets) {
        if (rel.assets.has(a.name)) {
          const theirs = rel.assets.get(a.name);
          if (theirs !== a.digest) throw exists(tag, a, theirs, items);
          items.push({ name: a.path, destination: where(tag, a.name), digest: a.digest, ...att(a), present: true });
          ctx.log(`${a.name} is already on the draft release ${tag}`);
          continue;
        }
        ctx.log(`uploading ${a.name} (${a.bytes.byteLength} bytes) to the draft`);
        items.push({ name: a.path, destination: await client.upload(rel, version, a), digest: a.digest, ...att(a) });
      }
      for (const x of signatures) {
        if (rel.assets.has(x.name)) {
          ctx.log(`${x.name} is already on the draft release ${tag}; it is not signed again`);
          items.push(sigItem(ctx, tag, x, { digest: rel.assets.get(x.name) ?? null, present: true }));
          continue;
        }
        items.push(await signAndUpload(ctx, client, rel, version, tag, x));
      }
      return done(items, { releaseId: rel.id, ...(rel.url ? { releaseUrl: rel.url } : {}), ...kept });
    },
    async reveal(ctx, staged) {
      const { tag, api, token, section } = setup(ctx);
      const client = new ForgeClient(decl, api, token, fetchImpl, ctx);
      const items = staged.items.map((i) => ({
        name: i.name,
        destination: i.destination,
        ...(i.digest ? { digest: i.digest } : {}),
        ...(i.attachment ? { attachment: i.attachment } : {}),
        ...(i.signs ? { signs: i.signs } : {}),
        ...(i.predicateType ? { predicateType: i.predicateType } : {}),
        ...(i.sigstore ? { sigstore: i.sigstore } : {}),
      }));
      if (staged.state.published === "true") return { target: this.name, destination: this.destination, items: items.map((i) => ({ ...i, present: true })) };
      // The notes the stage decided; a stage recorded before chant kept them has them decided again.
      const notes = staged.state.notes ?? (await releaseNotes(ctx, tag, section, client));
      if (decl.forge === "gitlab") {
        ctx.log(`creating the gitlab release ${tag} at ${ctx.release.commit.slice(0, 12)} with ${items.length} asset link(s)`);
        await client.createWithLinks(tag, ctx.release.commit, ctx.label ?? tag, items.map((i) => ({ name: basename(i.name), url: i.destination })), notes);
      } else {
        const id = staged.state.releaseId;
        if (!id) throw new PublishTargetError("publish-forge-failed", `the staged ${decl.forge} release for ${tag} has no draft id to publish`);
        const channel = ctx.tag !== null;
        const prerelease = prereleaseOf(ctx.label) !== null;
        const latest =
          decl.forge === "github"
            ? prerelease
              ? " as a prerelease, since its label is one, with make_latest false"
              : ` with make_latest ${String(decl.latest ?? !channel)}`
            : prerelease
              ? " as a prerelease, since its label is one"
              : channel
                ? " as a prerelease, since it was cut to a channel"
                : "";
        ctx.log(`publishing the draft ${decl.forge} release ${tag}${notes !== undefined ? " with its notes" : ""}${latest}`);
        await client.publishDraft(id, tag, { ...(notes !== undefined ? { notes } : {}), channel, prerelease });
      }
      return { target: this.name, destination: this.destination, items };
    },
  };
}

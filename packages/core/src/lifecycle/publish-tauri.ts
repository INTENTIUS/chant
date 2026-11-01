/**
 * The Tauri updater target (#4676): the updater manifest a Tauri v2 app reads
 * (`latest.json`), and a rolling GitHub release under a fixed tag, such as
 * `app-latest`, that holds the release's bundles and that manifest. Each
 * publish replaces what the rolling release held.
 *
 * The manifest is the updater's static JSON:
 *
 * ```json
 * {
 *   "version": "1.4.0",
 *   "notes": "...",
 *   "pub_date": "2026-10-17T10:00:00.000Z",
 *   "platforms": {
 *     "darwin-aarch64": { "signature": "<the .sig file's text>", "url": "https://.../Acme_aarch64.app.tar.gz" }
 *   }
 * }
 * ```
 *
 * `version` is the release's label from its first digit on; `notes` is the
 * text of the declared `notes` file, left out without one; `pub_date` is the
 * time of the cut whose signature the publish carries, left out when none is
 * known, so the manifest is the same bytes on every run. Each platform's
 * `signature` is the text of the `.sig` file the Tauri build wrote beside its
 * updater bundle, and `url` is the `url` pattern for that bundle, by default
 * its download URL on the rolling release.
 *
 * GitHub can't replace a release's contents in one request, so the two steps
 * (#4048) are a draft and a swap:
 *
 * - The stage makes a draft release for the rolling tag named
 *   `<tag> <version>` at the release's commit, or finds the one an earlier
 *   stage made, and uploads each bundle, each declared asset and the manifest
 *   to it. A file already on the draft with the same digest is not sent
 *   again; one that differs is refused (`publish-tauri-asset-exists`). The
 *   published rolling release is untouched, so the updater sees nothing new.
 *   A rolling release that already holds every file with the same digests is
 *   what an earlier reveal left, and the stage does nothing.
 * - The reveal deletes the published rolling release, deletes the tag so it
 *   is made again at the release's commit, and publishes the draft with
 *   `make_latest` from `latest` (default `false`: a rolling release is not
 *   the repository's latest). Between the delete and the publish, a few
 *   requests apart, the rolling release's URLs answer 404, which an updater
 *   treats as no update.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readCredential } from "./publish-credentials";
import type { TauriUpdaterPublishDeclaration } from "./publish-declaration";
import { GitHubRepo, githubApi, type GitHubRelease } from "./publish-github";
import { fillUrl, releaseVersion } from "./publish-homebrew";
import { bytesDigest, checkReleaseDigest, memberFile, publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget, type StagedTarget } from "./release-publish";

/** The first chant that publishes a `tauri-updater` target (#4676). */
export const PUBLISH_TAURI_UPDATER_FLOOR = "0.124.63";

interface File {
  path: string;
  name: string;
  bytes: Uint8Array;
  digest: string;
}

/** The updater manifest's bytes: 2-space JSON with a trailing newline, keys in the order Tauri's docs show them. */
export function tauriManifest(m: { version: string; notes: string | null; pubDate: string | null; platforms: Record<string, { signature: string; url: string }> }): Uint8Array {
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const key of Object.keys(m.platforms).sort()) platforms[key] = { signature: m.platforms[key]!.signature, url: m.platforms[key]!.url };
  const doc = { version: m.version, ...(m.notes !== null ? { notes: m.notes } : {}), ...(m.pubDate !== null ? { pub_date: m.pubDate } : {}), platforms };
  return new Uint8Array(Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, "utf-8"));
}

export function tauriUpdaterTarget(decl: TauriUpdaterPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const tokenNames = [decl.tokenEnv ?? "GITHUB_TOKEN"];
  const manifestName = decl.manifest ?? "latest.json";
  const urlPattern = decl.url ?? `https://github.com/${decl.repo}/releases/download/{tag}/{name}`;

  const read = (ctx: PublishContext, path: string): File => {
    const bytes = new Uint8Array(readFileSync(memberFile(ctx.cwd, path)));
    const digest = bytesDigest(bytes);
    checkReleaseDigest(ctx.release, "asset", ctx.cwd, path, [digest]);
    return { path, name: basename(path), bytes, digest };
  };

  const setup = (ctx: PublishContext) => {
    const version = releaseVersion(ctx.label);
    if (!version || !ctx.label) {
      throw new PublishTargetError(
        "publish-tauri-no-version",
        `the updater manifest's version is the release's label from its first digit, and release ${ctx.release.releaseDigest} has ${ctx.label ? `the label ${ctx.label}, which has no digit` : "no label"}`,
        "Cut the release with a label such as app-v1.4.0.",
      );
    }
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    if (!token) {
      throw new PublishTargetError("publish-credentials-missing", `the tauri-updater target reads its token from ${tokenNames[0]}, and it is not set`, `Set ${tokenNames[0]} to a token that may write releases on ${decl.repo}.`);
    }
    const files: File[] = [];
    const platforms: Record<string, { signature: string; url: string }> = {};
    for (const [platform, path] of Object.entries(decl.platforms)) {
      const bundle = read(ctx, path);
      const sig = read(ctx, `${path}.sig`);
      const signature = Buffer.from(sig.bytes).toString("utf-8").trim();
      if (!signature) throw new PublishTargetError("publish-tauri-signature-missing", `${path}.sig is empty, and the updater installs only a signed bundle`);
      if (!files.some((f) => f.name === bundle.name)) files.push(bundle);
      platforms[platform] = { signature, url: fillUrl(urlPattern, { tag: decl.tag, label: ctx.label, version, name: bundle.name }) };
    }
    for (const path of decl.assets ?? []) files.push(read(ctx, path));
    const notes = decl.notes ? readFileSync(memberFile(ctx.cwd, decl.notes), "utf-8").trim() : null;
    const bytes = tauriManifest({ version, notes, pubDate: ctx.cut?.timestamp ?? null, platforms });
    files.push({ path: manifestName, name: manifestName, bytes, digest: bytesDigest(bytes) });
    const names = new Set<string>();
    for (const f of files) {
      if (names.has(f.name)) throw new PublishTargetError("publish-tauri-asset-name-taken", `two files are named ${f.name}, and a release holds one asset per name`);
      names.add(f.name);
    }
    const repo = new GitHubRepo(githubApi(decl.api, ctx.env), decl.repo, token, fetchImpl, ctx, "publish-tauri-failed");
    return { version, token, files, repo, draftName: `${decl.tag} ${version}` };
  };
  const where = (name: string) => `github ${decl.repo} release ${decl.tag}, asset ${name}`;
  const itemOf = (f: File, present = false): PublishItem => ({ name: f.path, destination: where(f.name), digest: f.digest, ...(present ? { present: true } : {}) });
  const holdsAll = (rel: GitHubRelease, files: File[]) => rel.assets.size === files.length && files.every((f) => rel.assets.get(f.name) === f.digest);

  const target: PublishTarget = {
    kind: "tauri-updater",
    name: `tauri updater ${decl.repo} ${decl.tag}`,
    destination: `github ${decl.repo} release ${decl.tag}`,
    credentialEnv: tokenNames,
    key: publishTargetKey(decl),
    async plan(ctx) {
      return setup(ctx).files.map((f) => itemOf(f));
    },
    async stage(ctx): Promise<StagedTarget> {
      const { version, token, files, repo, draftName } = setup(ctx);
      ctx.log(`using the token from ${token.from}`);
      const done = (items: PublishItem[], state: Record<string, string>): StagedTarget => ({ target: target.name, destination: target.destination, items, state });
      const published = await repo.publishedRelease(decl.tag);
      if (published && holdsAll(published, files)) {
        ctx.log(`release ${decl.tag} already holds ${version}'s files`);
        return done(
          files.map((f) => itemOf(f, true)),
          { published: published.id },
        );
      }
      let draft = await repo.draftRelease(decl.tag, draftName);
      if (draft) ctx.log(`using the draft release ${draftName}`);
      else {
        ctx.log(`creating a draft release ${draftName} at ${ctx.release.commit.slice(0, 12)}`);
        draft = await repo.createDraft(decl.tag, ctx.release.commit, draftName);
      }
      const items: PublishItem[] = [];
      for (const f of files) {
        if (draft.assets.has(f.name)) {
          const theirs = draft.assets.get(f.name);
          if (theirs !== f.digest) {
            throw new PublishTargetError(
              "publish-tauri-asset-exists",
              `the draft release ${draftName} on ${decl.repo} already has ${f.name}${theirs ? ` with digest ${theirs}, not ${f.digest}` : ", and GitHub reports no digest to compare"}`,
              "Delete the draft on GitHub so the stage makes it again.",
            );
          }
          items.push(itemOf(f, true));
          continue;
        }
        ctx.log(`uploading ${f.name} (${f.bytes.byteLength} bytes) to the draft`);
        await repo.uploadAsset(draft, f.name, f.bytes);
        items.push(itemOf(f));
      }
      return done(items, { releaseId: draft.id });
    },
    async reveal(ctx, staged) {
      const items = staged.items.map((i) => ({ name: i.name, destination: i.destination, ...(i.digest ? { digest: i.digest } : {}) }));
      if (staged.state.published) return { target: target.name, destination: target.destination, items: items.map((i) => ({ ...i, present: true })) };
      const id = staged.state.releaseId;
      if (!id) throw new PublishTargetError("publish-tauri-failed", `the staged release for ${decl.tag} has no draft id to publish`);
      const { repo } = setup(ctx);
      const old = await repo.publishedRelease(decl.tag);
      if (old?.id === id) {
        ctx.log(`release ${decl.tag} is already the staged draft, published`);
        return { target: target.name, destination: target.destination, items };
      }
      if (old) {
        ctx.log(`deleting the published release ${decl.tag} (${old.id}) and its tag`);
        await repo.deleteRelease(old.id);
      }
      // A tag that is there stays where it is when a release is published on it, so it goes, and the publish makes it at the release's commit.
      await repo.deleteRef(`tags/${decl.tag}`);
      const makeLatest = String(decl.latest ?? false);
      ctx.log(`publishing the draft as ${decl.tag} with make_latest ${makeLatest}`);
      const res = await repo.publishDraft(id, makeLatest);
      if (res.status !== 200) repo.fail(`publishing the draft release ${decl.tag}`, res);
      return { target: target.name, destination: target.destination, items };
    },
  };
  return target;
}

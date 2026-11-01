/**
 * The Homebrew tap target (#4676): a formula in a tap repository on GitHub,
 * rendered from a template in the member with the release's version and each
 * asset's URL and SHA-256, and committed through GitHub's REST API with the
 * token from `tokenEnv` (default `HOMEBREW_TAP_TOKEN`).
 *
 * The template is the formula as the tap holds it, with placeholders where a
 * release changes it:
 *
 * - `{{version}}`: the release's version, its label from the first digit on
 *   (`v1.4.0` and `app-v1.4.0` are both `1.4.0`);
 * - `{{url:<name>}}` and `{{sha256:<name>}}`: the URL and the SHA-256 in hex
 *   of the declared asset whose file name is `<name>`;
 * - `{{label}}` and `{{tag}}`: the release's label and the tag the cut made.
 *
 * A placeholder chant does not know, or an asset name no declared asset has,
 * is refused (`publish-homebrew-template`). Everything else is copied as it
 * is, so `on_macos`, `on_linux`, `on_arm` and `on_intel` blocks each name
 * their own asset and the formula's Ruby stays the member's. Each SHA-256 is
 * of the file in the checkout, which must match the digest the release
 * records for it.
 *
 * A tap is a branch people install from, with no draft, so the two steps are
 * a branch and a fast-forward (#4048):
 *
 * - The stage commits the rendered formula to `chant-publish/<formula>-<version>`,
 *   a branch it makes at the tap branch's head (or moves there, when an
 *   earlier stage left it elsewhere). `brew` reads only the tap branch, so
 *   nothing is visible. A tap branch that already holds the formula as
 *   rendered stages nothing, and a staging branch that already holds it is
 *   not committed to again.
 * - The reveal fast-forwards the tap branch to the staged commit, then
 *   deletes the staging branch. When the tap branch moved since the stage,
 *   the reveal commits the formula onto it instead, one commit either way,
 *   unless it already holds the formula as rendered.
 *
 * The asset URLs are the declaration's `url` pattern, so the files must be
 * downloadable there by the time the formula is: declare the `forge` target
 * that attaches them before this one, and its reveal runs first.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { readCredential } from "./publish-credentials";
import type { HomebrewPublishDeclaration } from "./publish-declaration";
import { GitHubRepo, githubApi } from "./publish-github";
import { bytesDigest, checkReleaseDigest, memberFile, publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishContext, type PublishDeps, type PublishFetch, type PublishItem, type PublishTarget } from "./release-publish";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant that publishes a `homebrew` target (#4676). */
export const PUBLISH_HOMEBREW_FLOOR = NEXT_RELEASE;

/** The variable the tap token is read from when the declaration names none. */
export const HOMEBREW_TOKEN_ENV = "HOMEBREW_TAP_TOKEN";

/** A release's version for a package manager: its label from the first digit on, or null when the label has no digit. */
export function releaseVersion(label: string | null): string | null {
  const at = label?.search(/\d/) ?? -1;
  return label && at >= 0 ? label.slice(at) : null;
}

/** `pattern` with `{tag}`, `{label}`, `{version}` and `{name}` filled in, each URL-encoded except the tag's slashes. */
export function fillUrl(pattern: string, values: { tag: string; label: string; version: string; name: string }): string {
  return pattern.replace(/\{(tag|label|version|name)\}/g, (_, k: keyof typeof values) =>
    k === "tag" ? values.tag.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(values[k]),
  );
}

/** Render a formula template, or name what it can't fill. */
export function renderFormula(
  template: string,
  values: { version: string; label: string; tag: string },
  assets: ReadonlyMap<string, { url: string; sha256: string }>,
): string {
  return template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (whole, inner: string) => {
    if (inner === "version" || inner === "label" || inner === "tag") return values[inner];
    const m = /^(url|sha256):(.+)$/.exec(inner);
    const asset = m ? assets.get(m[2]!.trim()) : undefined;
    if (m && asset) return m[1] === "url" ? asset.url : asset.sha256;
    throw new PublishTargetError(
      "publish-homebrew-template",
      m ? `the formula template names ${whole}, and no declared asset is named ${m[2]!.trim()}` : `the formula template has ${whole}, which chant does not fill`,
      `The placeholders are {{version}}, {{label}}, {{tag}}, and {{url:<name>}} and {{sha256:<name>}} for an asset in assets: ${[...assets.keys()].join(", ")}.`,
    );
  });
}

export function homebrewTarget(decl: HomebrewPublishDeclaration, deps: PublishDeps): PublishTarget {
  const fetchImpl: PublishFetch = deps.fetch ?? ((url, init) => fetch(url, init as RequestInit));
  const tokenNames = [decl.tokenEnv ?? HOMEBREW_TOKEN_ENV];
  const formulaName = basename(decl.formula).replace(/\.rb$/, "");
  const setup = (ctx: PublishContext) => {
    const version = releaseVersion(ctx.label);
    if (!version || !ctx.label || !ctx.releaseTag) {
      throw new PublishTargetError(
        "publish-homebrew-no-version",
        `a formula's version is the release's label from its first digit, and release ${ctx.release.releaseDigest} has ${ctx.label ? `the label ${ctx.label}, which has no digit` : "no label"}`,
        "Cut the release with a label such as v1.4.0.",
      );
    }
    const token = readCredential(ctx.env, tokenNames, ctx.redactor);
    if (!token) {
      throw new PublishTargetError("publish-credentials-missing", `the homebrew target reads its token from ${tokenNames[0]}, and it is not set`, `Set ${tokenNames[0]} to a token that may push to ${decl.tap}.`);
    }
    const assets = new Map<string, { url: string; sha256: string }>();
    for (const p of decl.assets) {
      const abs = memberFile(ctx.cwd, p);
      const digest = bytesDigest(new Uint8Array(readFileSync(abs)));
      checkReleaseDigest(ctx.release, "asset", ctx.cwd, p, [digest]);
      const name = basename(p);
      if (assets.has(name)) throw new PublishTargetError("publish-homebrew-asset-name-taken", `two assets are named ${name}, and the template names an asset by its file name`);
      const url = fillUrl(decl.url, { tag: ctx.releaseTag, label: ctx.label, version, name });
      assets.set(name, { url, sha256: digest.slice("sha256:".length) });
    }
    const template = readFileSync(memberFile(ctx.cwd, decl.template), "utf-8");
    const bytes = new Uint8Array(Buffer.from(renderFormula(template, { version, label: ctx.label, tag: ctx.releaseTag }, assets), "utf-8"));
    return { version, token, assets, bytes, digest: bytesDigest(bytes) };
  };
  const where = (branch: string) => `${decl.tap}@${branch}:${decl.formula}`;
  const target: PublishTarget = {
    kind: "homebrew",
    name: `homebrew formula ${formulaName} in ${decl.tap}`,
    destination: `github ${decl.tap}`,
    credentialEnv: tokenNames,
    key: publishTargetKey(decl),
    async plan(ctx) {
      const { digest } = setup(ctx);
      return [{ name: decl.formula, destination: where(decl.branch ?? "the default branch"), digest }];
    },
    async stage(ctx) {
      const { version, token, assets, bytes, digest } = setup(ctx);
      ctx.log(`using the token from ${token.from}`);
      for (const [name, a] of assets) ctx.log(`${name}: ${a.url} sha256 ${a.sha256}`);
      const tap = new GitHubRepo(githubApi(decl.api, ctx.env), decl.tap, token, fetchImpl, ctx, "publish-homebrew-failed");
      const branch = decl.branch ?? (await tap.defaultBranch());
      const head = await tap.branchHead(branch);
      if (!head) throw new PublishTargetError("publish-homebrew-failed", `${decl.tap} has no branch ${branch}`, "Set branch to the branch brew installs from.");
      const item: PublishItem = { name: decl.formula, destination: where(branch), digest };
      const done = (state: Record<string, string>, present: boolean) => ({ target: target.name, destination: target.destination, items: [{ ...item, ...(present ? { present: true } : {}) }], state: { branch, ...state } });

      const onTap = await tap.file(decl.formula, branch);
      if (onTap && onTap.bytes.equals(Buffer.from(bytes))) {
        ctx.log(`${branch} already has ${decl.formula} for ${version}`);
        return done({ present: "true" }, true);
      }
      const staging = `chant-publish/${formulaName}-${version}`;
      const stagingHead = await tap.branchHead(staging);
      if (stagingHead) {
        const onStaging = await tap.file(decl.formula, staging);
        if (onStaging && onStaging.bytes.equals(Buffer.from(bytes))) {
          ctx.log(`${staging} already has ${decl.formula} for ${version}`);
          return done({ staging, commit: stagingHead }, true);
        }
        await tap.moveRef(`heads/${staging}`, head, true);
      } else {
        await tap.createBranch(staging, head);
      }
      ctx.log(`committing ${decl.formula} for ${version} to ${staging}, at ${branch}'s head ${head.slice(0, 12)}`);
      const commit = await tap.putFile(decl.formula, staging, bytes, `${formulaName} ${version}`, onTap?.sha ?? null);
      return done({ staging, commit }, false);
    },
    async reveal(ctx, staged) {
      const items = staged.items.map((i) => ({ name: i.name, destination: i.destination, ...(i.digest ? { digest: i.digest } : {}) }));
      const published = { target: target.name, destination: target.destination, items };
      if (staged.state.present === "true") return { ...published, items: items.map((i) => ({ ...i, present: true })) };
      const { version, token, bytes } = setup(ctx);
      const { branch, staging, commit } = staged.state;
      if (!branch || !staging || !commit) throw new PublishTargetError("publish-homebrew-failed", `the staged formula for ${decl.tap} has no staging commit to reveal`);
      const tap = new GitHubRepo(githubApi(decl.api, ctx.env), decl.tap, token, fetchImpl, ctx, "publish-homebrew-failed");
      ctx.log(`fast-forwarding ${branch} to ${commit.slice(0, 12)}`);
      if (!(await tap.moveRef(`heads/${branch}`, commit, false))) {
        // The tap moved since the stage: one commit of the formula onto it, unless it already holds it.
        const onTap = await tap.file(decl.formula, branch);
        if (onTap && onTap.bytes.equals(Buffer.from(bytes))) {
          ctx.log(`${branch} moved since the stage and already has ${decl.formula} for ${version}`);
        } else {
          ctx.log(`${branch} moved since the stage; committing ${decl.formula} for ${version} onto it`);
          await tap.putFile(decl.formula, branch, bytes, `${formulaName} ${version}`, onTap?.sha ?? null);
        }
      }
      await tap.deleteRef(`heads/${staging}`);
      return published;
    },
  };
  return target;
}

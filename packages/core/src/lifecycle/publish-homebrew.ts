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
 * With `sshKeyEnv` (#4699), the same two steps run with git over SSH and the
 * private key in that variable, such as a deploy key limited to the tap, in
 * place of the API and a token (./publish-git-ssh.ts). The stage fetches the
 * tap branch, commits the formula on its head and force-pushes that commit
 * to the staging branch. The reveal fetches the staging branch and pushes
 * its commit to the tap branch without force, which the remote takes only
 * as a fast-forward; when the tap branch moved, it commits the formula onto
 * the new head instead and pushes that, then deletes the staging branch.
 *
 * The asset URLs are the declaration's `url` pattern, so the files must be
 * downloadable there by the time the formula is: declare the `forge` target
 * that attaches them before this one, and its reveal runs first.
 *
 * Since #5158 this target is the `index` target's `homebrew-tap` preset
 * (./publish-index.ts) with the fields, kind, key, error codes and order it
 * always had: it stages and reveals in the order declared, a refusal fails
 * the publish, and each SHA-256 is of the file in the checkout.
 */

import type { HomebrewPublishDeclaration } from "./publish-declaration";
import { fillUrl, indexTargetOf, releaseVersion, renderManifest } from "./publish-index";
import { publishTargetKey } from "./publish-targets";
import { PublishTargetError, type PublishDeps, type PublishTarget } from "./release-publish";
import { basename } from "node:path";

export { fillUrl, releaseVersion };

/** The first chant that publishes a `homebrew` target (#4676). */
export const PUBLISH_HOMEBREW_FLOOR = "0.124.63";

/** The first chant that reads a homebrew target's `sshKeyEnv` (#4699). */
export const PUBLISH_HOMEBREW_SSH_KEY_FLOOR = "0.124.64";

/** The variable the tap token is read from when the declaration names none. */
export const HOMEBREW_TOKEN_ENV = "HOMEBREW_TAP_TOKEN";

/** Render a formula template, or name what it can't fill. */
export function renderFormula(
  template: string,
  values: { version: string; label: string; tag: string },
  assets: ReadonlyMap<string, { url: string; sha256: string }>,
): string {
  return renderManifest(template, values, assets, "publish-homebrew-template", "the formula template");
}

export function homebrewTarget(decl: HomebrewPublishDeclaration, deps: PublishDeps): PublishTarget {
  if (decl.sshKeyEnv && decl.tokenEnv) {
    throw new PublishTargetError("publish-homebrew-auth-invalid", `the homebrew target for ${decl.tap} names both tokenEnv and sshKeyEnv`, "Keep one: sshKeyEnv pushes with git over SSH, tokenEnv commits through the API.");
  }
  const formulaName = basename(decl.formula).replace(/\.rb$/, "");
  return indexTargetOf(
    {
      kind: "homebrew",
      code: "publish-homebrew",
      key: publishTargetKey(decl),
      label: `homebrew formula ${formulaName} in ${decl.tap}`,
      destination: `github ${decl.tap}`,
      name: formulaName,
      repo: decl.tap,
      mode: "commit",
      files: [{ path: decl.formula, template: decl.template }],
      zed: false,
      assets: decl.assets,
      url: decl.url,
      branch: decl.branch,
      fork: undefined,
      title: "{name} {version}",
      body: "",
      api: decl.api,
      tokenEnv: decl.tokenEnv ?? HOMEBREW_TOKEN_ENV,
      sshKeyEnv: decl.sshKeyEnv,
      revealsLast: false,
      refusalWarns: false,
      digests: "file",
      placeholders: ["version", "label", "tag"],
      branchIs: "the branch brew installs from",
    },
    deps,
  );
}

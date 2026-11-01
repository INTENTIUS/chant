/**
 * Where a member declares its publish targets (#4047): `release.publish` in
 * its `chant.config.ts`, a list of targets that `chant release publish` runs
 * in order.
 *
 * ```ts
 * export default {
 *   release: {
 *     publish: [
 *       { type: "npm", packages: ["packages/core", "packages/cli"] },
 *       { type: "oci", image: "dist/api.oci.tar", repository: "ghcr.io/acme/api", tags: ["{label}"], usernameEnv: "GITHUB_ACTOR", passwordEnv: "GITHUB_TOKEN" },
 *       { type: "forge", forge: "github", repo: "acme/api", assets: ["dist/api-linux-amd64.tar.gz"] },
 *       { type: "marketplace", marketplace: "openvsx", vsix: "dist/acme.vsix" },
 *       { type: "tauri-updater", repo: "acme/app", tag: "app-latest", platforms: { "darwin-aarch64": "dist/Acme_aarch64.app.tar.gz" } },
 *       { type: "homebrew", tap: "acme/homebrew-tap", formula: "Formula/api.rb", template: "packaging/api.rb", assets: ["dist/api-linux-amd64.tar.gz"], url: "https://github.com/acme/api/releases/download/{tag}/{name}" },
 *     ],
 *   },
 * };
 * ```
 *
 * The config is the one at the release's commit: a publish with a target
 * refuses a checkout whose `HEAD` is another commit. Paths are relative to
 * the member's directory. A declaration names the environment variables its
 * credentials are read from, never the credentials.
 *
 * This module imports nothing but zod, so ../config.ts can validate the block.
 */

import { z } from "zod";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");

/** An SBOM file, or `false` to publish without one (#4049). */
const sbomField = z.union([z.string().min(1), z.literal(false)]);

/** npm: `npm publish` for each package, in the order given. */
export const NpmPublishSchema = z
  .object({
    type: z.literal("npm"),
    /** Package directories or packed `.tgz` files, relative to the member, published in this order. */
    packages: z.array(z.string().min(1)).min(1),
    /** The registry, else the one npm's own config names. */
    registry: z.string().url().optional(),
    access: z.enum(["public", "restricted"]).optional(),
    /**
     * The SBOM each package carries at its root (#4049), a file name relative
     * to the package. Default: the first of `sbom.spdx.json`, `sbom.cdx.json`,
     * `sbom.cyclonedx.json` it holds. `false` publishes without one.
     */
    sbom: sbomField.optional(),
    /**
     * `false` publishes each package straight to the reveal tag (`latest`
     * unless the publish names another), with no `next` stage and no
     * `npm dist-tag` move (#4040). For credentials that may publish but not
     * move a dist-tag, such as npm trusted publishing without "Allow npm
     * dist-tag" on the package's record (#3904). Default `true`.
     */
    stage: z.boolean().optional(),
    /**
     * A variable holding an npm token to retry with when a package's publish
     * fails to authenticate (#4040), as chant's own publish-packages.sh does:
     * a package whose trusted-publisher record is broken publishes with the
     * token rather than failing the release. Unset or empty, there is no retry.
     */
    tokenEnv: envName.optional(),
    /**
     * A cap, in seconds, on the reveal's wait for the registry to serve every
     * version it published before installing them to audit (#4244). A
     * registry accepts a publish before it serves it. Unset, the wait ends
     * only when every version is served or the registry fails (#4271).
     */
    registryWait: z.number().int().min(0).optional(),
  })
  .strict();

/** An OCI registry such as GHCR or Docker Hub: the image is pushed by digest, then tagged. */
export const OciPublishSchema = z
  .object({
    type: z.literal("oci"),
    /** An OCI image layout, as a directory or a tar file such as `docker save` writes, relative to the member. */
    image: z.string().min(1),
    /** `<registry host>/<name>`, such as `ghcr.io/acme/api` or `docker.io/acme/api`. */
    repository: z.string().min(1),
    /** Tags to point at the pushed digest. `{label}` is the release's label. Default: `["{label}"]`, or none for a release with no label. */
    tags: z.array(z.string().min(1)).optional(),
    /** The variable holding the registry user name. Default `OCI_USERNAME`. */
    usernameEnv: envName.optional(),
    /** The variable holding the registry password or token. Default `OCI_PASSWORD`. */
    passwordEnv: envName.optional(),
    /** The SBOM pushed as a referrer of the image (#4049), relative to the member. Default: one written from the member's lockfile. `false` publishes without one. */
    sbom: sbomField.optional(),
  })
  .strict();

/** Release assets on a GitHub, GitLab or Forgejo release named by the release's tag. */
export const ForgePublishSchema = z
  .object({
    type: z.literal("forge"),
    forge: z.enum(["github", "gitlab", "forgejo"]),
    /** `owner/name` on GitHub and Forgejo; the project path or numeric id on GitLab. */
    repo: z.string().min(1),
    /** The API root: default `$GITHUB_API_URL` or `https://api.github.com` on GitHub, `$CI_API_V4_URL` or `https://gitlab.com/api/v4` on GitLab, `$GITHUB_API_URL` on Forgejo, which has no default. */
    api: z.string().url().optional(),
    /** Files to attach, relative to the member. */
    assets: z.array(z.string().min(1)).min(1),
    /** The forge release's tag. Default: the tag the cut made, `release/<label>` or `release/<member>/<label>`. */
    tag: z.string().min(1).optional(),
    /** The variable holding the token. Default `GITHUB_TOKEN`, `GITLAB_TOKEN` (then `CI_JOB_TOKEN`), or `FORGEJO_TOKEN`. */
    tokenEnv: envName.optional(),
    /** The SBOM attached to the release (#4049), relative to the member. Default: one written from the member's lockfile. `false` publishes without one. */
    sbom: sbomField.optional(),
    /**
     * GitHub only (#4676): whether the release becomes the repository's
     * latest when the reveal publishes it, sent as GitHub's `make_latest`.
     * `"legacy"` lets GitHub pick by creation date and semantic version.
     * Unset, nothing is sent and GitHub makes it latest.
     */
    latest: z.union([z.boolean(), z.literal("legacy")]).optional(),
  })
  .strict();

/**
 * A Homebrew formula in a tap repository on GitHub (#4676), rendered from a
 * template in the member with the release's version and each asset's URL and
 * SHA-256 (./publish-homebrew.ts).
 */
export const HomebrewPublishSchema = z
  .object({
    type: z.literal("homebrew"),
    /** The tap's repository, `owner/name`, such as `acme/homebrew-tap`. */
    tap: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name"),
    /** The formula's path in the tap, such as `Formula/api.rb`. */
    formula: z.string().min(1),
    /** The formula with placeholders, relative to the member: `{{version}}`, `{{label}}`, `{{tag}}`, `{{url:<asset name>}}`, `{{sha256:<asset name>}}`. */
    template: z.string().min(1),
    /** The files the formula downloads, relative to the member. Each is named in the template by its file name. */
    assets: z.array(z.string().min(1)).min(1),
    /** Where each asset is downloaded from: `{tag}`, `{label}`, `{version}` and `{name}` (its file name) are filled in. */
    url: z.string().min(1),
    /** The tap's branch that brew installs from. Default: the repository's default branch. */
    branch: z.string().min(1).optional(),
    /** The GitHub API root. Default `$GITHUB_API_URL`, else `https://api.github.com`. */
    api: z.string().url().optional(),
    /** The variable holding a token that may push to the tap. Default `HOMEBREW_TAP_TOKEN`. */
    tokenEnv: envName.optional(),
  })
  .strict();

/**
 * A packaged `.vsix` on the VS Code Marketplace or Open VSX (#4676), uploaded
 * at the reveal, since a marketplace has no draft (./publish-marketplace.ts).
 */
export const MarketplacePublishSchema = z
  .object({
    type: z.literal("marketplace"),
    marketplace: z.enum(["vscode", "openvsx"]),
    /** The `.vsix` that `vsce package` wrote, relative to the member. Its publisher, name and version are read from it. */
    vsix: z.string().min(1),
    /** Open VSX's root, default `https://open-vsx.org`; the VS Code Marketplace's gallery, default `https://marketplace.visualstudio.com`. */
    registry: z.string().url().optional(),
    /** The variable holding the token, under `auth: "token"`. Default `VSCE_PAT` for the VS Code Marketplace, `OVSX_PAT` for Open VSX. */
    tokenEnv: envName.optional(),
    /**
     * How the target authenticates (#4698). `"token"` (the default) reads a
     * token from `tokenEnv`. `"azure-credential"`, VS Code Marketplace only,
     * runs `vsce` with `--azure-credential`, which signs in with the Microsoft
     * Entra identity the job has, such as one `azure/login` set up from the
     * run's OIDC token. `"trusted-publishing"`, Open VSX only, exchanges the
     * run's OIDC ID token for a short-lived publishing token, as
     * `ovsx publish --trusted-publishing` does.
     */
    auth: z.enum(["token", "azure-credential", "trusted-publishing"]).optional(),
    /**
     * What the reveal does when the marketplace refuses the upload (#4698).
     * `"fail"` (the default) fails the publish. `"warn"` prints a warning
     * and goes on to the next target, and the target is not recorded as
     * published, so the same publish run again tries the upload again.
     */
    onRefusal: z.enum(["fail", "warn"]).optional(),
  })
  .strict();

/**
 * A Tauri v2 updater manifest and the rolling GitHub release that holds it
 * with the app's bundles (#4676), replaced on each publish
 * (./publish-tauri.ts).
 */
export const TauriUpdaterPublishSchema = z
  .object({
    type: z.literal("tauri-updater"),
    /** The GitHub repository, `owner/name`. */
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name"),
    /** The rolling release's tag, such as `app-latest`. */
    tag: z.string().min(1),
    /**
     * Each updater platform, such as `darwin-aarch64`, `linux-x86_64` or
     * `windows-x86_64-nsis`, and its updater bundle, relative to the member.
     * Its signature is the `.sig` file beside it that the Tauri build wrote.
     */
    platforms: z.record(z.string().regex(/^(darwin|linux|windows)-[a-z0-9_]+(-[a-z0-9]+)?$/, "<os>-<arch> or <os>-<arch>-<installer>"), z.string().min(1)).refine((p) => Object.keys(p).length > 0, "at least one platform"),
    /** More files the rolling release holds, such as installers for the site's download links, relative to the member. */
    assets: z.array(z.string().min(1)).optional(),
    /** A file whose text is the manifest's `notes`, relative to the member. */
    notes: z.string().min(1).optional(),
    /** Each platform's URL in the manifest: `{tag}` (the rolling tag), `{label}`, `{version}` and `{name}` are filled in. Default: the bundle's download URL on the rolling release on github.com. */
    url: z.string().min(1).optional(),
    /** The manifest's asset name. Default `latest.json`. */
    manifest: z.string().regex(/^[^/\\]+$/, "a file name").optional(),
    /** GitHub's `make_latest` for the rolling release. Default `false`. */
    latest: z.union([z.boolean(), z.literal("legacy")]).optional(),
    /** The GitHub API root. Default `$GITHUB_API_URL`, else `https://api.github.com`. */
    api: z.string().url().optional(),
    /** The variable holding the token. Default `GITHUB_TOKEN`. */
    tokenEnv: envName.optional(),
  })
  .strict();

export const PublishDeclarationSchema = z.discriminatedUnion("type", [NpmPublishSchema, OciPublishSchema, ForgePublishSchema, HomebrewPublishSchema, MarketplacePublishSchema, TauriUpdaterPublishSchema]);

export type NpmPublishDeclaration = z.infer<typeof NpmPublishSchema>;
export type OciPublishDeclaration = z.infer<typeof OciPublishSchema>;
export type ForgePublishDeclaration = z.infer<typeof ForgePublishSchema>;
export type HomebrewPublishDeclaration = z.infer<typeof HomebrewPublishSchema>;
export type MarketplacePublishDeclaration = z.infer<typeof MarketplacePublishSchema>;
export type TauriUpdaterPublishDeclaration = z.infer<typeof TauriUpdaterPublishSchema>;
export type PublishDeclaration = z.infer<typeof PublishDeclarationSchema>;

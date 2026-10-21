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
     * Seconds the reveal waits for the registry to serve every version it
     * published before installing them to audit (#4244). A registry accepts a
     * publish before it serves it. Default 600.
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
  })
  .strict();

export const PublishDeclarationSchema = z.discriminatedUnion("type", [NpmPublishSchema, OciPublishSchema, ForgePublishSchema]);

export type NpmPublishDeclaration = z.infer<typeof NpmPublishSchema>;
export type OciPublishDeclaration = z.infer<typeof OciPublishSchema>;
export type ForgePublishDeclaration = z.infer<typeof ForgePublishSchema>;
export type PublishDeclaration = z.infer<typeof PublishDeclarationSchema>;

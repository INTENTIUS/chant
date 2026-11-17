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
 *       { type: "mcp-registry", server: "server.json" },
 *       { type: "homebrew", tap: "acme/homebrew-tap", formula: "Formula/api.rb", template: "packaging/api.rb", assets: ["dist/api-linux-amd64.tar.gz"], url: "https://github.com/acme/api/releases/download/{tag}/{name}" },
 *       { type: "pypi", files: ["dist"] },
 *       { type: "cargo", crates: ["acme-core", "acme-cli"] },
 *       { type: "maven", bundle: "artifact:maven" },
 *       { type: "nuget", packages: ["artifact:nuget"] },
 *       { type: "rubygems", gems: ["artifact:gem"] },
 *       { type: "index", preset: "krew", name: "api", template: "packaging/krew.yaml", assets: ["artifact:api"], url: "https://github.com/acme/api/releases/download/{tag}/{name}" },
 *       { type: "helm", charts: ["artifact:chart"], oci: { repository: "ghcr.io/acme/charts" }, index: { repo: "acme/charts" } },
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
     * fails to authenticate (#4040): a package whose trusted-publisher record is broken publishes with the
     * token rather than failing the release. Unset or empty, there is no retry.
     */
    tokenEnv: envName.optional(),
    /**
     * A cap, in seconds, on the reveal's wait for the registry to serve every
     * version it published before installing them to audit (#4244). A
     * registry accepts a publish before it serves it. Unset, the wait ends
     * only when every version is served or the registry fails (#4271).
     */
    /**
     * A file in the package, from its root, holding the image digests it pins
     * (#4657), such as `dist/image-digests.json`. Every `sha256:` digest in it
     * must be an image the release records, or the plan and `chant release
     * verify` refuse the package. A package without the file is not checked,
     * and a target none of whose packages has it is refused.
     */
    pins: z.string().min(1).optional(),
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
    /** Files to attach, relative to the member. May be empty when `notes` gives the release its body. */
    assets: z.array(z.string().min(1)),
    /**
     * The release's notes (#4658), sent as the release's body on GitHub and
     * Forgejo and its description on GitLab: a section of a file in the
     * member, notes generated for the release (#5153), or both, between
     * `before` and `after`. They are decided when the target stages, so the
     * draft release carries them before the reveal.
     */
    notes: z
      .object({
        /** The file, relative to the member, such as `CHANGELOG.md` or a docs site's changes page. Needs `heading`. */
        file: z.string().min(1).optional(),
        /**
         * The heading that starts the section, such as `## In {version}` or `## [{version}]`. `{label}`, `{version}`
         * (the label from its first digit) and `{tag}` are filled in. The section runs to the next heading of the same
         * level or higher.
         */
        heading: z.string().regex(/^#{1,6} \S/, "a markdown heading, such as ## {version}").optional(),
        /** Links that start with `/` are made absolute against this, such as `https://docs.example.com`. */
        linkBase: z.string().url().optional(),
        /**
         * Notes generated for the release, after the file's section (#5153). `forge`: the forge's own, GitHub's
         * generate-notes or GitLab's changelog from `Changelog:` commit trailers; Forgejo has none and is refused.
         * `commits`: chant's own, from the conventional commits in the member since its previous release.
         */
        generate: z.enum(["forge", "commits"]).optional(),
        /** With `generate: "commits"`: the commit types listed. Default `feat`, `fix` and `perf`. A breaking change is listed whatever its type; `*` lists every commit. */
        types: z.array(z.string().min(1)).min(1).optional(),
        /** With `generate: "commits"`, instead of `types` (#5270): the commit types left out, such as `docs`, `test` and `chore`; every other commit is listed, conventional or not. */
        exclude: z.array(z.string().regex(/^\w+$/, "a commit type, such as docs")).min(1).optional(),
        /** With `generate: "commits"` (#5270): list the commits whose subject is not conventional. Default `true` with `exclude` or `types: ["*"]`, `false` with a list of types. */
        nonConventional: z.boolean().optional(),
        /** A paragraph before the notes, with the same placeholders. */
        before: z.string().min(1).optional(),
        /** A paragraph after the notes, with the same placeholders. */
        after: z.string().min(1).optional(),
      })
      .strict()
      .refine((n) => (n.file === undefined) === (n.heading === undefined), { message: "notes.file and notes.heading go together", path: ["heading"] })
      .refine((n) => n.file !== undefined || n.generate !== undefined, { message: "notes need a file section, generate, or both", path: ["generate"] })
      .refine((n) => n.types === undefined || n.generate === "commits", { message: 'notes.types applies to generate: "commits"', path: ["types"] })
      .refine((n) => n.exclude === undefined || n.generate === "commits", { message: 'notes.exclude applies to generate: "commits"', path: ["exclude"] })
      .refine((n) => n.nonConventional === undefined || n.generate === "commits", { message: 'notes.nonConventional applies to generate: "commits"', path: ["nonConventional"] })
      .refine((n) => n.exclude === undefined || n.types === undefined, { message: "notes.types lists types and notes.exclude leaves them out: name one", path: ["exclude"] })
      .optional(),
    /** The forge release's tag. Default: the tag the cut made, from `release.tag` (#5150; `release/<label>` or `release/<member>/<label>` when unset). */
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
  .strict()
  .refine((d) => d.assets.length > 0 || d.notes !== undefined, { message: "a forge release needs assets, notes or both", path: ["assets"] });

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
    /**
     * The variable holding an SSH private key that may push to the tap, such
     * as a deploy key with write access (#4699). Set, the target pushes with
     * git over SSH and reads no token; `tokenEnv` beside it is refused.
     */
    sshKeyEnv: envName.optional(),
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

/**
 * Python distributions on PyPI, TestPyPI or another index that takes PyPI's
 * upload API (./publish-pypi.ts). The wheels and sdists are uploaded at the
 * reveal, since an index has no draft.
 */
export const PypiPublishSchema = z
  .object({
    type: z.literal("pypi"),
    /**
     * The wheels and sdists, relative to the member: a file, a directory
     * (every `.whl`, `.tar.gz` and `.zip` in it), or `artifact:<name>` for the
     * files the release records for that `release.artifacts` entry.
     */
    files: z.array(z.string().min(1)).min(1),
    /** `pypi` (the default) or `testpypi`. */
    index: z.enum(["pypi", "testpypi"]).optional(),
    /** Another index's upload URL, such as `https://pypi.example.com/legacy/`. Needs `simpleUrl`. */
    uploadUrl: z.string().url().optional(),
    /** That index's simple API root, such as `https://pypi.example.com/simple/`, which the stage and reveal read. */
    simpleUrl: z.string().url().optional(),
    /**
     * `token` reads an API token from `tokenEnv`. `trusted-publishing`
     * exchanges the run's OIDC ID token for a short-lived upload token, on
     * PyPI and TestPyPI only. Unset: a token when `tokenEnv`'s variable is
     * set, else trusted publishing when the run has an OIDC ID token.
     */
    auth: z.enum(["token", "trusted-publishing"]).optional(),
    /** The variable holding the API token. Default `PYPI_TOKEN`, or `TEST_PYPI_TOKEN` for TestPyPI. */
    tokenEnv: envName.optional(),
    /** The variable holding the user name the token is sent with. Default: `__token__`, as PyPI's API tokens take. */
    usernameEnv: envName.optional(),
    /**
     * `false` publishes wheels without an SBOM under the `supply-chain`
     * group, which otherwise refuses a wheel that carries none in its
     * `.dist-info/sboms/` (PEP 770).
     */
    sbom: z.literal(false).optional(),
    /**
     * Upload the PEP 740 attestations beside each file, `<file>.<name>.attestation`
     * as `pypi-attestations sign` writes them. Default `true`. chant does not
     * write them.
     */
    attestations: z.boolean().optional(),
  })
  .strict()
  .refine((d) => (d.uploadUrl === undefined) === (d.simpleUrl === undefined), { message: "uploadUrl and simpleUrl go together", path: ["simpleUrl"] })
  .refine((d) => d.uploadUrl === undefined || d.index === undefined, { message: "index names PyPI or TestPyPI; uploadUrl names another index, so set one of them", path: ["index"] })
  .refine((d) => d.uploadUrl === undefined || d.auth !== "trusted-publishing", { message: "trusted publishing is PyPI's and TestPyPI's; another index takes a token", path: ["auth"] })
  .refine((d) => d.auth !== "trusted-publishing" || (d.tokenEnv === undefined && d.usernameEnv === undefined), { message: "auth: trusted-publishing reads no token", path: ["tokenEnv"] });

/**
 * Rust crates on crates.io or another Cargo registry, published with
 * `cargo publish` one crate at a time in dependency order
 * (./publish-cargo.ts). A crate is visible as soon as it is published, so
 * the reveal publishes.
 */
export const CargoPublishSchema = z
  .object({
    type: z.literal("cargo"),
    /** The `Cargo.toml` of the workspace or the crate, relative to the member. Default `Cargo.toml`. */
    manifest: z.string().min(1).optional(),
    /** The crates to publish, by package name. Default: every workspace member whose `publish` allows the registry. */
    crates: z.array(z.string().min(1)).min(1).optional(),
    /** A registry named in the project's `.cargo/config.toml`, passed as `cargo publish --registry`. Default: crates.io. Needs `index`. */
    registry: z.string().regex(/^[A-Za-z0-9_-]+$/, "a registry name from .cargo/config.toml").optional(),
    /** The registry's sparse index, such as `sparse+https://cargo.example.com/index/`, which the stage and reveal read. Default: crates.io's. */
    index: z.string().regex(/^(sparse\+)?https?:\/\//, "a sparse index URL").optional(),
    /** crates.io's API root, for trusted publishing. Default `https://crates.io`. */
    api: z.string().url().optional(),
    /**
     * `token` reads a registry token from `tokenEnv`. `trusted-publishing`
     * exchanges the run's OIDC ID token for a short-lived crates.io token,
     * revoked after the publish. Unset: a token when `tokenEnv`'s variable is
     * set, else trusted publishing when the run has an OIDC ID token.
     */
    auth: z.enum(["token", "trusted-publishing"]).optional(),
    /** The variable holding the token. Default `CARGO_REGISTRY_TOKEN`, or `CARGO_REGISTRIES_<NAME>_TOKEN` with `registry`, the variables cargo reads. */
    tokenEnv: envName.optional(),
    /** `false` publishes under the `supply-chain` group, which otherwise refuses this target: a registry keeps no SBOM beside a crate. */
    sbom: z.literal(false).optional(),
  })
  .strict()
  .refine((d) => d.registry === undefined || d.index !== undefined, { message: "a registry other than crates.io needs its sparse index", path: ["index"] })
  .refine((d) => d.registry === undefined || d.auth !== "trusted-publishing", { message: "trusted publishing is crates.io's; another registry takes a token", path: ["auth"] })
  .refine((d) => d.auth !== "trusted-publishing" || d.tokenEnv === undefined, { message: "auth: trusted-publishing reads no token", path: ["tokenEnv"] });

/**
 * Maven components on Maven Central (#5232): a bundle uploaded to the
 * Central Portal at the stage, validated there, and published at the reveal
 * (./publish-maven.ts).
 */
export const MavenPublishSchema = z
  .object({
    type: z.literal("maven"),
    /**
     * The bundle, relative to the member: a `.zip` in Maven repository
     * layout, a directory in that layout (chant zips it, adding each missing
     * `.md5` and `.sha1`), or `artifact:<name>` for the one `.zip` the release
     * records for that `release.artifacts` entry.
     */
    bundle: z.string().min(1),
    /** The Central Portal's root. Default `https://central.sonatype.com`. */
    api: z.string().url().optional(),
    /** The repository the stage reads for components already published. Default `https://repo1.maven.org/maven2/`. */
    repository: z.string().url().optional(),
    /** The variable holding the user token's name. Default `MAVEN_CENTRAL_USERNAME`. */
    usernameEnv: envName.optional(),
    /** The variable holding the user token's password. Default `MAVEN_CENTRAL_PASSWORD`. */
    passwordEnv: envName.optional(),
    /** `false` publishes under the `supply-chain` group components that carry no `-cyclonedx` or `-spdx` file. */
    sbom: z.literal(false).optional(),
  })
  .strict();

/**
 * NuGet packages on nuget.org or another feed that takes NuGet's push API
 * (#5232), pushed at the reveal (./publish-nuget.ts).
 */
export const NugetPublishSchema = z
  .object({
    type: z.literal("nuget"),
    /** The `.nupkg` files, relative to the member: a file, a directory (every `.nupkg` in it), or `artifact:<name>`. */
    packages: z.array(z.string().min(1)).min(1),
    /** Another feed's push URL, such as `https://nuget.acme.dev/api/v2/package`. Needs `flatContainerUrl`. Default nuget.org's. */
    pushUrl: z.string().url().optional(),
    /** That feed's package base address (flat container), which the stage and reveal read. */
    flatContainerUrl: z.string().url().optional(),
    /**
     * `token` reads an API key from `tokenEnv`. `trusted-publishing`
     * exchanges the run's OIDC ID token for a key that lasts an hour, on
     * nuget.org only. Unset: a token when `tokenEnv`'s variable is set, else
     * trusted publishing when the run has an OIDC ID token.
     */
    auth: z.enum(["token", "trusted-publishing"]).optional(),
    /** The variable holding the API key. Default `NUGET_API_KEY`. */
    tokenEnv: envName.optional(),
    /** The variable holding the nuget.org user (profile name, not email) whose trusted publishing policy names this workflow. Default `NUGET_USER`. */
    userEnv: envName.optional(),
    /** `false` publishes under the `supply-chain` group packages that carry no SBOM. */
    sbom: z.literal(false).optional(),
  })
  .strict()
  .refine((d) => (d.pushUrl === undefined) === (d.flatContainerUrl === undefined), { message: "pushUrl and flatContainerUrl go together", path: ["flatContainerUrl"] })
  .refine((d) => d.pushUrl === undefined || d.auth !== "trusted-publishing", { message: "trusted publishing is nuget.org's; another feed takes a token", path: ["auth"] })
  .refine((d) => d.auth !== "trusted-publishing" || d.tokenEnv === undefined, { message: "auth: trusted-publishing reads no token", path: ["tokenEnv"] });

/**
 * Ruby gems on RubyGems.org or another host that takes its API (#5232),
 * pushed at the reveal (./publish-rubygems.ts).
 */
export const RubygemsPublishSchema = z
  .object({
    type: z.literal("rubygems"),
    /** The `.gem` files, relative to the member: a file, a directory (every `.gem` in it), or `artifact:<name>`. */
    gems: z.array(z.string().min(1)).min(1),
    /** The gem host. Default `https://rubygems.org`. */
    host: z.string().url().optional(),
    /**
     * `token` reads an API key from `tokenEnv`. `trusted-publishing`
     * exchanges the run's OIDC ID token for a short-lived key, on
     * RubyGems.org only. Unset: a token when `tokenEnv`'s variable is set,
     * else trusted publishing when the run has an OIDC ID token.
     */
    auth: z.enum(["token", "trusted-publishing"]).optional(),
    /** The variable holding the API key. Default `GEM_HOST_API_KEY`, the one `gem push` reads. */
    tokenEnv: envName.optional(),
    /** `false` publishes under the `supply-chain` group, which otherwise refuses this target: a gem host keeps no SBOM beside a gem. */
    sbom: z.literal(false).optional(),
  })
  .strict()
  .refine((d) => d.host === undefined || d.auth !== "trusted-publishing", { message: "trusted publishing is RubyGems.org's; another host takes a token", path: ["auth"] })
  .refine((d) => d.auth !== "trusted-publishing" || d.tokenEnv === undefined, { message: "auth: trusted-publishing reads no token", path: ["tokenEnv"] });

/**
 * A `server.json` on the official MCP Registry (#5162), published after the
 * npm packages or images it names have been revealed
 * (./publish-mcp-registry.ts).
 */
export const McpRegistryPublishSchema = z
  .object({
    type: z.literal("mcp-registry"),
    /** The `server.json`, relative to the member. Default `server.json`. Its `version` and each package's version must be the release's label. */
    server: z.string().min(1).optional(),
    /** The registry's root. Default `https://registry.modelcontextprotocol.io`. */
    registry: z.string().url().optional(),
    /**
     * How the target gets a registry token. `"github-oidc"` (the default)
     * exchanges the GitHub Actions OIDC token of a job with `id-token: write`.
     * `"github-token"` exchanges a GitHub token read from `tokenEnv`, default
     * `MCP_GITHUB_TOKEN`. `"registry-token"` sends a registry token read from
     * `tokenEnv`, default `MCP_REGISTRY_TOKEN`, such as one `mcp-publisher`
     * got by a DNS or HTTP login.
     */
    auth: z.enum(["github-oidc", "github-token", "registry-token"]).optional(),
    /** The variable holding the token, under `github-token` or `registry-token`. */
    tokenEnv: envName.optional(),
  })
  .strict();

/** The index repositories `index` has a preset for (#5158). */
export const INDEX_PRESETS = ["krew", "winget", "scoop", "homebrew-core", "homebrew-tap", "zed", "artifacthub"] as const;

/**
 * A manifest in an index repository on GitHub (#5158), such as krew-index,
 * winget-pkgs, a Scoop bucket, homebrew-core, a Homebrew tap, Zed's
 * extensions or an Artifact Hub repository, rendered from templates in the
 * member and either committed to a repository the publisher may push to
 * (`mode: "commit"`) or proposed in a pull request from a fork
 * (`mode: "pull-request"`). It reveals after every other target
 * (./publish-index.ts).
 */
export const IndexPublishSchema = z
  .object({
    type: z.literal("index"),
    /** Defaults for a known index: its repository, mode, manifest path and pull request title. */
    preset: z.enum(INDEX_PRESETS).optional(),
    /** The index repository, `owner/name`. Default: the preset's, where it has one (krew, winget, homebrew-core, zed). */
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name").optional(),
    /** The package's name in the index: the krew plugin, the winget `PackageIdentifier`, the Scoop app, the formula, the Zed extension id, the Artifact Hub package. */
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "a name of letters, digits, '.', '_', '+' and '-'"),
    /** `commit` pushes to `branch` of `repo`; `pull-request` opens a pull request on `repo` from a branch of `fork`. Default: the preset's, else `pull-request`. */
    mode: z.enum(["commit", "pull-request"]).optional(),
    /** One manifest template, relative to the member, written to `path`. */
    template: z.string().min(1).optional(),
    /** Where `template` goes in the index. Default: the preset's path. `{name}`, `{version}`, `{label}`, `{letter}` (the name's first letter, lowercased) and `{namePath}` (the name with each `.` a `/`) are filled in. */
    path: z.string().min(1).optional(),
    /** More manifests: each path in the index, with the same placeholders as `path`, and its template relative to the member. */
    files: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** The release's files the manifests download: `artifact:<name>` for an entry of `release.artifacts`, or a path the release records. Each SHA-256 is the one the release records. */
    assets: z.array(z.string().min(1)).optional(),
    /** Where each asset is downloaded from: `{tag}`, `{label}`, `{version}` and `{name}` (its file name) are filled in. Needed with `assets`. */
    url: z.string().min(1).optional(),
    /** The branch of `repo` the index is read from, and the base of a pull request. Default: the repository's default branch. */
    branch: z.string().min(1).optional(),
    /** `pull-request` only: the repository the branch is pushed to, `owner/name`. Default: the token's user's fork of `repo`, made when it has none. `repo` itself opens the pull request from a branch of `repo`. */
    fork: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name").optional(),
    /** The commit message and pull request title: `{name}`, `{version}`, `{label}` and `{tag}` are filled in. Default: the preset's. */
    title: z.string().min(1).optional(),
    /** The pull request's body, with the same placeholders. */
    body: z.string().min(1).optional(),
    /** The GitHub API root. Default `$GITHUB_API_URL`, else `https://api.github.com`. */
    api: z.string().url().optional(),
    /** The variable holding the token. Default `HOMEBREW_TAP_TOKEN` under the homebrew-tap preset, else `INDEX_TOKEN`. */
    tokenEnv: envName.optional(),
    /** `commit` only: the variable holding an SSH private key that may push to `repo`, such as a deploy key. Set, the target pushes with git over SSH and reads no token. */
    sshKeyEnv: envName.optional(),
    /** What a refusal from the index does: `warn` (the default) prints a warning and leaves the target unrecorded, so a run of the same publish tries again; `fail` fails the publish. */
    onRefusal: z.enum(["fail", "warn"]).optional(),
  })
  .strict()
  .refine((d) => d.sshKeyEnv === undefined || d.tokenEnv === undefined, { message: "keep one of tokenEnv and sshKeyEnv", path: ["sshKeyEnv"] })
  .refine((d) => d.path === undefined || d.template !== undefined, { message: "path is where template goes; name a template", path: ["path"] })
  .refine((d) => (d.assets?.length ?? 0) === 0 || d.url !== undefined, { message: "assets need url, the pattern each is downloaded from", path: ["url"] });

/**
 * Helm charts (#5233): each chart archive pushed to an OCI registry, where
 * `helm install oci://...` reads it, and listed in a classic chart
 * repository's `index.yaml` on a branch of a GitHub repository, such as the
 * `gh-pages` branch GitHub Pages serves (./publish-helm.ts).
 */
export const HelmPublishSchema = z
  .object({
    type: z.literal("helm"),
    /** The chart archives, relative to the member: a `.tgz` file, or `artifact:<name>` for the files the release records for that `release.artifacts` entry. */
    charts: z.array(z.string().min(1)).min(1),
    /** Push each chart to `<repository>/<chart name>`, tagged with its version, as `helm push` does. */
    oci: z
      .object({
        /** `<registry host>/<path>`, such as `ghcr.io/acme/charts`; a chart goes under it by its name. */
        repository: z.string().min(1),
        /** The variable holding the registry user name. Default `OCI_USERNAME`. */
        usernameEnv: envName.optional(),
        /** The variable holding the registry password or token. Default `OCI_PASSWORD`. */
        passwordEnv: envName.optional(),
      })
      .strict()
      .optional(),
    /** List each chart in an `index.yaml` committed to a branch of a GitHub repository. */
    index: z
      .object({
        /** The repository, `owner/name`. */
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "owner/name"),
        /** The branch the chart repository is served from. Default `gh-pages`. */
        branch: z.string().min(1).optional(),
        /** The index's path on the branch. Default `index.yaml`. */
        path: z.string().min(1).optional(),
        /**
         * Where each chart is downloaded from: `{tag}`, `{label}`, `{version}` and `{name}` (the archive's file name) are
         * filled in, such as a forge release's asset URL. Unset, each archive is committed beside the index, and the
         * index names it by its file name, which helm reads from the repository's URL.
         */
        url: z.string().min(1).optional(),
        /** The GitHub API root. Default `$GITHUB_API_URL`, else `https://api.github.com`. */
        api: z.string().url().optional(),
        /** The variable holding a token that may push to the branch. Default `GITHUB_TOKEN`. */
        tokenEnv: envName.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((d) => d.oci !== undefined || d.index !== undefined, { message: "a helm target pushes to oci, lists the charts in an index, or both", path: ["oci"] });

export const PublishDeclarationSchema = z.discriminatedUnion("type", [
  NpmPublishSchema,
  OciPublishSchema,
  ForgePublishSchema,
  HomebrewPublishSchema,
  MarketplacePublishSchema,
  TauriUpdaterPublishSchema,
  PypiPublishSchema,
  CargoPublishSchema,
  McpRegistryPublishSchema,
  IndexPublishSchema,
  HelmPublishSchema,
  MavenPublishSchema,
  NugetPublishSchema,
  RubygemsPublishSchema,
]);

export type NpmPublishDeclaration = z.infer<typeof NpmPublishSchema>;
export type OciPublishDeclaration = z.infer<typeof OciPublishSchema>;
export type ForgePublishDeclaration = z.infer<typeof ForgePublishSchema>;
export type HomebrewPublishDeclaration = z.infer<typeof HomebrewPublishSchema>;
export type MarketplacePublishDeclaration = z.infer<typeof MarketplacePublishSchema>;
export type TauriUpdaterPublishDeclaration = z.infer<typeof TauriUpdaterPublishSchema>;
export type PypiPublishDeclaration = z.infer<typeof PypiPublishSchema>;
export type CargoPublishDeclaration = z.infer<typeof CargoPublishSchema>;
export type McpRegistryPublishDeclaration = z.infer<typeof McpRegistryPublishSchema>;
export type IndexPublishDeclaration = z.infer<typeof IndexPublishSchema>;
export type HelmPublishDeclaration = z.infer<typeof HelmPublishSchema>;
export type MavenPublishDeclaration = z.infer<typeof MavenPublishSchema>;
export type NugetPublishDeclaration = z.infer<typeof NugetPublishSchema>;
export type RubygemsPublishDeclaration = z.infer<typeof RubygemsPublishSchema>;
export type PublishDeclaration = z.infer<typeof PublishDeclarationSchema>;

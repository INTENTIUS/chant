/**
 * The publish targets (#4047): a member's `release.publish` declarations
 * (./publish-declaration.ts) made into {@link PublishTarget}s, and what the
 * targets share.
 *
 * - `npm` (./publish-npm.ts): `npm publish` per package, in order, with
 *   `--provenance` when the run has an OIDC token.
 * - `oci` (./publish-oci.ts): an OCI image layout pushed to a registry such
 *   as GHCR or Docker Hub over the registry HTTP API, by digest, then tagged.
 * - `forge` (./publish-forge.ts): files attached to the GitHub, GitLab or
 *   Forgejo release named by the release's tag.
 * - `homebrew` (./publish-homebrew.ts): a formula in a tap repository on
 *   GitHub, rendered from a template with each asset's URL and SHA-256.
 * - `marketplace` (./publish-marketplace.ts): a `.vsix` on the VS Code
 *   Marketplace (through `vsce`) or Open VSX (through its REST API).
 * - `tauri-updater` (./publish-tauri.ts): a Tauri updater manifest and the
 *   app's bundles on a rolling GitHub release, replaced on each publish.
 * - `pypi` (./publish-pypi.ts): wheels and sdists uploaded to PyPI, TestPyPI
 *   or another index, with a token or PyPI's trusted publishing (#5167).
 * - `cargo` (./publish-cargo.ts): `cargo publish` per crate of a workspace,
 *   in dependency order, to crates.io or another registry (#5167).
 * - `mcp-registry` (./publish-mcp-registry.ts): a `server.json` on the
 *   official MCP Registry, revealed after every other target.
 * - `index` (./publish-index.ts): manifests in an index repository such as
 *   krew-index or winget-pkgs, committed or proposed in a pull request,
 *   revealed after every other target. `homebrew` is its tap preset.
 * - `helm` (./publish-helm.ts): Helm chart archives pushed to an OCI
 *   registry, and listed in a chart repository's `index.yaml` on a branch of
 *   a GitHub repository (#5233).
 * - `maven` (./publish-maven.ts): a bundle uploaded to the Central Portal
 *   and validated at the stage, published to Maven Central at the reveal
 *   (#5232).
 * - `nuget` (./publish-nuget.ts): `.nupkg` files pushed to nuget.org or
 *   another feed, with an API key or nuget.org's trusted publishing (#5232).
 * - `rubygems` (./publish-rubygems.ts): `.gem` files pushed to RubyGems.org
 *   or another host, with an API key or trusted publishing (#5232).
 *
 * A file a target reads that the release records as an artifact at the same
 * path is checked against the release's digest, and a file that differs is
 * refused (`publish-artifact-digest-mismatch`). Other files are the commit's
 * by the checkout check (`checkCheckoutIsRelease` in ./release-publish.ts).
 * A forge, homebrew or index target's `assets` may name `artifact:<name>`, every
 * file the release records for that `release.artifacts` entry (#5151).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { PublishDeclaration } from "./publish-declaration";
import { PublishTargetError, type PublishContextBase, type PublishDeps, type PublishFetch, type PublishTarget } from "./release-publish";
import type { Release, ReleaseArtifact } from "./release-store";
import { sortedJsonReplacer } from "../utils";

/** Make each declaration a target, in the order declared. */
export async function createPublishTargets(decls: readonly PublishDeclaration[], deps: PublishDeps = {}): Promise<PublishTarget[]> {
  const out: PublishTarget[] = [];
  for (const d of decls) {
    switch (d.type) {
      case "npm":
        out.push((await import("./publish-npm")).npmTarget(d, deps));
        break;
      case "oci":
        out.push((await import("./publish-oci")).ociTarget(d, deps));
        break;
      case "forge":
        out.push((await import("./publish-forge")).forgeTarget(d, deps));
        break;
      case "homebrew":
        out.push((await import("./publish-homebrew")).homebrewTarget(d, deps));
        break;
      case "marketplace":
        out.push((await import("./publish-marketplace")).marketplaceTarget(d, deps));
        break;
      case "tauri-updater":
        out.push((await import("./publish-tauri")).tauriUpdaterTarget(d, deps));
        break;
      case "pypi":
        out.push((await import("./publish-pypi")).pypiTarget(d, deps));
        break;
      case "cargo":
        out.push((await import("./publish-cargo")).cargoTarget(d, deps));
        break;
      case "mcp-registry":
        out.push((await import("./publish-mcp-registry")).mcpRegistryTarget(d, deps));
        break;
      case "index":
        out.push((await import("./publish-index")).indexTarget(d, deps));
        break;
      case "helm":
        out.push((await import("./publish-helm")).helmTarget(d, deps));
        break;
      case "maven":
        out.push((await import("./publish-maven")).mavenTarget(d, deps));
        break;
      case "nuget":
        out.push((await import("./publish-nuget")).nugetTarget(d, deps));
        break;
      case "rubygems":
        out.push((await import("./publish-rubygems")).rubygemsTarget(d, deps));
        break;
    }
  }
  return out;
}

/**
 * The key of a target made from `decl` (#4048): its kind and the first 16 hex
 * digits of the SHA-256 of its sorted JSON. A declaration holds variable
 * names, never a credential, so the key holds none either.
 */
export function publishTargetKey(decl: PublishDeclaration): string {
  return `${decl.type}:${createHash("sha256").update(JSON.stringify(decl, sortedJsonReplacer)).digest("hex").slice(0, 16)}`;
}

/** `path` resolved in the member at `cwd`, refused when it is not there. */
export function memberFile(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new PublishTargetError("publish-file-missing", `${path} does not exist in ${cwd}`, "Build it before publishing: a publish uploads what is there and never builds.");
  }
  return abs;
}

/** `sha256:<hex>` of a file's bytes. */
export function fileDigest(abs: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
}

/** `sha256:<hex>` of bytes. */
export function bytesDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** True when `abs` is a directory. */
export function isDir(abs: string): boolean {
  return statSync(abs).isDirectory();
}

const normal = (p: string) => normalize(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** The release's artifact of `kind` at `path` (relative to the member at `cwd`), if it records one. */
export function releaseArtifactAt(release: Release, kind: ReleaseArtifact["kind"], cwd: string, path: string): ReleaseArtifact | undefined {
  const rel = normal(isAbsolute(path) ? relative(cwd, path) : path);
  return release.artifactDigests.find((a) => a.kind === kind && normal(a.path) === rel);
}

/**
 * Refuse a file the release records at `path` whose digest is none of
 * `digests`, the identities the target can compute for it (the file's bytes,
 * and for an image its manifest and config digests).
 */
export function checkReleaseDigest(release: Release, kind: ReleaseArtifact["kind"], cwd: string, path: string, digests: readonly string[]): void {
  const recorded = releaseArtifactAt(release, kind, cwd, path);
  if (!recorded || digests.includes(recorded.digest)) return;
  throw new PublishTargetError(
    "publish-artifact-digest-mismatch",
    `${path} is not the ${kind} release ${release.releaseDigest} built: the release records ${recorded.digest}, and the file here is ${digests[0]}`,
    "Publish the files the cut built. A publish never builds, so restore them from the cut's build, or cut a new release.",
  );
}

/**
 * A target's `assets` with each `artifact:<name>` (#5151) made the paths the
 * release records for that `release.artifacts` entry, in path order. A name
 * the release records no file for is refused.
 */
export function expandArtifactAssets(release: Release, assets: readonly string[]): string[] {
  return assets.flatMap((a) => {
    if (!a.startsWith("artifact:")) return [a];
    const name = a.slice("artifact:".length);
    const paths = release.artifactDigests
      .filter((f) => f.kind === "asset" && f.component === name)
      .map((f) => f.path)
      .sort();
    if (paths.length === 0) {
      throw new PublishTargetError(
        "publish-artifact-not-recorded",
        `assets names ${a}, and release ${release.releaseDigest} records no file for an artifact "${name}"`,
        "Name an entry of release.artifacts the release was cut with, or cut a new release.",
      );
    }
    return paths;
  });
}

/** True when the run can get an OIDC ID token: a GitHub Actions job with `id-token: write`, or one in `variable`. */
export function hasIdToken(env: NodeJS.ProcessEnv, variable: string): boolean {
  return Boolean(env[variable] || (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN));
}

/**
 * The run's OIDC ID token for `audience` (#5167): the value of `variable`
 * when it is set, as a GitLab job's `id_tokens` entry gives it, else one
 * GitHub Actions issues. Masked by the context's redactor. Throws `code`
 * when there is none.
 */
export async function runIdToken(ctx: PublishContextBase, fetchImpl: PublishFetch, audience: string, variable: string, code: string): Promise<string> {
  const direct = ctx.env[variable];
  if (direct) {
    ctx.redactor.add(direct);
    return direct;
  }
  if (!(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL && ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) {
    throw new PublishTargetError(code, `this run has no OIDC ID token: not a GitHub Actions job with id-token: write, and ${variable} is not set`, `In GitHub Actions, give the job permissions: id-token: write. Elsewhere, put an ID token whose audience is ${audience} in ${variable}.`);
  }
  ctx.redactor.add(ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  const url = new URL(ctx.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  const res = await fetchImpl(url.toString(), { method: "GET", headers: { authorization: `Bearer ${ctx.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, accept: "application/json" } });
  const text = await res.text().catch(() => "");
  let value: unknown;
  try {
    value = res.status === 200 ? (JSON.parse(text) as { value?: unknown }).value : undefined;
  } catch {
    value = undefined;
  }
  if (typeof value !== "string" || !value) {
    throw new PublishTargetError(code, `GitHub Actions gave no OIDC ID token for ${audience}: it answered ${res.status}`, "Give the job permissions: id-token: write.");
  }
  ctx.redactor.add(value);
  return value;
}

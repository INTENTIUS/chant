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
 *
 * A file a target reads that the release records as an artifact at the same
 * path is checked against the release's digest, and a file that differs is
 * refused (`publish-artifact-digest-mismatch`). Other files are the commit's
 * by the checkout check (`checkCheckoutIsRelease` in ./release-publish.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { PublishDeclaration } from "./publish-declaration";
import { PublishTargetError, type PublishDeps, type PublishTarget } from "./release-publish";
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

/**
 * publish family — deploy-time promotion by identity to the env location.
 *
 * "Make the image available at the deploy target" has more than one backend:
 * `publish-image` promotes into a registry (ECR/ACR/Artifact Registry, pulled
 * by the target); `load-image-on-host` copies the tarball straight onto a host
 * and `docker load`s it (registry-less). Both satisfy the same
 * `PublishImageBackend` interface — the backend is env config, not a pipeline
 * fork. `publish-asset`/`publish-artifact` is the non-image sibling (S3 /
 * CodeArtifact) used by producer/library components (e.g. a jar for EMR).
 * See docs/components/build-archive.mdx.
 *
 * Typed stubs only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

// ── shared backend interface ─────────────────────────────────────────────────

/**
 * Common shape both image-publish backends satisfy: promote the image bytes
 * held in the build archive to wherever the deploy target can consume them,
 * and return the identity the apply step references.
 */
export type PublishImageBackend = Capability<PublishImageInput, PublishImageOutput>;

// ── publish-image (registry backend) ────────────────────────────────────────

export interface PublishImageInput {
  /** Path of the image tarball inside the build archive (as produced by `docker-build`). */
  from: string;
  /** Destination registry (e.g. `$env.registry` resolved by the orchestrator). */
  to: string;
  /** Additional tags to apply alongside the digest. */
  tags?: string[];
}

export interface PublishImageOutput {
  /** Content-addressed digest of the promoted image (`sha256:...`) — what the apply step references. */
  digest: string;
  /** Fully qualified image reference (`registry/repo@sha256:...`). */
  uri: string;
}

/** Promote a built image from the archive into the environment's container registry. */
export const publishImage: PublishImageBackend = stubCapability("publish-image");

// ── load-image-on-host (host backend) ───────────────────────────────────────

export interface LoadImageOnHostInput {
  /** Path of the image tarball inside the build archive. */
  from: string;
  /** Target host (SSM instance id, hostname, or host group). */
  host: string;
}

export interface LoadImageOnHostOutput {
  /** Content-addressed digest of the loaded image (`sha256:...`) — what the apply step references. */
  digest: string;
  /** Local image reference in the host's Docker store (no registry involved). */
  localRef: string;
}

/** Copy the image tarball to a host and `docker load` it — registry-free promotion. */
export const loadImageOnHost: PublishImageBackend = stubCapability("load-image-on-host");

// ── publish-asset / publish-artifact ────────────────────────────────────────

export interface PublishArtifactInput {
  /** Path of the artifact inside the build archive (e.g. a jar or zip). */
  from: string;
  /** Destination (e.g. `$env.s3` resolved by the orchestrator). */
  to: string;
}

export interface PublishArtifactOutput {
  /** Location the artifact was published to — referenced downstream as `@<component>.publish.uri`. */
  uri: string;
  /** Content hash of the published artifact. */
  digest: string;
}

/** Promote a non-image artifact (jar, zip, arbitrary asset) from the archive to S3/CodeArtifact. */
export const publishArtifact: Capability<PublishArtifactInput, PublishArtifactOutput> =
  stubCapability("publish-artifact");

/** Alias for `publishArtifact` — same capability, the docs/epic use both names for the same verb. */
export const publishAsset = publishArtifact;

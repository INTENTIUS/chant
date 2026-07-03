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
 * `publish-image` is a real implementation (#557, epic #551): it loads the
 * archived image tarball, tags it for the destination registry, logs in via
 * ECR, and pushes — promoting by digest, per the epic's build-once invariant.
 * `load-image-on-host`/`publish-artifact` are non-AWS-leaf/non-pilot verbs and
 * stay typed stubs — out of scope for #557; see ../capability.ts for the "no
 * cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";

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

/**
 * Promote a built image from the archive into the environment's container
 * registry: `docker load` the archived tarball, tag it for `to` (the env
 * registry), `aws ecr get-login-password | docker login`, then `docker push`.
 * Returns the pushed image's registry digest — what `cfn-deploy`/
 * `ecs-update-service` reference via `imageRef: "@Publish.digest"`. No
 * rollback: an already-pushed, still-valid image in the registry is not
 * itself a problem to compensate (immutable, content-addressed, and simply
 * unreferenced if a later step fails) — the opt-out this capability takes.
 */
export function createPublishImageCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): PublishImageBackend {
  return {
    kind: "publish-image",
    async run(_ctx, input) {
      const { digest: localDigest } = await executor.docker.load({ inFile: input.from });
      const repo = input.to.replace(/\/+$/, "");
      const target = `${repo}@${localDigest}`;
      await executor.docker.tag({ source: localDigest, target });
      const registry = repo.split("/")[0]!;
      await executor.ecr.login(registry);
      const { digest } = await executor.docker.push({ image: target });
      for (const tag of input.tags ?? []) {
        const tagged = `${repo}:${tag}`;
        await executor.docker.tag({ source: localDigest, target: tagged });
        await executor.docker.push({ image: tagged });
      }
      return { digest, uri: `${repo}@${digest}` };
    },
  };
}

/** Default `publish-image` capability, backed by the real `CloudExecutor`. */
export const publishImage: PublishImageBackend = createPublishImageCapability();

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

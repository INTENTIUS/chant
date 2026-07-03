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
 *
 * `load-image-on-host` is a real implementation (#564, epic #551 "4. Build
 * archive + deferred publish"): it copies the archived tarball onto a host
 * and runs `docker load` there via the injected `CloudExecutor.host` — no
 * registry in the path at all. Both backends promote **by digest**, never
 * rebuilding: the bytes they move are exactly what `docker-build` produced
 * into the archive (see ./build-archive.ts). `selectPublishBackend` below is
 * the per-environment choice between them — env config, not a pipeline fork,
 * per docs/components/build-archive.mdx#backend-selection-is-per-environment.
 *
 * `publish-artifact` remains a non-AWS-leaf/non-pilot verb and stays a typed
 * stub — out of scope for #557/#564; see ../capability.ts for the "no cloud
 * implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";
import { archiveRelativePath } from "./build-archive";

// ── shared backend interface ─────────────────────────────────────────────────

/**
 * Common input shape both image-publish backends accept: promote the image
 * bytes at archive path `from` to wherever the deploy target can consume
 * them. `to` (registry) and `host` (bare host) are each meaningful to only
 * one backend, so a component authors one step shape (see
 * docs/components/build-archive.mdx) and the env-selected backend (see
 * `selectPublishBackend` below) reads whichever field it needs — the
 * unselected backend's field is simply unused, never a pipeline fork.
 */
export interface PublishImageInput {
  /** Path of the image tarball inside the build archive (as produced by `docker-build`; an `archive:`-prefixed reference is accepted and stripped). */
  from: string;
  /** Destination registry — required by `publish-image`, ignored by `load-image-on-host` (e.g. `$env.registry` resolved by the orchestrator). */
  to?: string;
  /** Target host — required by `load-image-on-host`, ignored by `publish-image` (SSM instance id, hostname, or host group). */
  host?: string;
  /** Destination path for the tarball on the host, used only by `load-image-on-host`. Default: `/tmp/chant-archive/<basename of from>`. */
  hostPath?: string;
  /** Additional tags to apply alongside the digest, used only by `publish-image`. */
  tags?: string[];
}

export interface PublishImageOutput {
  /** Content-addressed digest of the promoted image (`sha256:...`) — what the apply step references. */
  digest: string;
  /** Image reference the apply step can pull/run: `registry/repo@sha256:...` for `publish-image`, a host-local reference for `load-image-on-host`. */
  uri: string;
}

/**
 * Common shape both image-publish backends satisfy: promote the image bytes
 * held in the build archive to wherever the deploy target can consume them,
 * and return the identity the apply step references. The backend is
 * selected per environment (`selectPublishBackend`), never per component.
 */
export type PublishImageBackend = Capability<PublishImageInput, PublishImageOutput>;

// ── publish-image (registry backend) ────────────────────────────────────────

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
      if (!input.to) throw new Error(`publish-image "${input.from}": "to" (destination registry) is required`);
      const { digest: localDigest } = await executor.docker.load({ inFile: archiveRelativePath(input.from) });
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

/** Default on-host tarball destination when `hostPath` is omitted, derived from the archive path's basename. */
function defaultHostPath(from: string): string {
  const base = archiveRelativePath(from).split("/").pop() ?? "image.tar";
  return `/tmp/chant-archive/${base}`;
}

/**
 * Copy the image tarball straight onto a host and `docker load` it there —
 * genuinely registry-free promotion (#564): no `docker.push`, no ECR login,
 * no registry ever in the path. Still promotes **by digest**: the tarball
 * copied is the exact archive artifact `docker-build` produced, so the image
 * loaded on the host is byte-identical to the one tested in any other
 * environment, satisfying the same build-once invariant `publish-image`
 * does. No rollback, for the same reason `publish-image` declares none: an
 * already-loaded, content-addressed image sitting in a host's local Docker
 * store is not itself a problem to compensate.
 *
 * See docs/components/build-archive.mdx#registry-less-caveat: this makes
 * *your built* image registry-free. Third-party images a compose file
 * references (`postgres:16`, `redis`) still pull from their upstream
 * registry at `compose up` unless they are archived and loaded the same way.
 */
export function createLoadImageOnHostCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): PublishImageBackend {
  return {
    kind: "load-image-on-host",
    async run(_ctx, input) {
      if (!input.host) throw new Error(`load-image-on-host "${input.from}": "host" is required`);
      const from = archiveRelativePath(input.from);
      const to = input.hostPath ?? defaultHostPath(input.from);
      await executor.host.copyFile({ host: input.host, from, to });
      const { digest } = await executor.host.dockerLoad({ host: input.host, path: to });
      return { digest, uri: `host:${input.host}#${digest}` };
    },
  };
}

/** Default `load-image-on-host` capability, backed by the real `CloudExecutor`. */
export const loadImageOnHost: PublishImageBackend = createLoadImageOnHostCapability();

// ── per-environment backend selection ───────────────────────────────────────

/** The `kind` of either image-publish backend — what an environment's config declares as its choice. */
export type PublishImageBackendKind = "publish-image" | "load-image-on-host";

/**
 * Resolve which publish backend an environment uses, given its declared
 * `kind` (`$env.publish.kind` in the component's env config — see
 * docs/components/build-archive.mdx#backend-selection-is-per-environment).
 * The decision is per environment, not per component: the same component's
 * `Publish` phase runs `publish-image` against dev's ECR and
 * `load-image-on-host` against a locked-down prod host, with no change to
 * the component's own composition — only the env config `kind` differs.
 *
 * Accepts an optional registry of backends so a caller can extend the set
 * (e.g. a third-party plugin registering another `PublishImageBackend`)
 * without this function needing to change; defaults to the two starter-set
 * backends built above.
 */
export function selectPublishBackend(
  kind: PublishImageBackendKind,
  backends: Partial<Record<PublishImageBackendKind, PublishImageBackend>> = {
    "publish-image": publishImage,
    "load-image-on-host": loadImageOnHost,
  },
): PublishImageBackend {
  const backend = backends[kind];
  if (!backend) {
    throw new Error(
      `no publish backend registered for kind "${kind}" (known: ${Object.keys(backends).sort().join(", ")})`,
    );
  }
  return backend;
}

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

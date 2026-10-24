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
 * `publish-artifact` (aliased `publish-asset`) uploads a single archive
 * artifact (jar/zip/asset) to S3 via `aws s3 cp` through the same
 * endpoint-aware `CloudExecutor`, returning the object URI and a content digest
 * of the uploaded bytes — the non-image sibling of `publish-image`.
 *
 * **#610 addition: publish-time SBOM/BOM referrer attach.** `publish-image`
 * optionally registers the archive's SBOM (and, when given, the
 * component-level aggregate BOM) as an OCI referrer on the just-pushed image
 * digest via `oras attach` — a registry-side convenience for `oras
 * discover`/`cosign tree` layered on top of the archive-carried copy, never a
 * replacement for it (see ../../lifecycle/build-ledger.ts's module doc: the
 * archive remains the universal home, working for every artifact type and
 * the registry-less `load-image-on-host` path, which this attach step
 * deliberately does not touch — non-image/registry-less publishes stay
 * archive-carried only). Attach is opt-in per call (`input.sbom` supplied),
 * guarded on `oras` availability, and never fails the publish itself: a
 * missing `oras` binary or a failed attach is reported back on the output
 * (`referrerAttach.attached: false` + a reason) rather than thrown, since the
 * image is already successfully promoted by the time this step runs — the
 * one part of this capability that is genuinely best-effort.
 */

import type { Capability } from "@intentius/chant/components/capability";
import { defaultCloudExecutor, type CloudExecutor } from "./cloud-executor";
import { archiveRelativePath } from "@intentius/chant/components/verbs/build-archive";
import { defaultProcessRunner, type ProcessRunner } from "@intentius/chant/components/verbs/process-runner";
import {
  createPublishImageCapability as createCorePublishImage,
  type PublishImageBackend,
  type RegistryLoginBackend,
} from "@intentius/chant/components/verbs/publish-image";

import {
  createPublishArtifactCapability as createCorePublishArtifact,
  type ArtifactStorageBackend,
  type PublishArtifactInput,
  type PublishArtifactOutput,
} from "@intentius/chant/components/verbs/publish-artifact";

// ── shared backend interface ─────────────────────────────────────────────────

export type {
  PublishImageInput,
  PublishImageOutput,
  PublishImageBackend,
  ReferrerAttachResult,
} from "@intentius/chant/components/verbs/publish-image";

// ── publish-image: the ECR backend (the verb itself is core's) ──────────────

/**
 * The aws lexicon's registry login for core's `publish-image` (#3142, #3143):
 * `aws ecr get-login-password | docker login`. The aws plugin contributes it;
 * core owns load, tag, push and the digest read-back.
 */
export function createEcrRegistryBackend(executor?: CloudExecutor): RegistryLoginBackend {
  return {
    name: "ecr",
    matches: (registry) => /\.dkr\.ecr(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(registry),
    // The real executor is built on first login, so loading the plugin shells out to nothing.
    login: (registry) => (executor ?? defaultCloudExecutor()).ecr.login(registry),
  };
}

/** The ECR backend the aws plugin contributes, over the real `CloudExecutor`. */
export const ecrRegistryBackend: RegistryLoginBackend = createEcrRegistryBackend();

/**
 * `publish-image` with ECR as its only login backend: core's verb, bound to
 * this executor. Kept so aws-only callers and tests build it the way they
 * always did; behaviour is unchanged (load, tag, ECR login, push, optional
 * referrer attach).
 */
export function createPublishImageCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
  processRunner: ProcessRunner = defaultProcessRunner(),
): PublishImageBackend {
  return createCorePublishImage({ docker: executor.docker, processRunner, backends: [createEcrRegistryBackend(executor)] });
}

/** `publish-image` bound to the real executor; the registered verb is core's, with this lexicon's ECR backend injected. */
export const publishImageCapability: PublishImageBackend = createPublishImageCapability();

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
export const loadImageOnHostCapability: PublishImageBackend = createLoadImageOnHostCapability();

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
    "publish-image": publishImageCapability,
    "load-image-on-host": loadImageOnHostCapability,
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

// ── publish-asset / publish-artifact (the verb is core's, #4408) ───────────

export type { PublishArtifactInput, PublishArtifactOutput } from "@intentius/chant/components/verbs/publish-artifact";

/**
 * The aws lexicon's storage backend for core's `publish-artifact`: `aws s3 cp`
 * (endpoint-aware through the `CloudExecutor`). Core owns the digest and the
 * object URI; this only uploads.
 */
export function createS3StorageBackend(executor?: CloudExecutor): ArtifactStorageBackend {
  return {
    name: "s3",
    matches: (uri) => uri.startsWith("s3://"),
    // The real executor is built on first upload, so loading the plugin shells out to nothing.
    upload: (args) => (executor ?? defaultCloudExecutor()).s3.cp(args),
  };
}

/** The S3 backend the aws plugin contributes, over the real `CloudExecutor`. */
export const s3StorageBackend: ArtifactStorageBackend = createS3StorageBackend();

/**
 * `publish-artifact` with S3 as its only storage backend: core's verb, bound
 * to this executor. Kept so aws-only callers and tests build it the way they
 * always did; behaviour is unchanged (upload, return uri + content digest).
 */
export function createPublishArtifactCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<PublishArtifactInput, PublishArtifactOutput> {
  return createCorePublishArtifact({ backends: [createS3StorageBackend(executor)] });
}

/** Default `publish-artifact`, bound to the real executor; the registered verb is core's, with this lexicon's S3 backend injected. */
export const publishArtifactCapability: Capability<PublishArtifactInput, PublishArtifactOutput> =
  createPublishArtifactCapability();

/** Alias for `publish-artifact`: same capability, the docs/epic use both names for the same verb. */
export const publishAssetCapability = publishArtifactCapability;

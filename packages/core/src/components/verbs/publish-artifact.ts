/**
 * `publish-artifact` (aliased `publish-asset`): the object-storage half of the
 * publish family, owned by core (#4408), the same way `publish-image` is.
 * "Put this archive file at the deploy target" is one agnostic verb; what
 * differs per cloud is the upload. Each cloud lexicon contributes that as an
 * {@link ArtifactStorageBackend} through `CapabilityPlugin.storageBackends()`
 * (aws: S3, azure: Blob, gcp: GCS), and the environment picks one (see
 * {@link selectStorageBackend}).
 *
 * This is a sibling of `registryBackends()` rather than a reuse of it: a
 * registry backend only logs a docker client in, while a storage backend
 * moves bytes, and the two are matched against different destinations.
 *
 * Core computes the content digest and the final object URI; the backend only
 * uploads. No rollback.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Capability } from "../capability";
import { archiveRelativePath } from "./build-archive";

export interface PublishArtifactInput {
  /** Path of the artifact inside the build archive (e.g. a jar or zip). */
  from: string;
  /** Destination (e.g. `$env.s3` resolved by the orchestrator). A trailing `/` appends the file's basename. */
  to: string;
  /** Which storage backend to use ("s3", "azure-blob", "gcs"). Normally left out: `$env.publish.backend` or the destination URI picks it. */
  backend?: string;
}

export interface PublishArtifactOutput {
  /** Location the artifact was published to, referenced downstream as `@<component>.publish.uri`. */
  uri: string;
  /** Content hash of the published artifact. */
  digest: string;
}

/** A cloud's way of putting one local file at a storage URI. */
export interface ArtifactStorageBackend {
  /** Stable name an environment selects by: "s3", "azure-blob", "gcs". */
  readonly name: string;
  /** True when this backend owns the destination URI. */
  matches(uri: string): boolean;
  /** Upload the local file `from` to the full object URI `to`. */
  upload(args: { from: string; to: string }): Promise<void>;
}

export class StorageBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageBackendError";
  }
}

/**
 * Pick the storage backend for one publish. Order: the step's `backend`, then
 * the environment's `ctx.vars.publish.backend`, then the single backend whose
 * `matches` claims the destination, then the only backend there is.
 */
export function selectStorageBackend(
  backends: readonly ArtifactStorageBackend[],
  uri: string,
  named?: string,
): ArtifactStorageBackend {
  const names = backends.map((b) => b.name).sort().join(", ") || "none";
  if (named) {
    const found = backends.find((b) => b.name === named);
    if (!found) {
      throw new StorageBackendError(
        `publish-artifact: no storage backend "${named}" is registered (available: ${names}); declare the lexicon that contributes it in chant.config.ts`,
      );
    }
    return found;
  }
  const matched = backends.filter((b) => b.matches(uri));
  if (matched.length === 1) return matched[0]!;
  if (matched.length > 1) {
    throw new StorageBackendError(
      `publish-artifact: destination "${uri}" matches several backends (${matched.map((b) => b.name).join(", ")}); set $env.publish.backend`,
    );
  }
  if (backends.length === 1) return backends[0]!;
  throw new StorageBackendError(
    `publish-artifact: cannot tell which storage backend serves "${uri}" (available: ${names}); set $env.publish.backend`,
  );
}

/** Implemented by a capability that wants the plugins' storage backends injected when a registry is built. */
export interface StorageBackendConsumer {
  withStorageBackends(backends: readonly ArtifactStorageBackend[]): Capability<never, unknown>;
}

export function isStorageBackendConsumer(value: unknown): value is StorageBackendConsumer {
  return typeof value === "object" && value !== null && typeof (value as StorageBackendConsumer).withStorageBackends === "function";
}

export type PublishArtifactCapability = Capability<PublishArtifactInput, PublishArtifactOutput> & StorageBackendConsumer;

/** Build the `publish-artifact` verb over the storage backends available. */
export function createPublishArtifactCapability(options: { backends?: readonly ArtifactStorageBackend[] } = {}): PublishArtifactCapability {
  const backends = options.backends ?? [];
  return {
    kind: "publish-artifact",
    withStorageBackends(next) {
      return createPublishArtifactCapability({ backends: next });
    },
    async run(ctx, input) {
      const localPath = archiveRelativePath(input.from);
      const digest = `sha256:${createHash("sha256").update(readFileSync(localPath)).digest("hex")}`;
      const basename = localPath.split("/").pop() ?? localPath;
      const uri = input.to.endsWith("/") ? `${input.to}${basename}` : input.to;
      const envBackend = (ctx.vars?.publish as { backend?: unknown } | undefined)?.backend;
      const backend = selectStorageBackend(backends, uri, input.backend ?? (typeof envBackend === "string" ? envBackend : undefined));
      await backend.upload({ from: localPath, to: uri });
      return { uri, digest };
    },
  };
}

/** The starter plugin's `publish-artifact`: storage backends injected from the loaded plugins. */
export const publishArtifactCapability: PublishArtifactCapability = createPublishArtifactCapability();

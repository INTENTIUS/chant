/**
 * A root's state read by version (#4762), for chant core's state export
 * (`@intentius/chant/state-export`): the version a bucket or container
 * holds now, whether it holds another, and one version's text.
 *
 *   s3       bucket versioning: the object's `x-amz-version-id`
 *   gcs      object versioning: a version is a generation
 *   azurerm  blob versioning: the blob's `x-ms-version-id`; with none, the
 *            snapshots the backend takes when it sets `snapshot = true`, and
 *            a request for the current version takes one, whose id names it
 *   http     a GitLab-managed state (./gitlab.ts): GitLab keeps each version
 *            by its serial, so the version id is the serial
 *
 * A local state keeps no versions, and is refused. Nothing here writes a
 * state; the one write is the azurerm snapshot above.
 *
 * Lifted from terragucci's `backend.ts` (`version`, `hasVersion`,
 * `readVersion` of its stores), so terragucci deletes its copy.
 */
import type { StateVersion, StateVersionSource } from "@intentius/chant/state-export";
import { AzureBlobClient, type AzureTarget } from "./azure-blob";
import { isRefused, stateLocation, type StateObject, type StoredState } from "./backend";
import { GcsClient } from "./gcs";
import type { GitLabStateStore } from "./gitlab";
import type { StoreFetch } from "./object-store";
import { S3Client } from "./s3";

/** What the version reads cover, for a refusal. */
export const READS_VERSIONS = "a state export reads versions of s3, gcs and azurerm states and GitLab-managed state";

function s3Versions(o: Extract<StoredState, { backend: "s3" }>, fetchFn?: StoreFetch): StateVersionSource {
  const client = new S3Client(o.target, fetchFn);
  return {
    location: `s3://${o.bucket}/${o.key}`,
    async current(): Promise<StateVersion> {
      const head = await client.head(o.key);
      if (!head.exists) return { exists: false };
      return head.versionId ? { exists: true, versionId: head.versionId } : { exists: true, off: `bucket versioning is off for ${o.bucket}, so it keeps only the latest state` };
    },
    hasVersion: (id) => client.hasVersion(o.key, id),
    readVersion: (id) => client.readVersion(o.key, id),
  };
}

function gcsVersions(o: Extract<StoredState, { backend: "gcs" }>, fetchFn?: StoreFetch): StateVersionSource {
  const client = new GcsClient(o.target, fetchFn);
  return {
    location: `gs://${o.bucket}/${o.key}`,
    async current(): Promise<StateVersion> {
      const head = await client.head(o.key);
      if (!head.exists) return { exists: false };
      if ((await client.versioning()) === false) return { exists: true, off: `object versioning is off for ${o.bucket}, so it keeps only the latest state` };
      return { exists: true, ...(head.generation ? { versionId: head.generation } : {}) };
    },
    hasVersion: async (id) => (await client.head(o.key, id)).exists,
    readVersion: (id) => client.readGeneration(o.key, id),
  };
}

function azureVersions(o: Extract<StoredState, { backend: "azurerm" }>, fetchFn?: StoreFetch): StateVersionSource {
  const client = new AzureBlobClient({ account: o.account, container: o.container, endpoint: o.endpoint, ...o.auth } as AzureTarget, fetchFn);
  // A blob that keeps versions names each by its version id; else by a snapshot.
  const at = async (id: string) => ((await client.head(o.key)).versionId ? { versionid: id } : { snapshot: id });
  return {
    location: `az://${o.account}/${o.container}/${o.key}`,
    async current(): Promise<StateVersion> {
      const head = await client.head(o.key);
      if (!head.exists) return { exists: false };
      if (head.versionId) return { exists: true, versionId: head.versionId };
      if (!o.snapshot) return { exists: true, off: `blob versioning is off for ${o.account}, and the backend takes no snapshots (snapshot = true), so it keeps only the latest state` };
      return { exists: true, versionId: await client.snapshot(o.key) };
    },
    hasVersion: async (id) => (await client.head(o.key, await at(id))).exists,
    readVersion: async (id) => client.readAt(o.key, await at(id)),
  };
}

/** A root's state as a version source, or why it has none: a refused backend, or a local state, which keeps no versions. */
export function stateVersionSource(o: StateObject, fetchFn?: StoreFetch): StateVersionSource | { refused: string } {
  if (isRefused(o)) return { refused: o.reason };
  if (o.backend === "local") return { refused: `the state is a local file, ${stateLocation(o)}, which keeps no versions; ${READS_VERSIONS}` };
  if (o.backend === "s3") return s3Versions(o, fetchFn);
  if (o.backend === "gcs") return gcsVersions(o, fetchFn);
  return azureVersions(o, fetchFn);
}

/** A GitLab-managed state as a version source: the version id is the serial. */
export function gitlabVersionSource(store: GitLabStateStore): StateVersionSource {
  return {
    location: store.location,
    async current(): Promise<StateVersion> {
      const now = await store.serial();
      return now ? { exists: true, versionId: String(now.serial) } : { exists: false };
    },
    hasVersion: async (id) => /^\d+$/.test(id) && (await store.hasVersion(id)),
    readVersion: (id) => store.readVersion(id),
  };
}

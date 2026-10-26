/**
 * A state where it is, opened for its lock and for what a run keeps beside
 * it. Each backend locks its own way:
 *
 *   s3       the lock file `use_lockfile` takes, `<key>.tflock`, written only
 *            when absent
 *   gcs      the lock object `<prefix>/<workspace>.tflock`, written only when
 *            absent; the ID `force-unlock` takes is its generation
 *   azurerm  a lease on the state blob, with the lock info base64 in its
 *            `terraformlockid` metadata; the binary cannot write the blob
 *            while chant holds the lease, so the store writes it
 *   local    a lock file `<path>.tflock` beside the state, created only when
 *            absent. It keeps another chant run out; the binary's own local
 *            lock is a file lock it takes per command, so the run writes
 *            with `-lock=false` while it holds this one. A bare
 *            `terraform apply` on the same checkout at the same time is not
 *            kept out. Ruled on #4481 (ruling 4, 2026-10-25): chant's own
 *            lock file, no Terraform lock-info file, local backends allowed.
 *
 * Lifted from terragucci's `backend.ts` (c493e0e): `StateStore`, `s3Store`,
 * `gcsStore` and `azureStore`, plus a local store and `removeBeside`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { AzureBlobClient, type AzureTarget } from "./azure-blob";
import type { AzureState, GcsState, LocalState, LockableState, S3State } from "./backend";
import { GcsClient } from "./gcs";
import { StoreError, type StoreFetch } from "./object-store";
import { S3Client } from "./s3";

/** The lock a state's backend holds: the ID `force-unlock` takes, and the lock info the binary (or a run) wrote. */
export interface LockHolder {
  id: string;
  /** The lock info as written, JSON. */
  info: string;
}

/** A state where it is, for what locks it and keeps beside it. */
export interface StateStore {
  readonly backend: LockableState["backend"];
  /** Where the state is. */
  readonly location: string;
  /** Where its lock is: the lock object, or the blob whose lease is the lock. */
  readonly lockLocation: string;
  /** The lock the backend holds now, or undefined. */
  heldLock(): Promise<LockHolder | undefined>;
  /** Take the state's lock with `info`, the way the backend takes it: false when it is held. */
  lock(info: string): Promise<boolean>;
  /** Release the lock `lock` took, or the one `adopt` took over. */
  unlock(): Promise<void>;
  /**
   * Write a new state under the lock, for a backend whose lock keeps the
   * binary from writing (azurerm's lease); undefined for a backend the
   * binary writes with `-lock=false` while the run holds the lock.
   */
  write?: (body: string) => Promise<void>;
  /**
   * The object beside the state whose key is the state's with `suffix` after
   * it, in the same bucket, container or directory, under the state's own
   * access controls: read (undefined when there is none), written, removed.
   */
  readBeside(suffix: string): Promise<string | undefined>;
  writeBeside(suffix: string, body: string): Promise<void>;
  removeBeside(suffix: string): Promise<void>;
  /** Where the object beside the state with `suffix` is, for messages. */
  besideLocation(suffix: string): string;
  /**
   * Take over a lock this store finds held, which an earlier run of the same
   * operation left held on purpose: `unlock` then releases it. A lease
   * (azurerm) is taken over by its ID, the others need nothing.
   */
  adopt(held: LockHolder): void;
}

/** The ID in a lock info's JSON, or "" when it names none. */
export function lockId(text: string): string {
  try {
    const v = JSON.parse(text) as { ID?: unknown };
    return typeof v.ID === "string" ? v.ID : "";
  } catch {
    return "";
  }
}

const JSON_TYPE = "application/json";

/** The S3 state, locked by the lock file `use_lockfile` takes. */
function s3Store(o: S3State, fetchFn?: StoreFetch): StateStore {
  const client = new S3Client(o.target, fetchFn);
  const lockKey = `${o.key}.tflock`;
  return {
    backend: "s3",
    location: `s3://${o.bucket}/${o.key}`,
    lockLocation: `s3://${o.bucket}/${lockKey}`,
    heldLock: async () => {
      const text = await client.get(lockKey);
      return text === undefined ? undefined : { id: lockId(text), info: text };
    },
    lock: (info) => client.putIfAbsent(lockKey, info, JSON_TYPE),
    unlock: () => client.remove(lockKey),
    readBeside: (suffix) => client.get(`${o.key}${suffix}`),
    writeBeside: (suffix, body) => client.put(`${o.key}${suffix}`, body, JSON_TYPE),
    removeBeside: (suffix) => client.remove(`${o.key}${suffix}`),
    besideLocation: (suffix) => `s3://${o.bucket}/${o.key}${suffix}`,
    adopt: () => {},
  };
}

/** The GCS state, locked by `<prefix>/<workspace>.tflock`, whose generation is the lock's ID. */
function gcsStore(o: GcsState, fetchFn?: StoreFetch): StateStore {
  const client = new GcsClient(o.target, fetchFn);
  return {
    backend: "gcs",
    location: `gs://${o.bucket}/${o.key}`,
    lockLocation: `gs://${o.bucket}/${o.lock}`,
    heldLock: async () => {
      const head = await client.head(o.lock);
      const info = head.exists ? await client.get(o.lock) : undefined;
      if (!head.exists || info === undefined) return undefined;
      return { id: head.generation ?? lockId(info), info };
    },
    lock: (info) => client.putIfAbsent(o.lock, info, JSON_TYPE),
    unlock: () => client.remove(o.lock),
    readBeside: (suffix) => client.get(`${o.key}${suffix}`),
    writeBeside: (suffix, body) => client.put(`${o.key}${suffix}`, body, JSON_TYPE),
    removeBeside: (suffix) => client.remove(`${o.key}${suffix}`),
    besideLocation: (suffix) => `gs://${o.bucket}/${o.key}${suffix}`,
    adopt: () => {},
  };
}

/** The metadata an azurerm backend keeps a lock's info in, base64 JSON, on the leased blob. */
export const LOCK_METADATA = "terraformlockid";

/** The azurerm state blob, locked by a lease on it with the lock info in its metadata. */
function azureStore(o: AzureState, fetchFn?: StoreFetch): StateStore {
  const client = new AzureBlobClient({ account: o.account, container: o.container, endpoint: o.endpoint, ...o.auth } as AzureTarget, fetchFn);
  let leaseId: string | undefined;
  const at = `az://${o.account}/${o.container}/${o.key}`;
  return {
    backend: "azurerm",
    location: at,
    lockLocation: at,
    heldLock: async () => {
      const head = await client.head(o.key);
      if (!head.exists || head.leaseState !== "leased") return undefined;
      const meta = head.metadata[LOCK_METADATA];
      const info = meta ? Buffer.from(meta, "base64").toString("utf-8") : "";
      return { id: lockId(info), info };
    },
    lock: async (info) => {
      const id = lockId(info);
      // The backend leases a blob that is there: a state with none yet gets an empty one first, as the backend makes it.
      if (!(await client.head(o.key)).exists) await client.putBlob(o.key, "", JSON_TYPE, { ifNoneMatch: true });
      if (!(await client.lease(o.key, "acquire", id))) return false;
      leaseId = id;
      await client.setMetadata(o.key, { [LOCK_METADATA]: Buffer.from(info).toString("base64") }, id);
      return true;
    },
    unlock: async () => {
      if (!leaseId) return;
      const id = leaseId;
      await client.setMetadata(o.key, {}, id);
      await client.lease(o.key, "release", id);
      leaseId = undefined;
    },
    write: async (body) => {
      if (!leaseId) throw new StoreError(`${at} is written under its lease, and none is held`);
      // As the backend writes it: a snapshot first when it takes snapshots, and the lock info kept on the blob.
      if (o.snapshot && (await client.head(o.key)).exists) await client.snapshot(o.key);
      const meta = (await client.head(o.key)).metadata;
      await client.putBlob(o.key, body, JSON_TYPE, { leaseId, metadata: meta });
    },
    readBeside: (suffix) => client.get(`${o.key}${suffix}`),
    writeBeside: async (suffix, body) => void (await client.putBlob(`${o.key}${suffix}`, body, JSON_TYPE)),
    removeBeside: (suffix) => client.remove(`${o.key}${suffix}`),
    besideLocation: (suffix) => `${at}${suffix}`,
    adopt: (held) => {
      leaseId = held.id;
    },
  };
}

/** A local state, locked by `<path>.tflock` created only when absent. `dir` is the root the path is relative to. */
function localStore(o: LocalState, dir: string): StateStore {
  const file = isAbsolute(o.path) ? o.path : join(dir, o.path);
  const lockFile = `${file}.tflock`;
  const read = (f: string): string | undefined => (existsSync(f) ? readFileSync(f, "utf-8") : undefined);
  return {
    backend: "local",
    location: file,
    lockLocation: lockFile,
    heldLock: async () => {
      const text = read(lockFile);
      return text === undefined ? undefined : { id: lockId(text), info: text };
    },
    lock: async (info) => {
      mkdirSync(dirname(lockFile), { recursive: true });
      try {
        writeFileSync(lockFile, info, { flag: "wx" });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    },
    unlock: async () => rmSync(lockFile, { force: true }),
    readBeside: async (suffix) => read(`${file}${suffix}`),
    writeBeside: async (suffix, body) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}${suffix}`, body);
    },
    removeBeside: async (suffix) => rmSync(`${file}${suffix}`, { force: true }),
    besideLocation: (suffix) => `${file}${suffix}`,
    adopt: () => {},
  };
}

/** The store a state is in, opened with the credentials stateObject chose. `dir` is the root a local path is relative to. */
export function stateStore(o: LockableState, dir: string, fetchFn?: StoreFetch): StateStore {
  if (o.backend === "s3") return s3Store(o, fetchFn);
  if (o.backend === "gcs") return gcsStore(o, fetchFn);
  if (o.backend === "azurerm") return azureStore(o, fetchFn);
  return localStore(o, dir);
}

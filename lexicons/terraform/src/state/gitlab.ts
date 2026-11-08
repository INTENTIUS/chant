/**
 * GitLab-managed Terraform state (#4773): an http backend whose address is a
 * GitLab project's state API, `<api>/projects/<id>/terraform/state/<name>`,
 * with `<address>/lock` as its lock and unlock address.
 *
 * GitLab keeps each version of a state by its serial. `GET <address>` is the
 * current state, `GET <address>/versions/<serial>` one version, and `POST`
 * and `DELETE` on `<address>/lock` (the backend's `LOCK` and `UNLOCK` by
 * default) take and release the lock. A lock that is held answers a take
 * with 409 and the holder's lock info. While a lock is held GitLab takes a
 * write of the state only with the lock's ID (`POST <address>?ID=<id>`), so
 * the binary cannot write with `-lock=false` under chant's lock and the store
 * writes the state itself, as the azurerm store does under its lease.
 *
 * The backend's configuration comes from the block, a `-backend-config` file
 * or flag (which `init` records), or the job's `TF_HTTP_*` variables (which
 * it does not record): each attribute is the recorded value, else its
 * variable (`TF_HTTP_ADDRESS`, `TF_HTTP_LOCK_ADDRESS`,
 * `TF_HTTP_UNLOCK_ADDRESS`, `TF_HTTP_LOCK_METHOD`, `TF_HTTP_UNLOCK_METHOD`),
 * as the binary reads it. Every call is made with the backend's own
 * credentials, `username` and `password` (`TF_HTTP_USERNAME`,
 * `TF_HTTP_PASSWORD`): the job token in a pipeline, a personal access token
 * at a shell.
 *
 * What a run keeps beside the state goes in another state of the same
 * project, named the state's name with the suffix after it, so it is under
 * the project's own access controls.
 *
 * Lifted from terragucci's `gitlab-state.ts` (INTENTIUS/terragucci 70b7509),
 * so terragucci deletes its copy.
 */
import { randomUUID } from "node:crypto";
import type { ForgeFetch } from "@intentius/chant/pr-forge";
import { defaultFetch, StoreError } from "./object-store";
import type { LockHolder, StateStore } from "./store";

/**
 * The HTTP calls the store makes. A StoreFetch, chant's forge fetch and the
 * global fetch all fit.
 */
export type GitLabFetch = ForgeFetch;

/** Where a GitLab-managed state is, and how to call its API. */
export interface GitLabState {
  backend: "http";
  /** The state's address as the backend has it. */
  address: string;
  /** The state's name, the last part of its address. */
  name: string;
  lockAddress?: string;
  unlockAddress?: string;
  lockMethod: string;
  unlockMethod: string;
  /** The Authorization header the backend's credentials make, when it has any. */
  auth?: string;
}

/** The path of GitLab's state API: `.../api/v4/projects/<id>/terraform/state/<name>`. */
const STATE_API_PATH = /\/api\/v4\/projects\/[^/]+\/terraform\/state\/([^/]+)\/?$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Whether an http backend's address is a GitLab project's state API. */
export function isGitLabAddress(address: string | undefined): boolean {
  if (!address) return false;
  try {
    return STATE_API_PATH.test(new URL(address).pathname);
  } catch {
    return false;
  }
}

/** A URL with its credentials and query left out, to print and record. */
export function shownUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw;
  }
}

/** The http backend's attribute, as the binary reads it: recorded, else its `TF_HTTP_*` variable. */
const attribute = (config: Record<string, unknown>, env: NodeJS.ProcessEnv, name: string): string | undefined => str(config[name]) ?? str(env[`TF_HTTP_${name.toUpperCase()}`]);

/** The GitLab-managed state an http backend's configuration names, or undefined when its address is not GitLab's state API. */
export function gitlabState(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): GitLabState | undefined {
  const address = attribute(config, env, "address");
  if (!address || !isGitLabAddress(address)) return undefined;
  const name = decodeURIComponent(new URL(address).pathname.match(STATE_API_PATH)![1]!);
  const username = attribute(config, env, "username");
  const password = attribute(config, env, "password");
  const lockAddress = attribute(config, env, "lock_address");
  const unlockAddress = attribute(config, env, "unlock_address");
  return {
    backend: "http",
    address,
    name,
    ...(lockAddress ? { lockAddress } : {}),
    ...(unlockAddress ? { unlockAddress } : {}),
    lockMethod: attribute(config, env, "lock_method") ?? "LOCK",
    unlockMethod: attribute(config, env, "unlock_method") ?? "UNLOCK",
    ...(username || password ? { auth: `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}` } : {}),
  };
}

/**
 * A GitLab state address with its state name suffixed `-<suffix>`, and a
 * lock address with the state name before `/lock` suffixed the same way.
 * Undefined when the address is not GitLab's state API (or its lock).
 */
export function suffixedGitLabAddress(address: string, suffix: string): string | undefined {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return undefined;
  }
  const m = u.pathname.match(/^(.*\/api\/v4\/projects\/[^/]+\/terraform\/state\/)([^/]+?)(\/lock)?\/?$/);
  if (!m) return undefined;
  u.pathname = `${m[1]}${m[2]}-${suffix}${m[3] ?? ""}`;
  return u.toString();
}

const headers = (s: GitLabState, json = false): Record<string, string> => ({ ...(s.auth ? { authorization: s.auth } : {}), ...(json ? { "content-type": "application/json" } : {}) });

const base = (address: string): string => address.replace(/\/+$/, "");

/** An error that names the call and GitLab's answer, never the credentials. */
function answered(what: string, url: string, status: number, text: string): StoreError {
  const why = status === 401 ? ": the backend's username and password (TF_HTTP_USERNAME, TF_HTTP_PASSWORD) are not a token GitLab accepts" : status === 403 ? ": the token may not read this project's state (reads need Developer)" : "";
  return new StoreError(`GitLab answered ${status} to ${what} ${shownUrl(url)}${why}${text && !why ? `: ${text.trim().slice(0, 200)}` : ""}`);
}

const held = (status: number): boolean => status === 409 || status === 423;

/** The URL of one version of the state. */
export const gitlabVersionUrl = (s: GitLabState, serial: string | number): string => `${base(s.address)}/versions/${encodeURIComponent(String(serial))}`;

/** The address of the state beside this one whose name is this one's with `suffix` after it. */
export function gitlabBesideAddress(s: GitLabState, suffix: string): string {
  const u = new URL(s.address);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${encodeURIComponent(suffix)}`;
  return u.toString();
}

/** The holder in GitLab's answer to a take of a lock that is held: its ID, its GitLab user and when it was taken. GitLab answers the other fields with the ask's own, so they are left out. */
function heldBy(text: string): string {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(["ID", "Who", "Created"].filter((k) => typeof v[k] === "string").map((k) => [k, v[k]])));
  } catch {
    return text;
  }
}

const idOf = (text: string): string => {
  try {
    const v = JSON.parse(text) as { ID?: unknown };
    return typeof v.ID === "string" ? v.ID : "";
  } catch {
    return "";
  }
};

/** A GitLab-managed state opened as a {@link StateStore}, with the reads GitLab's API has beyond one: its serial, its versions, and a lock released by its ID. */
export interface GitLabStateStore extends StateStore {
  readonly backend: "http";
  /**
   * The serial and lineage of the state GitLab holds now, or undefined when
   * it holds none. GitLab has no call that answers the serial alone, so this
   * reads the state and keeps those two fields only.
   */
  serial(): Promise<{ serial: number; lineage?: string } | undefined>;
  /** Whether GitLab keeps the version with this serial: a HEAD, so no state is read. */
  hasVersion(serial: string | number): Promise<boolean>;
  /** One version of the state, or undefined when GitLab keeps no version with that serial. */
  readVersion(serial: string | number): Promise<string | undefined>;
  /**
   * Who holds the lock, as lock info text with its ID, its GitLab user and
   * when it was taken, or undefined when nobody does. GitLab has no call that
   * reads a lock, so this asks for it: a held lock answers 409 with its
   * holder, and a free one is taken by the ask and released at once by its
   * own ID.
   */
  probeLock(): Promise<string | undefined>;
  /**
   * Release the lock with this ID. GitLab releases it only while that ID
   * holds it: another lock taken since answers 409, which is thrown.
   */
  releaseLock(id: string): Promise<void>;
}

/**
 * The GitLab-managed state as a store. `who` names the probe's lock info
 * (its `Who`, and the start of its ID), so a holder that reads the lock
 * while the probe has it sees whose it is.
 */
export function gitlabStore(s: GitLabState, fetchFn: GitLabFetch = defaultFetch, who = "chant"): GitLabStateStore {
  const location = shownUrl(s.address);
  let lockedId: string | undefined;

  const needLock = (): string => {
    if (!s.lockAddress || !s.unlockAddress) throw new StoreError(`the http backend of ${location} names no ${s.lockAddress ? "unlock_address" : "lock_address"}`);
    return s.lockAddress;
  };

  /** Take the lock with `info`: true when taken, the held answer's text when another holds it. */
  const take = async (info: string): Promise<true | { heldText: string }> => {
    const at = needLock();
    const r = await fetchFn(at, { method: s.lockMethod, headers: headers(s, true), body: info });
    const text = await r.text();
    if (held(r.status)) return { heldText: text };
    if (!r.ok) throw answered("a lock of", at, r.status, text);
    return true;
  };

  const releaseLock = async (id: string): Promise<void> => {
    if (!s.unlockAddress) throw new StoreError(`the http backend of ${location} names no unlock_address`);
    const r = await fetchFn(s.unlockAddress, { method: s.unlockMethod, headers: headers(s, true), body: JSON.stringify({ ID: id }) });
    const text = await r.text();
    if (held(r.status)) throw new StoreError(`GitLab did not release lock ${id} on ${shownUrl(s.unlockAddress)}: another lock holds the state now`);
    if (!r.ok) throw answered("a release of", s.unlockAddress, r.status, text);
  };

  const probeLock = async (): Promise<string | undefined> => {
    const id = `${who}-probe-${randomUUID()}`;
    const info = JSON.stringify({ ID: id, Operation: "OperationTypeInvalid", Info: `${who} reads who holds the lock`, Who: who, Version: "", Created: new Date().toISOString(), Path: "" });
    const got = await take(info);
    if (got !== true) return heldBy(got.heldText);
    await releaseLock(id);
    return undefined;
  };

  /** The text at `url`, or undefined when GitLab holds no state there. */
  const read = async (url: string): Promise<string | undefined> => {
    const r = await fetchFn(url, { method: "GET", headers: headers(s) });
    if (r.status === 404 || r.status === 204) return undefined;
    const text = await r.text();
    if (!r.ok) throw answered("a read of", url, r.status, text);
    return text;
  };

  const post = async (url: string, body: string): Promise<void> => {
    const r = await fetchFn(url, { method: "POST", headers: headers(s, true), body });
    const text = await r.text();
    if (held(r.status)) throw new StoreError(`GitLab refused a write of ${shownUrl(url)}: its lock is held by another ID`);
    if (!r.ok) throw answered("a write of", url, r.status, text);
  };

  return {
    backend: "http",
    location,
    lockLocation: shownUrl(s.lockAddress ?? s.address),
    serial: async () => {
      const text = await read(s.address);
      if (text === undefined) return undefined;
      let doc: { serial?: unknown; lineage?: unknown };
      try {
        doc = JSON.parse(text) as typeof doc;
      } catch {
        throw new StoreError(`GitLab answered ${location} with no state`);
      }
      if (typeof doc.serial !== "number") throw new StoreError(`the state at ${location} has no serial`);
      return { serial: doc.serial, ...(typeof doc.lineage === "string" ? { lineage: doc.lineage } : {}) };
    },
    hasVersion: async (serial) => {
      const url = gitlabVersionUrl(s, serial);
      const r = await fetchFn(url, { method: "HEAD", headers: headers(s) });
      if (r.status === 404) return false;
      if (!r.ok) throw answered("a check of", url, r.status, "");
      return true;
    },
    readVersion: async (serial) => {
      const url = gitlabVersionUrl(s, serial);
      const r = await fetchFn(url, { method: "GET", headers: headers(s) });
      if (r.status === 404) return undefined;
      const text = await r.text();
      if (!r.ok) throw answered("a read of", url, r.status, text);
      return text;
    },
    probeLock,
    releaseLock,
    heldLock: async (): Promise<LockHolder | undefined> => {
      const info = await probeLock();
      return info === undefined ? undefined : { id: idOf(info), info };
    },
    lock: async (info) => {
      if ((await take(info)) !== true) return false;
      lockedId = idOf(info);
      return true;
    },
    unlock: async () => {
      if (lockedId === undefined) return;
      await releaseLock(lockedId);
      lockedId = undefined;
    },
    write: async (body) => {
      if (lockedId === undefined) throw new StoreError(`${location} is written under its lock, and none is held`);
      const u = new URL(s.address);
      u.searchParams.set("ID", lockedId);
      await post(u.toString(), body);
    },
    readBeside: (suffix) => read(gitlabBesideAddress(s, suffix)),
    writeBeside: (suffix, body) => post(gitlabBesideAddress(s, suffix), body),
    removeBeside: async (suffix) => {
      const url = gitlabBesideAddress(s, suffix);
      const r = await fetchFn(url, { method: "DELETE", headers: headers(s) });
      if (r.status === 404) return;
      const text = await r.text();
      if (!r.ok) throw answered("a delete of", url, r.status, text);
    },
    besideLocation: (suffix) => shownUrl(gitlabBesideAddress(s, suffix)),
    adopt: (h) => {
      lockedId = h.id;
    },
  };
}

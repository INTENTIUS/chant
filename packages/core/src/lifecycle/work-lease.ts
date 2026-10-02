/**
 * The work lease (#2732, ws-055 option a): who is working on which work item,
 * as a lease beside the operator lease.
 *
 * A work item's lease is the operator lease (./lease.ts) under the key
 * `work/<id>`, so its ref is `refs/chant/lease/work/<id>`, or
 * `refs/chant/lease/_members/<member>/work/<id>` in a workspace member's
 * ledger (#2524 D7). It keeps every property the operator lease has: a claim
 * is one compare-and-set of that ref, the record carries a fencing token that
 * changes only when the lease changes hands, it expires after its time to
 * live, and it is pushed to and fetched from the project's remote. Unlike the
 * operator's, a work lease counts only once the remote has taken it
 * (`requirePush`), so two workers in separate clones cannot both hold one
 * item.
 *
 * The ref holds only the live lease. Every claim, renew and release also
 * appends a line to `_leases/<id>.jsonl` on `chant/lifecycle`, the same
 * append-only shape as `_gates/<op>.jsonl` (./gate-ledger.ts), so the history
 * of an item's leases is a ledger like the others.
 *
 * The lease is coordination, not a record of work: it never touches the
 * working branch, so it stays out of a release's nothing-to-ship test and out
 * of the write-scope checks (ws-055, and chud's own leases.mjs before it).
 *
 * Which ledger an item's lease lives in is decided by the caller through
 * `cwd`: `chant workspace work` passes the directory of the work kind file,
 * so the member owning the kind owns its items' leases wherever the command
 * runs from.
 */
import { sortedJsonReplacer } from "../utils";
import { getRuntime } from "../runtime-adapter";
import {
  acquireLease,
  leaseRef,
  LEASE_REF_PREFIX,
  LEASE_REMOTE_TRACKING_PREFIX,
  readLease,
  releaseLease,
  type LeaseRecord,
} from "./lease";
import {
  fetchLifecycleStatus,
  pushLifecycle,
  readBlobBySha,
  readBlobFromPath,
  readPathSha,
  RefCASConflictError,
  writeBlobToPath,
} from "./git";
import { dirname } from "node:path";
import type { ReasonCode } from "../workspace/reason-codes";
import { resolveMemberLedger } from "./member-ledger";

/** The key prefix of a work lease under the operator lease's ref namespace. */
export const WORK_LEASE_KEY_PREFIX = "work/";

/** The directory on `chant/lifecycle` that holds lease histories, under a member's prefix when it has one. */
export const LEASES_DIR = "_leases";

/** How long a claim lasts unless renewed: chud's default, which its dispatcher renews at a third of. */
export const DEFAULT_WORK_LEASE_TTL_MS = 10 * 60_000;

/** A work item id a lease can be keyed by: one ref path segment and one file name. */
export const WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** How long a claim waits out another process's lock on the ref before calling it stale. */
const LOCK_WAIT_MS = 2_000;
const APPEND_RETRY_ATTEMPTS = 5;

/** The lease key of work item `id`. */
export function workLeaseKey(id: string): string {
  return `${WORK_LEASE_KEY_PREFIX}${id}`;
}

/** The lease ref of work item `id` in the ledger with `memberPrefix`. */
export function workLeaseRef(id: string, memberPrefix = ""): string {
  return leaseRef(workLeaseKey(id), memberPrefix);
}

/** The path of work item `id`'s lease history on `chant/lifecycle`. */
export function leaseHistoryPath(id: string, memberPrefix = ""): string {
  return `${memberPrefix}${LEASES_DIR}/${id}.jsonl`;
}

/** One work item's lease, as the read contract reports it. */
export interface WorkLease {
  /** The work item's id. */
  item: string;
  holder: string;
  /** The fencing token: new on every claim, kept by every renew. */
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

/** A lease with whether it is still live at the time it was read. */
export interface WorkLeaseState extends WorkLease {
  state: "active" | "expired";
  /** The lease ref. */
  ref: string;
}

/** One line of `_leases/<id>.jsonl`. */
export interface LeaseHistoryRecord {
  version: 1;
  event: "claim" | "renew" | "release";
  item: string;
  /** The lease's holder. */
  holder: string;
  /** Who wrote this line: the holder, or, for the release of an expired lease, whoever closed it out. */
  by: string;
  token: string;
  acquiredAt: string;
  /** The lease's expiry after this event; a release keeps the expiry it had. */
  expiresAt: string;
  /** When the event happened. */
  timestamp: string;
  /** How the work ended, on a release. Free text such as done, not_done or skipped. */
  outcome?: string;
  note?: string;
}

/** Why a claim, renew or release was refused. Closed: a new code is a contract change. */
export const WORK_LEASE_REFUSALS = [
  /** Someone holds the lease live: another worker, or, for a claim, the same one. */
  "lease-held",
  /** Nobody holds it live: it expired, was released or was never claimed. */
  "lease-not-held",
  /** The live lease has another token than the one given. */
  "lease-token-mismatch",
  /** Another writer changed the lease between the read and the write. */
  "lease-race",
  /** The remote refused the push: another clone got there first, or it could not be reached. */
  "lease-push-rejected",
] as const satisfies readonly ReasonCode[];
export type WorkLeaseRefusal = (typeof WORK_LEASE_REFUSALS)[number];

/** Where the history line went. */
export interface LeaseHistoryWrite {
  path: string;
  commit: string;
  /** Whether `chant/lifecycle` reached the remote; false with no remote too. */
  pushed: boolean;
}

export type WorkLeaseResult =
  | { ok: true; lease: WorkLease; history: LeaseHistoryWrite }
  | { ok: false; reason: WorkLeaseRefusal; message: string; heldBy?: WorkLease };

export interface WorkLeaseOptions {
  /** A directory in the repository, inside the member whose ledger holds the lease. */
  cwd: string;
  now?: () => Date;
}

function toWorkLease(item: string, r: LeaseRecord): WorkLease {
  return { item, holder: r.holder, token: r.token, acquiredAt: r.acquiredAt, expiresAt: r.expiresAt };
}

function checkId(id: string): void {
  if (!WORK_ITEM_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error(`${JSON.stringify(id)} can't key a work lease: use letters, digits, ".", "_" and "-", starting with a letter or digit`);
  }
}

const REASONS: Record<string, WorkLeaseRefusal> = {
  held: "lease-held",
  "not-held": "lease-not-held",
  "token-mismatch": "lease-token-mismatch",
  race: "lease-race",
  "push-rejected": "lease-push-rejected",
};

function refusalMessage(id: string, reason: WorkLeaseRefusal, heldBy: WorkLease | undefined): string {
  const by = heldBy ? `${heldBy.holder} until ${heldBy.expiresAt}` : undefined;
  switch (reason) {
    case "lease-held":
      return `${id} is held by ${by}`;
    case "lease-not-held":
      return `${id} is not held${heldBy ? ` by the caller: ${by}` : ""}; claim it again`;
    case "lease-token-mismatch":
      return `${id} is held with another token (${heldBy?.token}) by ${by}`;
    case "lease-race":
      return `${id} changed while it was being written${by ? `: it is held by ${by}` : ""}`;
    case "lease-push-rejected":
      return `the remote refused the lease on ${id}${by ? `: it is held there by ${by}` : ", or could not be reached"}`;
  }
}

/**
 * Claim work item `id` for `holder` for `ttlMs`. Refused with `lease-held`,
 * naming the holder, when anyone holds it live, `holder` included; an expired
 * lease does not refuse a claim, and the new claim gets a new token.
 */
export async function claimWorkLease(
  id: string,
  holder: string,
  opts: WorkLeaseOptions & { ttlMs?: number; note?: string },
): Promise<WorkLeaseResult> {
  checkId(id);
  const result = await acquireLease(workLeaseKey(id), holder, {
    cwd: opts.cwd,
    ttlMs: opts.ttlMs ?? DEFAULT_WORK_LEASE_TTL_MS,
    now: opts.now,
    mode: "claim",
    requirePush: true,
    lockWaitMs: LOCK_WAIT_MS,
  });
  return finish(id, "claim", holder, result, opts);
}

/**
 * Move the expiry of `holder`'s live lease on `id` to `ttlMs` from now,
 * keeping its token. With `token`, the live lease must carry it. Refused with
 * `lease-not-held` once the lease has expired or was released: the holder
 * claims it again, and gets a new token.
 */
export async function renewWorkLease(
  id: string,
  holder: string,
  opts: WorkLeaseOptions & { ttlMs?: number; token?: string; note?: string },
): Promise<WorkLeaseResult> {
  checkId(id);
  const result = await acquireLease(workLeaseKey(id), holder, {
    cwd: opts.cwd,
    ttlMs: opts.ttlMs ?? DEFAULT_WORK_LEASE_TTL_MS,
    now: opts.now,
    mode: "renew",
    token: opts.token,
    requirePush: true,
    lockWaitMs: LOCK_WAIT_MS,
  });
  return finish(id, "renew", holder, result, opts);
}

async function finish(
  id: string,
  event: "claim" | "renew",
  holder: string,
  result: Awaited<ReturnType<typeof acquireLease>>,
  opts: WorkLeaseOptions & { note?: string },
): Promise<WorkLeaseResult> {
  if (!result.acquired || !result.lease) {
    const reason = REASONS[result.reason ?? "race"];
    const heldBy = result.heldBy ? toWorkLease(id, result.heldBy) : undefined;
    return { ok: false, reason, message: refusalMessage(id, reason, heldBy), ...(heldBy ? { heldBy } : {}) };
  }
  const lease = toWorkLease(id, result.lease);
  const now = opts.now?.() ?? new Date();
  const history = await appendLeaseHistory(
    { version: 1, event, item: id, holder, by: holder, token: lease.token, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, timestamp: now.toISOString(), ...(opts.note ? { note: opts.note } : {}) },
    opts,
  );
  return { ok: true, lease, history };
}

/**
 * Give the lease on `id` back. The holder releases a live lease (with
 * `token`, only that one); anyone may release an expired one, which is how an
 * abandoned claim is closed out. `outcome` says how the work ended. Refused
 * with `lease-not-held` when there is no lease, and `lease-held` when someone
 * else holds it live.
 */
export async function releaseWorkLease(
  id: string,
  by: string,
  opts: WorkLeaseOptions & { token?: string; outcome?: string; note?: string },
): Promise<WorkLeaseResult> {
  checkId(id);
  const key = workLeaseKey(id);
  const now = opts.now?.() ?? new Date();
  const { record } = await readLease(key, { cwd: opts.cwd });
  if (!record) return { ok: false, reason: "lease-not-held", message: refusalMessage(id, "lease-not-held", undefined) };
  const current = toWorkLease(id, record);
  const live = new Date(record.expiresAt).getTime() > now.getTime();
  if (live && record.holder !== by) return { ok: false, reason: "lease-held", message: refusalMessage(id, "lease-held", current), heldBy: current };
  if (opts.token !== undefined && record.token !== opts.token) {
    return { ok: false, reason: "lease-token-mismatch", message: refusalMessage(id, "lease-token-mismatch", current), heldBy: current };
  }
  if (!(await releaseLease(key, record.holder, record.token, { cwd: opts.cwd }))) {
    const after = (await readLease(key, { cwd: opts.cwd })).record;
    const heldBy = after ? toWorkLease(id, after) : undefined;
    return { ok: false, reason: "lease-race", message: refusalMessage(id, "lease-race", heldBy), ...(heldBy ? { heldBy } : {}) };
  }
  const history = await appendLeaseHistory(
    {
      version: 1,
      event: "release",
      item: id,
      holder: record.holder,
      by,
      token: record.token,
      acquiredAt: record.acquiredAt,
      expiresAt: record.expiresAt,
      timestamp: now.toISOString(),
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    },
    opts,
  );
  return { ok: true, lease: current, history };
}

/**
 * Append one line to `_leases/<id>.jsonl`, with the same read-then-CAS retry
 * the gate ledger's appends use, then push `chant/lifecycle`. The branch is
 * fetched first when it fast-forwards, and the push is best-effort: the lease
 * ref is what coordinates, and a history that did not reach the remote is
 * reported as `pushed: false` rather than failing a lease that was taken.
 */
async function appendLeaseHistory(record: LeaseHistoryRecord, opts: { cwd: string }): Promise<LeaseHistoryWrite> {
  await fetchLifecycleStatus(opts).catch(() => undefined);
  const file = `${record.item}.jsonl`;
  const json = JSON.stringify(record, sortedJsonReplacer);
  let commit: string | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS && commit === undefined; attempt++) {
    try {
      const priorSha = await readPathSha(LEASES_DIR, file, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${json}` : json;
      commit = await writeBlobToPath(LEASES_DIR, file, content, `Work lease ${record.event}: ${record.item} (${record.holder})`, {
        ...opts,
        expectPriorPathSha: priorSha,
      });
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  if (commit === undefined) throw lastErr;
  const pushed = await pushLifecycle(opts).catch(() => false);
  const { prefix } = await resolveMemberLedger(opts.cwd);
  return { path: leaseHistoryPath(record.item, prefix), commit, pushed };
}

/** Parse the text of a lease history file, oldest first. Malformed lines are counted and skipped. */
export function parseLeaseHistory(content: string): { records: LeaseHistoryRecord[]; malformed: number } {
  const records: LeaseHistoryRecord[] = [];
  let malformed = 0;
  for (const line of content.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Partial<LeaseHistoryRecord>;
      const ok =
        r.version === 1 &&
        (r.event === "claim" || r.event === "renew" || r.event === "release") &&
        [r.item, r.holder, r.by, r.token, r.acquiredAt, r.expiresAt, r.timestamp].every((v) => typeof v === "string");
      if (ok) records.push(r as LeaseHistoryRecord);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** Read work item `id`'s lease history in the ledger of the project at `opts.cwd`. Empty when it has none. */
export async function readLeaseHistory(id: string, opts: { cwd: string }): Promise<{ records: LeaseHistoryRecord[]; malformed: number }> {
  checkId(id);
  const content = await readBlobFromPath(LEASES_DIR, `${id}.jsonl`, opts);
  return content ? parseLeaseHistory(content) : { records: [], malformed: 0 };
}

function parseRecord(raw: string): LeaseRecord | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LeaseRecord>;
    return typeof v.holder === "string" && typeof v.token === "string" && typeof v.acquiredAt === "string" && typeof v.expiresAt === "string"
      ? (v as LeaseRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every work lease in the ledger with `memberPrefix`, read from the local
 * refs only: the lease refs this clone wrote, and the remote's as last
 * fetched (`refs/chant/lease-remote/`), the fresher of the two per item, as
 * `readLease` picks. It never fetches, so a read-only report stays off the
 * network; a claim or renew fetches before it decides. Released leases have
 * no ref and are not listed; expired ones are, with `state: "expired"`.
 * Sorted by item.
 */
export async function listWorkLeases(opts: { cwd: string; memberPrefix: string; now?: Date }): Promise<WorkLeaseState[]> {
  const rt = getRuntime();
  const now = (opts.now ?? new Date()).getTime();
  const local = `${LEASE_REF_PREFIX}${opts.memberPrefix}${WORK_LEASE_KEY_PREFIX}`;
  const remote = `${LEASE_REMOTE_TRACKING_PREFIX}${opts.memberPrefix}${WORK_LEASE_KEY_PREFIX}`;
  const out = await rt.spawn(["git", "for-each-ref", "--format=%(refname) %(objectname)", local, remote], { cwd: opts.cwd });
  if (out.exitCode !== 0) return [];
  const best = new Map<string, LeaseRecord>();
  for (const line of out.stdout.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(" ");
    const id = ref.startsWith(local) ? ref.slice(local.length) : ref.slice(remote.length);
    if (!WORK_ITEM_ID_PATTERN.test(id)) continue;
    const record = parseRecord((await readBlobBySha(sha, opts)) ?? "");
    if (!record) continue;
    const prior = best.get(id);
    const key = (r: LeaseRecord) => `${r.acquiredAt} ${r.expiresAt}`;
    if (!prior || key(record) > key(prior) || (key(record) === key(prior) && ref.startsWith(local))) best.set(id, record);
  }
  return [...best.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, r]) => ({
      ...toWorkLease(id, r),
      state: new Date(r.expiresAt).getTime() > now ? ("active" as const) : ("expired" as const),
      ref: workLeaseRef(id, opts.memberPrefix),
    }));
}

/**
 * The active lease of each work item of the kind at `kindFile`, by item id,
 * for `chant workspace records --json`. Read from the local refs of the
 * ledger owning the kind file's directory, without fetching. Empty when
 * nothing can be read.
 */
export async function activeWorkLeases(kindFile: string, now = new Date()): Promise<Map<string, Omit<WorkLease, "item">>> {
  const cwd = dirname(kindFile);
  try {
    const { prefix } = await resolveMemberLedger(cwd);
    const leases = await listWorkLeases({ cwd, memberPrefix: prefix, now });
    return new Map(leases.filter((l) => l.state === "active").map((l) => [l.item, { holder: l.holder, token: l.token, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt }]));
  } catch {
    return new Map();
  }
}

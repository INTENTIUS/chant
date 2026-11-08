/**
 * A stale state lock released behind a gated request (#4762): the lock a
 * job killed mid-apply left behind, released once someone else approved
 * that lock by its ID, and only while no run that may hold it is alive.
 *
 * Engine-neutral. The engine's adapter is a {@link StateLockSource}: where
 * the lock is, the lock it holds now, and a release by ID. The terraform
 * lexicon builds one from a root's backend and the binary's `force-unlock`
 * (`@intentius/chant-lexicon-terraform/state-unlock`); a Pulumi stack's lock
 * (`.pulumi/locks/...` and `pulumi cancel`) fits the same calls. The runs
 * come from the forge ({@link forgeLiveRuns}), or the caller's own list.
 *
 *   1. The lock is read, with its ID, who took it and when.
 *   2. A run of the repository that has not finished and began before the
 *      lock was taken (give or take {@link CLOCK_SKEW_MS}) may be the one
 *      holding it, so while one is alive nothing is asked and nothing is
 *      released. A forge that cannot be read refuses too: nothing then says
 *      the holder is gone.
 *   3. The request (kind `unlock`, subject the root or stack, fields the
 *      lock's location and ID) waits for an approval by someone other than
 *      the requester. An approval binds that lock and no other.
 *   4. Approved, the runs are read again just before the spend, the lock is
 *      released by its ID, read again to check it is gone, and the finished
 *      line records who released which lock under whose approval.
 */
import { CHANT_EXIT } from "./exit-codes";
import { gatedOp, type GatedRequestLedger } from "./lifecycle/gated-op";
import type { GatedRequestRules } from "./lifecycle/gated-request";
import type { ForgeFetch, ForgeKind } from "./pr-forge";

/** The first chant with the engine-neutral lock release and {@link forgeLiveRuns} (#4762). */
export const STATE_UNLOCK_FLOOR = "0.124.77";

/** A run of the repository that has not finished, as {@link forgeLiveRuns} reads it. */
export interface LiveRun {
  id: string;
  status: string;
  /** When it began, or was created when the forge gives no start. ISO 8601. */
  started?: string;
  url?: string;
}

/** Where {@link forgeLiveRuns} reads a repository's runs. */
export interface LiveRunsTarget {
  kind: ForgeKind;
  /** The forge's API base: `https://api.github.com`, `https://<host>/api/v1`, `https://<host>/api/v4`. */
  apiBase: string;
  /** `owner/repo` on GitHub and Forgejo; the project's id or path on GitLab. */
  repo: string;
  token?: string;
  /** GitLab: the header the token goes in. Default `PRIVATE-TOKEN`. */
  tokenHeader?: "PRIVATE-TOKEN" | "JOB-TOKEN";
  fetch?: ForgeFetch;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * The repository's runs that have not finished: GitHub's and Forgejo's
 * Actions runs queued, waiting or in progress, GitLab's pipelines running,
 * pending, preparing or waiting for a resource. Kept here rather than on the
 * forge clients, so the bundles that carry those clients do not grow with
 * a read only a lock release makes. Throws on a forge that answers an error.
 */
export async function forgeLiveRuns(t: LiveRunsTarget): Promise<LiveRun[]> {
  const fetchFn = t.fetch ?? (globalThis.fetch as unknown as ForgeFetch);
  const base = t.apiBase.replace(/\/+$/, "");
  const headers: Record<string, string> =
    t.kind === "github"
      ? { ...(t.token ? { Authorization: `Bearer ${t.token}` } : {}), Accept: "application/vnd.github+json" }
      : t.kind === "forgejo"
        ? { ...(t.token ? { Authorization: `token ${t.token}` } : {}), Accept: "application/json" }
        : { ...(t.token ? { [t.tokenHeader ?? "PRIVATE-TOKEN"]: t.token } : {}), Accept: "application/json" };
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${base}${path}`, { method: "GET", headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`GET ${base}${path}: ${res.status} ${body.slice(0, 200)}`);
    return body ? (JSON.parse(body) as unknown) : undefined;
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const out = new Map<string, LiveRun>();
  if (t.kind === "gitlab") {
    const project = encodeURIComponent(decodeURIComponent(t.repo));
    for (const status of ["running", "pending", "preparing", "waiting_for_resource"]) {
      const rows = await get(`/projects/${project}/pipelines?status=${status}&per_page=100`);
      for (const p of Array.isArray(rows) ? rows : []) {
        if (!isObject(p) || p.id === undefined) continue;
        const started = text(p.started_at) ?? text(p.created_at);
        const url = text(p.web_url);
        out.set(String(p.id), { id: String(p.id), status: text(p.status) ?? status, ...(started ? { started } : {}), ...(url ? { url } : {}) });
      }
    }
    return [...out.values()];
  }
  const statuses = t.kind === "github" ? ["in_progress", "queued", "waiting", "pending", "requested"] : ["running", "waiting", "blocked"];
  for (const status of statuses) {
    const body = await get(`/repos/${t.repo}/actions/runs?status=${status}&${t.kind === "github" ? "per_page=100" : "limit=50"}`);
    const runs = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    for (const r of runs) {
      if (!isObject(r) || r.id === undefined) continue;
      const started = t.kind === "github" ? (text(r.run_started_at) ?? text(r.created_at)) : (text(r.started) ?? text(r.created));
      // Forgejo leaves `started` at the epoch until a job starts.
      const begun = started && Date.parse(started) > 0 ? started : (text(r.created) ?? text(r.created_at));
      const url = text(r.html_url);
      out.set(String(r.id), { id: String(r.id), status: text(r.status) ?? status, ...(begun ? { started: begun } : {}), ...(url ? { url } : {}) });
    }
  }
  return [...out.values()];
}

/** How far a run's start may be after the lock's and still count as a run that could hold it: the clocks of the job and the forge differ. */
export const CLOCK_SKEW_MS = 2 * 60 * 1000;

/** A lock's info, as Terraform's binary writes it and other engines can name it. */
export interface LockInfo {
  ID: string;
  Operation?: string;
  Info?: string;
  Who?: string;
  Version?: string;
  Created?: string;
  Path?: string;
}

/** A lock info's JSON, or undefined when it holds no lock ID. */
export function parseLockInfo(text: string): LockInfo | undefined {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.ID !== "string" || v.ID === "") return undefined;
    const out: LockInfo = { ID: v.ID };
    for (const k of ["Operation", "Info", "Who", "Version", "Created", "Path"] as const) if (typeof v[k] === "string") out[k] = v[k] as string;
    return out;
  } catch {
    return undefined;
  }
}

/** An engine's state lock: the adapter a product's engine supplies. */
export interface StateLockSource {
  /** Where the lock is, as messages and the record name it. Never a credential. */
  readonly location: string;
  /** The lock held now, or undefined when none is. */
  read(): Promise<LockInfo | undefined>;
  /** Release the lock with this ID, and no other. */
  release(id: string): Promise<void>;
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The live runs that may hold a lock taken at `created`: those that began
 * before it, give or take the clocks' skew. A lock with no time it was taken,
 * or a run with no start, keeps every run in.
 */
export function possibleHolders(runs: readonly LiveRun[], created: string | undefined, skewMs = CLOCK_SKEW_MS): LiveRun[] {
  const taken = time(created);
  return runs.filter((r) => Number.isNaN(taken) || Number.isNaN(time(r.started)) || time(r.started) <= taken + skewMs);
}

/** A lock as one line: its ID, operation, holder and time. */
export const describeLock = (l: LockInfo): string => `lock ${l.ID}${l.Operation ? `, ${l.Operation}` : ""}${l.Who ? ` by ${l.Who}` : ""}${l.Created ? ` at ${l.Created}` : ""}`;

/** A run as one line. */
export const describeRun = (r: LiveRun): string => `run ${r.id} (${r.status}${r.started ? `, began ${r.started}` : ""})${r.url ? ` ${r.url}` : ""}`;

/** The product's words for a release. */
export interface StateUnlockWords {
  /** The op the requests wait at, such as `tf-unlock`. */
  op: string;
  /** The request's kind. Default `unlock`. */
  kind?: string;
  /** The command that approves a request, as the product prints it. Default chant's. */
  approveCommand?: (subject: string, digest: string) => string;
}

export interface StateUnlockInput {
  /** Whose lock: a root, a stack. The gate the request waits at. */
  subject: string;
  /** The requester. Their own approval never counts. */
  by: string;
  lock: StateLockSource;
  /**
   * The repository's runs that have not finished, such as
   * {@link forgeLiveRuns}. Read before the request and again just before
   * the spend. A throw refuses the release.
   */
  liveRuns: () => Promise<LiveRun[]>;
  words: StateUnlockWords;
  rules: GatedRequestRules;
  cwd?: string;
  base?: string;
  /** How long a request waits for its approval. Default 48h. */
  expiry?: string;
  now?: string;
  commit?: string;
  skewMs?: number;
  ledger?: GatedRequestLedger;
}

/** How a release ended. `exit` is the code its command exits with. */
export type StateUnlockOutcome =
  | { status: "free"; exit: 0; location: string }
  | { status: "released"; exit: 0; location: string; lock: LockInfo; digest: string; approvedBy: string; liveRuns: number; recorded: boolean }
  /** A run that may hold the lock is alive: nothing was asked or released. */
  | { status: "alive"; exit: 5; location: string; lock: LockInfo; alive: LiveRun[] }
  | { status: "waiting"; exit: 3; location: string; lock: LockInfo; digest: string; command: string }
  | { status: "refused"; exit: 3; location: string; lock: LockInfo; digest: string; command: string; by: string; reason: string }
  /** Approved, and a run that may hold the lock came back before the spend: the approval stands unspent. */
  | { status: "held"; exit: 5; location: string; lock: LockInfo; digest: string; reason: string }
  | { status: "spent"; exit: 1; location: string; lock: LockInfo; digest: string }
  | { status: "failed"; exit: 1; location: string; lock: LockInfo; digest: string; error: Error; recorded: boolean };

/** A refusal before anything is asked: the runs could not be read. */
export class StateUnlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUnlockError";
  }
}

/** Release a state's lock that no live run can hold, once an approval of that lock stands. */
export async function releaseStateLock(input: StateUnlockInput): Promise<StateUnlockOutcome> {
  const location = input.lock.location;
  const lock = await input.lock.read();
  if (!lock) return { status: "free", exit: CHANT_EXIT.done, location };
  let live = 0;
  const holders = async (): Promise<LiveRun[]> => {
    let runs: LiveRun[];
    try {
      runs = await input.liveRuns();
    } catch (e) {
      throw new StateUnlockError(`the repository's runs could not be read (${(e as Error).message}), so nothing says the run holding ${describeLock(lock)} is gone`);
    }
    live = runs.length;
    return possibleHolders(runs, lock.Created, input.skewMs);
  };
  const alive = await holders();
  if (alive.length > 0) return { status: "alive", exit: CHANT_EXIT.held, location, lock, alive };

  const result = await gatedOp(
    {
      op: input.words.op,
      request: { kind: input.words.kind ?? "unlock", subject: input.subject, by: input.by, fields: { location, id: lock.ID } },
      rules: input.rules,
      description: `release ${describeLock(lock)} on ${location}`,
      expiry: input.expiry ?? "48h",
      ...(input.base ? { base: input.base } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.ledger ? { ledger: input.ledger } : {}),
      // The approval may be hours old: the runs are read again just before the spend.
      beforeSpend: async () => {
        const still = await holders();
        return still.length > 0 ? `a run that began before the lock is alive again (${still.map(describeRun).join("; ")}), so the lock is not released` : undefined;
      },
    },
    async ({ approvedBy }) => {
      await input.lock.release(lock.ID);
      const after = await input.lock.read();
      if (after?.ID === lock.ID) throw new StateUnlockError(`the release of lock ${lock.ID} ran, and ${location} still holds it`);
      return {
        output: approvedBy,
        detail: {
          by: input.by,
          location,
          lock_id: lock.ID,
          ...(lock.Operation ? { operation: lock.Operation } : {}),
          ...(lock.Who ? { locked_by: lock.Who } : {}),
          ...(lock.Created ? { locked_at: lock.Created } : {}),
          approved_by: approvedBy,
          live_runs: live,
        },
      };
    },
  );
  const command = (fallback: string): string => (input.words.approveCommand ? input.words.approveCommand(input.subject, result.digest) : fallback);
  const at = { location, lock, digest: result.digest };
  switch (result.status) {
    case "done":
      return { status: "released", exit: CHANT_EXIT.done, ...at, approvedBy: result.approvedBy, liveRuns: live, recorded: result.recorded };
    case "waiting":
      return { status: "waiting", exit: CHANT_EXIT.waiting, ...at, command: command(result.command) };
    case "refused":
      return { status: "refused", exit: CHANT_EXIT.waiting, ...at, command: command(result.command), by: result.by, reason: result.reason };
    case "held":
      return { status: "held", exit: CHANT_EXIT.held, ...at, reason: result.reason };
    case "spent":
      return { status: "spent", exit: CHANT_EXIT.failed, ...at };
    case "failed":
      return { status: "failed", exit: CHANT_EXIT.failed, ...at, error: result.error, recorded: result.recorded };
  }
}

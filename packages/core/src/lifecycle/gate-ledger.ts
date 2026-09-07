/**
 * Gate resolution ledger (#1485, epic #1487) — the durable counterpart to a
 * converge tick's gate-as-fact outcome (`./converge-ledger.ts`'s
 * `ConvergeRuleOutcome.action === "gated"`). Same append-only, content-
 * addressed shape as the converge/release ledgers, reusing
 * `writeBlobToPath`/`readBlobFromPath` (./git.ts) directly — one line per
 * resolution at `_gates/<op>.jsonl` on the `chant/lifecycle` orphan branch.
 *
 * Keyed by op name rather than environment (`_gates`, not `<env>/gates...`)
 * because a gate belongs to the *dispatched* op — the thing a converge
 * rule's `run()` action names — and that op's own env, if it declares one at
 * all, isn't always the calling `ConvergeOp`'s env. `writeBlobToPath`'s own
 * doc already establishes this generic-namespace pattern
 * (`./build-ledger-store.ts`'s `_builds`); this is the same move for a
 * second non-env top-level directory.
 *
 * `chant approve <op> <gate>` (`../cli/handlers/operator.ts`) is what
 * appends a resolution — issue #1485's "resolution is an out-of-band act
 * that writes the counterpart fact". Per that issue's leaning on open
 * question 3 ("local trust in v1, signature as an additive follow-up"),
 * this record is *not* itself an authorization check — anyone who can run
 * `chant approve` locally can write one, the same trust boundary a local
 * commit already has.
 *
 * Since #2119 the file carries both halves of the loop. A `gate` step the
 * local executor reaches (`../op/local-executor.ts`) appends a
 * {@link PendingGateRecord} and ends that run with status `gated`; `chant
 * approve` appends the {@link GateResolutionRecord} that answers it; the next
 * run reads both, finds a resolution newer than the pending fact, and walks
 * through the gate carrying the approver. A resolution older than the newest
 * pending fact is not an answer to it — {@link latestResolutionSince} applies
 * that rule for the executor and for `chant operator status` alike. Both kinds
 * of line share one file, told apart by {@link GateLedgerRecord}'s `kind`
 * (absent on the resolution lines written before #2119, which is why
 * `"resolution"` is the default reading).
 */
import { sortedJsonReplacer } from "../utils";
import { readBlobFromPath, readPathSha, readBlobBySha, writeBlobToPath, RefCASConflictError } from "./git";

const DIR = "_gates";
const APPEND_RETRY_ATTEMPTS = 5;

/**
 * The address of the approval surface for a gate, resolved from the CI
 * environment (#2028).
 *
 * #1485's argument for gate-as-fact was that approval gets an address:
 * "gate-as-PR gives approval a URL, a review surface, and CODEOWNERS as the
 * authorization model." What shipped recorded the gate and not the address,
 * so a pending-approval card had nothing to link to and gate-as-PR stayed a
 * convention. This is the narrow, honest half of that: when a tick (or a
 * `chant approve`) runs inside the PR/MR job that carries the change, the
 * loop genuinely knows where approval happens, and says so. Anywhere else it
 * returns `undefined` and the field is simply absent — never a guess, never a
 * synthesized link.
 *
 * The env-var fallback chain is the same one `--actor` and `--run-id` already
 * use (`../cli/handlers/components.ts`): GitHub Actions first, then GitLab CI.
 *
 * - GitHub Actions on a `pull_request` event: `GITHUB_SERVER_URL` +
 *   `GITHUB_REPOSITORY` + the PR number, which `GITHUB_REF_NAME` carries as
 *   `<n>/merge`. A push-event run has no PR, so it resolves to nothing.
 * - GitLab CI on a merge-request pipeline: `CI_MERGE_REQUEST_PROJECT_URL` +
 *   `CI_MERGE_REQUEST_IID`.
 */
export function resolveApprovalUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const prNumber = /^(\d+)\/(merge|head)$/.exec(env.GITHUB_REF_NAME ?? "")?.[1];
  if (prNumber && env.GITHUB_REPOSITORY) {
    const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
    return `${server}/${env.GITHUB_REPOSITORY}/pull/${prNumber}`;
  }

  if (env.CI_MERGE_REQUEST_PROJECT_URL && env.CI_MERGE_REQUEST_IID) {
    return `${env.CI_MERGE_REQUEST_PROJECT_URL.replace(/\/$/, "")}/-/merge_requests/${env.CI_MERGE_REQUEST_IID}`;
  }

  return undefined;
}

/**
 * Whether `raw` is an address worth recording as one: an absolute `http`/
 * `https` URL. A gate's address is a link a reader is expected to follow, so
 * a relative path or a `file:`/`javascript:` scheme is refused at the CLI
 * boundary rather than written into an immutable record.
 */
export function isApprovalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** One immutable gate-resolution record. */
export interface GateResolutionRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** Discriminator against {@link PendingGateRecord}, which shares this file. Absent on every line written before #2119, so a reader must treat "no kind" as `"resolution"`. */
  kind?: "resolution";
  /** The dispatched op the gate belongs to. */
  op: string;
  /** The gate's signal name (matches `ConvergeRuleOutcome.gateName`). */
  gate: string;
  /** Who resolved it — an actor name, the same convention `components release --actor` and `run approve --approver` use. */
  resolvedBy: string;
  /** ISO-8601 timestamp, caller-supplied (library code never calls `Date.now()` internally). */
  timestamp: string;
  /** Optional free-text context. Before #2028 this was also where a PR link went by convention; put the link in {@link GateResolutionRecord.url} instead and leave this for prose. */
  note?: string;
  /**
   * The address this resolution happened at (#2028) — the PR that carried the
   * change, the review thread, whatever the approval surface was. Typed, so
   * "resolved by this PR" is machine-readable instead of a reader sniffing
   * `note` for something that looks like a link.
   *
   * `chant approve --url` sets it; absent when the resolver genuinely had no
   * address (a human at a terminal, no PR). Always an absolute `http`/`https`
   * URL — see {@link isApprovalUrl}.
   */
  url?: string;
}

export type GateResolutionInput = Omit<GateResolutionRecord, "version" | "kind">;

/**
 * One immutable pending-gate record (#2119) — what an executor writes when a
 * run reaches a `gate` step with no resolution standing against it. The run
 * ends here with status `gated`; this line is the durable trace of that, and
 * the anchor a later {@link GateResolutionRecord} has to be newer than to
 * count as its answer.
 *
 * Idempotent by design: a run that finds a live (unexpired) pending fact for
 * the same gate reuses it rather than appending a second one, so a converge
 * loop ticking every minute against an unapproved gate does not grow the
 * ledger by a line a minute. Once `expiresAt` passes, the fact is stale and
 * the next run records a fresh one.
 */
export interface PendingGateRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  kind: "pending";
  /** The op (or, on the component driver, the component) the gate belongs to. */
  op: string;
  /** The gate's name (matches `GateStep.gate`). */
  gate: string;
  /** The gate's human-readable description, when it declared one — what `chant operator status` shows a reader who wasn't there for the run. */
  description?: string;
  /** The run that reached the gate, when the caller identifies its runs. */
  runId?: string;
  /** ISO-8601 timestamp, caller-supplied (library code never calls `Date.now()` internally). */
  timestamp: string;
  /** ISO-8601 expiry, from the gate's `timeout` (default {@link DEFAULT_GATE_EXPIRY}). Past it, the fact is stale and a run re-records it. */
  expiresAt: string;
  /** The address approval happens at, when the run knew one — see {@link resolveApprovalUrl}. */
  url?: string;
}

export type PendingGateInput = Omit<PendingGateRecord, "version" | "kind">;

/** Either kind of line in `_gates/<op>.jsonl`. */
export type GateLedgerRecord = GateResolutionRecord | PendingGateRecord;

/** The default a gate's pending fact expires after when its `GateStep` declares no `timeout` — the same 48h `GateStep.timeout` documents as its own default. */
export const DEFAULT_GATE_EXPIRY = "48h";

/** Whether a pending fact has aged out of relevance at `nowIso`. */
export function isPendingGateExpired(record: PendingGateRecord, nowIso: string): boolean {
  return new Date(record.expiresAt).getTime() <= new Date(nowIso).getTime();
}

function filename(op: string): string {
  return `${op}.jsonl`;
}

/** Append one immutable gate-resolution record. Does not push to the remote — call `pushLifecycle` (./git.ts) afterward, same two-step shape every other ledger write here uses. Retries on `RefCASConflictError` the same way `appendConvergeRecord` does (./converge-ledger.ts) — a concurrent writer to a different op's/env's file on the same orphan branch is the ordinary case, not an edge case. The baseline read must be `readPathSha` + `readBlobBySha` rather than `readBlobFromPath`, so the exact sha `existing` came from can be passed as `expectPriorPathSha` — see `writeBlobToPath` (./git.ts) for the race that closes. */
export async function appendGateResolution(
  input: GateResolutionInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: GateResolutionRecord }> {
  const record: GateResolutionRecord = { version: 1, ...input };
  const commit = await appendGateLine(record, "Gate resolution record", opts);
  return { commit, record };
}

/**
 * Append one immutable pending-gate record (#2119) — the fact a run leaves
 * behind when it reaches a gate nobody has approved. Same file, same
 * append-and-retry discipline, same "does not push" contract as
 * {@link appendGateResolution}.
 */
export async function appendPendingGate(
  input: PendingGateInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: PendingGateRecord }> {
  const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
  const commit = await appendGateLine(record, "Pending gate record", opts);
  return { commit, record };
}

async function appendGateLine(
  record: GateLedgerRecord,
  message: string,
  opts?: { cwd?: string },
): Promise<string> {
  const json = JSON.stringify(record, sortedJsonReplacer);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(DIR, filename(record.op), opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${json}` : json;
      return await writeBlobToPath(DIR, filename(record.op), content, message, {
        ...opts,
        expectPriorPathSha: priorSha,
      });
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Read every line of `op`'s gate file, oldest first, split into the two kinds
 * (#2119). Malformed lines are skipped and counted, not thrown on — the same
 * graceful-degradation stance `readConvergeLedger` takes. Returns empty arrays
 * (never throws) when `op` has nothing recorded yet.
 */
export async function readGateLedger(
  op: string,
  opts?: { cwd?: string },
): Promise<{ resolutions: GateResolutionRecord[]; pending: PendingGateRecord[]; malformed: number }> {
  const content = await readBlobFromPath(DIR, filename(op), opts);
  if (!content) return { resolutions: [], pending: [], malformed: 0 };

  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const resolutions: GateResolutionRecord[] = [];
  const pending: PendingGateRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<Omit<GateResolutionRecord, "kind">> &
        Partial<Omit<PendingGateRecord, "kind">> & { kind?: string };
      const common =
        parsed.version === 1 && typeof parsed.op === "string" &&
        typeof parsed.gate === "string" && typeof parsed.timestamp === "string";
      if (!common) {
        malformed++;
        continue;
      }
      if (parsed.kind === "pending") {
        if (typeof parsed.expiresAt !== "string") {
          malformed++;
          continue;
        }
        pending.push(parsed as PendingGateRecord);
        continue;
      }
      if (typeof parsed.resolvedBy !== "string") {
        malformed++;
        continue;
      }
      resolutions.push(parsed as GateResolutionRecord);
    } catch {
      malformed++;
    }
  }
  return { resolutions, pending, malformed };
}

/** Read every gate-*resolution* record for `op`, oldest first — {@link readGateLedger} narrowed to the half every caller before #2119 wanted. Pending facts are not malformed lines and are not counted as such. */
export async function readGateResolutions(
  op: string,
  opts?: { cwd?: string },
): Promise<{ records: GateResolutionRecord[]; malformed: number }> {
  const { resolutions, malformed } = await readGateLedger(op, opts);
  return { records: resolutions, malformed };
}

/** The most recent pending fact for `gate`, expired or not — the anchor {@link latestResolutionSince} measures a resolution against. `undefined` when the gate has never been recorded pending. */
export function latestPendingGate(
  records: PendingGateRecord[],
  gate: string,
): PendingGateRecord | undefined {
  let latest: PendingGateRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate) continue;
    if (!latest || new Date(r.timestamp).getTime() >= new Date(latest.timestamp).getTime()) latest = r;
  }
  return latest;
}

/** The most recent resolution for `gate` recorded after `sinceIso` (a gated tick's own timestamp) — what `chant operator status` uses to tell a resolved gate from a still-pending one. `undefined` when no such resolution exists. */
export function latestResolutionSince(
  records: GateResolutionRecord[],
  gate: string,
  sinceIso: string,
): GateResolutionRecord | undefined {
  const since = new Date(sinceIso).getTime();
  let latest: GateResolutionRecord | undefined;
  for (const r of records) {
    if (r.gate !== gate) continue;
    if (new Date(r.timestamp).getTime() < since) continue;
    if (!latest || new Date(r.timestamp).getTime() >= new Date(latest.timestamp).getTime()) latest = r;
  }
  return latest;
}

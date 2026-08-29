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
 * appends here — issue #1485's "resolution is an out-of-band act that
 * writes the counterpart fact". Per the issue's own leaning on open
 * question 3 ("local trust in v1, signature as an additive follow-up"),
 * this record is *not* itself an authorization check — anyone who can run
 * `chant approve` locally can write one, the same trust boundary a local
 * `git commit` already has. What it changes: `chant operator status` (and
 * any future gate-aware dispatch retry) can tell a resolved gate from a
 * still-pending one by finding a resolution newer than the tick that
 * recorded it. It does **not** (v1) retroactively make a gated op's local
 * dispatch succeed — the local executor still refuses any op containing a
 * gate outright (`../op/local-executor.ts`'s `LocalGateUnsupportedError`),
 * unconditionally, gate resolution or not. Wiring an approved gate back
 * into the local executor's dispatch path is the GateStep semantic change
 * issue #1485 itself flags as open question 1 ("suspension → fact... does
 * it land as its own issue first? Leaning: yes, split it out") — deferred
 * here for the same reason the issue defers it: it touches both the local
 * executor and the generated Temporal workflow, and has migration impact on
 * shipped ops. `chant approve` in v1 is the durable, queryable record of
 * "this gate is cleared" that a human (or a future auto-resume path) reads;
 * it is not itself the unblock.
 */
import { sortedJsonReplacer } from "../utils";
import { readBlobFromPath, readPathSha, readBlobBySha, writeBlobToPath, RefCASConflictError } from "./git";

const DIR = "_gates";
const APPEND_RETRY_ATTEMPTS = 5;

/** One immutable gate-resolution record. */
export interface GateResolutionRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** The dispatched op the gate belongs to. */
  op: string;
  /** The gate's signal name (matches `ConvergeRuleOutcome.gateName`). */
  gate: string;
  /** Who resolved it — an actor name, the same convention `components release --actor` and `run signal --approver` use. */
  resolvedBy: string;
  /** ISO-8601 timestamp, caller-supplied (library code never calls `Date.now()` internally). */
  timestamp: string;
  /** Optional free-text context (e.g. a PR URL — "or a merged PR" is the issue's other resolution path; recording its link here keeps both paths visible from one ledger). */
  note?: string;
}

export type GateResolutionInput = Omit<GateResolutionRecord, "version">;

function filename(op: string): string {
  return `${op}.jsonl`;
}

/** Append one immutable gate-resolution record. Does not push to the remote — call `pushLifecycle` (./git.ts) afterward, same two-step shape every other ledger write here uses. Retries on `RefCASConflictError` the same way `appendConvergeRecord` does (./converge-ledger.ts) — a concurrent writer to a different op's/env's file on the same orphan branch is the ordinary case, not an edge case. The baseline read must be `readPathSha` + `readBlobBySha` rather than `readBlobFromPath`, so the exact sha `existing` came from can be passed as `expectPriorPathSha` — see `writeBlobToPath` (./git.ts) for the race that closes. */
export async function appendGateResolution(
  input: GateResolutionInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: GateResolutionRecord }> {
  const record: GateResolutionRecord = { version: 1, ...input };
  const json = JSON.stringify(record, sortedJsonReplacer);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(DIR, filename(record.op), opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${json}` : json;
      const commit = await writeBlobToPath(DIR, filename(record.op), content, "Gate resolution record", {
        ...opts,
        expectPriorPathSha: priorSha,
      });
      return { commit, record };
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Read every gate-resolution record for `op`, oldest first. Malformed lines are skipped, not thrown on, the same graceful-degradation stance `readConvergeLedger` takes. Returns `[]` (never throws) when `op` has no resolutions recorded yet. */
export async function readGateResolutions(
  op: string,
  opts?: { cwd?: string },
): Promise<{ records: GateResolutionRecord[]; malformed: number }> {
  const content = await readBlobFromPath(DIR, filename(op), opts);
  if (!content) return { records: [], malformed: 0 };

  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const records: GateResolutionRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<GateResolutionRecord>;
      if (
        parsed.version !== 1 ||
        typeof parsed.op !== "string" ||
        typeof parsed.gate !== "string" ||
        typeof parsed.resolvedBy !== "string" ||
        typeof parsed.timestamp !== "string"
      ) {
        malformed++;
        continue;
      }
      records.push(parsed as GateResolutionRecord);
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
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

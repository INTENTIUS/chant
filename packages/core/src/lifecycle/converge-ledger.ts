/**
 * Converge ledger (#1484) — the append-only record of what a `ConvergeOp`
 * tick did, one line per tick, at `<env>/converge.jsonl` on the
 * `chant/lifecycle` orphan branch. Same storage shape as the release ledger
 * (./release-ledger.ts): immutable, append-only JSONL, reusing
 * `writeBlobToPath`/`readBlobFromPath` (./git.ts) directly rather than a new
 * git-plumbing path — the exact reuse `appendReleaseRecordLine` already
 * demonstrates for a second filename under the same env directory.
 *
 * This is also where flap-damping state lives (issue: "consecutive-fire
 * counts go in the ledger ... not process memory, so damping survives worker
 * restarts"): each record's `firedRuleIds` names every rule whose predicate
 * matched this tick, independent of what action was actually taken (run,
 * report, or skipped for budget/flap reasons) — {@link consecutiveRuleFires}
 * walks the ledger backward from the newest record and counts how many in a
 * row include a given rule id, stopping at the first tick where it didn't
 * fire (the symptom cleared).
 */
import { randomUUID } from "node:crypto";
import { sortedJsonReplacer } from "../utils";
import type { ComponentStatusRow } from "./status";
import { readBlobFromPath, readPathSha, readBlobBySha, writeBlobToPath, RefCASConflictError } from "./git";

const FILENAME = "converge.jsonl";

/**
 * Cap a piece of free text to one sanitized line before it goes into a
 * record. A record here is one line of JSON, so a multi-line or unbounded
 * string folded into any field would break the line the ledger is built out
 * of. Every free-text field a tick writes goes through this: a dispatch
 * failure's `stderr` (lexicons/temporal's `sanitizeOneLine`, which delegates
 * here) and a component verdict's lexicon-authored `detail`.
 */
const MAX_LEDGER_TEXT_LEN = 300;
export function sanitizeLedgerText(raw: string, maxLen = MAX_LEDGER_TEXT_LEN): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  // Strips literal control bytes; it is not matching on a range boundary.
  const stripped = firstLine.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped;
}

/**
 * Read-modify-append retry budget for {@link appendConvergeRecord} (#1485).
 * `writeBlobToPath`'s ref write is now CAS-guarded (./git.ts) — a conflict
 * (another writer, e.g. a second operator ticking a different env on the
 * same orphan branch, updated the branch tip between our read and our
 * write) throws `RefCASConflictError` instead of silently clobbering. This
 * many attempts, re-reading the ledger fresh each time, absorbs that race
 * rather than surfacing it as a tick failure — the whole point of the CAS
 * guard is correctness, not a new way for a tick to fail.
 */
const APPEND_RETRY_ATTEMPTS = 5;

/** One rule's outcome within a tick. */
export interface ConvergeRuleOutcome {
  ruleId: string;
  /**
   * What actually happened for this fired rule this tick. `"gated"` (#1485)
   * is gate-as-fact: the dispatched op's own run hit a gate it can't clear
   * on the local executor, and the tick records that as a terminal, durable
   * fact — `gateName` names the gate — rather than treating it as a
   * dispatch failure. Resolution is out-of-band (`chant approve <op>
   * <gate>`, ./gate-ledger.ts, or a merged PR); the tick itself never
   * blocks waiting for it.
   */
  action: "ran" | "reported" | "skipped-budget" | "skipped-flap" | "gated";
  /** The dispatched Op name, for `action: "ran"` or `"gated"`. */
  op?: string;
  /** The gate's signal name, for `action: "gated"`. */
  gateName?: string;
  /** The report reason, for `action: "reported"` (including a flap-damped rule's forced report) — and the human-readable explanation for `action: "gated"`. */
  reason?: string;
}

/**
 * One component's verdict as the tick observed it (#2027) — the per-entity
 * layer behind the tick's single aggregate `status`.
 *
 * A deliberate subset of `ComponentStatusRow`: the five verdict-bearing
 * fields, joined on the same `component` key `chant components status --live
 * --json` emits, and none of the heavy ones. `recorded`, `build` and
 * `componentBom` are dropped on purpose — they are release/build-ledger
 * content, already readable by that same key, and a tick record is one line
 * of JSON appended every tick forever. `detail` goes through
 * {@link sanitizeLedgerText} for the same reason.
 */
export interface ConvergeComponentVerdict {
  component: string;
  reconciliation: ComponentStatusRow["reconciliation"];
  /** Human-readable detail backing the verdict, capped to one line. */
  detail: string;
  /** "Observed live", when live evidence was gathered. Absent means "did not look" or "could not look" — see `unobserved`. */
  live?: boolean;
  /** Why live state could not be read for this component (#1089). Mutually exclusive with `live`; this is the row that tripped an aggregate `status: "unknown"`. */
  unobserved?: { reason: string; detail?: string };
}

/**
 * Project the tick's `ComponentStatusRow[]` down to what the ledger keeps.
 * Pure; row order is preserved, so a consumer sees components in the same
 * order the status join produced them.
 */
export function componentVerdicts(rows: readonly ComponentStatusRow[]): ConvergeComponentVerdict[] {
  return rows.map((row) => ({
    component: row.component,
    reconciliation: row.reconciliation,
    detail: sanitizeLedgerText(row.detail ?? ""),
    ...(row.live !== undefined ? { live: row.live } : {}),
    ...(row.unobserved
      ? {
          unobserved: {
            reason: row.unobserved.reason,
            ...(row.unobserved.detail !== undefined ? { detail: sanitizeLedgerText(row.unobserved.detail) } : {}),
          },
        }
      : {}),
  }));
}

/** One immutable converge-tick record. */
export interface ConvergeTickRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /**
   * Stable tick id (#2027) — the one thing an outcome, a gate fact or a
   * remediation can point at. Before this, a tick's identity was the
   * `(op, env, timestamp)` triple, so two ticks landing in the same ISO
   * second were indistinguishable and nothing could reference one.
   *
   * Minted by {@link appendConvergeRecord} with `randomUUID()` (the same
   * mint `./lease.ts` uses for a lease token) when the caller doesn't supply
   * one. Optional on the type because `version: 1` records written before
   * #2027 have none — a reader must handle its absence, not assume it.
   */
  id?: string;
  /** The ConvergeOp's name (`OpConfig.name`). */
  op: string;
  env: string;
  /** ISO-8601 timestamp, caller-supplied (same convention as `ReleaseRecord.timestamp` — library code never calls `Date.now()` internally). */
  timestamp: string;
  /** Every rule id whose predicate matched this tick, regardless of what action followed — the flap-damping input. */
  firedRuleIds: string[];
  /** Per-rule outcome, for every fired rule. */
  outcomes: ConvergeRuleOutcome[];
  /**
   * The per-component verdicts this tick observed (#2027), behind the
   * aggregate counts in `summary`.
   *
   * The tick derives these to compute `summary.drifted` and the whole-tick
   * `status`, and used to throw them away — so a reader could say "this
   * environment drifted twice this hour" but could not colour the node that
   * drifted, or name the single unobserved component whose `unknown` verdict
   * refused remediation for everything else. Optional because `version: 1`
   * records written before #2027 have none; absent is not "no components".
   */
  components?: ConvergeComponentVerdict[];
  /** Aggregate counts backing the tick's one log line. */
  summary: {
    drifted: number;
    remediated: number;
    reported: number;
    skippedBudget: number;
    skippedFlap: number;
    unobserved: number;
    adopted: number;
    /** Rules whose dispatch hit a gate this tick (#1485) — a terminal, non-blocking fact; see `ConvergeRuleOutcome.action`'s doc. @default 0, so an older record without this field still reads as zero, not undefined. */
    gated?: number;
  };
  /** The one human-readable log line this tick produced (issue: "one log line and one ledger record per tick"). */
  log: string;
}

export type ConvergeTickRecordInput = Omit<ConvergeTickRecord, "version">;

/**
 * Append one immutable tick record. Does not push to the remote — call
 * `pushLifecycle` (./git.ts) afterward, same two-step shape every other
 * ledger write here uses.
 *
 * Mints `record.id` (#2027) when the input doesn't carry one, so every tick
 * written from here on is referenceable. Unlike `timestamp`, which stays
 * caller-supplied because library code never calls `Date.now()` internally,
 * an id has nothing for a caller to decide — the mint lives here so no
 * writer can forget it. An explicit `input.id` still wins, which is what a
 * test asserting an exact record uses.
 *
 * Retries the whole read-modify-write cycle (#1485) on `RefCASConflictError`
 * — `writeBlobToPath`'s ref write is CAS-guarded, so a concurrent writer to
 * a *different* env's file on the same orphan branch (two operators ticking
 * two environments at once is the ordinary case, not an edge case) can lose
 * the race and needs to re-read the branch tip and retry, not fail the
 * tick. Each retry re-reads `existing` fresh, so it always appends onto
 * whatever the other writer just committed rather than reintroducing a stale
 * read. Exhausting the budget re-throws the conflict — a real, sustained
 * pile-up of writers is a signal worth surfacing, not silently swallowing.
 *
 * The baseline read must be `readPathSha` + `readBlobBySha` rather than
 * `readBlobFromPath`, so the exact sha `existing` came from can be passed as
 * `expectPriorPathSha`. See `writeBlobToPath` (./git.ts) for the race that
 * closes.
 */
export async function appendConvergeRecord(
  input: ConvergeTickRecordInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: ConvergeTickRecord & { id: string } }> {
  const record: ConvergeTickRecord & { id: string } = { version: 1, ...input, id: input.id ?? randomUUID() };
  const json = JSON.stringify(record, sortedJsonReplacer);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(record.env, FILENAME, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${json}` : json;
      const commit = await writeBlobToPath(record.env, FILENAME, content, "Converge tick record", {
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

/** Read every tick record for `environment`, oldest first. Malformed lines are skipped, not thrown on — a corrupted or hand-edited ledger degrades gracefully, the same stance `readReleaseLedger` takes. */
export async function readConvergeLedger(
  environment: string,
  opts?: { cwd?: string },
): Promise<{ records: ConvergeTickRecord[]; malformed: number }> {
  const content = await readBlobFromPath(environment, FILENAME, opts);
  if (!content) return { records: [], malformed: 0 };

  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const records: ConvergeTickRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Partial<ConvergeTickRecord>;
      if (
        parsed.version !== 1 ||
        typeof parsed.op !== "string" ||
        typeof parsed.env !== "string" ||
        typeof parsed.timestamp !== "string" ||
        !Array.isArray(parsed.firedRuleIds)
      ) {
        malformed++;
        continue;
      }
      records.push(parsed as ConvergeTickRecord);
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/**
 * How many consecutive most-recent ticks (newest first) fired `ruleId`,
 * stopping at the first tick where it did not — the count a rule's
 * `flapThreshold` is compared against. `0` when the newest tick didn't fire
 * it (including an empty ledger).
 */
export function consecutiveRuleFires(records: ConvergeTickRecord[], ruleId: string): number {
  let count = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (!records[i].firedRuleIds.includes(ruleId)) break;
    count++;
  }
  return count;
}

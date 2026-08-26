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
import { sortedJsonReplacer } from "../utils";
import { readBlobFromPath, writeBlobToPath } from "./git";

const FILENAME = "converge.jsonl";

/** One rule's outcome within a tick. */
export interface ConvergeRuleOutcome {
  ruleId: string;
  /** What actually happened for this fired rule this tick. */
  action: "ran" | "reported" | "skipped-budget" | "skipped-flap";
  /** The dispatched Op name, for `action: "ran"`. */
  op?: string;
  /** The report reason, for `action: "reported"` (including a flap-damped rule's forced report). */
  reason?: string;
}

/** One immutable converge-tick record. */
export interface ConvergeTickRecord {
  /** Schema version, so an incompatible future shape is detected before being misread. */
  version: 1;
  /** The ConvergeOp's name (`OpConfig.name`). */
  op: string;
  env: string;
  /** ISO-8601 timestamp, caller-supplied (same convention as `ReleaseRecord.timestamp` — library code never calls `Date.now()` internally). */
  timestamp: string;
  /** Every rule id whose predicate matched this tick, regardless of what action followed — the flap-damping input. */
  firedRuleIds: string[];
  /** Per-rule outcome, for every fired rule. */
  outcomes: ConvergeRuleOutcome[];
  /** Aggregate counts backing the tick's one log line. */
  summary: {
    drifted: number;
    remediated: number;
    reported: number;
    skippedBudget: number;
    skippedFlap: number;
    unobserved: number;
    adopted: number;
  };
  /** The one human-readable log line this tick produced (issue: "one log line and one ledger record per tick"). */
  log: string;
}

export type ConvergeTickRecordInput = Omit<ConvergeTickRecord, "version">;

/** Append one immutable tick record. Does not push to the remote — call `pushLifecycle` (./git.ts) afterward, same two-step shape every other ledger write here uses. */
export async function appendConvergeRecord(
  input: ConvergeTickRecordInput,
  opts?: { cwd?: string },
): Promise<{ commit: string; record: ConvergeTickRecord }> {
  const record: ConvergeTickRecord = { version: 1, ...input };
  const json = JSON.stringify(record, sortedJsonReplacer);
  const existing = await readBlobFromPath(record.env, FILENAME, opts);
  const content = existing ? `${existing.replace(/\n$/, "")}\n${json}` : json;
  const commit = await writeBlobToPath(record.env, FILENAME, content, "Converge tick record", opts);
  return { commit, record };
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

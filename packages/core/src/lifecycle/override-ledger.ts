/**
 * The override gate's lines on `chant/lifecycle` (#3760): read the denials,
 * overrides and applied records, record a denial, and record that a run
 * applied under an override, which spends it. The decision is
 * `../override-gate.ts`'s, which bundles without this module's git code.
 *
 * Denials and overrides share `_gates/policy-override.jsonl` with the
 * ordinary gate line shapes, so `chant approve`, `chant operator status` and
 * the audit reader read them as they read any gate. Applied records live in
 * `_gates/policy-override/applied.jsonl`, which no gate reader lists.
 */

import { sortedJsonReplacer } from "../utils";
import { appendPendingGate, readGateLedger, type GateResolutionRecord, type PendingGateRecord } from "./gate-ledger";
import { readBlobBySha, readBlobFromPath, readPathSha, RefCASConflictError, writeBlobToPath } from "./git";
import {
  OVERRIDE_OP,
  parseAppliedOverrides,
  overridePending,
  type AppliedOverrideRecord,
  type OverridePendingInput,
  type OverridePendingRecord,
} from "../override-gate";

const APPLIED_DIR = `_gates/${OVERRIDE_OP}`;
const APPLIED_FILE = "applied.jsonl";
const APPEND_RETRY_ATTEMPTS = 5;

export interface OverrideLedger {
  resolutions: GateResolutionRecord[];
  pending: PendingGateRecord[];
  applied: AppliedOverrideRecord[];
}

/** The override ledger and its applied records, oldest first. Empty when nothing is recorded. */
export async function readOverrideLedger(opts?: { cwd?: string }): Promise<OverrideLedger> {
  const { resolutions, pending } = await readGateLedger(OVERRIDE_OP, opts);
  const text = await readBlobFromPath(APPLIED_DIR, APPLIED_FILE, opts);
  return { resolutions, pending, applied: text ? parseAppliedOverrides(text) : [] };
}

/** Append a denial's pending fact ({@link overridePending}). Does not push. */
export async function recordOverrideDenial(input: OverridePendingInput, opts?: { cwd?: string }): Promise<{ commit: string; record: OverridePendingRecord }> {
  const { version: _v, kind: _k, ...rest } = overridePending(input);
  const { commit, record } = await appendPendingGate(rest, opts);
  return { commit, record: record as OverridePendingRecord };
}

/** Append applied records, spending the overrides they name. Write them before applying; a write that fails should stop the run. Does not push. */
export async function recordOverridesApplied(records: readonly AppliedOverrideRecord[], opts?: { cwd?: string }): Promise<string | undefined> {
  if (records.length === 0) return undefined;
  const lines = records.map((r) => JSON.stringify(r, sortedJsonReplacer)).join("\n");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const priorSha = await readPathSha(APPLIED_DIR, APPLIED_FILE, opts);
      const existing = priorSha ? await readBlobBySha(priorSha, opts) : null;
      const content = existing ? `${existing.replace(/\n$/, "")}\n${lines}` : lines;
      return await writeBlobToPath(APPLIED_DIR, APPLIED_FILE, content, `Applied under override: ${records.map((r) => r.gate).join(", ")}`, {
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

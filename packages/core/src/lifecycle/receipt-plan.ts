/**
 * Receipt planning (#1832, epic #1703) — the plan half of the effect-receipt
 * contract.
 *
 * A receipt is declared, diffed, and observed like any resource, but it is
 * OBSERVE-ONLY to the generic apply path: the `effect()` step (#1834) is the
 * sole writer, on success, last (epic decision log, item 3). The plan's job is
 * therefore not "create the receipt" — it is "say whether the effect will
 * fire". This module compares each declared receipt's live value against its
 * resolved expectation and classifies:
 *
 * - absent or differing → an `effect` entry ("effect will fire") — including
 *   the crash-between-effect-and-write case, where a stale or missing receipt
 *   re-proposes the fire on the next plan. That re-proposal is the whole
 *   at-least-once guarantee; anything that stamps the receipt on the generic
 *   path silently converts it into never.
 * - equal → `noop` — the effect has run for these inputs; the plan is clean.
 * - unobservable → `unobserved`, loudly. A receipt nobody could read is a
 *   hole in the plan, never a clean row.
 * - a reference input that cannot resolve at plan time → an `effect` entry
 *   with an "unresolved input" note, never a guessed digest. The effect step
 *   resolves again at run and decides there.
 *
 * A receipt name is also stripped out of whatever the generic change-set
 * classification proposed for it ({@link mergeReceiptEntries}): a receipt is
 * never a `create`, never an `update`, and never a `delete`/`adopt` prune
 * candidate — the entries built here are the only rows a receipt gets.
 *
 * Pure: no I/O. Live state arrives as {@link ReceiptReading}s the caller
 * built from its observations; reference inputs resolve through the
 * caller-supplied resolver ({@link observedValueResolver} builds one over the
 * plan's merged observed values).
 */
import { AttrRef } from "../attrref";
import {
  EXISTENCE_EXPECTATION,
  resolveReceiptExpectation,
  type EffectReceiptDeclaration,
  type ReceiptInputResolver,
} from "../effect-receipt";
import type { ResourceMetadata } from "../lexicon";
import type { UnobservedReason } from "../observation";
import type { ChangeSet, ChangeSetEntry } from "./change-set";

/**
 * The attribute a materialized receipt's live value is read from. A lexicon
 * receipt row's observation (#1835) maps the stored value onto
 * `attributes[RECEIPT_VALUE_ATTRIBUTE]`; `Value` is accepted as a fallback for
 * observations that keep the provider's own casing (SSM's `Value`).
 */
export const RECEIPT_VALUE_ATTRIBUTE = "value";

/** Read a live receipt's stored value off an observation's attributes. */
export function readReceiptValue(attributes: Record<string, unknown> | undefined): unknown {
  if (!attributes) return undefined;
  if (RECEIPT_VALUE_ATTRIBUTE in attributes) return attributes[RECEIPT_VALUE_ATTRIBUTE];
  return attributes["Value"];
}

/**
 * What the plan's observation pass learned about one declared receipt.
 * Deliberately tri-state, the same shape the change set rests on (#1089):
 * `observed: false` means "nobody looked", which is a hole — never absence.
 * A receipt with no reading at all means no loaded lexicon even claims it.
 */
export interface ReceiptReading {
  /** The lexicon actually looked. `false` → the receipt is a plan hole. */
  observed: boolean;
  /** Observed present in the live system. Meaningful only when `observed`. */
  present: boolean;
  /** The live receipt's stored value ({@link readReceiptValue}). */
  value?: unknown;
  /** Live resource type, when reported. */
  type?: string;
  /** Provider-assigned physical id, when reported. */
  physicalId?: string;
  /** The lexicon whose observation produced this reading. */
  lexicon?: string;
  /** Why the read did not happen, when `observed: false`. */
  unobservedReason?: UnobservedReason;
  unobservedDetail?: string;
}

/**
 * A {@link ReceiptInputResolver} over the plan's merged observed values: an
 * attr-ref resolves to the referenced entity's observed attribute. Anything
 * that is not among the observed values throws — which `planReceipts` renders
 * as an effect-will-fire entry with an "unresolved input" note rather than a
 * guessed expectation.
 */
export function observedValueResolver(
  resources: Readonly<Record<string, ResourceMetadata>>,
): ReceiptInputResolver {
  return (ref, path) => {
    if (ref instanceof AttrRef) {
      const entity = ref.getLogicalName();
      if (!entity) {
        throw new Error(`unresolved input at ${path}: attr-ref carries no logical name`);
      }
      const attrs = resources[entity]?.attributes;
      if (!attrs || !(ref.attribute in attrs)) {
        throw new Error(
          `unresolved input at ${path}: ${entity}.${ref.attribute} is not among the observed values`,
        );
      }
      return attrs[ref.attribute];
    }
    throw new Error(`unresolved input at ${path}: reference cannot resolve at plan time`);
  };
}

/**
 * Classify every declared receipt into its change-set entry. See the module
 * doc for the classification; entries come back sorted by name.
 */
export function planReceipts(
  receipts: ReadonlyMap<string, EffectReceiptDeclaration>,
  readings: ReadonlyMap<string, ReceiptReading>,
  resolver: ReceiptInputResolver,
): ChangeSetEntry[] {
  const entries: ChangeSetEntry[] = [];

  for (const [name, receipt] of receipts) {
    const reading = readings.get(name);
    const base = {
      name,
      type: reading?.type ?? receipt.entityType,
      ...(reading?.lexicon ? { lexicon: reading.lexicon } : {}),
      ...(reading?.physicalId ? { physicalId: reading.physicalId } : {}),
      effect: receipt.effect,
      ownership: "unknown" as const,
    };
    const evidence = {
      declared: true,
      inSnapshot: false,
      live: reading?.present ?? false,
      observed: reading?.observed ?? false,
    };

    if (!reading) {
      // No loaded lexicon materializes or observes this receipt — a hole,
      // said loudly, never a silently clean row (#1089's tri-state).
      entries.push({
        ...base,
        action: "unobserved",
        evidence,
        unobservedReason: "unsupported-kind",
        unobservedDetail:
          `no loaded lexicon materializes or observes this receipt — ` +
          `whether effect "${receipt.effect}" has run is unknown, not clean`,
      });
      continue;
    }

    if (!reading.observed) {
      entries.push({
        ...base,
        action: "unobserved",
        evidence,
        unobservedReason: reading.unobservedReason ?? "read-failed",
        ...(reading.unobservedDetail ? { unobservedDetail: reading.unobservedDetail } : {}),
      });
      continue;
    }

    // Resolve the expectation. A reference that cannot resolve at plan time
    // is never guessed around: the fire is proposed with the note, and the
    // effect step resolves again at run (epic decision log, item 5).
    let expectation: string | undefined;
    let unresolved: string | undefined;
    try {
      expectation = resolveReceiptExpectation(receipt, resolver);
    } catch (err) {
      unresolved = err instanceof Error ? err.message : String(err);
    }

    if (!reading.present) {
      entries.push({
        ...base,
        action: "effect",
        evidence,
        effectReason: "receipt-absent",
        effectDetail:
          `receipt confirmed absent — no run of "${receipt.effect}" is recorded` +
          (unresolved ? ` (${unresolved})` : ""),
      });
      continue;
    }

    if (expectation === undefined) {
      entries.push({
        ...base,
        action: "effect",
        evidence,
        effectReason: "unresolved-input",
        effectDetail: unresolved,
      });
      continue;
    }

    if (reading.value === expectation) {
      entries.push({ ...base, action: "noop", evidence });
      continue;
    }

    entries.push({
      ...base,
      action: "effect",
      evidence,
      effectReason: "receipt-stale",
      effectDetail:
        receipt.flavor === "existence"
          ? `live value ${fmtValue(reading.value)} is not the existence marker "${EXISTENCE_EXPECTATION}"`
          : `live value ${fmtValue(reading.value)} differs from expected ${expectation}`,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Replace whatever the generic classification proposed for the receipts with
 * the receipt entries built by {@link planReceipts}, in place.
 *
 * This is the plan-side write-exclusion (#1832): the generic change set,
 * knowing nothing about receipts, classifies a declared-but-absent receipt as
 * `create` and an undeclared-but-live one as `delete`/`adopt` — proposals the
 * generic apply path must never act on for a receipt, and prune candidacy a
 * receipt must never have. Every entry named like a receipt is dropped and
 * the receipt's own entries stand in.
 */
export function mergeReceiptEntries(
  cs: ChangeSet,
  receipts: ReadonlyMap<string, EffectReceiptDeclaration>,
  receiptEntries: ChangeSetEntry[],
): ChangeSet {
  if (receipts.size === 0) return cs;
  cs.entries = cs.entries.filter((e) => !receipts.has(e.name));
  cs.entries.push(...receiptEntries);
  cs.entries.sort((a, b) => a.name.localeCompare(b.name));
  return cs;
}

function fmtValue(v: unknown): string {
  if (v === undefined) return "<unset>";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 72 ? `${s.slice(0, 69)}...` : s;
}

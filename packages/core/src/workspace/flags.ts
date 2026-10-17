/**
 * Feature flags as workspace records (#4024, decided in #4016).
 *
 * A flag is a record of a kind with a `flag` block (`records.ts`). It names a
 * member, one of that member's declared build-time parameters, an owner, the
 * work item the flag hides and a value per environment. The member's build
 * reads it as that parameter (`../flag-params.ts`), so turning a flag on in
 * an environment is a commit that changes the record, and the release cut
 * from that commit carries the new value as a `params` entry whose `source`
 * is `flag:<id>` (ws-104).
 *
 * This module and `./flags-read.ts` do three things:
 *
 * - {@link applyFlags}: on a `records` read of a flag kind, gives each record
 *   its work item with that item's state, the decisions the item implements,
 *   and whether the flag is due for removal, with the warnings
 *   `flag-work-unknown` and `flag-stale`.
 * - `readWorkspaceFlags` (`./flags-read.ts`): every flag of every flag kind
 *   the declaration names, for `workspace status` (`featureFlags`) and the
 *   build.
 * - `memberFlagBindings` (`./flags-read.ts`): the flags of the member holding
 *   a directory, by parameter, for one environment.
 *
 * The readers live apart so that `records.ts`, which loads this module for a
 * flag kind, never reaches `records-cli.ts` and what it imports.
 *
 * A flag is due for removal when its work item implements at least one
 * decision and every decision it implements is confirmed: in one of its
 * kind's closed states and superseded by nothing. For chant's decision kind
 * that is `ratified` (a superseded decision has a superseder). The work is
 * then settled, and the flag that hid it is dead weight.
 */

import { dirname } from "node:path";
import type { ReasonCode } from "./reason-codes";
import { loadRecordKind, readRecords, RecordReadError, type LoadedRecordKind, type ReadRecordsOptions, type RecordEntry } from "./records";
import type { WorkLink } from "./work";

/** Why a flag record carries a warning. Closed, like the record warning codes. */
export const FLAG_WARNING_CODES = [
  /** The flag names a work item no record of its kind's work kind has. */
  "flag-work-unknown",
  /** Every decision the flag's work item implements is confirmed, so the flag is due for removal. `check` reports it (WSP118). */
  "flag-stale",
] as const satisfies readonly ReasonCode[];
export type FlagWarningCode = (typeof FLAG_WARNING_CODES)[number];

/** A flag's value in one environment: what a build-time parameter can hold. */
export type FlagValue = string | number | boolean;

/** A decision a flag's work item implements, with whether it is confirmed. */
export interface FlagDecision extends WorkLink {
  /** In one of its kind's closed states and superseded by nothing. */
  confirmed: boolean;
}

/** What a read of a flag kind adds to each record (#4024). */
export interface FlagState {
  /** The work item the flag hides, with its state, or null when the record names none. The state is null when no record has the id. */
  work: WorkLink | null;
  /** Each decision the work item implements, with its state. Empty when the item is unknown or implements none. */
  implements: FlagDecision[];
  /** True when the work item implements at least one decision and every one is confirmed: the flag is due for removal. */
  stale: boolean;
}

/** A flag as `workspace status` and the build read it. */
export interface WorkspaceFlag {
  /** The flag's name, its record's id. */
  id: string;
  /** The kind file from the workspace root. */
  kind: string;
  /** The record file from the workspace root, with / separators. */
  path: string;
  member: string;
  param: string;
  owner: string;
  /** The value per environment, as the record writes it, in key order. */
  values: Record<string, FlagValue>;
  work: WorkLink | null;
  implements: FlagDecision[];
  stale: boolean;
}

/** A flag record that is not valid, so no build trusts it. */
export interface InvalidFlag {
  kind: string;
  path: string;
  /** The member the record names, or null when it names none that can be read. */
  member: string | null;
  message: string;
}

/** Every flag a workspace's declared flag kinds hold. */
export interface WorkspaceFlags {
  flags: WorkspaceFlag[];
  invalid: InvalidFlag[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Give each record of a flag kind its {@link FlagState} and warnings, in
 * place. Throws a `RecordReadError` when the work kind it names can't be read
 * or is not a work kind.
 */
export async function applyFlags(loaded: LoadedRecordKind, entries: RecordEntry[], options: ReadRecordsOptions): Promise<void> {
  const flag = loaded.kind.flag!;
  const workKind = await loadRecordKind(flag.work.kind, dirname(loaded.file));
  if (!workKind.kind.work) {
    throw new RecordReadError("kind-invalid", `flag kind ${loaded.kind.name} names ${flag.work.kind} as its work kind, and that kind has no work block`);
  }
  const decisionKind = await loadRecordKind(workKind.kind.work.decisions, dirname(workKind.file));
  const read = await readRecords(workKind, { root: options.root, source: options.source });
  const items = new Map<string, RecordEntry>();
  for (const r of read.records) if (r.id !== null && !items.has(r.id)) items.set(r.id, r);
  const decisions = new Map((read.decisions ?? []).map((d) => [d.id, d]));
  const closed = new Set(decisionKind.kind.closedStates ?? []);

  for (const e of entries) {
    if (e.data === null) continue;
    const named = str(e.data[flag.work.field]);
    if (named === null) {
      e.flag = { work: null, implements: [], stale: false };
      continue;
    }
    const item = items.get(named);
    if (!item) {
      e.flag = { work: { id: named, state: null }, implements: [], stale: false };
      e.warnings.push({ code: "flag-work-unknown", message: `hides the work item ${named}, which no record in ${flag.work.kind} has` });
      continue;
    }
    const implementsList: FlagDecision[] = (item.implements ?? []).map((d) => {
      const decision = decisions.get(d.id);
      return { ...d, confirmed: decision !== undefined && decision.state !== null && closed.has(decision.state) && decision.supersededBy === null };
    });
    const stale = implementsList.length > 0 && implementsList.every((d) => d.confirmed);
    e.flag = { work: { id: named, state: item.state }, implements: implementsList, stale };
    if (stale) {
      e.warnings.push({
        code: "flag-stale",
        message: `is due for removal: its work item ${named} implements ${implementsList.map((d) => `${d.id} (${d.state})`).join(", ")}, and every one is confirmed`,
      });
    }
  }
}


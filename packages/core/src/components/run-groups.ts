/**
 * What a promote under a release, `components fan-out` and `run --components`
 * say about the groups they applied as one (ws-107, #4465), as `pr-report`
 * says it for a pull request since #4446: each group with its members, the
 * wave it ran in, its digest and the reads its apply computes, how each
 * member ended, and why each component that could have grouped did not.
 */

import type { ChangeSetDocument } from "../change-set";
import type { GroupMemberStatus } from "./capability";
import type { FanOutGroup, FanOutGroupFallback, FanOutPlan } from "./fan-out";

/** One group a run applied as one. */
export interface RunGroupReport {
  /** The kind of the capability every member's one step names. */
  capability: string;
  /** The members, in apply order: upstreams first. */
  components: string[];
  /** The 1-based wave of the grouped fan-out it ran in. */
  wave: number;
  /** The group digest folded into each member's `planDigest`; `null` when it failed to plan. Absent when the run planned it in its wave. */
  digest?: string | null;
  /** Why the group failed to plan. */
  error?: string;
  /** Each read of another member its plan did not know, by change-set member, which the group's apply computes. Absent when none. */
  reads?: Array<{ member: string; ref: string }>;
  /** How each member's part ended, as the capability said. Absent when the group did not run. */
  outcomes?: Record<string, GroupMemberStatus>;
}

export interface RunGroupsReport {
  groups?: RunGroupReport[];
  fallbacks?: FanOutGroupFallback[];
}

/**
 * The report of `grouped`'s groups. `planned` are the groups a release gate's
 * plan planned (`ReleasePlan.groups`), with their digests; `doc` is the
 * change set they are in, which names each member's reads; `outcomes` is the
 * run's `groupOutcomes`.
 */
export function runGroupsReport(input: {
  grouped: FanOutPlan | undefined;
  planned?: ReadonlyArray<FanOutGroup & { digest: string | null; error?: string }>;
  doc?: ChangeSetDocument;
  outcomes?: Record<string, GroupMemberStatus>;
}): RunGroupsReport {
  const waves = input.grouped?.waves ?? [];
  const waveOf = new Map(waves.flatMap((w, i) => w.map((name) => [name, i + 1] as const)));
  const groups: Array<FanOutGroup & { digest?: string | null; error?: string }> = input.planned?.length ? [...input.planned] : [...(input.grouped?.groups ?? [])];
  const out: RunGroupReport[] = groups.map((g) => {
    const reads = g.digest
      ? (input.doc?.members ?? []).filter((m) => m.group?.digest === g.digest).flatMap((m) => m.group!.reads.map((ref) => ({ member: m.member, ref })))
      : [];
    const outcomes = Object.fromEntries(g.components.filter((c) => input.outcomes?.[c] !== undefined).map((c) => [c, input.outcomes![c]!]));
    return {
      capability: g.capability,
      components: [...g.components],
      wave: waveOf.get(g.components[0]!) ?? 0,
      ...(g.digest !== undefined ? { digest: g.digest } : {}),
      ...(g.error !== undefined ? { error: g.error } : {}),
      ...(reads.length > 0 ? { reads } : {}),
      ...(Object.keys(outcomes).length > 0 ? { outcomes } : {}),
    };
  });
  const fallbacks = input.grouped?.fallbacks ?? [];
  return { ...(out.length > 0 ? { groups: out } : {}), ...(fallbacks.length > 0 ? { fallbacks: [...fallbacks] } : {}) };
}

/** `a`, `b` and `c`. */
const listed = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

const OUTCOME_WORDS: Record<GroupMemberStatus, string> = {
  applied: "applied",
  "no-changes": "had no changes",
  partial: "applied in part, and what applied stays",
  failed: "failed",
  "not-started": "did not start",
};

/**
 * The report as lines for a person: one per group naming its members, wave,
 * digest and the reads its apply computes, then how each member ended, and,
 * when the apply stopped part way, what `again` (the command to run again)
 * plans next. Then why the components that could have grouped did not; a
 * fallback of kind `off` is not printed.
 */
export function renderRunGroups(report: RunGroupsReport, again: string): string[] {
  const out: string[] = [];
  for (const g of report.groups ?? []) {
    const reads = (g.reads ?? []).map((r) => `${r.member} reads ${r.ref}`);
    out.push(
      `${listed(g.components)} plan and apply as one (${g.capability}, wave ${g.wave}${g.digest ? `, group ${g.digest}` : ""})` +
        (g.error ? `; the group failed to plan, so nothing of it applied: ${g.error}` : reads.length > 0 ? `; ${listed(reads)}, known when the group applies` : ""),
    );
    const outcomes = g.outcomes ?? {};
    const ran = g.components.filter((c) => outcomes[c] !== undefined);
    if (ran.length === 0) continue;
    out.push(`  ${ran.map((c) => `${c} ${OUTCOME_WORDS[outcomes[c]!]}`).join("; ")}`);
    const left = ran.filter((c) => outcomes[c] !== "applied" && outcomes[c] !== "no-changes");
    if (left.length > 0) {
      out.push(`  the group's apply stopped part way and nothing that applied is undone; ${again} plans ${listed(left)} again, as one group where they still join`);
    }
  }
  const byWhy = new Map<string, string[]>();
  for (const f of report.fallbacks ?? []) {
    if (f.kind === "off") continue;
    const why = `(${f.kind}): ${f.reason}`;
    byWhy.set(why, [...(byWhy.get(why) ?? []), f.component]);
  }
  for (const [why, names] of byWhy) out.push(`planned one by one, not as a group: ${names.join(", ")} ${why}`);
  return out;
}

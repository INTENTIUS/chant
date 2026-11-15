/**
 * Scoring for the pull request preset replay (#5118): the bar, the labelled
 * corpus format, and the precision of the preset over a set of findings.
 * Shared by the replay harness (`replay.ts`), which produces the findings by
 * running chant over the saved corpus, and `bar.test.ts`, which scores the
 * findings recorded in `corpus.json` without running anything.
 */

import { presetGate, type PresetGate, type RulePreset } from "../../packages/core/src/audit/pull-request-preset";
import type { Severity } from "../../packages/core/src/lint/rule";

/**
 * The bar, from the issue's Done-when: merge-blocking findings at least 35%
 * true, every true finding kept, and at most 10 of the 159 changes blocked.
 */
export const BAR = { precision: 0.35, maxBlockedChanges: 10 } as const;

/**
 * The id the harness gives an unstable `chant helm localize` render. It is not
 * a lint rule; the preset runs the localize check beside its rules and treats
 * a render that became unstable as merge-blocking.
 */
export const LOCALIZE_CHECK_ID = "HELM-LOCALIZE";

export type Label = "true" | "debatable" | "noise";

/** Which command produced a finding: the repository audit, the per-file lint, or the localize check. */
export type ReplayCheck = "audit" | "lint" | "localize";

export interface ReplayFinding {
  /** The change's commit in the corpus. */
  change: string;
  check: ReplayCheck;
  rule: string;
  file: string;
  /** `identity.ts` over the finding; for lint, over the path inside the import project. */
  identity: string;
  severity: Severity;
  entity?: string;
  message: string;
}

export interface LabelledFinding extends ReplayFinding {
  label: Label;
  /** Why, in a sentence. A key into `reasons` when it starts with `@`. */
  reason: string;
}

export interface Corpus {
  /** What was replayed, with which chant, and when. */
  meta: Record<string, unknown>;
  /** Shared reasons, referenced from findings as `@key`. */
  reasons: Record<string, string>;
  /** Commits of the changes in scope, in order. */
  changes: string[];
  findings: LabelledFinding[];
}

/**
 * What names a finding in the corpus. The file is part of it because a
 * per-file lint names its findings inside its own import project, so two
 * files of one change can give the same identity.
 */
export function findingKey(f: Pick<ReplayFinding, "change" | "check" | "file" | "identity">): string {
  return `${f.change} ${f.check} ${f.file} ${f.identity}`;
}

export function reasonOf(corpus: Pick<Corpus, "reasons">, f: Pick<LabelledFinding, "reason">): string {
  return f.reason.startsWith("@") ? (corpus.reasons[f.reason.slice(1)] ?? f.reason) : f.reason;
}

/** The set a replayed finding falls in. The localize check is merge-blocking. */
export function gateOf(preset: RulePreset, f: Pick<ReplayFinding, "rule" | "severity" | "check">): PresetGate | undefined {
  if (f.check === "localize") return "merge-blocking";
  return presetGate(preset, f.rule, f.severity);
}

export interface Score {
  findings: number;
  truePositives: number;
  precision: number;
  blockedChanges: string[];
  /** True findings in the whole set that the preset does not report as merge-blocking. */
  trueDropped: LabelledFinding[];
  byRule: Record<string, { total: number; true: number; debatable: number; noise: number }>;
}

/** Precision of `findings` with every rule on, or of its merge-blocking part under `preset`. */
export function score(findings: readonly LabelledFinding[], preset?: RulePreset): Score {
  const kept = preset ? findings.filter((f) => gateOf(preset, f) === "merge-blocking") : [...findings];
  const byRule: Score["byRule"] = {};
  for (const f of kept) {
    const r = (byRule[f.rule] ??= { total: 0, true: 0, debatable: 0, noise: 0 });
    r.total++;
    r[f.label]++;
  }
  const truePositives = kept.filter((f) => f.label === "true").length;
  const keptKeys = new Set(kept.map(findingKey));
  return {
    findings: kept.length,
    truePositives,
    precision: kept.length === 0 ? 0 : truePositives / kept.length,
    blockedChanges: [...new Set(kept.map((f) => f.change))],
    trueDropped: findings.filter((f) => f.label === "true" && !keptKeys.has(findingKey(f))),
    byRule,
  };
}

/** Why `s` misses the bar, one line each; empty when it meets it. */
export function barFailures(s: Score): string[] {
  const out: string[] = [];
  // A window with no merge-blocking finding blocks nothing, so it cannot be wrong; the
  // true findings it must keep are checked below.
  if (s.findings > 0 && s.precision < BAR.precision) {
    out.push(`precision ${pct(s.precision)} (${s.truePositives} of ${s.findings}) is below the bar of ${pct(BAR.precision)}`);
  }
  if (s.trueDropped.length > 0) {
    out.push(`${s.trueDropped.length} true finding(s) are not merge-blocking: ${s.trueDropped.map((f) => `${f.rule} ${f.file}`).join("; ")}`);
  }
  if (s.blockedChanges.length > BAR.maxBlockedChanges) {
    out.push(`${s.blockedChanges.length} changes get a merge-blocking finding, more than ${BAR.maxBlockedChanges}`);
  }
  return out;
}

export function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

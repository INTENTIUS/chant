/**
 * The pull request preset (#5118): a named rule set and a severity floor that
 * `chant audit --preset pull-request` and `chant lint --preset pull-request`
 * both read, so a check that runs on every pull request reports what the
 * change introduced and blocks only on rules that were right most of the time
 * on a replay of real history.
 *
 * Each rule is in one of three sets. A merge-blocking finding fails the run.
 * A report-only finding is printed and never fails it. A tool notice (an
 * import or a build that chant could not finish) is printed apart from the
 * findings, since it says what chant could not read rather than what is wrong
 * with the change. Every other rule is off, so a rule added later stays off
 * here until a replay shows it meets the bar.
 *
 * With a baseline (the same command's JSON or SARIF report on the pull
 * request's base), only findings whose identity (`identity.ts`, #5106) is not
 * in the baseline are reported. A finding that was there before the change
 * is not the change's to fix.
 *
 * The lists, and the measured reason each off rule is off, come from the
 * replay in `test/pr-preset-replay/`. `test/pr-preset-replay/bar.test.ts`
 * fails if a change to these lists drops the replay's precision below the bar.
 */

import type { Severity } from "../lint/rule";
import { findingIdentities, IDENTITY_FINGERPRINT_KEY } from "./identity";

export type PresetGate = "merge-blocking" | "report-only" | "notice";

export interface RulePreset {
  name: string;
  /** Findings below this severity are not reported in any set. */
  floor: Severity;
  mergeBlocking: readonly string[];
  reportOnly: readonly string[];
  /** Ids that report a tool failure, not a defect. */
  notices: readonly string[];
  /** Rules this preset leaves out on purpose, with the measured reason. Any id in no set is off too. */
  off: Readonly<Record<string, string>>;
}

export const PULL_REQUEST_PRESET_NAME = "pull-request";

const SECRET_FORMATS = ["SEC001", "SEC002", "SEC003", "SEC004", "SEC005", "SEC006", "SEC007", "SEC008", "SEC009"];

export const PULL_REQUEST_PRESET: RulePreset = {
  name: PULL_REQUEST_PRESET_NAME,
  floor: "warning",
  mergeBlocking: [
    // Fields the API server prunes from a CRD-backed object.
    "WK8501",
    // A dashboard variable the dashboard does not define.
    "GRAF103",
    // Secrets in a known format.
    ...SECRET_FORMATS,
  ],
  reportOnly: [
    "WK8102",
    "WK8104",
    "WK8105",
    "WK8201",
    "WK8301",
    "WK8302",
    "WK8003",
    "TF010",
    "TF011",
    "TF012",
    "TF017",
    "TF020",
    "TF039",
    "PROM217",
    // Silent on the replay since their fixes (#5081, #5080): no finding to
    // measure, so they report and never block.
    "TF006",
    "TF022",
    // Proposed as merge-blocking on #5118 and measured on two six-month
    // windows of the replay: none of their findings was true, so they report
    // and never block. Counts are new findings, the first window then the second.
    // Duplicate panel ids and overlapping panels: 21 and 5, none true.
    // Grafana renumbers and moves the panels when it loads the dashboard.
    "GRAF104",
    "GRAF105",
    // Container security context: 6 and 116, none true. Most of the second
    // window's came from manifests moved to a new path, or node DaemonSets
    // that need root by design.
    "WK8203",
    "WK8204",
    "WK8205",
    // Provider version pins: 2 and 2, none true. Two of the four were a pin
    // missing before the change, reported again because a new provider block
    // moved the finding's identity.
    "TF002",
  ],
  notices: ["LEX002", "EVL001"],
  off: {
    COR001: "judges the TypeScript chant import wrote, not the change: 116 new findings on the replay, none true",
    COR004: "judges the TypeScript chant import wrote, not the change: 88 new findings on the replay, none true",
    COR009: "judges the TypeScript chant import wrote, not the change: 1 new finding on the replay, not true",
    COR013: "judges the TypeScript chant import wrote, not the change",
    WK8001: "a namespace written in a manifest is normal: 21 new findings on the replay, none true",
    GRAF101: "an imported dashboard needs no datasource variable: 29 new findings on the replay, none true",
    GRAF107: "keys Grafana still accepts that the pinned schema lacks: 131 new findings on the replay, none true",
    SEC010: "high-entropy strings on the replay were URLs, ARNs, a managed policy name and a secret path: 6 new findings, none true",
    TF007: "no new finding on the replay since #5081, but it still reports a UUID default such as a subscription id",
    TF009: "an HMAC key id fed from secret_data, which the provider already marks sensitive: 6 new findings on the replay, none true",
    ARGO003: "needs the cluster list from another file, which a per-file run cannot see: 1 new finding on the replay, not true",
    ARGO005: "a per-file run cannot see the directory a source.path names: 1 new finding on the replay, not true",
    WK8503: "needs the ExternalSecret in another file of the kustomization: 1 new finding on the replay, not true",
  },
};

const PRESETS: Readonly<Record<string, RulePreset>> = { [PULL_REQUEST_PRESET_NAME]: PULL_REQUEST_PRESET };

/** The preset a `--preset <name>` names, or undefined. */
export function resolveRulePreset(name: string): RulePreset | undefined {
  return PRESETS[name];
}

/** Every preset name, for an error message. */
export function rulePresetNames(): string[] {
  return Object.keys(PRESETS);
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

/** Which set a finding falls in under `preset`, or undefined when the preset leaves it out. */
export function presetGate(preset: RulePreset, checkId: string, severity: Severity): PresetGate | undefined {
  if (preset.notices.includes(checkId)) return "notice";
  if (RANK[severity] < RANK[preset.floor]) return undefined;
  if (preset.mergeBlocking.includes(checkId)) return "merge-blocking";
  if (preset.reportOnly.includes(checkId)) return "report-only";
  return undefined;
}

/** What a finding needs for the preset to place it and to compute its identity. */
export interface PresetInput {
  checkId: string;
  file: string;
  severity: Severity;
  entity?: string;
  locator?: string;
  fingerprint?: string;
  missing?: { kind: string; scope: string };
}

export type PresetFinding<T> = T & { identity: string; gate: PresetGate };

export interface PresetResult<T> {
  /** Findings that fail the run: merge-blocking and not in the baseline. */
  mergeBlocking: PresetFinding<T>[];
  reportOnly: PresetFinding<T>[];
  notices: PresetFinding<T>[];
  /** Findings in a set whose identity the baseline already had. */
  unchanged: number;
  /** Findings the preset leaves out, by rule or by the floor. */
  off: number;
}

/**
 * Place each finding under the preset. `findings` must be in the order the
 * command emitted them, since identity tells equal findings apart by their
 * order. With `baseline`, a finding whose identity it holds is counted in
 * `unchanged` and not reported.
 */
export function applyRulePreset<T extends PresetInput>(
  preset: RulePreset,
  findings: readonly T[],
  baseline?: ReadonlySet<string>,
): PresetResult<T> {
  const identities = findingIdentities(findings);
  const result: PresetResult<T> = { mergeBlocking: [], reportOnly: [], notices: [], unchanged: 0, off: 0 };
  findings.forEach((f, i) => {
    const gate = presetGate(preset, f.checkId, f.severity);
    if (gate === undefined) {
      result.off++;
      return;
    }
    const identity = identities[i];
    if (gate !== "notice" && baseline?.has(identity)) {
      result.unchanged++;
      return;
    }
    const placed = { ...f, identity, gate };
    if (gate === "merge-blocking") result.mergeBlocking.push(placed);
    else if (gate === "report-only") result.reportOnly.push(placed);
    else result.notices.push(placed);
  });
  return result;
}

/**
 * The finding identities in a baseline report: a `chant audit --format json`
 * report (`findings[].identity`), a SARIF report from `chant audit` or from
 * `chant lint --preset` (`partialFingerprints`), or the JSON array `chant lint
 * --preset --format json` prints.
 * Throws on text that is none of these, so a wrong file is not read as an
 * empty baseline that reports every finding as new.
 */
export function readBaselineIdentities(text: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the baseline is not JSON; pass the JSON or SARIF report of the same command run on the base");
  }
  const ids = new Set<string>();
  // `chant lint --preset --format json` prints the diagnostics as an array.
  if (Array.isArray(parsed)) {
    for (const d of parsed as Array<{ identity?: unknown }>) if (typeof d?.identity === "string") ids.add(d.identity);
    if (parsed.length > 0 && ids.size === 0) throw new Error("the baseline's findings carry no identity; run the base with --preset too");
    return ids;
  }
  const doc = parsed as { findings?: unknown; runs?: unknown };
  if (Array.isArray(doc.findings)) {
    for (const f of doc.findings as Array<{ identity?: unknown }>) if (typeof f?.identity === "string") ids.add(f.identity);
    return ids;
  }
  if (Array.isArray(doc.runs)) {
    for (const run of doc.runs as Array<{ results?: Array<{ partialFingerprints?: Record<string, unknown> }> }>) {
      for (const r of run.results ?? []) {
        const id = r.partialFingerprints?.[IDENTITY_FINGERPRINT_KEY];
        if (typeof id === "string") ids.add(id);
      }
    }
    return ids;
  }
  throw new Error("the baseline has no findings[] or SARIF runs[]; pass the JSON or SARIF report of the same command run on the base");
}

/** One line for a run under the preset, for the end of a text report. */
export function presetSummary(preset: RulePreset, result: PresetResult<unknown>, withBaseline: boolean): string {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const parts = [
    `${n(result.mergeBlocking.length, "merge-blocking finding")}`,
    `${result.reportOnly.length} report-only`,
    ...(result.notices.length > 0 ? [n(result.notices.length, "tool notice")] : []),
    ...(withBaseline ? [`${result.unchanged} already on the base`] : []),
    `${result.off} left out by the preset`,
  ];
  return `Preset ${preset.name}: ${parts.join(", ")}.`;
}

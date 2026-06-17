/**
 * Shared report model — turns raw findings into the structured shape both the
 * Markdown and HTML renderers consume, so they can never drift. Computes the
 * tier split, de-noising, per-file quick-win patches (combined unified diff via
 * proof.ts), guidance clusters, and severity counts.
 */

import type { AuditFinding } from "./core";
import { RULE_CATALOG, ruleDocUrl, type Authority, type Category, type FixKind, type RuleMeta, type Tier } from "./catalog";
import { proveFix, unifiedDiff, type ProveOptions } from "./proof";
import type { Severity } from "../lint/rule";

/**
 * Version of the machine-readable JSON report. Stability contract: additive
 * changes (new fields) keep the same major; renamed/removed fields bump the
 * major. Consumers should check the major and ignore unknown fields. See
 * `docs/cli/audit`.
 */
// Additive changes (new fields like `category`, #415) keep the same version per
// the stability contract; only renamed/removed fields bump it.
export const REPORT_SCHEMA_VERSION = "1.0";

export const SEVERITY_WEIGHT: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Report-only rules made redundant by a specific merge-worthy rule on the same entity. */
const SUPERSEDED_BY: Record<string, string[]> = {
  WGL021: ["WGL016"], // "unused variable" is noise when the var is a flagged hardcoded secret
};

export interface EnrichedFinding extends AuditFinding {
  meta: RuleMeta;
}

/** A per-file quick-win: a combined patch plus any findings still needing input. */
export interface QuickWinFile {
  file: string;
  /** Combined unified diff of the deterministic fixes applied to this file. */
  diff?: string;
  /** Rules the diff addresses. */
  addressed: RuleMeta[];
  /** Deduped findings that are deterministic but blocked on a value (e.g. a SHA). */
  needsInput: EnrichedFinding[];
}

/** Guidance findings grouped by their primary authority. */
export interface GuidanceCluster {
  name: string;
  url?: string;
  rules: Array<{ meta: RuleMeta; findings: EnrichedFinding[] }>;
}

export interface ReportCounts {
  total: number;
  quickWin: number;
  needsReview: number;
  reportOnly: number;
  errors: number;
  warnings: number;
  infos: number;
  /** Findings by category (#415) — what kind of issue, not how confident the fix. */
  security: number;
  correctness: number;
  bestPractice: number;
}

export interface ReportModel {
  counts: ReportCounts;
  quickWins: QuickWinFile[];
  needsReview: GuidanceCluster[];
  reportOnly: EnrichedFinding[];
  /** All shown findings (after de-noise), flat and sorted — for serialization. */
  findings: EnrichedFinding[];
}

/** Provenance snapshot of what was audited (anchors findings to a commit). */
export interface AuditSnapshot {
  target: string;
  host?: string;
  repo?: string;
  ref?: string;
  commit?: string;
  files: string[];
  generatedAt: string;
  toolVersion: string;
}

/** A finding flattened for the machine-readable JSON report. */
export interface SerializedFinding {
  checkId: string;
  severity: Severity;
  message: string;
  file: string;
  entity?: string;
  lexicon: string;
  tier: Tier;
  fixKind: FixKind;
  /** What kind of finding this is (security / correctness / best-practice). */
  category: Category;
  title: string;
  remediation: string;
  authority: Authority[];
  /** Link to this rule's entry in the audit rules reference. */
  docUrl: string;
}

/** The versioned machine-readable audit report. */
export interface AuditReportJson {
  schemaVersion: string;
  tool: { name: string; version: string };
  snapshot?: AuditSnapshot;
  summary: ReportCounts;
  findings: SerializedFinding[];
}

export function metaFor(id: string): RuleMeta {
  return (
    RULE_CATALOG[id] ?? {
      id,
      tier: "report-only" as Tier,
      fixKind: "guidance",
      title: id,
      remediation: "",
      yamlBased: true,
    }
  );
}

export function sortFindings(a: EnrichedFinding, b: EnrichedFinding): number {
  const sev = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
  if (sev !== 0) return sev;
  if (a.checkId !== b.checkId) return a.checkId < b.checkId ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function byFile(items: EnrichedFinding[]): Map<string, EnrichedFinding[]> {
  const map = new Map<string, EnrichedFinding[]>();
  for (const it of [...items].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const list = map.get(it.file) ?? [];
    list.push(it);
    map.set(it.file, list);
  }
  return map;
}

function clusterName(m: RuleMeta): string {
  return m.authority?.[0]?.name ?? "General hardening";
}

function buildQuickWins(findings: EnrichedFinding[], contents: Map<string, string>, proveOpts: ProveOptions): QuickWinFile[] {
  const out: QuickWinFile[] = [];
  for (const [file, group] of byFile(findings)) {
    const ids = [...new Set(group.map((f) => f.checkId))].sort();
    const original = contents.get(file);
    const addressed: RuleMeta[] = [];
    const needsInput: EnrichedFinding[] = [];
    let patched = original;

    if (original !== undefined) {
      for (const id of ids) {
        const res = proveFix(id, patched ?? original, proveOpts);
        if (res.applied && res.patched !== undefined) {
          patched = res.patched;
          addressed.push(metaFor(id));
        } else if (res.reason === "needs-input") {
          needsInput.push(...group.filter((f) => f.checkId === id));
        }
        // "noop" (already resolved by a prior fix in the combined patch) is dropped.
      }
    } else {
      for (const f of group) needsInput.push(f);
    }

    const diff = original !== undefined && patched !== undefined && patched !== original ? unifiedDiff(original, patched) : undefined;

    // Dedupe needs-input by check + entity.
    const seen = new Set<string>();
    const deduped = needsInput.filter((f) => {
      const k = `${f.checkId}:${f.entity ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    out.push({ file, diff, addressed, needsInput: deduped });
  }
  return out;
}

function buildClusters(findings: EnrichedFinding[]): GuidanceCluster[] {
  const clusters = new Map<string, EnrichedFinding[]>();
  for (const f of [...findings].sort(sortFindings)) {
    const key = clusterName(f.meta);
    const list = clusters.get(key) ?? [];
    list.push(f);
    clusters.set(key, list);
  }
  return [...clusters.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, group]) => {
      const byRule = new Map<string, EnrichedFinding[]>();
      for (const f of group) {
        const list = byRule.get(f.checkId) ?? [];
        list.push(f);
        byRule.set(f.checkId, list);
      }
      return {
        name,
        url: group[0].meta.authority?.[0]?.url,
        rules: [...byRule.values()].map((findings) => ({ meta: findings[0].meta, findings })),
      };
    });
}

export interface BuildModelOptions {
  files?: Array<{ path: string; content: string }>;
  resolveSha?: ProveOptions["resolveSha"];
  resolveDigest?: ProveOptions["resolveDigest"];
}

/** Build the structured report model from raw findings. */
export function buildReportModel(findings: AuditFinding[], opts: BuildModelOptions = {}): ReportModel {
  const enriched: EnrichedFinding[] = findings.map((f) => ({ ...f, meta: metaFor(f.checkId) }));
  const contents = new Map((opts.files ?? []).map((f) => [f.path, f.content]));

  const mergeWorthy = enriched.filter((f) => f.meta.tier === "merge-worthy");
  const quickWinFindings = mergeWorthy.filter((f) => f.meta.fixKind === "deterministic");
  const needsReviewFindings = mergeWorthy.filter((f) => f.meta.fixKind === "guidance");

  // De-noise: drop a report-only finding only when a specific merge-worthy
  // finding supersedes it on the same entity; keep unrelated hygiene.
  const mwOnEntity = new Set(mergeWorthy.filter((f) => f.entity).map((f) => `${f.file}:${f.entity}:${f.checkId}`));
  const reportOnly = enriched.filter((f) => {
    if (f.meta.tier !== "report-only") return false;
    const supers = SUPERSEDED_BY[f.checkId];
    if (supers && f.entity && supers.some((id) => mwOnEntity.has(`${f.file}:${f.entity}:${id}`))) return false;
    return true;
  });

  const shown = [...quickWinFindings, ...needsReviewFindings, ...reportOnly];
  const counts: ReportCounts = {
    total: shown.length,
    quickWin: quickWinFindings.length,
    needsReview: needsReviewFindings.length,
    reportOnly: reportOnly.length,
    errors: shown.filter((f) => f.severity === "error").length,
    warnings: shown.filter((f) => f.severity === "warning").length,
    infos: shown.filter((f) => f.severity === "info").length,
    security: shown.filter((f) => f.meta.category === "security").length,
    correctness: shown.filter((f) => f.meta.category === "correctness").length,
    bestPractice: shown.filter((f) => f.meta.category === "best-practice").length,
  };

  return {
    counts,
    quickWins: buildQuickWins(quickWinFindings, contents, { resolveSha: opts.resolveSha, resolveDigest: opts.resolveDigest }),
    needsReview: buildClusters(needsReviewFindings),
    reportOnly: [...reportOnly].sort(sortFindings),
    findings: [...shown].sort(sortFindings),
  };
}

/** Build the versioned, machine-readable JSON report (stable contract). */
export function buildReportJson(findings: AuditFinding[], opts: { snapshot?: AuditSnapshot; toolVersion?: string } = {}): AuditReportJson {
  const model = buildReportModel(findings);
  const version = opts.toolVersion ?? opts.snapshot?.toolVersion ?? "0.0.0";
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "chant-audit", version },
    snapshot: opts.snapshot,
    summary: model.counts,
    findings: model.findings.map((f) => ({
      checkId: f.checkId,
      severity: f.severity,
      message: f.message,
      file: f.file,
      entity: f.entity,
      lexicon: f.lexicon,
      tier: f.meta.tier,
      fixKind: f.meta.fixKind,
      category: f.meta.category,
      title: f.meta.title,
      remediation: f.meta.remediation,
      authority: f.meta.authority ?? [],
      docUrl: ruleDocUrl(f.checkId),
    })),
  };
}

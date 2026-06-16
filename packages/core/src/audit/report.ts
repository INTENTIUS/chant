/**
 * Markdown report generator for audit findings.
 *
 * Structure:
 *  - **Quick wins (deterministic)** — merge-worthy findings with a safe
 *    mechanical fix, grouped per file with one combined unified diff (from
 *    proof.ts) so the report doubles as a ready-to-apply patch. Pin fixes that
 *    need a SHA (no resolver) are listed instead of diffed.
 *  - **Needs review (guidance)** — merge-worthy findings that need judgment,
 *    clustered by their primary authority so related rules (e.g. all
 *    pull_request_target / pwn-request checks) read as one concern.
 *  - **Report-only (hygiene)** — a compact table.
 *
 * Deterministic ordering keeps snapshots stable. Pure string output.
 */

import type { AuditFinding } from "./core";
import { RULE_CATALOG, type RuleMeta, type Tier } from "./catalog";
import { proveFix, unifiedDiff, type ProveOptions } from "./proof";
import type { Severity } from "../lint/rule";

export interface RenderOptions {
  /** Repo URL or path shown in the header. */
  target?: string;
  /** Audited file contents (path → YAML), enabling inline fix diffs. */
  files?: Array<{ path: string; content: string }>;
  /** Resolve an action ref to a SHA so pin fixes can be diffed. */
  resolveSha?: ProveOptions["resolveSha"];
  /** Resolve a container image to a digest so image-pin fixes can be diffed. */
  resolveDigest?: ProveOptions["resolveDigest"];
  /** Coverage caveats shown near the top (e.g. unresolved GitLab includes). */
  notes?: string[];
}

const SEVERITY_WEIGHT: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Report-only rules made redundant by a specific merge-worthy rule on the same
 * entity. Narrow by design — only genuinely duplicative pairs.
 */
const SUPERSEDED_BY: Record<string, string[]> = {
  WGL021: ["WGL016"], // "unused variable" is noise when the var is a flagged hardcoded secret
};

function metaFor(id: string): RuleMeta {
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

interface EnrichedFinding extends AuditFinding {
  meta: RuleMeta;
}

function enrich(findings: AuditFinding[]): EnrichedFinding[] {
  return findings.map((f) => ({ ...f, meta: metaFor(f.checkId) }));
}

function sortFindings(a: EnrichedFinding, b: EnrichedFinding): number {
  const sev = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
  if (sev !== 0) return sev;
  if (a.checkId !== b.checkId) return a.checkId < b.checkId ? -1 : 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function byFile<T extends { file: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of [...items].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const list = map.get(it.file) ?? [];
    list.push(it);
    map.set(it.file, list);
  }
  return map;
}

// ── Quick wins (deterministic) ───────────────────────────────────────

function renderQuickWins(
  findings: EnrichedFinding[],
  contents: Map<string, string>,
  proveOpts: ProveOptions,
): string[] {
  const lines: string[] = ["## Quick wins (deterministic)", "", "Safe mechanical fixes — the diff changes only the flagged lines.", ""];

  for (const [file, group] of byFile(findings)) {
    lines.push(`### \`${file}\``);
    const ids = [...new Set(group.map((f) => f.checkId))].sort();
    const original = contents.get(file);

    const addressed: string[] = [];
    const needsInput: EnrichedFinding[] = [];
    let patched = original;

    if (original !== undefined) {
      for (const id of ids) {
        const res = proveFix(id, patched ?? original, proveOpts);
        if (res.applied && res.patched !== undefined) {
          patched = res.patched;
          addressed.push(id);
        } else if (res.reason === "needs-input") {
          // Deterministic but blocked on input (e.g. pin needs a SHA).
          needsInput.push(...group.filter((f) => f.checkId === id));
        }
        // reason "noop" (already resolved by a prior fix in the combined patch)
        // is intentionally dropped — not listed as needing attention.
      }
    }

    if (original !== undefined && patched !== undefined && patched !== original) {
      const labels = addressed.map((id) => `${id} (${metaFor(id).title})`).join(", ");
      lines.push("", `Addresses ${labels}:`, "", "```diff", unifiedDiff(original, patched), "```");
    } else if (original === undefined) {
      // No content available — list the findings with remediation.
      for (const f of group) needsInput.push(f);
    }

    const seen = new Set<string>();
    const leftover = needsInput.filter((f) => {
      const k = `${f.checkId}:${f.entity ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (leftover.length > 0) {
      lines.push("", "Needs a value before it can be auto-patched:");
      for (const f of leftover) {
        const where = f.entity ? ` (\`${f.entity}\`)` : "";
        lines.push(`- **${f.checkId}**${where} — ${f.meta.remediation}`);
      }
    }
    lines.push("");
  }

  return lines;
}

// ── Needs review (guidance), clustered by authority ──────────────────

function clusterKey(m: RuleMeta): string {
  return m.authority?.[0]?.name ?? "General hardening";
}

function renderNeedsReview(findings: EnrichedFinding[]): string[] {
  const lines: string[] = ["These need a judgement call — remediation guidance, not an auto-fix.", ""];

  const clusters = new Map<string, EnrichedFinding[]>();
  for (const f of [...findings].sort(sortFindings)) {
    const key = clusterKey(f.meta);
    const list = clusters.get(key) ?? [];
    list.push(f);
    clusters.set(key, list);
  }

  for (const [cluster, group] of [...clusters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const authority = group[0].meta.authority?.[0];
    const heading = authority ? `[${cluster}](${authority.url})` : cluster;
    lines.push(`### ${heading}`, "");
    const byRule = new Map<string, EnrichedFinding[]>();
    for (const f of group) {
      const list = byRule.get(f.checkId) ?? [];
      list.push(f);
      byRule.set(f.checkId, list);
    }
    for (const [id, rule] of byRule) {
      lines.push(`- **${id}** — ${rule[0].meta.title} (${rule[0].severity}). ${rule[0].meta.remediation}`);
      for (const f of rule) {
        const where = f.entity ? `\`${f.file}\` (\`${f.entity}\`)` : `\`${f.file}\``;
        lines.push(`  - ${where} — ${escapeCell(f.message)}`);
      }
    }
    lines.push("");
  }

  return lines;
}

function renderReportOnly(findings: EnrichedFinding[]): string[] {
  const lines: string[] = ["", "| Rule | Title | File | Detail |", "| --- | --- | --- | --- |"];
  for (const f of [...findings].sort(sortFindings)) {
    lines.push(`| ${f.checkId} | ${escapeCell(f.meta.title)} | \`${f.file}\` | ${escapeCell(f.message)} |`);
  }
  lines.push("");
  return lines;
}

/** Render an audit report as Markdown. */
export function renderMarkdown(findings: AuditFinding[], opts: RenderOptions = {}): string {
  const enriched = enrich(findings);
  const contents = new Map((opts.files ?? []).map((f) => [f.path, f.content]));

  const mergeWorthy = enriched.filter((f) => f.meta.tier === "merge-worthy");
  const quickWins = mergeWorthy.filter((f) => f.meta.fixKind === "deterministic");
  const needsReview = mergeWorthy.filter((f) => f.meta.fixKind === "guidance");

  // De-noise: drop a report-only finding only when a specific merge-worthy
  // finding supersedes it on the *same* entity (e.g. "unused variable" is noise
  // when that variable is already flagged as a hardcoded secret). Kept narrow
  // so unrelated hygiene on a shared job entity is not lost.
  const mwOnEntity = new Set(mergeWorthy.filter((f) => f.entity).map((f) => `${f.file}:${f.entity}:${f.checkId}`));
  const isSuperseded = (f: EnrichedFinding): boolean => {
    const supers = SUPERSEDED_BY[f.checkId];
    if (!supers || !f.entity) return false;
    return supers.some((id) => mwOnEntity.has(`${f.file}:${f.entity}:${id}`));
  };
  const reportOnly = enriched.filter((f) => f.meta.tier === "report-only" && !isSuperseded(f));

  const shown = [...quickWins, ...needsReview, ...reportOnly];
  const errors = shown.filter((f) => f.severity === "error").length;
  const warnings = shown.filter((f) => f.severity === "warning").length;
  const infos = shown.filter((f) => f.severity === "info").length;

  const lines: string[] = ["# CI security audit"];
  if (opts.target) lines.push("", `Target: ${opts.target}`);
  lines.push("");
  for (const note of opts.notes ?? []) lines.push(`> Note: ${note}`, "");

  if (shown.length === 0) {
    lines.push("No issues found.", "", "---", "Generated by [chant audit](https://intentius.io/chant/).", "");
    return lines.join("\n");
  }

  lines.push(
    `${shown.length} finding${shown.length === 1 ? "" : "s"} — ` +
      `${quickWins.length} quick-win, ${needsReview.length} needs-review, ${reportOnly.length} report-only ` +
      `(${errors} error, ${warnings} warning, ${infos} info).`,
    "",
  );

  // Quick wins lead, expanded. Needs-review and hygiene collapse so a pasted
  // report opens on the actionable fix.
  if (quickWins.length > 0) {
    lines.push(...renderQuickWins(quickWins, contents, { resolveSha: opts.resolveSha, resolveDigest: opts.resolveDigest }));
  }
  if (needsReview.length > 0) {
    lines.push("<details>", `<summary>Needs review (guidance) — ${needsReview.length}</summary>`, "");
    lines.push(...renderNeedsReview(needsReview));
    lines.push("</details>", "");
  }
  if (reportOnly.length > 0) {
    lines.push("<details>", `<summary>Report-only (hygiene) — ${reportOnly.length}</summary>`, "");
    lines.push(...renderReportOnly(reportOnly));
    lines.push("</details>", "");
  }

  lines.push("---", "Generated by [chant audit](https://intentius.io/chant/).", "");
  return lines.join("\n");
}

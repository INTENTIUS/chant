/**
 * Generator for the audit rules reference docs page. The page is derived from
 * RULE_CATALOG so report rule-id links always have a target, and a sync test
 * (rules-doc.test.ts) keeps the committed page in step with the catalog.
 *
 * Each rule gets an `### <ID>` heading, which Starlight slugifies to `#<id>`
 * (lowercased) — the anchor `ruleDocUrl()` links to.
 */

import { RULE_CATALOG, type RuleMeta } from "./catalog";

const GROUPS: Array<{ heading: string; prefixes: string[]; blurb: string }> = [
  { heading: "GitHub Actions (GHA)", prefixes: ["GHA"], blurb: "Also applied to Forgejo workflows, which are GitHub-dialect." },
  { heading: "GitLab CI (WGL)", prefixes: ["WGL"], blurb: "" },
  { heading: "Forgejo (WFJ)", prefixes: ["WFJ"], blurb: "" },
  { heading: "Kubernetes (WK8 / ARGO)", prefixes: ["WK8", "ARGO"], blurb: "Run against Kubernetes manifests." },
  { heading: "Docker (DKRD)", prefixes: ["DKRD"], blurb: "Run against Dockerfiles and Compose files." },
  { heading: "AWS CloudFormation (WAW / COR / EXT)", prefixes: ["WAW", "COR", "EXT"], blurb: "Run against CloudFormation templates (JSON or YAML)." },
  { heading: "Azure ARM (AZR)", prefixes: ["AZR"], blurb: "Run against ARM deployment templates (JSON)." },
  { heading: "GCP Config Connector (WGC)", prefixes: ["WGC"], blurb: "Run against Config Connector (cnrm.cloud.google.com) manifests." },
];

function ruleBlock(m: RuleMeta): string {
  const tags = `${m.tier} · ${m.fixKind}`;
  const authority = m.authority?.length
    ? `\n\nAuthority: ${m.authority.map((a) => `[${a.name}](${a.url})`).join(" · ")}`
    : "";
  return `### ${m.id}\n\n**${m.title}** — ${tags}\n\n${m.remediation}${authority}`;
}

/** Render the full audit rules reference page (frontmatter + body). */
export function renderRulesReference(): string {
  const ids = Object.keys(RULE_CATALOG).sort();
  const sections = GROUPS.map(({ heading, prefixes, blurb }) => {
    const blocks = ids.filter((id) => prefixes.some((p) => id.startsWith(p))).map((id) => ruleBlock(RULE_CATALOG[id]));
    if (blocks.length === 0) return "";
    return `## ${heading}\n${blurb ? `\n${blurb}\n` : ""}\n${blocks.join("\n\n")}`;
  }).filter(Boolean);

  return `---
title: Audit rules reference
description: Every rule chant audit can report, with its tier, fix kind, and remediation.
---

This is the reference for every rule [\`chant audit\`](/chant/cli/audit/) can report. Each finding in a report links to its rule here.

Each rule is tagged with its **tier** — \`merge-worthy\` (a security or correctness issue worth a PR) or \`report-only\` (hygiene) — and its **fix kind** — \`deterministic\` (a safe mechanical fix the report can apply as a diff) or \`guidance\` (needs a judgement call).

${sections.join("\n\n")}
`;
}

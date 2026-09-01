/**
 * Generator for the audit rules reference docs page. The page is derived from
 * RULE_CATALOG so report rule-id links always have a target, and a sync test
 * (rules-doc.test.ts) keeps the committed page in step with the catalog.
 *
 * Each rule gets an `### <ID>` heading, which Starlight slugifies to `#<id>`
 * (lowercased) — the anchor `ruleDocUrl()` links to.
 */

import { resolveAuditCatalog, type RuleMeta } from "./catalog";
import { AUDIT_LEXICONS } from "./discover";

const GROUPS: Array<{ heading: string; prefixes: string[]; blurb: string }> = [
  { heading: "GitHub Actions (GHA)", prefixes: ["GHA"], blurb: "Also applied to Forgejo workflows, which are GitHub-dialect." },
  { heading: "GitLab CI (WGL)", prefixes: ["WGL"], blurb: "" },
  { heading: "Forgejo (WFJ)", prefixes: ["WFJ"], blurb: "" },
  { heading: "Kubernetes (WK8 / ARGO / FLUX)", prefixes: ["WK8", "ARGO", "FLUX"], blurb: "Run against Kubernetes manifests." },
  { heading: "Docker (DKRD)", prefixes: ["DKRD"], blurb: "Run against Dockerfiles and Compose files." },
  { heading: "AWS CloudFormation (WAW / COR / EXT)", prefixes: ["WAW", "COR", "EXT"], blurb: "Run against CloudFormation templates (JSON or YAML)." },
  { heading: "Azure ARM (AZR)", prefixes: ["AZR"], blurb: "Run against ARM deployment templates (JSON)." },
  { heading: "GCP Config Connector (WGC)", prefixes: ["WGC"], blurb: "Run against Config Connector (cnrm.cloud.google.com) manifests." },
  { heading: "Helm (WHM)", prefixes: ["WHM"], blurb: "Run against Helm charts (Chart.yaml + templates)." },
  { heading: "fountain (FTN)", prefixes: ["FTN"], blurb: "Run against fountain manifests (`apiVersion: fountain.dev/v1`) — standalone `fountain apply` YAML is parsed back into the entity graph, so the same rules fire on `chant build` and `chant audit`." },
  { heading: "Secrets & credentials (SEC)", prefixes: ["SEC"], blurb: "Lexicon-independent — scans the raw text of every scanned file for likely credentials, regardless of which audit lexicons are installed. Matched values are always redacted; see [suppressing false positives](/chant/cli/audit/#suppressing-a-secrets-finding)." },
  { heading: "Wrangler config (WRG)", prefixes: ["WRG"], blurb: "Lexicon-independent, audit-only (#446) — scans `wrangler.toml`, Cloudflare Workers' native deploy config, which the engine cannot otherwise parse (it is not YAML/JSON). No authoring surface: chant does not write Wrangler config, it only reads it for these checks." },
  { heading: "nginx config (NGX)", prefixes: ["NGX"], blurb: "Lexicon-independent, audit-only (#1979) — parses nginx's native directive/block config (`nginx.conf` and `.conf` files under nginx-ish directories, confirmed by content). No authoring surface: chant does not write nginx config, it only reads it for these checks." },
  {
    heading: "Agent configuration (AGT)",
    prefixes: ["AGT"],
    blurb:
      "Run by `chant audit --agents` against the agent configuration on a machine — instruction files, MCP servers, skills, plugins, and permissions at system, user, and project scope. Unlike every other family here, these do not fire on repository YAML.",
  },
];

/**
 * MDX treats `{expr}` as a JavaScript expression and `<x` as JSX, so rule
 * text containing literal braces (`${VAR}` substitution references) or angle
 * brackets must be escaped or the docs build fails at render time.
 */
function mdxEscape(text: string): string {
  return text.replace(/\{/g, "\\{").replace(/</g, "\\<");
}

function ruleBlock(m: RuleMeta): string {
  const tags = `${m.tier} · ${m.fixKind}`;
  const authority = m.authority?.length
    ? `\n\nAuthority: ${m.authority.map((a) => `[${a.name}](${a.url})`).join(" · ")}`
    : "";
  return `### ${m.id}\n\n**${mdxEscape(m.title)}** — ${tags}\n\n${mdxEscape(m.remediation)}${authority}`;
}

/**
 * Render the full audit rules reference page (frontmatter + body). Aggregates
 * the catalog across every audit lexicon (#687) — each provider's rule metadata
 * now lives in its own lexicon and is merged over core's static entries — so the
 * doc lists them all. Async because it loads the lexicon plugins to collect
 * their contributed catalogs; a doc-build step has all lexicons installed.
 */
export async function renderRulesReference(): Promise<string> {
  const catalog = await resolveAuditCatalog([...AUDIT_LEXICONS]);
  const ids = Object.keys(catalog).sort();
  const sections = GROUPS.map(({ heading, prefixes, blurb }) => {
    const blocks = ids.filter((id) => prefixes.some((p) => id.startsWith(p))).map((id) => ruleBlock(catalog[id]));
    if (blocks.length === 0) return "";
    return `## ${heading}\n${blurb ? `\n${blurb}\n` : ""}\n${blocks.join("\n\n")}`;
  }).filter(Boolean);

  return `---
title: Audit rules reference
description: Every rule chant audit can report, with its tier, fix kind, and remediation.
diataxis: reference
---

This is the reference for every rule [\`chant audit\`](/chant/cli/audit/) can report. Each finding in a report links to its rule here.

Each rule is tagged with its **tier** — \`merge-worthy\` (a security or correctness issue worth a PR) or \`report-only\` (hygiene) — and its **fix kind** — \`deterministic\` (a safe mechanical fix the report can apply as a diff) or \`guidance\` (needs a judgement call).

${sections.join("\n\n")}
`;
}

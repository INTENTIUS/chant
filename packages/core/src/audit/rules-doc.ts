/**
 * Generator for the audit rules reference docs page. The page is derived from
 * RULE_CATALOG so report rule-id links always have a target, and a sync test
 * (rules-doc.test.ts) keeps the committed page in step with the catalog.
 *
 * Each rule gets an `### <ID>` heading, which Starlight slugifies to `#<id>`
 * (lowercased) — the anchor `ruleDocUrl()` links to.
 */

import { PRIOR_ART, resolveAuditCatalog, type Lineage, type PriorArtEntry, type RuleMeta } from "./catalog";
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

function lineageLink(l: Lineage): string {
  const tool = (PRIOR_ART as Record<string, PriorArtEntry>)[l.tool]?.name ?? l.tool;
  const label = l.rule ? `${tool} \`${l.rule}\`` : tool;
  return `[${mdxEscape(label)}](${l.url}) (${l.relation})`;
}

/**
 * A rule's backing, as a two-column table: the authority that says the finding
 * matters, and the prior art that checked it first. A table rather than two
 * "Label: ..." lines so that 379 rules do not read as 379 repeated sentences.
 */
function backingTable(m: RuleMeta): string {
  const rows: string[] = [];
  if (m.authority?.length) rows.push(`| Authority | ${m.authority.map((a) => `[${a.name}](${a.url})`).join(" · ")} |`);
  if (m.lineage?.length) rows.push(`| Prior art | ${m.lineage.map(lineageLink).join(" · ")} |`);
  return rows.length ? `\n\n| | |\n|---|---|\n${rows.join("\n")}` : "";
}

function ruleBlock(m: RuleMeta): string {
  const tags = `${m.tier} · ${m.fixKind}`;
  return `### ${m.id}\n\n**${mdxEscape(m.title)}** — ${tags}\n\n${mdxEscape(m.remediation)}${backingTable(m)}`;
}

/**
 * The closing section: every tool the rules credit, with its licence and how
 * many rules point at it. Rendered from the same registry the entries key into,
 * so a tool cannot be credited on a rule without appearing here.
 */
function priorArtSection(catalog: Record<string, RuleMeta>): string {
  const counts = new Map<string, number>();
  for (const m of Object.values(catalog)) {
    for (const l of m.lineage ?? []) counts.set(l.tool, (counts.get(l.tool) ?? 0) + 1);
  }
  const rows = (Object.entries(PRIOR_ART) as Array<[string, PriorArtEntry]>)
    .filter(([key]) => counts.has(key))
    .sort(([a], [b]) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    .map(([key, t]) => `| [${t.name}](${t.url}) | ${t.kind} | ${t.license} | ${counts.get(key)} |`);
  if (rows.length === 0) return "";
  return `## Prior art

chant's rules were written against the output chant emits, but much of what they check was checked first by a dedicated tool. Each rule above that has a counterpart names it under **Prior art**, with the upstream rule id and how the two relate.

- \`equivalent\` is the same condition at the same scope.
- \`overlaps\` shares the core condition, with one side narrower or broader, or expressed for a different dialect of the same control.
- \`extends\` means chant checks a strict superset of the upstream rule.

This is credit rather than authority, and it never changes a rule's tier or category. A credit counts once per upstream rule cited, so a chant rule that names two zizmor audits adds two.

| Tool | Kind | Licence | Credits |
|---|---|---|---|
${rows.join("\n")}
`;
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

Each rule is tagged with its **tier** — \`merge-worthy\` (a security or correctness issue worth a PR) or \`report-only\` (hygiene) — and its **fix kind** — \`deterministic\` (a safe mechanical fix the report can apply as a diff) or \`guidance\` (needs a judgement call). Where an open-source tool checks the same thing, the rule says so under **Prior art**; the [Prior art](#prior-art) section at the end lists every tool the rules on this page credit.

${[...sections, priorArtSection(catalog)].filter(Boolean).join("\n\n")}
`;
}

/**
 * `chant audit --agents` — audit the agent configuration on this machine.
 *
 * This is a different *subject* from the rest of `chant audit` (a machine, not
 * a repo) but deliberately the same *product*: the same tiering, the same
 * five output formats, the same rule-catalog links. A reader who already knows
 * how to read a chant audit report can read this one, and the HTML/SARIF/JSON
 * consumers downstream need no changes.
 *
 * The bridge is {@link toAuditFindings}: an `AgentFinding` is projected onto
 * the `AuditFinding` shape the renderers already take, with the site id in
 * `entity` so a reader can tell which configuration a finding came from.
 *
 * Two things this command adds that a repo audit has no need for:
 *
 *  - **An inventory.** "What is configured on this machine" is the primary
 *    question here; findings are secondary. A clean scan should still print
 *    the sites it found, because most users have never seen the full list.
 *  - **Coverage honesty.** The scan probes a fixed set of locations, so it can
 *    state what it looked for and didn't find, what it couldn't parse, and how
 *    many registered projects it did not visit. An inventory that quietly
 *    omits half the machine is worse than no inventory.
 */

import { writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { scanAgentConfigs, unscannedProjectCount } from "../../agents/discover";
import { checkAgentConfigs } from "../../agents/checks";
import type { AgentConfigSite, AgentFinding, AgentRuntime, AgentScanResult, AgentScope } from "../../agents/types";
import { AGENT_RUNTIMES, AGENT_SCOPES } from "../../agents/types";
import type { AuditFinding } from "../../audit/core";
import { RULE_CATALOG, type RuleMeta } from "../../audit/catalog";
import { renderMarkdown } from "../../audit/report";
import { renderHtml, type ReportTheme } from "../../audit/report-html";
import { buildReportJson, type AuditSnapshot } from "../../audit/report-model";
import type { AuditFailOn, AuditFormat, AuditTier } from "./audit";

export interface AuditAgentsOptions {
  format?: AuditFormat;
  tier?: AuditTier;
  failOn?: AuditFailOn;
  /** Scopes to scan. Defaults to all three. */
  scopes?: readonly AgentScope[];
  /** Harnesses to scan. Defaults to all five. */
  runtimes?: readonly AgentRuntime[];
  /** Project roots to scan at project scope. Defaults to `[cwd]`. */
  projectRoots?: string[];
  /** Home directory override — injectable so tests scan a fixture tree. */
  home?: string;
  platform?: NodeJS.Platform;
  /** Write the report here instead of returning it for stdout. */
  output?: string;
  theme?: ReportTheme;
  template?: string;
  now?: string;
  toolVersion?: string;
}

export interface AuditAgentsResult {
  success: boolean;
  output: string;
  findings: AgentFinding[];
  scan: AgentScanResult;
  exitCode: number;
  wroteTo?: string;
  error?: string;
}

/**
 * Project an agent finding onto the audit renderers' finding shape.
 *
 * `lexicon` is set to `"agents"` — the renderers only use it as a grouping
 * label, and calling this family what it is keeps a mixed report readable.
 */
export function toAuditFindings(findings: AgentFinding[]): AuditFinding[] {
  return findings.map((f) => ({
    checkId: f.checkId,
    severity: f.severity,
    message: f.message,
    file: f.file,
    lexicon: "agents",
    entity: f.entity ? `${f.siteId} › ${f.entity}` : f.siteId,
  }));
}

function isMergeWorthy(f: AuditFinding, catalog: Record<string, RuleMeta>): boolean {
  return catalog[f.checkId]?.tier === "merge-worthy";
}

function exitCodeFor(findings: AuditFinding[], failOn: AuditFailOn, catalog: Record<string, RuleMeta>): number {
  if (failOn === "merge-worthy") return findings.some((f) => isMergeWorthy(f, catalog)) ? 1 : 0;
  if (failOn === "warning") return findings.some((f) => f.severity === "error" || f.severity === "warning") ? 1 : 0;
  return 0;
}

/** One-line summary of what a site carries, e.g. `3 MCP servers · 11 skills`. */
export function siteSummary(site: AgentConfigSite): string {
  const parts: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (site.instructions.length > 0) parts.push(plural(site.instructions.length, "instruction file"));
  if (site.mcpServers.length > 0) parts.push(plural(site.mcpServers.length, "MCP server"));
  if (site.skills.length > 0) parts.push(plural(site.skills.length, "skill"));
  if (site.subagents.length > 0) parts.push(plural(site.subagents.length, "subagent"));
  if (site.commands.length > 0) parts.push(plural(site.commands.length, "command"));
  if (site.plugins.length > 0) parts.push(plural(site.plugins.length, "plugin"));
  const envCount = Object.keys(site.env).length;
  if (envCount > 0) parts.push(plural(envCount, "env var"));
  if (site.model) parts.push(`model ${site.model}`);
  return parts.length > 0 ? parts.join(" · ") : "no content";
}

/**
 * Coverage caveats. Stated even when empty-ish, because the value of an
 * inventory depends entirely on the reader knowing its edges.
 */
export function agentCoverageNotes(scan: AgentScanResult, opts: { home: string; projectRoots: string[]; scopes: readonly AgentScope[] }): string[] {
  const notes: string[] = [];

  if (opts.scopes.includes("project")) {
    const roots = opts.projectRoots.length;
    const unscanned = unscannedProjectCount(opts.home, opts.projectRoots);
    if (unscanned > 0) {
      notes.push(
        `Scanned ${roots} project root${roots === 1 ? "" : "s"}; ` +
          `${unscanned} more ${unscanned === 1 ? "is" : "are"} registered in ~/.claude.json and ${unscanned === 1 ? "was" : "were"} not visited. ` +
          // The path is positional (`chant audit <path>`), not a `--path` flag.
          `Scan one with \`chant audit --agents --scope project <dir>\`, or all of them with \`--all-projects\`.`,
      );
    } else if (roots > 1) {
      // Breadth is worth stating even when nothing was missed — a reader
      // seeing four findings should know whether that was across one project
      // or sixty-five.
      notes.push(`Scanned ${roots} project roots — every project registered in ~/.claude.json whose directory still exists.`);
    }
  }

  if (scan.unreadable.length > 0) {
    notes.push(
      `${scan.unreadable.length} file${scan.unreadable.length === 1 ? "" : "s"} existed but could not be parsed, so ` +
        `${scan.unreadable.length === 1 ? "its" : "their"} contents are not covered: ` +
        scan.unreadable.map((u) => `${u.path} (${u.reason})`).join("; "),
    );
  }

  const skippedScopes = AGENT_SCOPES.filter((s) => !opts.scopes.includes(s));
  if (skippedScopes.length > 0) notes.push(`Scope${skippedScopes.length === 1 ? "" : "s"} not scanned: ${skippedScopes.join(", ")}.`);

  return notes;
}

/** Render the inventory section — what was found, before any judgement about it. */
function renderInventory(scan: AgentScanResult): string[] {
  const lines: string[] = [];
  if (scan.sites.length === 0) {
    lines.push("No agent configuration found.");
    return lines;
  }
  lines.push(`Found ${scan.sites.length} agent config${scan.sites.length === 1 ? "" : "s"}:`);
  let lastScope: AgentScope | undefined;
  for (const site of scan.sites) {
    if (site.scope !== lastScope) {
      lines.push("", `  ${site.scope}:`);
      lastScope = site.scope;
    }
    lines.push(`    ${site.runtime.padEnd(9)} ${site.root}`);
    lines.push(`      ${siteSummary(site)}`);
    lines.push(`      from ${site.sources.length} file${site.sources.length === 1 ? "" : "s"}`);
  }
  return lines;
}

function renderStylish(scan: AgentScanResult, findings: AuditFinding[], notes: string[], catalog: Record<string, RuleMeta>): string {
  const lines: string[] = [...renderInventory(scan), ""];

  for (const note of notes) lines.push(`Note: ${note}`);
  if (notes.length > 0) lines.push("");

  const mw = findings.filter((f) => isMergeWorthy(f, catalog));
  const ro = findings.filter((f) => !isMergeWorthy(f, catalog));
  lines.push(`${findings.length} finding${findings.length === 1 ? "" : "s"} (${mw.length} merge-worthy, ${ro.length} report-only).`);

  const section = (title: string, list: AuditFinding[]) => {
    if (list.length === 0) return;
    lines.push("", title);
    for (const f of list) {
      lines.push(`  [${f.checkId}] ${f.severity}  ${f.entity}`);
      lines.push(`    ${f.message}`);
      lines.push(`    ${f.file}`);
    }
  };
  section("Merge-worthy:", mw);
  section("Report-only:", ro);
  return lines.join("\n");
}

/**
 * Provenance for the machine-readable and HTML reports. `target` is the home
 * directory rather than a repo URL, and `files` lists the config sources that
 * contributed — the machine-scope analogue of "which workflow files were read".
 */
function buildSnapshot(scan: AgentScanResult, home: string, opts: AuditAgentsOptions): AuditSnapshot {
  return {
    target: home,
    files: scan.sites.flatMap((s) => s.sources),
    generatedAt: opts.now ?? new Date().toISOString(),
    toolVersion: opts.toolVersion ?? "0.0.0",
  };
}

/** The JSON report: the full inventory plus findings, so a consumer can do its own analysis. */
function renderJson(
  scan: AgentScanResult,
  agentFindings: AgentFinding[],
  findings: AuditFinding[],
  notes: string[],
  catalog: Record<string, RuleMeta>,
  snapshot: AuditSnapshot,
): string {
  const base = buildReportJson(findings, { snapshot, toolVersion: snapshot.toolVersion, catalog });
  return JSON.stringify(
    {
      ...base,
      subject: "agent-configuration",
      notes,
      sites: scan.sites.map((site) => ({
        id: site.id,
        scope: site.scope,
        runtime: site.runtime,
        root: site.root,
        sources: site.sources,
        summary: siteSummary(site),
        instructions: site.instructions.map((i) => ({ path: i.path, bytes: i.bytes })),
        mcpServers: site.mcpServers,
        skills: site.skills.map((s) => ({ name: s.name, origin: s.origin, path: s.path, source: s.source, ref: s.ref })),
        subagents: site.subagents,
        commands: site.commands,
        plugins: site.plugins,
        env: Object.keys(site.env),
        permissions: site.permissions,
        model: site.model,
      })),
      agentFindings,
      coverage: { probed: scan.probed, unreadable: scan.unreadable },
    },
    null,
    2,
  );
}

function renderSarif(findings: AuditFinding[], catalog: Record<string, RuleMeta>): string {
  const ids = [...new Set(findings.map((f) => f.checkId))].sort();
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "chant audit --agents",
              informationUri: "https://intentius.io/chant/cli/audit/",
              rules: ids.map((id) => ({
                id,
                name: catalog[id]?.title ?? id,
                shortDescription: { text: catalog[id]?.title ?? id },
                fullDescription: { text: catalog[id]?.remediation ?? "" },
                helpUri: `https://intentius.io/chant/lint-rules/audit-rules/#${id.toLowerCase()}`,
              })),
            },
          },
          results: findings.map((f) => ({
            ruleId: f.checkId,
            level: f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "note",
            message: { text: f.message },
            locations: [{ physicalLocation: { artifactLocation: { uri: f.file } } }],
          })),
        },
      ],
    },
    null,
    2,
  );
}

/**
 * Scan the machine's agent configuration and render a report.
 *
 * Pure with respect to the filesystem apart from the scan itself and an
 * optional `--output` write, so it can be driven from tests against a fixture
 * home directory.
 */
export function auditAgentsCommand(opts: AuditAgentsOptions = {}): AuditAgentsResult {
  const home = opts.home ?? homedir();
  const scopes = opts.scopes ?? AGENT_SCOPES;
  const runtimes = opts.runtimes ?? AGENT_RUNTIMES;
  const projectRoots = (opts.projectRoots ?? [process.cwd()]).map((p) => resolve(p));
  const format = opts.format ?? "stylish";
  const tier = opts.tier ?? "all";
  const failOn = opts.failOn ?? "none";
  const catalog = RULE_CATALOG;

  const scan = scanAgentConfigs({ scopes, runtimes, projectRoots, home, platform: opts.platform });
  const all = checkAgentConfigs(scan);
  const agentFindings = tier === "merge-worthy" ? all.filter((f) => catalog[f.checkId]?.tier === "merge-worthy") : all;
  const findings = toAuditFindings(agentFindings);
  const notes = agentCoverageNotes(scan, { home, projectRoots, scopes });

  const snapshot = buildSnapshot(scan, home, opts);

  let output: string;
  switch (format) {
    case "json":
      output = renderJson(scan, agentFindings, findings, notes, catalog, snapshot);
      break;
    case "sarif":
      output = renderSarif(findings, catalog);
      break;
    case "markdown":
      output = [
        "# Agent configuration audit",
        "",
        "```",
        renderInventory(scan).join("\n"),
        "```",
        "",
        renderMarkdown(findings, { target: home, notes, catalog }),
      ].join("\n");
      break;
    case "html":
      output = renderHtml(findings, {
        notes,
        catalog,
        snapshot,
        theme: opts.theme,
        template: opts.template,
      });
      break;
    default:
      output = renderStylish(scan, findings, notes, catalog);
  }

  let wroteTo: string | undefined;
  if (opts.output) {
    try {
      writeFileSync(opts.output, output, "utf-8");
      wroteTo = opts.output;
    } catch (err) {
      return {
        success: false,
        output: "",
        findings: agentFindings,
        scan,
        exitCode: 1,
        error: `Failed to write ${opts.output}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    success: true,
    output,
    findings: agentFindings,
    scan,
    exitCode: exitCodeFor(findings, failOn, catalog),
    wroteTo,
  };
}

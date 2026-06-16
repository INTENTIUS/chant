/**
 * `chant audit` — run chant's CI security checks against an existing repo's
 * pipeline YAML and emit a tiered report. Does not require a chant project;
 * it reads `.github/workflows`, `.gitlab-ci.yml`, and `.forgejo/workflows`
 * directly and runs the real post-synth checks via the audit core.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { auditFiles, type AuditInput, type AuditFinding, type AuditLexicon } from "../../audit/core";
import { RULE_CATALOG } from "../../audit/catalog";
import { renderMarkdown } from "../../audit/report";
import { fetchCiFiles, resolveActionSha, FetchError } from "../../audit/fetch";
import { extractUnpinnedActions } from "../../audit/proof";
import type { ProveOptions } from "../../audit/proof";
import type { Severity } from "../../lint/rule";

export type AuditFormat = "stylish" | "json" | "sarif" | "markdown";
export type AuditTier = "merge-worthy" | "all";
export type AuditFailOn = "merge-worthy" | "warning" | "none";

export interface AuditCommandOptions {
  /** Repo root/dir to scan, or an https:// repo URL to fetch and audit. */
  path: string;
  format?: AuditFormat;
  /** Restrict findings to a tier (default "all"). */
  tier?: AuditTier;
  /** Exit-code policy (default "none" — read-only friendly). */
  failOn?: AuditFailOn;
  /** Server-side token for remote fetch (defaults to env). */
  token?: string;
  /** Injectable fetch for testing remote audits. */
  fetchImpl?: typeof fetch;
}

export interface AuditCommandResult {
  success: boolean;
  /** Rendered report in the requested format. */
  output: string;
  findings: AuditFinding[];
  /** Files that were scanned (relative to the root). */
  scanned: string[];
  exitCode: number;
  error?: string;
}

function isYaml(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

function collectDir(root: string, dir: string, lexicon: AuditLexicon, out: AuditInput[]): void {
  const abs = join(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
  for (const name of readdirSync(abs).sort()) {
    if (!isYaml(name)) continue;
    const full = join(abs, name);
    if (!statSync(full).isFile()) continue;
    out.push({ path: relative(root, full), content: readFileSync(full, "utf-8"), lexicon });
  }
}

/** Discover CI files under a repo root. */
export function discoverCiFiles(root: string): AuditInput[] {
  const inputs: AuditInput[] = [];
  collectDir(root, ".github/workflows", "github", inputs);
  collectDir(root, ".forgejo/workflows", "forgejo", inputs);
  const gitlab = join(root, ".gitlab-ci.yml");
  if (existsSync(gitlab) && statSync(gitlab).isFile()) {
    inputs.push({ path: ".gitlab-ci.yml", content: readFileSync(gitlab, "utf-8"), lexicon: "gitlab" });
  }
  return inputs;
}

function isMergeWorthy(f: AuditFinding): boolean {
  return RULE_CATALOG[f.checkId]?.tier === "merge-worthy";
}

function exitCodeFor(findings: AuditFinding[], failOn: AuditFailOn): number {
  if (failOn === "merge-worthy") return findings.some(isMergeWorthy) ? 1 : 0;
  if (failOn === "warning") {
    return findings.some((f) => f.severity === "error" || f.severity === "warning") ? 1 : 0;
  }
  return 0;
}

function sarifLevel(sev: Severity): string {
  return sev === "error" ? "error" : sev === "warning" ? "warning" : "note";
}

function renderStylish(findings: AuditFinding[], scanned: string[]): string {
  const lines: string[] = [];
  const mw = findings.filter(isMergeWorthy);
  const ro = findings.filter((f) => !isMergeWorthy(f));
  lines.push(
    `Audited ${scanned.length} CI file${scanned.length === 1 ? "" : "s"} — ` +
      `${findings.length} finding${findings.length === 1 ? "" : "s"} ` +
      `(${mw.length} merge-worthy, ${ro.length} report-only).`,
  );
  const section = (title: string, list: AuditFinding[]) => {
    if (list.length === 0) return;
    lines.push("", title);
    for (const f of list) {
      const where = f.entity ? `${f.file} (${f.entity})` : f.file;
      const title = RULE_CATALOG[f.checkId]?.title ?? f.checkId;
      lines.push(`  [${f.checkId}] ${f.severity}  ${where}  — ${title}`);
    }
  };
  section("Merge-worthy:", mw);
  section("Report-only:", ro);
  return lines.join("\n");
}

function renderSarif(findings: AuditFinding[]): string {
  const ruleIds = [...new Set(findings.map((f) => f.checkId))].sort();
  const rules = ruleIds.map((id) => {
    const m = RULE_CATALOG[id];
    return {
      id,
      name: m?.title ?? id,
      shortDescription: { text: m?.title ?? id },
      helpUri: m?.authority?.[0]?.url,
    };
  });
  const results = findings.map((f) => ({
    ruleId: f.checkId,
    level: sarifLevel(f.severity),
    message: { text: f.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: f.file } } }],
  }));
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "chant-audit", informationUri: "https://intentius.io/chant/", rules } }, results }],
    },
    null,
    2,
  );
}

/** Run the audit and produce a rendered result. */
export async function auditCommand(options: AuditCommandOptions): Promise<AuditCommandResult> {
  const format = options.format ?? "stylish";
  const tier = options.tier ?? "all";
  const failOn = options.failOn ?? "none";

  const isUrl = /^https?:\/\//.test(options.path);

  let inputs: AuditInput[];
  if (isUrl) {
    try {
      inputs = await fetchCiFiles(options.path, {
        token: options.token ?? process.env.CHANT_AUDIT_TOKEN ?? process.env.GITHUB_TOKEN,
        fetchImpl: options.fetchImpl,
      });
    } catch (err) {
      const msg = err instanceof FetchError ? err.message : err instanceof Error ? err.message : String(err);
      return { success: false, output: "", findings: [], scanned: [], exitCode: 1, error: msg };
    }
  } else {
    if (!existsSync(options.path)) {
      return { success: false, output: "", findings: [], scanned: [], exitCode: 1, error: `Path not found: ${options.path}` };
    }
    inputs = discoverCiFiles(options.path);
  }

  const scanned = inputs.map((i) => i.path);

  if (inputs.length === 0) {
    return { success: true, output: `No CI files found under ${options.path}.`, findings: [], scanned: [], exitCode: 0 };
  }

  let findings = await auditFiles(inputs);
  if (tier === "merge-worthy") findings = findings.filter(isMergeWorthy);

  let output: string;
  switch (format) {
    case "json":
      output = JSON.stringify({ scanned, findings }, null, 2);
      break;
    case "sarif":
      output = renderSarif(findings);
      break;
    case "markdown": {
      // For remote audits, resolve action SHAs so pin fixes render as inline
      // diffs. Pre-resolved into a sync map; render stays synchronous.
      let resolveSha: ProveOptions["resolveSha"];
      if (isUrl) {
        const token = options.token ?? process.env.CHANT_AUDIT_TOKEN ?? process.env.GITHUB_TOKEN;
        const refs = new Map<string, { action: string; ref: string }>();
        for (const inp of inputs) {
          for (const a of extractUnpinnedActions(inp.content)) refs.set(`${a.action}@${a.ref}`, a);
        }
        const resolved = await Promise.all(
          [...refs.values()].map(async (a) => {
            const key = `${a.action}@${a.ref}`;
            const sha = await resolveActionSha(a.action, a.ref, { token, fetchImpl: options.fetchImpl });
            return [key, sha] as [string, string | undefined];
          }),
        );
        const shaMap = new Map<string, string>();
        for (const [key, sha] of resolved) if (sha) shaMap.set(key, sha);
        if (shaMap.size > 0) resolveSha = (action, ref) => shaMap.get(`${action}@${ref}`);
      }
      output = renderMarkdown(findings, {
        target: options.path,
        files: inputs.map((i) => ({ path: i.path, content: i.content })),
        resolveSha,
      });
      break;
    }
    default:
      output = renderStylish(findings, scanned);
  }

  return { success: true, output, findings, scanned, exitCode: exitCodeFor(findings, failOn) };
}

/** Print an audit result to stdout. */
export function printAuditResult(result: AuditCommandResult): void {
  if (!result.success) {
    console.error(result.error ?? "Audit failed");
    return;
  }
  console.log(result.output);
}

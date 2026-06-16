/**
 * `chant audit` — run chant's CI security checks against an existing repo's
 * pipeline YAML and emit a tiered report. Does not require a chant project;
 * it reads `.github/workflows`, `.gitlab-ci.yml`, and `.forgejo/workflows`
 * directly and runs the real post-synth checks via the audit core.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { auditFiles, type AuditInput, type AuditFinding, type AuditLexicon, type ChecksProvider } from "../../audit/core";
import { RULE_CATALOG } from "../../audit/catalog";
import { renderMarkdown } from "../../audit/report";
import { fetchCiFiles, resolveActionSha, resolveImageDigest, FetchError } from "../../audit/fetch";
import { extractUnpinnedActions, extractUnpinnedImages } from "../../audit/proof";
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
  /** Write the rendered report to this file instead of returning it for stdout. */
  output?: string;
  /** Injectable post-synth checks provider (testing). */
  checksProvider?: ChecksProvider;
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
  /** Set when the report was written to a file (via `output`). */
  wroteTo?: string;
}

/**
 * Select the fetch token for a repo host. Tokens are host-specific — a GitHub
 * PAT sent to GitLab/Codeberg is rejected (401) — so we never cross hosts.
 */
export function tokenForHost(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  switch (host) {
    case "gitlab.com":
      return env.GITLAB_TOKEN ?? env.CHANT_AUDIT_GITLAB_TOKEN;
    case "codeberg.org":
      return env.CODEBERG_TOKEN ?? env.CHANT_AUDIT_CODEBERG_TOKEN;
    case "github.com":
      return env.GITHUB_TOKEN ?? env.CHANT_AUDIT_GITHUB_TOKEN;
    default:
      return undefined;
  }
}

/** GitHub token used for action-SHA resolution (always queries api.github.com). */
function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GITHUB_TOKEN ?? env.CHANT_AUDIT_GITHUB_TOKEN;
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

/** Coverage caveats about what the audit could and couldn't see. */
export function coverageNotes(inputs: AuditInput[]): string[] {
  const notes: string[] = [];
  const withIncludes = inputs.filter((i) => i.lexicon === "gitlab" && /^include:/m.test(i.content)).length;
  if (withIncludes > 0) {
    notes.push(
      `${withIncludes} GitLab pipeline${withIncludes === 1 ? " uses" : "s use"} \`include:\` — included files are not fetched, so findings cover the root file only.`,
    );
  }
  return notes;
}

function renderStylish(findings: AuditFinding[], scanned: string[], notes: string[]): string {
  const lines: string[] = [];
  for (const note of notes) lines.push(`Note: ${note}`);
  if (notes.length > 0) lines.push("");
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
        token: options.token ?? tokenForHost(options.path),
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

  let findings: AuditFinding[];
  try {
    findings = await auditFiles(inputs, { checksProvider: options.checksProvider });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: "", findings: [], scanned, exitCode: 1, error: msg };
  }
  if (tier === "merge-worthy") findings = findings.filter(isMergeWorthy);
  const notes = coverageNotes(inputs);

  let output: string;
  switch (format) {
    case "json":
      output = JSON.stringify({ scanned, findings }, null, 2);
      break;
    case "sarif":
      output = renderSarif(findings);
      break;
    case "markdown": {
      // For remote audits, resolve action SHAs and image digests so pin fixes
      // render as inline diffs. Pre-resolved into sync maps; render stays sync.
      let resolveSha: ProveOptions["resolveSha"];
      let resolveDigest: ProveOptions["resolveDigest"];
      if (isUrl) {
        // Action SHAs always resolve against api.github.com, so use the GitHub
        // token regardless of which host the repo lives on.
        const token = githubToken();
        const refs = new Map<string, { action: string; ref: string }>();
        const images = new Set<string>();
        for (const inp of inputs) {
          for (const a of extractUnpinnedActions(inp.content)) refs.set(`${a.action}@${a.ref}`, a);
          for (const img of extractUnpinnedImages(inp.content)) images.add(img);
        }
        const [resolvedShas, resolvedDigests] = await Promise.all([
          Promise.all(
            [...refs.values()].map(async (a) => {
              const sha = await resolveActionSha(a.action, a.ref, { token, fetchImpl: options.fetchImpl });
              return [`${a.action}@${a.ref}`, sha] as [string, string | undefined];
            }),
          ),
          Promise.all(
            [...images].map(async (img) => {
              const digest = await resolveImageDigest(img, { fetchImpl: options.fetchImpl });
              return [img, digest] as [string, string | undefined];
            }),
          ),
        ]);
        const shaMap = new Map<string, string>();
        for (const [key, sha] of resolvedShas) if (sha) shaMap.set(key, sha);
        if (shaMap.size > 0) resolveSha = (action, ref) => shaMap.get(`${action}@${ref}`);
        const digestMap = new Map<string, string>();
        for (const [img, digest] of resolvedDigests) if (digest) digestMap.set(img, digest);
        if (digestMap.size > 0) resolveDigest = (img) => digestMap.get(img);
      }
      output = renderMarkdown(findings, {
        target: options.path,
        files: inputs.map((i) => ({ path: i.path, content: i.content })),
        resolveSha,
        resolveDigest,
        notes,
      });
      break;
    }
    default:
      output = renderStylish(findings, scanned, notes);
  }

  const exitCode = exitCodeFor(findings, failOn);
  if (options.output) {
    try {
      writeFileSync(options.output, output);
    } catch (err) {
      return { success: false, output, findings, scanned, exitCode: 1, error: `Failed to write ${options.output}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { success: true, output, findings, scanned, exitCode, wroteTo: options.output };
  }

  return { success: true, output, findings, scanned, exitCode };
}

/** Print an audit result to stdout. */
export function printAuditResult(result: AuditCommandResult): void {
  if (!result.success) {
    console.error(result.error ?? "Audit failed");
    return;
  }
  if (result.wroteTo) {
    console.error(`Wrote report to ${result.wroteTo}`);
    return;
  }
  console.log(result.output);
}

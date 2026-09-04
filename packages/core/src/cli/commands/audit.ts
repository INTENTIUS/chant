/**
 * `chant audit` — run chant's security, correctness, and best-practice checks against an existing repo's
 * pipeline YAML and emit a tiered report. Does not require a chant project;
 * it reads `.github/workflows`, `.gitlab-ci.yml`, and `.forgejo/workflows`
 * directly and runs the real post-synth checks via the audit core.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { auditFiles, type AuditInput, type AuditFinding, type ChecksProvider } from "../../audit/core";
import { AUDIT_LEXICONS, classifyFiles, collectCandidates, loadAuditPlugins, unclaimedFiles, type DetectPlugin, type RepoFile, type UnclaimedFile } from "../../audit/discover";
import { RULE_CATALOG, resolveAuditCatalog, type RuleMeta } from "../../audit/catalog";
import { scanForSecrets, parseSecretsConfig, type SecretsScanOptions } from "../../audit/secrets";
import { auditWranglerConfigs } from "../../audit/wrangler";
import { auditNginxConfigs } from "../../audit/nginx";
import { renderMarkdown } from "../../audit/report";
import { renderHtml, type ReportTheme } from "../../audit/report-html";
import { buildReportJson, REPORT_SCHEMA_VERSION, type AuditSnapshot } from "../../audit/report-model";
import { fetchRepoFiles, resolveActionSha, resolveImageDigest, resolveRepoCommit, parseRepoUrl, FetchError } from "../../audit/fetch";
import { extractUnpinnedActions, extractUnpinnedImages } from "../../audit/proof";
import type { ProveOptions } from "../../audit/proof";
import type { Severity } from "../../lint/rule";

export type AuditFormat = "stylish" | "json" | "sarif" | "markdown" | "html";
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
  /** HTML report: theme knobs (title, logo, accent, footer). */
  theme?: ReportTheme;
  /** HTML report: full template override. */
  template?: string;
  /** Snapshot timestamp (ISO); defaults to now. Injectable for deterministic output. */
  now?: string;
  /** Tool version recorded in the HTML snapshot. */
  toolVersion?: string;
  /** Injectable detection plugins (testing); defaults to every installed audit lexicon. */
  plugins?: DetectPlugin[];
  /**
   * Secrets-detection options (#443) — entropy threshold/min-length and an
   * allowlist. Merged over a `.chant-audit.json` at the local target root, if
   * present (URL targets have no local config file to read).
   */
  secretsScan?: SecretsScanOptions;
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
  /**
   * `"no-lexicons"` when not a single audit lexicon resolved, so nothing was
   * inspected (#1623). `output` then carries the diagnostic, not a report.
   */
  status?: "ok" | "no-lexicons";
  /** Candidate files that looked like they wanted a lexicon that is not installed. */
  unclaimed?: UnclaimedFile[];
  /** Where `output` belongs; diagnostics go to stderr, reports to stdout (default). */
  stream?: "stdout" | "stderr";
}

/** Exit code when the audit had no lexicons to look with. Distinct from 1 (findings / failure). */
export const NO_LEXICONS_EXIT_CODE = 2;

/** The npm package that provides an audit lexicon's detection and checks. */
function lexiconPackage(name: string): string {
  return `@intentius/chant-lexicon-${name}`;
}

/** Missing audit lexicons the unclaimed files pointed at, in first-seen order. `terraform` is not installable. */
function wantedLexicons(unclaimed: UnclaimedFile[]): string[] {
  return [...new Set(unclaimed.map((u) => u.lexicon))].filter((l) => l !== "terraform");
}

/**
 * The exact one-liner that gives a bare `npx @intentius/chant audit` the
 * lexicons it needs. Every wanted lexicon is a `-p` package so npx puts all of
 * them on the same resolution path.
 */
export function installLine(lexicons: string[], target: string): string {
  const pkgs = ["@intentius/chant", ...lexicons.map(lexiconPackage)];
  return `npx ${pkgs.map((p) => `-p ${p}`).join(" ")} chant audit ${target}`;
}

/** One-line coverage hint for the partial case: some lexicons loaded, others wanted by files on disk. */
function missingLexiconHint(unclaimed: UnclaimedFile[]): string | undefined {
  const wanted = wantedLexicons(unclaimed);
  const tf = unclaimed.filter((u) => u.lexicon === "terraform").length;
  const parts: string[] = [];
  if (wanted.length > 0) {
    const n = unclaimed.length - tf;
    parts.push(
      `${n} file${n === 1 ? " looks" : "s look"} like ${wanted.join("/")} but ${wanted.length === 1 ? "that lexicon is" : "those lexicons are"} not installed, so ${n === 1 ? "it was" : "they were"} skipped` +
        ` (npm i ${wanted.map(lexiconPackage).join(" ")}).`,
    );
  }
  if (tf > 0) parts.push(`${tf} Terraform file${tf === 1 ? "" : "s"} skipped; the audit does not read HCL (see chant carve).`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Human-readable diagnostic for the zero-lexicon case. */
function renderNoLexicons(target: string, unclaimed: UnclaimedFile[]): string {
  const lines: string[] = [];
  lines.push(`chant audit had nothing to look with: no audit lexicon is installed, so nothing under ${target} was inspected.`);
  lines.push("This is not a clean result. Detection and checks live in the lexicon packages.");
  const wanted = wantedLexicons(unclaimed);
  if (unclaimed.length > 0) {
    lines.push("", "Files that wanted a lexicon:");
    for (const u of unclaimed) {
      const note = u.lexicon === "terraform" ? "terraform (not audited; see chant carve)" : u.lexicon;
      lines.push(`  ${u.path}  ->  ${note}`);
    }
  } else {
    lines.push("", "No file under the target looked like CI, Kubernetes, Helm, Docker, CloudFormation, ARM, Config Connector, or fountain either.");
  }
  lines.push("", "Run it with the lexicons those files need:");
  lines.push(`  ${installLine(wanted.length > 0 ? wanted : [...AUDIT_LEXICONS], target)}`);
  return lines.join("\n");
}

/** Machine-readable form of the zero-lexicon diagnostic (`status: "no-lexicons"`). */
function renderNoLexiconsJson(target: string, unclaimed: UnclaimedFile[]): string {
  const wanted = wantedLexicons(unclaimed);
  return JSON.stringify(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: { name: "chant-audit" },
      status: "no-lexicons",
      target,
      summary: { total: 0 },
      findings: [],
      unclaimed,
      missingLexicons: wanted,
      install: installLine(wanted.length > 0 ? wanted : [...AUDIT_LEXICONS], target),
    },
    null,
    2,
  );
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

function isMergeWorthy(f: AuditFinding, catalog: Record<string, RuleMeta> = RULE_CATALOG): boolean {
  return catalog[f.checkId]?.tier === "merge-worthy";
}

function exitCodeFor(findings: AuditFinding[], failOn: AuditFailOn, catalog: Record<string, RuleMeta> = RULE_CATALOG): number {
  if (failOn === "merge-worthy") return findings.some((f) => isMergeWorthy(f, catalog)) ? 1 : 0;
  if (failOn === "warning") {
    return findings.some((f) => f.severity === "error" || f.severity === "warning") ? 1 : 0;
  }
  return 0;
}

function sarifLevel(sev: Severity): string {
  return sev === "error" ? "error" : sev === "warning" ? "warning" : "note";
}

/** `.chant-audit.json`'s `secrets` section at the local target root, if present (tolerant of a missing/malformed file). */
function readLocalSecretsConfig(root: string): SecretsScanOptions {
  const file = join(root, ".chant-audit.json");
  if (!existsSync(file)) return {};
  try {
    return parseSecretsConfig(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

/** Merge the local `.chant-audit.json` config under any explicitly-passed options (options win). */
function resolveSecretsOptions(fileConfig: SecretsScanOptions, explicit?: SecretsScanOptions): SecretsScanOptions {
  return {
    entropyThreshold: explicit?.entropyThreshold ?? fileConfig.entropyThreshold,
    entropyMinLength: explicit?.entropyMinLength ?? fileConfig.entropyMinLength,
    allow: [...(fileConfig.allow ?? []), ...(explicit?.allow ?? [])],
  };
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

function renderStylish(findings: AuditFinding[], scanned: string[], notes: string[], catalog: Record<string, RuleMeta> = RULE_CATALOG): string {
  const lines: string[] = [];
  for (const note of notes) lines.push(`Note: ${note}`);
  if (notes.length > 0) lines.push("");
  const mw = findings.filter((f) => isMergeWorthy(f, catalog));
  const ro = findings.filter((f) => !isMergeWorthy(f, catalog));
  lines.push(
    `Audited ${scanned.length} file${scanned.length === 1 ? "" : "s"} — ` +
      `${findings.length} finding${findings.length === 1 ? "" : "s"} ` +
      `(${mw.length} merge-worthy, ${ro.length} report-only).`,
  );
  const section = (title: string, list: AuditFinding[]) => {
    if (list.length === 0) return;
    lines.push("", title);
    for (const f of list) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const where = f.entity ? `${loc} (${f.entity})` : loc;
      const title = catalog[f.checkId]?.title ?? f.checkId;
      lines.push(`  [${f.checkId}] ${f.severity}  ${where}  — ${title}`);
    }
  };
  section("Merge-worthy:", mw);
  section("Report-only:", ro);
  return lines.join("\n");
}

/**
 * SARIF (2.1.0) export (#442). Rule-level metadata — category (the finding
 * "dimension": security/correctness/best-practice) and remediation — is
 * carried in the property bag / `help` block since SARIF's core schema has no
 * dedicated slot for either; `tier` is per-result (a `RuleMeta` fact looked up
 * per finding) so consumers can triage merge-worthy vs. report-only without a
 * second catalog lookup.
 */
function renderSarif(findings: AuditFinding[], catalog: Record<string, RuleMeta> = RULE_CATALOG): string {
  const ruleIds = [...new Set(findings.map((f) => f.checkId))].sort();
  const rules = ruleIds.map((id) => {
    const m = catalog[id];
    return {
      id,
      name: m?.title ?? id,
      shortDescription: { text: m?.title ?? id },
      ...(m?.remediation ? { help: { text: m.remediation } } : {}),
      helpUri: m?.authority?.[0]?.url,
      // `priorArt` credits the upstream tools whose rules check the same thing
      // (audit/prior-art.ts) — tool key, upstream rule id, doc URL, relation.
      ...(m?.category || m?.lineage?.length
        ? {
            properties: {
              ...(m?.category ? { category: m.category, dimension: m.category } : {}),
              ...(m?.lineage?.length ? { priorArt: m.lineage } : {}),
            },
          }
        : {}),
    };
  });
  const results = findings.map((f) => {
    const tier = catalog[f.checkId]?.tier;
    return {
      ruleId: f.checkId,
      level: sarifLevel(f.severity),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            ...(f.line ? { region: { startLine: f.line } } : {}),
          },
        },
      ],
      ...(tier ? { properties: { tier } } : {}),
    };
  });
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

/** Build a provenance snapshot of what was audited (for the HTML report). */
async function buildSnapshot(options: AuditCommandOptions, files: string[], isUrl: boolean): Promise<AuditSnapshot> {
  let host: string | undefined;
  let repo: string | undefined;
  let commit: string | undefined;
  if (isUrl) {
    try {
      host = new URL(options.path).hostname;
      const parsed = parseRepoUrl(options.path);
      repo = `${parsed.owner}/${parsed.repo}`;
    } catch {
      // leave host/repo undefined
    }
    commit = await resolveRepoCommit(options.path, { token: options.token ?? tokenForHost(options.path), fetchImpl: options.fetchImpl });
  } else {
    host = "local";
  }
  return {
    target: options.path,
    host,
    repo,
    commit,
    files,
    generatedAt: options.now ?? new Date().toISOString(),
    toolVersion: options.toolVersion ?? "0.0.0",
  };
}

/** Run the audit and produce a rendered result. */
export async function auditCommand(options: AuditCommandOptions): Promise<AuditCommandResult> {
  const format = options.format ?? "stylish";
  const tier = options.tier ?? "all";
  const failOn = options.failOn ?? "none";

  const isUrl = /^https?:\/\//.test(options.path);

  // Detection lives in the lexicon plugins (each one's `detectTemplate`), so a
  // lexicon that isn't installed can't claim its files. Every branch below
  // therefore also computes which candidate files looked like they wanted an
  // absent lexicon, so "nothing found" and "had nothing to look with" never
  // render the same way (#1623).
  const plugins = options.plugins ?? (await loadAuditPlugins());
  let candidates: RepoFile[];
  if (isUrl) {
    try {
      // Fetch the whole repo's candidate files (all lexicons, not just CI) and
      // run them through the same classifier the local path uses (#420).
      candidates = await fetchRepoFiles(options.path, {
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
    // One walk, plugin-delegated detection. CI (path), Dockerfiles (name), and
    // Helm charts (bundle) are special-cased by the classifier since content
    // shape alone can't disambiguate them.
    candidates = collectCandidates(options.path);
  }
  const inputs = classifyFiles(candidates, plugins);
  const unclaimed = unclaimedFiles(candidates, inputs, plugins);
  const scanned = inputs.map((i) => i.path);

  // Secrets detection (#443) is independent of lexicon: it scans every
  // candidate file's raw text, not just the ones a lexicon claimed, and runs
  // even when no lexicon is installed at all. `.chant-audit.json` at a local
  // target's root supplies the entropy threshold / allowlist; a URL target
  // has no local config file to read.
  const secretsConfig = isUrl ? {} : readLocalSecretsConfig(options.path);
  const secretsFindings = scanForSecrets(candidates, resolveSecretsOptions(secretsConfig, options.secretsScan));
  // Wrangler config audit (#446) is likewise lexicon-independent: it scans
  // every candidate file for `wrangler.toml` by its own detector, not through
  // `classifyFiles`/an installed lexicon package (no such package exists —
  // this format ships only a detector and checks, per the issue's scope).
  const wranglerFindings = auditWranglerConfigs(candidates);
  // nginx config audit (#1979) — same lexicon-independent shape as wrangler:
  // its own path detector plus a parsed-content marker check (a `.conf` in a
  // shared directory name like conf.d/ only counts once it parses as nginx).
  const nginxFindings = auditNginxConfigs(candidates);

  if (plugins.length === 0) {
    const output = format === "json" ? renderNoLexiconsJson(options.path, unclaimed) : renderNoLexicons(options.path, unclaimed);
    return { success: true, status: "no-lexicons", output, findings: [...secretsFindings, ...wranglerFindings, ...nginxFindings], scanned: [], unclaimed, exitCode: NO_LEXICONS_EXIT_CODE, stream: format === "json" ? "stdout" : "stderr" };
  }

  const missingLexiconNote = missingLexiconHint(unclaimed);

  if (inputs.length === 0 && secretsFindings.length === 0 && wranglerFindings.length === 0 && nginxFindings.length === 0) {
    const output = `No auditable files found under ${options.path}.${missingLexiconNote ? ` ${missingLexiconNote}` : ""}`;
    return { success: true, status: "ok", output, findings: [], scanned: [], unclaimed, exitCode: 0 };
  }

  let findings: AuditFinding[] = [];
  if (inputs.length > 0) {
    try {
      findings = await auditFiles(inputs, { checksProvider: options.checksProvider });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", findings: [], scanned, exitCode: 1, error: msg };
    }
  }
  findings = [...findings, ...secretsFindings, ...wranglerFindings, ...nginxFindings];
  // Resolve the audit catalog once, aggregating the audited lexicons' own
  // metadata over core's static catalog (#687). The lexicons are already loaded
  // by `auditFiles` above, so this is cheap. Core's static catalog (always
  // included) carries the SEC* secrets rules, so they resolve even when
  // `inputs` claimed nothing.
  const catalog = await resolveAuditCatalog([...new Set(inputs.map((i) => i.lexicon))]);

  if (tier === "merge-worthy") findings = findings.filter((f) => isMergeWorthy(f, catalog));
  const notes = coverageNotes(inputs);
  if (missingLexiconNote) notes.push(missingLexiconNote);

  // Diff-bearing renderers (markdown, html) need action SHAs / image digests
  // resolved up front (sync maps so rendering stays synchronous).
  let resolveSha: ProveOptions["resolveSha"];
  let resolveDigest: ProveOptions["resolveDigest"];
  if (isUrl && (format === "markdown" || format === "html")) {
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

  const files = inputs.map((i) => ({ path: i.path, content: i.content }));
  let output: string;
  switch (format) {
    case "json": {
      const snapshot = await buildSnapshot(options, scanned, isUrl);
      output = JSON.stringify(buildReportJson(findings, { snapshot, toolVersion: options.toolVersion, catalog, unclaimed }), null, 2);
      break;
    }
    case "sarif":
      output = renderSarif(findings, catalog);
      break;
    case "markdown":
      output = renderMarkdown(findings, { target: options.path, files, resolveSha, resolveDigest, notes, catalog });
      break;
    case "html": {
      const snapshot = await buildSnapshot(options, scanned, isUrl);
      output = renderHtml(findings, { files, resolveSha, resolveDigest, notes, snapshot, theme: options.theme, template: options.template, catalog });
      break;
    }
    default:
      output = renderStylish(findings, scanned, notes, catalog);
  }

  const exitCode = exitCodeFor(findings, failOn, catalog);
  if (options.output) {
    try {
      writeFileSync(options.output, output);
    } catch (err) {
      return { success: false, output, findings, scanned, exitCode: 1, error: `Failed to write ${options.output}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { success: true, status: "ok", output, findings, scanned, unclaimed, exitCode, wroteTo: options.output };
  }

  return { success: true, status: "ok", output, findings, scanned, unclaimed, exitCode };
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
  if (result.stream === "stderr") console.error(result.output);
  else console.log(result.output);
}

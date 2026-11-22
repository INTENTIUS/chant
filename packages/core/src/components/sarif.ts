/**
 * SARIF 2.1.0, as much of it as chant reads (#5451): a scanner's findings
 * for the check report's summary, and an image scanner's vulnerabilities for
 * the release scan gate. Nothing here runs a tool.
 *
 * A check hook writes its findings under `$CHANT_FINDINGS`, a directory the
 * check runner creates and reads after the hooks ran (`./check-hooks.ts`).
 * `*.sarif` and `*.sarif.json` files are read here; `*.status.json` files
 * ({@link ScannerStatus}) carry the result of a tool that emits no SARIF.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import { normalizeSeverity, type Severity, type VulnFinding } from "./verbs/vuln-scan";

/** The first chant whose check job reads `$CHANT_FINDINGS` into the check report, and that has the Sonar, Mend and Wiz presets and the Wiz image scanner for the release scan (#5451). */
export const CHECK_FINDINGS_FLOOR = NEXT_RELEASE;

/** The environment variable naming the directory a check hook writes its findings to. */
export const CHECK_FINDINGS_ENV = "CHANT_FINDINGS";

/** Where a check job's findings go, under the report directory. */
export const CHECK_FINDINGS_DIR = "findings";

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }>;
  properties?: Record<string, unknown>;
}

interface SarifRule {
  id?: string;
  name?: string;
  shortDescription?: { text?: string };
  properties?: Record<string, unknown>;
}

interface SarifRun {
  tool?: { driver?: { name?: string; version?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}

/** The runs of a SARIF document, or null when `text` is not one. */
function sarifRuns(text: string): SarifRun[] | null {
  let doc: { version?: unknown; runs?: unknown };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.runs)) return null;
  return doc.runs as SarifRun[];
}

/** SARIF's levels as the check report counts them. */
export type SarifLevel = "error" | "warning" | "note" | "none";

/** One finding, reduced to what the check report lists. */
export interface FindingRow {
  rule: string;
  level: SarifLevel;
  message: string;
  location?: string;
}

/** What one findings file says. */
export interface FindingsSummary {
  /** The tool that wrote it, as it names itself. */
  tool: string;
  /** The file under the findings directory. */
  file: string;
  /** Findings by level. */
  counts: Record<SarifLevel, number>;
  total: number;
  /** The first few findings, errors first. */
  top: FindingRow[];
  /** A link to the tool's own report, when the file carries one. */
  url?: string;
  /** For a `*.status.json` file: what the tool said of itself. */
  status?: "passed" | "failed";
  note?: string;
}

/**
 * What a tool that emits no SARIF writes beside its run, as
 * `<name>.status.json`: whether it passed, and where its own report is.
 */
export interface ScannerStatus {
  tool: string;
  status: "passed" | "failed";
  url?: string;
  note?: string;
}

const LEVELS: SarifLevel[] = ["error", "warning", "note", "none"];
const levelOf = (raw: unknown): SarifLevel => (typeof raw === "string" && (LEVELS as string[]).includes(raw) ? (raw as SarifLevel) : "warning");

/** The most findings a summary lists by name. */
export const FINDINGS_LISTED = 5;

/** Summarize SARIF `text` written to `file`. Null when it is not SARIF. */
export function summarizeSarif(text: string, file: string): FindingsSummary | null {
  const runs = sarifRuns(text);
  if (!runs) return null;
  const counts: Record<SarifLevel, number> = { error: 0, warning: 0, note: 0, none: 0 };
  const rows: FindingRow[] = [];
  let tool = "";
  for (const run of runs) {
    tool ||= run.tool?.driver?.name ?? "";
    for (const r of run.results ?? []) {
      const level = levelOf(r.level);
      counts[level] += 1;
      const loc = r.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      rows.push({
        rule: r.ruleId ?? "unknown",
        level,
        message: (r.message?.text ?? "").split("\n")[0]!.trim(),
        ...(uri ? { location: loc?.region?.startLine ? `${uri}:${loc.region.startLine}` : uri } : {}),
      });
    }
  }
  const order = (l: SarifLevel) => LEVELS.indexOf(l);
  const top = rows.sort((a, b) => order(a.level) - order(b.level) || a.rule.localeCompare(b.rule) || (a.location ?? "").localeCompare(b.location ?? "")).slice(0, FINDINGS_LISTED);
  return { tool: tool || file.replace(/\.sarif(\.json)?$/, ""), file, counts, total: rows.length, top };
}

/** Summarize a `*.status.json` file, or null when it is not one. */
export function summarizeStatus(text: string, file: string): FindingsSummary | null {
  let doc: Partial<ScannerStatus>;
  try {
    doc = JSON.parse(text) as Partial<ScannerStatus>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || (doc.status !== "passed" && doc.status !== "failed")) return null;
  return {
    tool: typeof doc.tool === "string" && doc.tool !== "" ? doc.tool : file.replace(/\.status\.json$/, ""),
    file,
    counts: { error: 0, warning: 0, note: 0, none: 0 },
    total: 0,
    top: [],
    status: doc.status,
    ...(typeof doc.url === "string" && doc.url !== "" ? { url: doc.url } : {}),
    ...(typeof doc.note === "string" && doc.note !== "" ? { note: doc.note } : {}),
  };
}

/**
 * The findings files in `dir`, summarized, in name order. A file that is
 * neither SARIF nor a status file is reported as unreadable rather than
 * skipped, so a tool that wrote something else is not read as clean. With
 * `since` (a time in ms), a file written before it is a previous run's and
 * is left out.
 */
export function readFindings(dir: string, since?: number): { summaries: FindingsSummary[]; unreadable: string[] } {
  if (!existsSync(dir)) return { summaries: [], unreadable: [] };
  const summaries: FindingsSummary[] = [];
  const unreadable: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    const sarif = /\.sarif(\.json)?$/.test(file);
    const status = file.endsWith(".status.json");
    if (!sarif && !status) continue;
    if (since !== undefined && statSync(join(dir, file)).mtimeMs < since) continue;
    const text = readFileSync(join(dir, file), "utf-8");
    const s = sarif ? summarizeSarif(text, file) : summarizeStatus(text, file);
    if (s) summaries.push(s);
    else unreadable.push(file);
  }
  return { summaries, unreadable };
}

/** The markdown lines of a findings section for the check report. */
export function findingsSummaryLines(summaries: readonly FindingsSummary[], unreadable: readonly string[] = []): string[] {
  if (summaries.length === 0 && unreadable.length === 0) return [];
  const out: string[] = ["#### Findings", ""];
  for (const s of summaries) {
    const link = s.url ? ` ([report](${s.url}))` : "";
    if (s.status) {
      out.push(`- \`${s.tool}\`: ${s.status}${s.note ? `, ${s.note}` : ""}${link}`);
      continue;
    }
    const by = LEVELS.filter((l) => s.counts[l] > 0).map((l) => `${s.counts[l]} ${l}`);
    out.push(`- \`${s.tool}\`: ${s.total === 0 ? "no findings" : `${s.total} finding${s.total === 1 ? "" : "s"} (${by.join(", ")})`}${link}`);
    for (const r of s.top) out.push(`  - ${r.level}: \`${r.rule}\`${r.location ? ` at \`${r.location}\`` : ""}${r.message ? `, ${r.message}` : ""}`);
    if (s.total > s.top.length) out.push(`  - and ${s.total - s.top.length} more in \`${s.file}\``);
  }
  for (const f of unreadable) out.push(`- \`${f}\` is not SARIF and not a status file, so it was not read`);
  out.push("");
  return out;
}

/** CVSS-style `security-severity` (a number as text) to a severity, as GitHub code scanning reads it. */
function severityFromScore(raw: unknown): Severity | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  if (n > 0) return "low";
  return "negligible";
}

/** The package and version a vulnerability result names, from its properties, else its message. */
function packageOf(r: SarifResult): { name: string; version: string } {
  const p = r.properties ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const name = str("packageName") ?? str("package") ?? str("libraryName");
  const version = str("packageVersion") ?? str("installedVersion") ?? str("version");
  if (name) return { name, version: version ?? "" };
  const m = /(?:package|library)\s+["'`]?([^\s"'`,]+)["'`]?(?:\s+(?:version\s+)?["'`]?([^\s"'`,]+))?/i.exec(r.message?.text ?? "");
  return { name: m?.[1] ?? "unknown", version: version ?? m?.[2] ?? "" };
}

/**
 * The vulnerabilities a SARIF document lists, as the release scan gate reads
 * them (#5451): `ruleId` is the advisory, the severity is the rule's or the
 * result's `security-severity` or `severity` property, else the SARIF level
 * (error as high, warning as medium, note as low), and the package, its
 * version and `fixedVersion` come from the result's properties, else the
 * message. A result with no severity of its own is never read as lower than
 * its level says. Throws when `text` is not SARIF, so a scanner that wrote
 * something else is a refusal rather than an empty scan.
 */
export function sarifVulnFindings(text: string): VulnFinding[] {
  const runs = sarifRuns(text);
  if (!runs) throw new Error("not a SARIF document");
  const out: VulnFinding[] = [];
  for (const run of runs) {
    const rules = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id ?? r.name ?? "", r]));
    for (const r of run.results ?? []) {
      const rule = rules.get(r.ruleId ?? "");
      const own = r.properties?.["severity"] ?? rule?.properties?.["severity"];
      const severity: Severity =
        severityFromScore(r.properties?.["security-severity"]) ??
        severityFromScore(rule?.properties?.["security-severity"]) ??
        (typeof own === "string" && normalizeSeverity(own) !== "unknown" ? normalizeSeverity(own) : null) ??
        (r.level === "error" ? "high" : r.level === "note" ? "low" : "medium");
      const pkg = packageOf(r);
      const fixed = r.properties?.["fixedVersion"] ?? r.properties?.["fixed_version"];
      const fixedVersion = typeof fixed === "string" && fixed !== "" ? fixed : undefined;
      out.push({
        cveId: r.ruleId ?? "UNKNOWN",
        severity,
        package: pkg.name,
        installedVersion: pkg.version,
        ...(fixedVersion ? { fixedVersion } : {}),
        fixable: fixedVersion !== undefined,
      });
    }
  }
  return out;
}

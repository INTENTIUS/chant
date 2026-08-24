/**
 * Runner side of the pinnability survey (#1231, epic #1228).
 *
 * Pulls each corpus chart at its pinned version (network), renders twice with
 * closed inputs, and classifies. Chart tarballs are never vendored into the
 * repo: the corpus is `charts.txt` (the pins), `values/` (closed inputs for
 * charts that need them — #1233), and `expected.txt` (asserted verdicts).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  classify,
  countCapabilityRefs,
  countDifferingLines,
  extractActions,
  routeBySource,
  scanLookups,
  type Classification,
  type LookupScan,
  type TemplateAction,
} from "./classify";

/**
 * The kube version renders are pinned against. The epic's evidence ran
 * against k8s v1.33.6; more importantly, helm's default is a property of the
 * helm binary (3.16.2 → v1.31.0, 4.1.1 → v1.35.0), so an unpinned render is
 * not comparable across machines at all.
 */
export const PINNED_KUBE_VERSION = "1.33.6";

/** Where pulled charts live between runs. Never inside the repo. */
export const SURVEY_CACHE = join(tmpdir(), "chant-helm-survey-cache");

export interface CorpusEntry {
  name: string;
  repo: string;
  chart: string;
  version: string;
}

/** Parse `charts.txt`: one `name repo chart version` line per chart. */
export function parseCorpus(text: string): CorpusEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => {
      const parts = l.split(/\s+/);
      if (parts.length !== 4) throw new Error(`malformed charts.txt line: ${l}`);
      return { name: parts[0], repo: parts[1], chart: parts[2], version: parts[3] };
    });
}

/**
 * Pull one chart into the cache, isolated from the user's helm repo config.
 * Isolation is required, not hygiene: without `--repository-config /dev/null
 * --repository-cache <private>` a single stale unrelated repo index on the
 * machine fails every pull (same fix render.ts applies).
 */
export function pullChart(entry: CorpusEntry): string {
  const dest = join(SURVEY_CACHE, `${entry.name}-${entry.version}`);
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
    execFileSync(
      "helm",
      [
        "pull",
        entry.chart,
        "--repo",
        entry.repo,
        "--version",
        entry.version,
        "--repository-config",
        "/dev/null",
        "--repository-cache",
        join(SURVEY_CACHE, "_repo-cache"),
        "--untar",
        "--untardir",
        dest,
      ],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
  }
  return findChartDir(dest);
}

/** Locate the untarred chart's root (the directory holding Chart.yaml). */
export function findChartDir(dest: string): string {
  for (const entry of readdirSync(dest)) {
    const dir = join(dest, entry);
    if (statSync(dir).isDirectory() && existsSync(join(dir, "Chart.yaml"))) return dir;
  }
  throw new Error(`no Chart.yaml found under ${dest}`);
}

/**
 * Every template file in the chart, subcharts included. Finding 10 exists
 * because a scan (or a routing rule) that only sees the top level passes on
 * fixtures and fails on the umbrella charts people actually deploy.
 */
export function collectTemplateFiles(chartDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, underTemplates: boolean): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p, underTemplates || entry === "templates");
        continue;
      }
      if (!underTemplates) continue;
      if (entry === "NOTES.txt") continue; // rendered for the console, not the cluster
      if (/\.(ya?ml|tpl)$/.test(entry)) out.push(p);
    }
  };
  walk(chartDir, false);
  return out;
}

export function scanChart(chartDir: string): { actions: TemplateAction[]; lookups: LookupScan; capabilityRefs: number } {
  const actions: TemplateAction[] = [];
  for (const file of collectTemplateFiles(chartDir)) {
    const rel = file.slice(chartDir.length + 1);
    actions.push(...extractActions(readFileSync(file, "utf8"), rel));
  }
  return { actions, lookups: scanLookups(actions), capabilityRefs: countCapabilityRefs(actions) };
}

/** One closed-input render: pinned kube version, values file when present. */
export function renderChart(chartDir: string, valuesFile?: string, extraArgs: string[] = []): string {
  const args = [
    "template",
    "rel",
    chartDir,
    "--include-crds",
    "--kube-version",
    PINNED_KUBE_VERSION,
    ...extraArgs,
  ];
  if (valuesFile) args.push("--values", valuesFile);
  return execFileSync("helm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export interface SurveyRow {
  name: string;
  version: string;
  classification: Classification;
  /** Rendered documents routed to crds/ by the segment rule. */
  crdDocs: number;
  /** Rendered documents routed to templates/. */
  templateDocs: number;
  capabilityRefs: number;
  lookupControl: number;
  lookupValue: number;
  /** Differing lines between the two renders (0 when stable). */
  unstableLines: number;
  valuesSupplied: boolean;
}

/**
 * Survey one already-pulled chart. A chart that cannot render is a thrown
 * error, not a skipped row — a chart silently excluded from the corpus reads
 * as coverage it does not have (#1233).
 */
export function surveyChart(
  name: string,
  version: string,
  chartDir: string,
  valuesFile?: string,
): SurveyRow {
  const { lookups, capabilityRefs } = scanChart(chartDir);
  const a = renderChart(chartDir, valuesFile);
  const b = renderChart(chartDir, valuesFile);
  const unstableLines = countDifferingLines(a, b);
  const routed = routeBySource(a);
  const classification = classify({
    lookups,
    capabilityRefs,
    stable: unstableLines === 0,
    unstableLines,
    valuesSupplied: valuesFile !== undefined,
  });
  return {
    name,
    version,
    classification,
    crdDocs: routed.crds.length,
    templateDocs: routed.templates.length,
    capabilityRefs,
    lookupControl: lookups.controlFlow.length,
    lookupValue: lookups.valuePosition.length,
    unstableLines,
    valuesSupplied: valuesFile !== undefined,
  };
}

/**
 * The asserted line for `expected.txt`. Everything on it is a survey output,
 * so any drift — verdict, CRD routing, lookup counts, stability — fails the
 * suite rather than merely printing differently.
 */
export function formatRow(row: SurveyRow): string {
  return [
    row.name,
    row.classification.verdict,
    `crds=${row.crdDocs}`,
    `caps=${row.capabilityRefs}`,
    `lookup-control=${row.lookupControl}`,
    `lookup-value=${row.lookupValue}`,
    `unstable-lines=${row.unstableLines}`,
    `values=${row.valuesSupplied ? "yes" : "no"}`,
  ].join(" ");
}

/** The values file for a corpus chart, when the corpus ships one (#1233). */
export function valuesFileFor(surveyDir: string, name: string): string | undefined {
  const p = join(surveyDir, "values", `${name}.yaml`);
  return existsSync(p) ? p : undefined;
}

/** Human-readable reasons, for the survey's printed report. */
export function formatReasons(row: SurveyRow): string {
  return row.classification.reasons.join("; ") || "none";
}

export function chartLabel(chartDir: string): string {
  return basename(chartDir);
}

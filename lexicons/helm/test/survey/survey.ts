/**
 * Runner side of the pinnability survey (#1231, epic #1228).
 *
 * Pulls each corpus chart at its pinned version (network), renders twice with
 * closed inputs, and classifies with the production gate
 * (`src/pinnability`, #1234). Chart tarballs are never vendored into the
 * repo: the corpus is `charts.txt` (the pins), `values/` (closed inputs for
 * charts that need them — #1233), and `expected.txt` (asserted verdicts).
 *
 * The harness imports only the pinnability module, which needs no generated
 * lexicon artifacts — the survey CI job runs without a generation step.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  classifyChart,
  countDifferingLines,
  routeBySource,
  type PinnabilityReport,
  type PinnabilityVerdict,
} from "../../src/pinnability";

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

/** The survey's verdict labels, kept stable across the classifier promotion. */
export const VERDICT_LABELS: Record<PinnabilityVerdict, string> = {
  deterministic: "deterministic-as-is",
  pinnable: "pinnable-with-closed-inputs",
  unpinnable: "unpinnable",
};

export interface SurveyRow {
  name: string;
  version: string;
  report: PinnabilityReport;
  /** Rendered documents routed to crds/ by the segment rule. */
  crdDocs: number;
  /** Rendered documents routed to templates/. */
  templateDocs: number;
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
  const a = renderChart(chartDir, valuesFile);
  const b = renderChart(chartDir, valuesFile);
  const unstableLines = countDifferingLines(a, b);
  const routed = routeBySource(a);
  const report = classifyChart(chartDir, {
    valuesFiles: valuesFile !== undefined ? [valuesFile] : [],
    renderEvidence: { stable: unstableLines === 0, unstableLines },
  });
  return {
    name,
    version,
    report,
    crdDocs: routed.crds.length,
    templateDocs: routed.templates.length,
    unstableLines,
    valuesSupplied: valuesFile !== undefined,
  };
}

/**
 * The asserted line for `expected.txt`. Everything on it is a survey output,
 * so any drift — verdict, CRD routing, lookup counts, hazards, stability —
 * fails the suite rather than merely printing differently.
 */
export function formatRow(row: SurveyRow): string {
  return [
    row.name,
    VERDICT_LABELS[row.report.verdict],
    `crds=${row.crdDocs}`,
    `caps=${row.report.requiresProfile.length}`,
    `lookup-control=${row.report.lookups.controlFlow.length}`,
    `lookup-value=${row.report.lookups.valuePosition.length}`,
    `hazards=${row.report.hazards.length}`,
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
  return row.report.reasons.join("; ") || "none";
}

export function chartLabel(chartDir: string): string {
  return basename(chartDir);
}

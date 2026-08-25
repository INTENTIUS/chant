/**
 * `chant helm <verb>` — the pinned-renders surface (#1248, epic #1228
 * Phase 6), mounted through the command-group seam (#1078).
 *
 * Three verbs over machinery that already exists but had no CLI reach:
 *
 * - `classify` runs the pinnability gate (#1234) over a chart directory and
 *   prints the verdict with every finding located — capability references,
 *   open generated inputs, conditional hazards, lookup sites.
 * - `localize` runs the double-render localizer (#1236): it renders the
 *   chart twice, maps every unstable output line to the open input that
 *   produced it, and prints the validated pins that would close each one.
 * - `renders` discovers the current project and lists every `HelmRender`
 *   record with its digests (#1237) and capability profile, plus the
 *   stability report grouping renders by input identity.
 *
 * The diff verbs land separately: render-to-render is #1249, render-to-live
 * is #1250. This module is plain data reachable from plugin.ts — every
 * implementation (classifier, localizer, discovery) sits behind a dynamic
 * import, following `lexicons/k8s/src/kube/group.ts`'s discipline, so
 * loading the plugin never pays for machinery no verb was asked to run.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { splitJoinedFlags, unknownFlagError } from "@intentius/chant/cli/command-group";

import type { PinnabilityReport } from "./pinnability/classify";
import type { LocalizationReport } from "./pinnability/localize";
import type { HelmRenderRecord } from "./render";
import type { RenderStabilityReport } from "./render-digest";

const BOOLEAN_FLAGS = new Set(["--json"]);

interface ParsedArgs {
  positionals: string[];
  valuesFiles: string[];
  json: boolean;
  kubeVersion?: string;
  maxProbes?: number;
}

function parseVerbArgs(verb: string, raw: string[], accept: ReadonlySet<string>): ParsedArgs {
  const args = splitJoinedFlags(raw, BOOLEAN_FLAGS);
  const parsed: ParsedArgs = { positionals: [], valuesFiles: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" && accept.has("--json")) {
      parsed.json = true;
    } else if (a === "--values" && accept.has("--values")) {
      const value = args[++i];
      if (!value) throw new Error(`--values needs a file path.`);
      parsed.valuesFiles.push(value);
    } else if (a === "--kube-version" && accept.has("--kube-version")) {
      const value = args[++i];
      if (!value) throw new Error(`--kube-version needs a version like "1.33.6".`);
      parsed.kubeVersion = value;
    } else if (a === "--max-probes" && accept.has("--max-probes")) {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`--max-probes needs a positive integer.`);
      parsed.maxProbes = value;
    } else if (a.startsWith("-")) {
      throw unknownFlagError(a, `"chant helm ${verb}" accepts ${[...accept].join(", ")}.`);
    } else {
      parsed.positionals.push(a);
    }
  }
  return parsed;
}

function requireChartDir(verb: string, parsed: ParsedArgs): string {
  if (parsed.positionals.length === 0) {
    throw new Error(`Usage: chant helm ${verb} <chart-dir> [flags]\nThe chart directory (the one holding Chart.yaml) is required.`);
  }
  if (parsed.positionals.length > 1) {
    throw new Error(`chant helm ${verb} takes one chart directory, got: ${parsed.positionals.join(", ")}`);
  }
  return parsed.positionals[0];
}

function shortDigest(digest: string | undefined): string {
  if (!digest) return "-";
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return `sha256:${hex.slice(0, 12)}`;
}

/** The printed classify report — one line per finding, locations included. */
export function formatPinnabilityReport(report: PinnabilityReport): string {
  const lines: string[] = [`verdict: ${report.verdict}`];
  if (report.requiresProfile.length > 0) {
    lines.push(`requires capability profile (${report.requiresProfile.length} reference(s)):`);
    for (const req of report.requiresProfile) {
      lines.push(`  .Capabilities.${req.capability} at ${req.file}:${req.line}`);
    }
  }
  if (report.closedInputs.length > 0) {
    lines.push(`open inputs (${report.closedInputs.length}):`);
    for (const input of report.closedInputs) {
      const where = input.file !== undefined ? ` at ${input.file}:${input.line}` : "";
      lines.push(`  ${input.kind}${input.fn !== undefined ? ` ${input.fn}` : ""}${where} — ${input.detail}`);
    }
  }
  if (report.hazards.length > 0) {
    lines.push(`conditional hazards (${report.hazards.length}):`);
    for (const hazard of report.hazards) {
      lines.push(`  ${hazard.file}:${hazard.line} — ${hazard.detail}`);
    }
  }
  lines.push(
    `lookups: control-flow=${report.lookups.controlFlow.length} value-position=${report.lookups.valuePosition.length}`,
  );
  if (report.reasons.length > 0) {
    lines.push("reasons:");
    for (const reason of report.reasons) lines.push(`  - ${reason}`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

/**
 * The printed localization table: one block per open input, then the lines
 * nothing explains. Same shape the survey harness prints, kept here so the
 * CLI does not reach into test code.
 */
export function formatLocalizationReport(loc: LocalizationReport): string {
  if (loc.deterministic) return "deterministic (double render byte-stable)";
  const lines: string[] = [
    `unstable: ${loc.differingLines} differing line(s), ${loc.renders} renders used` +
      (loc.stableWithAllPins === undefined ? "" : `, stable with all pins: ${loc.stableWithAllPins ? "yes" : "no"}`),
  ];
  for (const input of loc.inputs) {
    lines.push(
      `  ${input.fn} at ${input.file}:${input.line}` +
        ` suppliable=${input.suppliable ? "yes" : "no"}` +
        (input.suggestedPin !== undefined ? ` pin: ${input.suggestedPin}` : "") +
        (input.existingSlots.length > 0 ? ` existing-slots: ${input.existingSlots.join(", ")}` : ""),
    );
    for (const occ of input.occurrences) {
      lines.push(`    ${occ.derived ? "derived " : ""}${occ.docId} ${occ.doc}:${occ.line} ${occ.key}`);
    }
  }
  for (const occ of loc.unlocalized) {
    lines.push(`  UNLOCALIZED ${occ.docId} ${occ.doc}:${occ.line} ${occ.key}`);
  }
  return lines.join("\n");
}

/** The printed render-record table plus the stability summary. */
export function formatRenderRecords(
  records: readonly HelmRenderRecord[],
  stability: RenderStabilityReport,
): string {
  const rows = records.map((r) => [
    r.name,
    r.chart,
    r.version ?? "-",
    r.capabilityProfile?.name ?? "(unpinned)",
    shortDigest(r.inputDigest),
    shortDigest(r.contentDigest),
  ]);
  const header = ["NAME", "CHART", "VERSION", "PROFILE", "INPUT DIGEST", "CONTENT DIGEST"];
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col].length)));
  const lines = [header, ...rows].map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
  lines.push(
    `stability: ${stability.stable.length} stable group(s), ${stability.unstable.length} unstable, ${stability.unassessed.length} unassessed`,
  );
  for (const group of stability.unstable) {
    lines.push(
      `  UNSTABLE ${group.names[0]}: ${group.contentDigests.length} distinct content digests for input ${shortDigest(group.inputDigest)}`,
    );
  }
  return lines.join("\n");
}

async function classifyHandler(ctx: CommandGroupContext): Promise<number> {
  const parsed = parseVerbArgs("classify", ctx.rawArgs, new Set(["--values", "--json"]));
  const chartDir = requireChartDir("classify", parsed);
  const { classifyChart } = await import("./pinnability/classify");
  const report = classifyChart(chartDir, { valuesFiles: parsed.valuesFiles });
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatPinnabilityReport(report));
  // The gate's answer IS the exit code, so CI can refuse to pin on it:
  // deterministic and pinnable exit 0, unpinnable exits 1.
  return report.verdict === "unpinnable" ? 1 : 0;
}

async function localizeHandler(ctx: CommandGroupContext): Promise<number> {
  const parsed = parseVerbArgs(
    "localize",
    ctx.rawArgs,
    new Set(["--values", "--kube-version", "--max-probes", "--json"]),
  );
  const chartDir = requireChartDir("localize", parsed);
  const { classifyChart } = await import("./pinnability/classify");
  const { localizeOpenInputs } = await import("./pinnability/localize");
  const { execFileSync } = await import("node:child_process");

  const render = (pins: Record<string, string>): string => {
    const args = ["template", "rel", chartDir, "--include-crds"];
    if (parsed.kubeVersion !== undefined) args.push("--kube-version", parsed.kubeVersion);
    for (const file of parsed.valuesFiles) args.push("--values", file);
    // Values keys with literal dots would need helm's backslash escaping; a
    // probe that misses merely fails to validate the pin, never misreports.
    for (const [path, value] of Object.entries(pins)) args.push("--set-string", `${path}=${value}`);
    try {
      return execFileSync("helm", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      const stderr = err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr) : String(err);
      throw new Error(
        `helm template failed for ${chartDir}:\n${stderr}\nHint: ensure the 'helm' CLI is on PATH (helm version).`,
      );
    }
  };

  const report = classifyChart(chartDir, { valuesFiles: parsed.valuesFiles });
  const localization = localizeOpenInputs(chartDir, report, {
    render,
    valuesFiles: parsed.valuesFiles,
    maxProbesPerInput: parsed.maxProbes,
  });
  console.log(parsed.json ? JSON.stringify(localization, null, 2) : formatLocalizationReport(localization));
  return 0;
}

async function rendersHandler(ctx: CommandGroupContext): Promise<number> {
  const parsed = parseVerbArgs("renders", ctx.rawArgs, new Set(["--json"]));
  if (parsed.positionals.length > 0) {
    throw new Error(`chant helm renders takes no positional arguments, got: ${parsed.positionals.join(", ")}`);
  }
  const { loadChantConfig } = await import("@intentius/chant/config");
  const { discover } = await import("@intentius/chant");
  const { getHelmRenderRecords, clearHelmRenderRecords } = await import("./render");
  const { renderStability } = await import("./render-digest");
  const { resolve } = await import("node:path");

  const cwd = process.cwd();
  const { config, configPath } = await loadChantConfig(cwd);
  if (!configPath) {
    throw new Error(
      `Not a chant project: no chant.config.ts or chant.config.json at ${cwd}.\n` +
        `chant helm renders discovers the project's HelmRender declarations, so it needs one.`,
    );
  }
  // Records accumulate per process; discovery below is the only source this
  // command reports, so start from an empty list (a no-op in the one-shot
  // CLI, but honest if a long-lived caller invokes the handler directly).
  clearHelmRenderRecords();
  const root = resolve(cwd, config.sourceDir ?? ".");
  const result = await discover(root);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(String(error));
    return 1;
  }
  const records = getHelmRenderRecords();
  const stability = renderStability(records);
  if (parsed.json) {
    console.log(JSON.stringify({ records, stability }, null, 2));
    return 0;
  }
  if (records.length === 0) {
    console.log("no HelmRender declarations recorded — the project discovered clean but declares none");
    return 0;
  }
  console.log(formatRenderRecords(records, stability));
  return 0;
}

/** The `chant helm` verb group (#1248). */
export function helmCommandGroup(): CommandGroup {
  return {
    name: "helm",
    description: "Pinned-render surface for helm charts: classify pinnability, localize unstable inputs, list recorded renders",
    commands: [
      {
        name: "classify",
        description: "Run the pinnability gate over a chart directory — verdict, capability references, open inputs, hazards (exit 1 = unpinnable)",
        handler: classifyHandler,
      },
      {
        name: "localize",
        description: "Double-render a chart and map every unstable output line to the open input that produced it, with validated pins",
        handler: localizeHandler,
      },
      {
        name: "renders",
        description: "Discover the project and list every HelmRender record with digests, capability profile, and render stability",
        handler: rendersHandler,
      },
    ],
  };
}

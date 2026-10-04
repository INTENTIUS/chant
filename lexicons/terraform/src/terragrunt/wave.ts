/**
 * One wave of Terragrunt units as one `terragrunt run --all` (#3414): the
 * arguments, the environment, the run report and the change-set parts.
 *
 * A wave names its units with explicit path filters, so it plans and applies
 * exactly those units. `.terragrunt-filters` is not read by a wave run:
 * Terragrunt unions its filters with the ones given on the command line
 * (observed on 1.1.6), so a filters file selecting `live/prod/**` would pull
 * every prod unit into every wave. Discovery reads it; the wave's paths came
 * from discovery.
 *
 * Plan writes `<outDir>/<unit>/tfplan.tfplan` and
 * `<jsonOutDir>/<unit>/tfplan.json`; apply reads the saved plans from the
 * same `outDir` with the same filters.
 *
 * Pure: nothing here spawns or reads files, so terragucci can bundle it. It
 * imports `../change-set` and chant's `change-set` types only.
 */

import type { ChangeSetPart, ChangeSetPlanner } from "@intentius/chant/change-set";
import { terraformChangeSetPart } from "../change-set";
import { stackOfUnit, unitPathFilter } from "./units";

export type TerragruntWaveCommand = "plan" | "apply";

export interface TerragruntWaveArgsInput {
  /** The wave's units, by path relative to where Terragrunt runs. */
  units: readonly string[];
  command: TerragruntWaveCommand;
  /** Where plan writes and apply reads the saved plan files. */
  outDir: string;
  /** Where plan writes each unit's `show -json`. Plan only. */
  jsonOutDir?: string;
  /** Where Terragrunt writes the run report (JSON). */
  reportFile: string;
  /** A destroy wave: plan runs `plan -destroy`, and both pass `--filter-allow-destroy`. */
  destroy?: boolean;
  /** `--parallelism`. Unset, Terragrunt runs every unit of the wave at once. */
  parallelism?: number;
  /** Arguments after `--`, beside the ones the command needs (`-lock-timeout=5m`). */
  extra?: readonly string[];
}

/** Arguments to `terragrunt` for one wave. Throws on an empty wave: with no filter, `run --all` runs every unit. */
export function terragruntWaveArgs(input: TerragruntWaveArgsInput): string[] {
  if (input.units.length === 0) throw new Error("a Terragrunt wave needs at least one unit; with no path filter run --all would run every unit");
  if (input.parallelism !== undefined && (!Number.isInteger(input.parallelism) || input.parallelism < 1)) {
    throw new Error(`parallelism must be a whole number of 1 or more, got ${input.parallelism}`);
  }
  const units = [...new Set(input.units)].sort();
  const args = [
    "run",
    "--all",
    "--non-interactive",
    "--no-color",
    "--no-filters-file",
    ...units.flatMap((u) => ["--filter", unitPathFilter(u)]),
    ...(input.destroy ? ["--filter-allow-destroy"] : []),
    "--out-dir",
    input.outDir,
    ...(input.command === "plan" && input.jsonOutDir ? ["--json-out-dir", input.jsonOutDir] : []),
    "--report-file",
    input.reportFile,
    "--report-format",
    "json",
    ...(input.parallelism !== undefined ? ["--parallelism", String(input.parallelism)] : []),
    "--",
    input.command,
    ...(input.command === "plan" && input.destroy ? ["-destroy"] : []),
    ...(input.extra ?? []),
  ];
  return args;
}

/**
 * The environment a wave adds: `TG_TF_PATH` when the project names a binary,
 * nothing otherwise, so Terragrunt's own choice (tofu, then terraform, or a
 * unit's `terraform_binary`) stands.
 */
export function terragruntEnv(binary: string | undefined): Record<string, string> {
  return binary ? { TG_TF_PATH: binary } : {};
}

/** One row of a Terragrunt run report (`run/report` JSON). */
export interface TerragruntReportRow {
  name: string;
  /** `succeeded`, `failed`, `early exit`, `excluded`, as Terragrunt writes them. */
  result: string;
  reason?: string;
  cause?: string;
  cmd?: string;
  started?: string;
  ended?: string;
}

/** The rows of a run report, keyed by unit path. Malformed rows are dropped. */
export function parseTerragruntReport(text: string | unknown): Map<string, TerragruntReportRow> {
  const doc = typeof text === "string" ? (JSON.parse(text.trim() === "" ? "[]" : text) as unknown) : text;
  const rows = Array.isArray(doc) ? doc : [];
  const out = new Map<string, TerragruntReportRow>();
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.Name !== "string" || typeof r.Result !== "string") continue;
    const name = r.Name.replace(/\\/g, "/").replace(/^\.\//, "");
    out.set(name, {
      name,
      result: r.Result,
      ...(typeof r.Reason === "string" && r.Reason ? { reason: r.Reason } : {}),
      ...(typeof r.Cause === "string" && r.Cause ? { cause: r.Cause.trim() } : {}),
      ...(typeof r.Cmd === "string" ? { cmd: r.Cmd } : {}),
      ...(typeof r.Started === "string" ? { started: r.Started } : {}),
      ...(typeof r.Ended === "string" ? { ended: r.Ended } : {}),
    });
  }
  return out;
}

/** How one unit of a wave ended. */
export interface TerragruntUnitResult {
  unit: string;
  /** `succeeded` only when the run report says so; a unit missing from it did not run. */
  status: "succeeded" | "failed";
  /** The report's result, or `not run` when the unit is not in it. */
  result: string;
  /** Why it failed, from the report's reason and cause. */
  error?: string;
}

/** Each of the wave's units against the run report. A unit the report leaves out failed: nothing says it ran. */
export function terragruntUnitResults(units: readonly string[], report: Map<string, TerragruntReportRow>): TerragruntUnitResult[] {
  return [...new Set(units)].sort().map((unit) => {
    const row = report.get(unit);
    if (!row) return { unit, status: "failed", result: "not run", error: "not in Terragrunt's run report, so it did not run" };
    if (row.result === "succeeded") return { unit, status: "succeeded", result: row.result };
    const why = [row.reason, row.cause].filter(Boolean).join(": ");
    return { unit, status: "failed", result: row.result, error: `${row.result}${why ? ` (${why})` : ""}` };
  });
}

export interface TerragruntWavePartsInput {
  units: readonly string[];
  report: Map<string, TerragruntReportRow>;
  /** A unit's `tfplan.json`, parsed, or undefined when plan wrote none. */
  planFor: (unit: string) => unknown;
  /** The binary Terragrunt called. */
  planner: ChangeSetPlanner;
  /** The scope a unit's member carries. Default: its stack, {@link stackOfUnit}. */
  scopeFor?: (unit: string) => string | undefined;
}

/**
 * The change-set parts of a planned wave: one member per unit, named by the
 * unit's path. A unit the run report marks succeeded, with a plan JSON, goes
 * through {@link terraformChangeSetPart}; any other is a failed member
 * carrying the report's result, so a unit that never planned cannot read as
 * planned with nothing to do.
 */
export function terragruntWaveParts(input: TerragruntWavePartsInput): ChangeSetPart[] {
  const scopeFor = input.scopeFor ?? stackOfUnit;
  return terragruntUnitResults(input.units, input.report).map((r) => {
    const scope = scopeFor(r.unit);
    const plan = r.status === "succeeded" ? input.planFor(r.unit) : undefined;
    if (r.status === "succeeded" && plan !== undefined) {
      return terraformChangeSetPart({ member: r.unit, plan, planner: input.planner, ...(scope ? { scope } : {}) });
    }
    return {
      member: {
        member: r.unit,
        lexicon: "terraform",
        planner: input.planner,
        ...(scope ? { scope } : {}),
        status: "failed" as const,
        error: r.error ?? "Terragrunt reported the unit succeeded but wrote no plan JSON for it",
        planDigest: null,
        holes: [],
      },
      entries: [],
    };
  });
}

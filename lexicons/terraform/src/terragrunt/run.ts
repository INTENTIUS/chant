/**
 * The Terragrunt runner (#3414): discovery and one wave, run against a real
 * `terragrunt`. The pure halves are `./units.ts` and `./wave.ts`.
 *
 * Every call takes an injectable `exec`, so tests stub the process and the
 * acceptance test runs the real binary.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChangeSetPart, ChangeSetPlanner } from "@intentius/chant/change-set";
import { plannerForBinary } from "../change-set";
import {
  parseTerragruntFind,
  terragruntFindArgs,
  terragruntVersionProblem,
  type TerragruntFindOptions,
  type TerragruntUnit,
} from "./units";
import {
  parseTerragruntReport,
  terragruntEnv,
  terragruntUnitResults,
  terragruntWaveArgs,
  terragruntWaveParts,
  type TerragruntUnitResult,
} from "./wave";

export interface ExecResult {
  /** The exit code; null when the process did not exit on its own. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `file args` in `cwd` with `env` added to the process environment. Never throws on a non-zero exit. */
export type TerragruntExec = (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => Promise<ExecResult>;

export const defaultTerragruntExec: TerragruntExec = (file, args, options) =>
  new Promise((done) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: { ...process.env, ...options.env }, maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
        done({ code, stdout: String(stdout), stderr: err && code === null ? `${String(stderr)}${err.message}` : String(stderr) });
      },
    );
  });

export interface TerragruntRunOptions {
  /** The project directory Terragrunt runs in. Unit paths are relative to it. */
  dir: string;
  /** The `terragrunt` executable. Default `terragrunt` on PATH. */
  terragrunt?: string;
  /** The project's `binary`: what Terragrunt calls, via `TG_TF_PATH`. Unset leaves Terragrunt's own choice. */
  binary?: string;
  exec?: TerragruntExec;
}

/** Thrown when `terragrunt` is missing, too old or fails. */
export class TerragruntError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerragruntError";
  }
}

/** Refuse a Terragrunt older than 1.1. Returns the version line. */
export async function checkTerragruntVersion(options: TerragruntRunOptions): Promise<string> {
  const exec = options.exec ?? defaultTerragruntExec;
  const tg = options.terragrunt ?? "terragrunt";
  const r = await exec(tg, ["--version"], { cwd: options.dir, env: {} });
  if (r.code !== 0) throw new TerragruntError(`\`${tg} --version\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  const problem = terragruntVersionProblem(r.stdout);
  if (problem) throw new TerragruntError(problem);
  return r.stdout.trim();
}

export interface TerragruntDiscovery {
  units: TerragruntUnit[];
  /** Units whose own configuration names a `terraform_binary` that `TG_TF_PATH` overrides. */
  warnings: string[];
}

/**
 * The project's units, from `terragrunt find`, with catalog templates and the
 * module cache left out and `.terragrunt-filters` honoured.
 */
export async function discoverTerragruntUnits(options: TerragruntRunOptions & TerragruntFindOptions): Promise<TerragruntDiscovery> {
  const exec = options.exec ?? defaultTerragruntExec;
  const tg = options.terragrunt ?? "terragrunt";
  const args = terragruntFindArgs(options);
  const r = await exec(tg, args, { cwd: options.dir, env: terragruntEnv(options.binary) });
  if (r.code !== 0) throw new TerragruntError(`\`${tg} ${args.join(" ")}\` failed (exit ${r.code}): ${r.stderr.trim()}`);
  let units: TerragruntUnit[];
  try {
    units = parseTerragruntFind(r.stdout);
  } catch (err) {
    throw new TerragruntError(`could not read \`terragrunt find\` output: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { units, warnings: options.binary ? terraformBinaryWarnings(options.dir, units, options.binary) : [] };
}

const TERRAFORM_BINARY = /^\s*terraform_binary\s*=\s*(.+?)\s*$/m;

/**
 * A warning per unit whose `terragrunt.hcl`, or a file it includes, sets
 * `terraform_binary` to something other than `binary`. `TG_TF_PATH` wins over
 * it (observed on 1.1.6), so the unit runs `binary`, not what it names.
 */
export function terraformBinaryWarnings(dir: string, units: readonly TerragruntUnit[], binary: string): string[] {
  const out: string[] = [];
  for (const u of units) {
    const files = [join(u.path, "terragrunt.hcl"), ...Object.values(u.include ?? {})];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(resolve(dir, f), "utf8");
      } catch {
        continue;
      }
      const m = TERRAFORM_BINARY.exec(text);
      if (!m) continue;
      const literal = /^"([^"$]*)"$/.exec(m[1]!);
      if (literal && literal[1] === binary) break;
      out.push(
        `${u.path}: ${f} sets terraform_binary = ${m[1]}, but the project's binary is ${binary}; ` +
          `TG_TF_PATH=${binary} overrides it, so the unit runs ${binary}`,
      );
      break;
    }
  }
  return out;
}

/** The planner a wave's plans come from: the project's binary, else Terragrunt's default of tofu. */
export function terragruntPlanner(binary: string | undefined): ChangeSetPlanner {
  return plannerForBinary(binary ?? "tofu");
}

export interface TerragruntWaveRunInput extends TerragruntRunOptions {
  units: readonly string[];
  /** A directory for this wave's plans, plan JSON and reports. Plan and apply of one wave share it. */
  workDir: string;
  destroy?: boolean;
  parallelism?: number;
}

export interface TerragruntWavePlan {
  /** The change-set parts, one per unit. */
  parts: ChangeSetPart[];
  results: TerragruntUnitResult[];
  /** Terragrunt's exit code. */
  code: number | null;
  /** Terragrunt's stderr, for the job log. */
  log: string;
}

/** Plan one wave with one `terragrunt run --all`, and read each unit's plan JSON and run-report row. */
export async function planTerragruntWave(input: TerragruntWaveRunInput): Promise<TerragruntWavePlan> {
  const exec = input.exec ?? defaultTerragruntExec;
  const tg = input.terragrunt ?? "terragrunt";
  const work = resolve(input.dir, input.workDir);
  const outDir = join(work, "plans");
  const jsonOutDir = join(work, "json");
  const reportFile = join(work, "plan-report.json");
  // A plan or report left by an earlier attempt must not stand in for a unit that did not plan this time.
  for (const stale of [outDir, jsonOutDir, reportFile]) rmSync(stale, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const args = terragruntWaveArgs({
    units: input.units,
    command: "plan",
    outDir,
    jsonOutDir,
    reportFile,
    ...(input.destroy ? { destroy: true } : {}),
    ...(input.parallelism !== undefined ? { parallelism: input.parallelism } : {}),
  });
  const r = await exec(tg, args, { cwd: input.dir, env: terragruntEnv(input.binary) });
  const report = existsSync(reportFile) ? parseTerragruntReport(readFileSync(reportFile, "utf8")) : new Map();
  const planFor = (unit: string): unknown => {
    const f = join(jsonOutDir, unit, "tfplan.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as unknown) : undefined;
  };
  return {
    parts: terragruntWaveParts({ units: input.units, report, planFor, planner: terragruntPlanner(input.binary) }),
    results: terragruntUnitResults(input.units, report),
    code: r.code,
    log: r.stderr,
  };
}

export interface TerragruntWaveApply {
  results: TerragruntUnitResult[];
  code: number | null;
  log: string;
}

/**
 * Apply one planned wave from its saved plans, with the same filters. Refuses
 * before running anything when a unit of the wave has no saved plan, since
 * Terragrunt would plan it afresh and apply a plan nobody saw.
 */
export async function applyTerragruntWave(input: TerragruntWaveRunInput): Promise<TerragruntWaveApply> {
  const exec = input.exec ?? defaultTerragruntExec;
  const tg = input.terragrunt ?? "terragrunt";
  const work = resolve(input.dir, input.workDir);
  const outDir = join(work, "plans");
  const missing = [...new Set(input.units)].sort().filter((u) => !existsSync(join(outDir, u, "tfplan.tfplan")));
  if (missing.length > 0) {
    throw new TerragruntError(`no saved plan for ${missing.join(", ")} under ${outDir}; plan the wave before applying it, so apply runs the plan that was reviewed`);
  }
  const reportFile = join(work, "apply-report.json");
  rmSync(reportFile, { force: true });
  mkdirSync(dirname(reportFile), { recursive: true });
  const args = terragruntWaveArgs({
    units: input.units,
    command: "apply",
    outDir,
    reportFile,
    ...(input.destroy ? { destroy: true } : {}),
    ...(input.parallelism !== undefined ? { parallelism: input.parallelism } : {}),
  });
  const r = await exec(tg, args, { cwd: input.dir, env: terragruntEnv(input.binary) });
  const report = existsSync(reportFile) ? parseTerragruntReport(readFileSync(reportFile, "utf8")) : new Map();
  return { results: terragruntUnitResults(input.units, report), code: r.code, log: r.stderr };
}

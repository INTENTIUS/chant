/**
 * Terragrunt units as roots (#3414): what a unit is, how discovery finds the
 * units, and how the unit graph orders them into waves.
 *
 * A Terragrunt unit is a root: its own state, plan file and plan digest. The
 * units and their edges come from `terragrunt find --json --dag
 * --dependencies`, run by Terragrunt itself, so chant never evaluates
 * Terragrunt's HCL to learn the graph. Directories that group units (implicit
 * stacks) are labels: a unit's stack is its parent directory.
 *
 * This module runs nothing and imports only chant's `gated-waves` subpath, so
 * terragucci can bundle it without TypeScript (#3421). `./run.ts` spawns.
 */

import { layerWaves } from "@intentius/chant/gated-waves";
import type { WaveNode } from "@intentius/chant/gated-waves";

/** The oldest Terragrunt this runner drives: `run --all`, `find --dag` and `--filter` as 1.1 ships them. */
export const TERRAGRUNT_MIN_VERSION = "1.1.0";

/**
 * Filters every discovery adds: catalog unit templates, which parse only
 * inside a stack, and Terragrunt's module cache. A project's own `exclude`
 * globs are added after these.
 */
export const TERRAGRUNT_DISCOVERY_EXCLUDES: readonly string[] = ["catalog/**", "**/.terragrunt-cache/**"];

/** One unit as `find --json --dag --dependencies --include --reading` reports it. */
export interface TerragruntUnit {
  /** The unit's directory, relative to where discovery ran, with `/` separators. Also its change-set member name. */
  path: string;
  /** Units this one must follow, from `dependency` and `dependencies` blocks alike. */
  dependencies: string[];
  /** Included files by include name, relative to where discovery ran. */
  include?: Record<string, string>;
  /** Files Terragrunt reports the unit reading. */
  reading?: string[];
}

/** A Terragrunt version string, parsed. */
export interface TerragruntVersion {
  major: number;
  minor: number;
  patch: number;
  /** `rc1` in `1.2.0-rc1`. */
  pre?: string;
  raw: string;
}

/** Read `terragrunt --version` output (`terragrunt version v1.1.6`). Undefined when no version is in it. */
export function parseTerragruntVersion(output: string): TerragruntVersion | undefined {
  const m = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(output);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] ? { pre: m[4] } : {}), raw: m[0] };
}

/**
 * Why this Terragrunt cannot run units, or undefined when it can. A release
 * candidate of 1.1.0 or later counts as that release line.
 */
export function terragruntVersionProblem(output: string): string | undefined {
  const v = parseTerragruntVersion(output);
  if (!v) return `could not read a version from \`terragrunt --version\` (got ${JSON.stringify(output.trim().slice(0, 80))})`;
  const [minMajor, minMinor] = TERRAGRUNT_MIN_VERSION.split(".").map(Number) as [number, number];
  if (v.major > minMajor || (v.major === minMajor && v.minor >= minMinor)) return undefined;
  return `Terragrunt ${v.raw} is older than ${TERRAGRUNT_MIN_VERSION}, the oldest release chant runs units with (run --all, find --dag and --filter as 1.1 ships them)`;
}

/** A path filter that selects exactly one unit. Braced so a path with glob characters stays a path. */
export function unitPathFilter(path: string): string {
  return `{./${path}}`;
}

/** A filter that drops everything under `glob`, relative to where discovery runs. */
export function excludeFilter(glob: string): string {
  return `!./${glob.replace(/^\.\//, "")}`;
}

export interface TerragruntFindOptions {
  /** Globs to leave out beside {@link TERRAGRUNT_DISCOVERY_EXCLUDES}, relative to the project directory. */
  exclude?: readonly string[];
}

/**
 * Arguments to `terragrunt` for discovery. `.terragrunt-filters` is read, as
 * Terragrunt reads it by default; the excludes narrow what it selects.
 */
export function terragruntFindArgs(options: TerragruntFindOptions = {}): string[] {
  const excludes = [...TERRAGRUNT_DISCOVERY_EXCLUDES, ...(options.exclude ?? [])];
  return [
    "find",
    "--json",
    "--dag",
    "--dependencies",
    "--include",
    "--reading",
    "--no-color",
    ...excludes.flatMap((g) => ["--filter", excludeFilter(g)]),
  ];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const clean = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * The units in `find --json` output, in the order Terragrunt printed them
 * (its DAG order under `--dag`). Stacks and anything else that is not a unit
 * are left out. Throws when the output is not a JSON array.
 */
export function parseTerragruntFind(output: string | unknown): TerragruntUnit[] {
  const doc = typeof output === "string" ? (JSON.parse(output.trim() === "" ? "[]" : output) as unknown) : output;
  if (!Array.isArray(doc)) throw new Error("terragrunt find --json did not print an array");
  const units: TerragruntUnit[] = [];
  for (const raw of doc) {
    if (!isObject(raw) || raw.type !== "unit" || typeof raw.path !== "string") continue;
    const include = isObject(raw.include)
      ? Object.fromEntries(Object.entries(raw.include).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => [k, clean(v)]))
      : undefined;
    const reading = Array.isArray(raw.reading) ? strings(raw.reading).map(clean) : undefined;
    units.push({
      path: clean(raw.path),
      dependencies: [...new Set(strings(raw.dependencies).map(clean))].sort(),
      ...(include && Object.keys(include).length > 0 ? { include } : {}),
      ...(reading ? { reading } : {}),
    });
  }
  return units;
}

/** A unit's implicit stack: its parent directory, or `.` for a unit at the top. */
export function stackOfUnit(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}

/** Whether `path` matches `glob` (`*` within a segment, `**` across segments, `?` one character). */
export function matchesUnitGlob(path: string, glob: string): boolean {
  const g = clean(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      // `a/**/b` and `a/**` also match zero directories.
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

/** The units, as the nodes gated waves (#3049) and a fan-out (#2417) layer. */
export function terragruntWaveNodes(units: readonly TerragruntUnit[]): WaveNode[] {
  return units.map((u) => ({ name: u.path, dependsOn: u.dependencies }));
}

export interface TerragruntWavesOptions {
  /** Unit globs that form wave 1 (`live/dev/**`). A glob matching no unit in the set adds nothing. */
  canary?: readonly string[];
}

/** Thrown when units cannot be cut into waves. The message names the units. */
export class TerragruntWaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerragruntWaveError";
  }
}

/**
 * Cut units into waves by Terragrunt's unit graph: each unit after every unit
 * it depends on. A dependency outside `units` holds nothing back; it is not
 * part of this change. Each wave is sorted by path.
 *
 * Canaries go first, layered among themselves, so a canary that reads
 * another canary still waits for it to apply. A canary that depends on a unit
 * of the set that is not a canary is refused: it would apply before what it
 * reads.
 */
export function terragruntWaves(units: readonly TerragruntUnit[], options: TerragruntWavesOptions = {}): string[][] {
  const canaries = new Set((options.canary ?? []).flatMap((g) => units.filter((u) => matchesUnitGlob(u.path, g)).map((u) => u.path)));
  const names = new Set(units.map((u) => u.path));
  for (const u of units) {
    if (!canaries.has(u.path)) continue;
    const outside = u.dependencies.filter((d) => names.has(d) && !canaries.has(d));
    if (outside.length > 0) {
      throw new TerragruntWaveError(`canary ${u.path} depends on ${outside.join(", ")}, which is not a canary, so the canary wave would apply it first`);
    }
  }
  const nodes = terragruntWaveNodes(units);
  const layer = (subset: WaveNode[]): string[][] => {
    try {
      return layerWaves(subset);
    } catch (err) {
      throw new TerragruntWaveError(err instanceof Error ? err.message : String(err));
    }
  };
  return [...layer(nodes.filter((n) => canaries.has(n.name))), ...layer(nodes.filter((n) => !canaries.has(n.name)))];
}

/**
 * Every unit that depends on one of `changed`, directly or through other
 * units, not counting `changed` itself. Sorted by path.
 *
 * `find` reports `dependency` and ordering-only `dependencies` edges as one
 * list, so this follows both. A caller that follows `dependency` edges only
 * passes `edges` built from the units' own blocks.
 */
export function terragruntDependents(
  units: readonly TerragruntUnit[],
  changed: readonly string[],
  edges: (unit: TerragruntUnit) => readonly string[] = (u) => u.dependencies,
): string[] {
  const seeds = new Set(changed.map(clean));
  const reached = new Set<string>(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (reached.has(u.path)) continue;
      if (edges(u).some((d) => reached.has(d))) {
        reached.add(u.path);
        grew = true;
      }
    }
  }
  return [...reached].filter((p) => !seeds.has(p)).sort();
}

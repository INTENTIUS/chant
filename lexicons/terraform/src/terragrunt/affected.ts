/**
 * Affected Terragrunt units for a git range (#3415): what Terragrunt's own
 * git filter selects, plus three cases it misses, each unit with its reasons.
 *
 * Terragrunt's `[base...head]` filter is the starting point, so the selection
 * matches what `run --all` with that filter would run. Terragrunt 1.1.6 and
 * 1.2.0-rc1 both miss these (observed on `../__fixtures__/terragrunt/affected`):
 *
 * - `module-file`: a file under a unit's local module directory that is not a
 *   configuration file, such as one the module reads with `file()`. A unit's
 *   module directory is where the `.tf` and `.tofu` files in its `reading`
 *   list live, so an interpolated `terraform.source` resolves the way
 *   Terragrunt resolved it. A file Terragrunt lists in `reading` is its own
 *   to track and is not counted here.
 * - `module-call`: a file under a local module that the unit's module calls,
 *   followed through modules that call modules with the same reader
 *   `../changed-roots.ts` uses for plain roots.
 * - `stack-template`: a file under a stack's local unit template selects the
 *   units generated from it. A stack template (a `stack` block) selects every
 *   unit generated under it.
 *
 * Dependents of the selected units are the caller's to add (`terragruntDependents`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { rootWatchPaths } from "../changed-roots";
import { excludeFilter, parseTerragruntFind, TERRAGRUNT_DISCOVERY_EXCLUDES, type TerragruntFindOptions, type TerragruntUnit } from "./units";
import { defaultTerragruntExec, discoverTerragruntUnits, TerragruntError, type TerragruntRunOptions } from "./run";
import { terragruntEnv } from "./wave";

/** Why a unit is affected. */
export type TerragruntAffectedKind =
  /** Terragrunt's git filter selected it. */
  | "terragrunt"
  /** Terragrunt's git filter selected it and it is gone at head: Terragrunt plans its destroy from the base checkout. */
  | "removed"
  /** A changed file under the unit's module directory that Terragrunt does not track. */
  | "module-file"
  /** A changed file under a local module the unit's module calls. */
  | "module-call"
  /** A changed file under the stack template the unit is generated from. */
  | "stack-template";

export interface TerragruntAffectedReason {
  kind: TerragruntAffectedKind;
  /** The changed files behind this reason, sorted. Empty when Terragrunt selected the unit for files chant cannot attribute. */
  files: string[];
  /** The module directory or template directory the files sit under. Unset for `terragrunt` and `removed`. */
  via?: string;
}

export interface TerragruntAffectedUnit {
  /** The unit's path, as discovery reports it. */
  path: string;
  /** Terragrunt's reason first, then the supplements in the order of {@link TerragruntAffectedKind}. */
  reasons: TerragruntAffectedReason[];
}

export interface TerragruntAffected {
  /** The affected units, sorted by path. */
  units: TerragruntAffectedUnit[];
  /** What the selection could not do, one line each: a unit Terragrunt selected that discovery left out, a generated unit not generated yet. */
  notes: string[];
}

export interface TerragruntAffectedInput {
  /** The project directory. Unit paths, `reading` entries and changed files are relative to it. */
  dir: string;
  /** The project's units at head, from discovery, with stacks generated. */
  units: readonly TerragruntUnit[];
  /** Unit paths Terragrunt's own `[base...head]` filter selected. */
  terragruntSelected: readonly string[];
  /** Files the range changed, relative to `dir`, `/`-separated, as `git diff --name-only --relative` prints them. */
  changedFiles: readonly string[];
}

const KIND_ORDER: readonly TerragruntAffectedKind[] = ["terragrunt", "removed", "module-file", "module-call", "stack-template"];
const CONFIG_EXT = /\.(tf|tofu)(\.json)?$/;
const toPosix = (p: string): string => p.split(sep).join("/");
const clean = (p: string): string => posix.normalize(toPosix(p)).replace(/^\.\//, "").replace(/\/+$/, "");
const under = (dir: string, file: string): boolean => dir === "." || file === dir || file.startsWith(`${dir}/`);

/** Arguments to `terragrunt find` for the units Terragrunt's git filter selects between `base` and `head`. */
export function terragruntAffectedFindArgs(options: { base: string; head?: string } & TerragruntFindOptions): string[] {
  const excludes = [...TERRAGRUNT_DISCOVERY_EXCLUDES, ...(options.exclude ?? [])];
  return [
    "find",
    "--json",
    "--no-color",
    // A filters file is unioned with --filter, so it would add every unit it names to the range.
    "--no-filters-file",
    "--filter",
    `[${options.base}...${options.head ?? "HEAD"}]`,
    ...excludes.flatMap((g) => ["--filter", excludeFilter(g)]),
  ];
}

/** Arguments to `git` for the files the range changed, relative to the project directory. */
export function terragruntAffectedDiffArgs(options: { base: string; head?: string }): string[] {
  return ["diff", "--name-only", "--no-renames", "--relative", `${options.base}...${options.head ?? "HEAD"}`];
}

/** The unit's local module directories: where the `.tf` and `.tofu` files Terragrunt reports it reading live, outside the unit's own directory. */
export function terragruntModuleDirs(unit: TerragruntUnit): string[] {
  const dirs = new Set<string>();
  for (const f of unit.reading ?? []) {
    if (!CONFIG_EXT.test(f) || under(unit.path, f) || f.includes(".terragrunt-cache/")) continue;
    dirs.add(posix.dirname(f));
  }
  return [...dirs].sort();
}

/** A `unit` or `stack` block of a `terragrunt.stack.hcl`, as far as affected selection needs it. */
export interface TerragruntStackBlock {
  type: "unit" | "stack";
  name: string;
  /** The template directory, relative to the project, for a local source; unset for a remote one. */
  template?: string;
  /** Where the block generates, relative to the project. */
  generated: string;
}

/**
 * The `unit` and `stack` blocks of a stack file at `stackFile` (relative to
 * `dir`). Sources that are relative paths or start with `${get_terragrunt_dir()}`
 * are local; anything else (git, registry, other functions) is left without a
 * template, since its version lives in the stack file and a change to it is
 * Terragrunt's to see.
 */
export function readTerragruntStackFile(dir: string, stackFile: string, text: string): TerragruntStackBlock[] {
  const stackDir = posix.dirname(clean(stackFile));
  const blocks: TerragruntStackBlock[] = [];
  const head = /\b(unit|stack)\s+"([^"]+)"\s*\{/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const body = blockBody(text, head.lastIndex);
    const source = topLevelString(body, "source");
    const path = topLevelString(body, "path");
    if (path === undefined) continue;
    const noDot = /^\s*no_dot_terragrunt_stack\s*=\s*true\b/m.test(body);
    const base = noDot ? stackDir : posix.join(stackDir, ".terragrunt-stack");
    const generated = clean(posix.join(base, path));
    let template: string | undefined;
    if (source !== undefined) {
      const local = source.replace(/^\$\{get_terragrunt_dir\(\)\}\//, "./");
      if (/^\.{1,2}\//.test(local)) template = clean(toPosix(relative(dir, resolve(dir, stackDir, local.replace("//", "/")))));
    }
    blocks.push({ type: m[1] as "unit" | "stack", name: m[2]!, generated, ...(template !== undefined ? { template } : {}) });
  }
  return blocks;
}

/** The text between the brace before `start` and its matching close, skipping strings and comments. */
function blockBody(text: string, start: number): string {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

/** A string attribute of a block body at nesting depth zero (`path = "web"`, not one inside `values = { ... }`). */
function topLevelString(body: string, name: string): string | undefined {
  const attr = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`);
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 0) {
      const m = attr.exec(line);
      if (m) return m[1];
    }
    const code = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    depth += (code.match(/[{[]/g) ?? []).length - (code.match(/[}\]]/g) ?? []).length;
  }
  return undefined;
}

const SKIP_DIRS = new Set([".git", ".terragrunt-cache", "node_modules", ".terraform"]);

/** Every `terragrunt.stack.hcl` under `dir`, generated ones included, relative to `dir`. */
export function findTerragruntStackFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(p);
      else if (e.isFile() && e.name === "terragrunt.stack.hcl") out.push(p);
    }
  };
  walk("");
  return out.sort();
}

/** The stack file a generated unit came from: the one beside the `.terragrunt-stack` it sits in. */
function generatingStackFile(unitPath: string): string | undefined {
  const i = unitPath.lastIndexOf("/.terragrunt-stack/");
  return i < 0 ? undefined : `${unitPath.slice(0, i)}/terragrunt.stack.hcl`;
}

/**
 * The affected units: what Terragrunt selected, each with the changed files
 * that explain it, plus the three supplements. A unit Terragrunt selected
 * that discovery does not list is `removed` when its `terragrunt.hcl` is gone,
 * and otherwise left out with a note (discovery excluded it).
 */
export function terragruntAffected(input: TerragruntAffectedInput): TerragruntAffected {
  const changed = [...new Set(input.changedFiles.map(clean))].sort();
  const byPath = new Map(input.units.map((u) => [u.path, u]));
  const reasons = new Map<string, TerragruntAffectedReason[]>();
  const notes: string[] = [];
  const add = (path: string, reason: TerragruntAffectedReason): void => {
    const list = reasons.get(path) ?? [];
    list.push(reason);
    reasons.set(path, list);
  };

  for (const raw of new Set(input.terragruntSelected.map(clean))) {
    const unit = byPath.get(raw);
    if (!unit) {
      if (existsSync(join(input.dir, raw, "terragrunt.hcl"))) {
        notes.push(`${raw}: Terragrunt's git range selected it, but discovery left it out, so it is not affected here`);
      } else {
        add(raw, { kind: "removed", files: changed.filter((f) => under(raw, f)) });
      }
      continue;
    }
    const tracked = new Set([...(unit.reading ?? []), ...Object.values(unit.include ?? {}), generatingStackFile(unit.path)].filter((f): f is string => !!f));
    add(raw, { kind: "terragrunt", files: changed.filter((f) => under(unit.path, f) || tracked.has(f)) });
  }

  for (const unit of input.units) {
    const reading = new Set(unit.reading ?? []);
    const moduleDirs = terragruntModuleDirs(unit);
    const called = new Map<string, string>();
    for (const m of moduleDirs) {
      for (const d of rootWatchPaths(input.dir, { dir: m })) if (!moduleDirs.includes(d) && !called.has(d)) called.set(d, m);
    }
    const viaFile = new Map<string, string[]>();
    const viaCall = new Map<string, string[]>();
    for (const f of changed) {
      if (reading.has(f)) continue;
      const call = [...called.keys()].filter((d) => under(d, f)).sort((a, b) => b.length - a.length)[0];
      if (call !== undefined) {
        viaCall.set(call, [...(viaCall.get(call) ?? []), f]);
        continue;
      }
      const own = moduleDirs.filter((d) => under(d, f)).sort((a, b) => b.length - a.length)[0];
      if (own !== undefined) viaFile.set(own, [...(viaFile.get(own) ?? []), f]);
    }
    for (const [via, files] of viaFile) add(unit.path, { kind: "module-file", files, via });
    for (const [via, files] of viaCall) add(unit.path, { kind: "module-call", files, via });
  }

  for (const stackFile of findTerragruntStackFiles(input.dir)) {
    let text: string;
    try {
      text = readFileSync(join(input.dir, stackFile), "utf8");
    } catch {
      continue;
    }
    for (const block of readTerragruntStackFile(input.dir, stackFile, text)) {
      if (block.template === undefined) continue;
      const files = changed.filter((f) => under(block.template!, f));
      if (files.length === 0) continue;
      const targets = block.type === "unit" ? (byPath.has(block.generated) ? [block.generated] : []) : input.units.filter((u) => under(block.generated, u.path)).map((u) => u.path);
      if (targets.length === 0) {
        notes.push(
          `${block.generated}: generated by ${block.type} "${block.name}" in ${stackFile} from the changed template ${block.template}, ` +
            "but discovery did not list it; run `terragrunt stack generate` before discovery",
        );
      }
      for (const t of targets) add(t, { kind: "stack-template", files, via: block.template });
    }
  }

  const units = [...reasons.entries()]
    .map(([path, list]) => ({
      path,
      reasons: list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.via ?? "").localeCompare(b.via ?? "")),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { units, notes: [...new Set(notes)].sort() };
}

/** One line per reason, for a report or a job log. */
export function describeTerragruntAffectedReason(reason: TerragruntAffectedReason): string {
  const files = reason.files.join(", ");
  switch (reason.kind) {
    case "terragrunt":
      return files ? `Terragrunt's git range selected it (${files})` : "Terragrunt's git range selected it";
    case "removed":
      return "removed in the range; Terragrunt plans its destroy";
    case "module-file":
      return `${files} changed under its module ${reason.via}, which Terragrunt does not track`;
    case "module-call":
      return `${files} changed under ${reason.via}, a module its module calls`;
    case "stack-template":
      return `${files} changed under ${reason.via}, the stack template it is generated from`;
  }
}

export interface FindTerragruntAffectedOptions extends TerragruntRunOptions, TerragruntFindOptions {
  /** The range's base commit or ref (`origin/main`). */
  base: string;
  /** The range's head. Default `HEAD`. */
  head?: string;
  /** The project's units at head; discovered when unset. Stacks must be generated before discovery. */
  units?: readonly TerragruntUnit[];
  /** The `git` executable. Default `git` on PATH. */
  git?: string;
}

/** Run git and Terragrunt's git filter in `dir` and return the affected units with their reasons. */
export async function findTerragruntAffected(options: FindTerragruntAffectedOptions): Promise<TerragruntAffected> {
  const exec = options.exec ?? defaultTerragruntExec;
  const tg = options.terragrunt ?? "terragrunt";
  const git = options.git ?? "git";
  const diffArgs = terragruntAffectedDiffArgs(options);
  const diff = await exec(git, diffArgs, { cwd: options.dir, env: {} });
  if (diff.code !== 0) throw new TerragruntError(`\`${git} ${diffArgs.join(" ")}\` failed (exit ${diff.code}): ${diff.stderr.trim()}`);
  const findArgs = terragruntAffectedFindArgs(options);
  const found = await exec(tg, findArgs, { cwd: options.dir, env: terragruntEnv(options.binary) });
  if (found.code !== 0) throw new TerragruntError(`\`${tg} ${findArgs.join(" ")}\` failed (exit ${found.code}): ${found.stderr.trim()}`);
  let selected: string[];
  try {
    selected = parseTerragruntFind(found.stdout).map((u) => u.path);
  } catch (err) {
    throw new TerragruntError(`could not read \`terragrunt find\` output: ${err instanceof Error ? err.message : String(err)}`);
  }
  const units = options.units ?? (await discoverTerragruntUnits(options)).units;
  return terragruntAffected({
    dir: options.dir,
    units,
    terragruntSelected: selected,
    changedFiles: diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
  });
}

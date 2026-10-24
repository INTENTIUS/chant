/**
 * What the dbt readers share (#3932, #3935): YAML and line helpers, the
 * `quoting:` rules, and the project's `model-paths`.
 */

import { posix } from "node:path";
import type { KindReadGap } from "./kind-link-readers";
import { joinPath, skippedDir, type WorkspaceTree } from "./tree";

export const DBT_PROJECT_FILE = "dbt_project.yml";
export const DEFAULT_MODEL_PATHS = ["models"];

/** The dialects whose naming the reader follows; the member's `dialect` field picks one. */
export const DBT_DIALECTS = ["postgres", "clickhouse"] as const;
export type Dialect = (typeof DBT_DIALECTS)[number];

export interface Quoting {
  schema: boolean;
  identifier: boolean;
}

export const isTemplated = (v: string) => /\{\{|\{%/.test(v);
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A name as text: a string, or a number or boolean YAML read as one. */
export function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Whether an entry is enabled: `enabled`, or `config.enabled`. A templated value is a gap, and the entry is left out. */
export function readEnabled(entry: Record<string, unknown>, file: string, line: number, where: string, gaps: KindReadGap[]): boolean {
  const config = isObject(entry.config) ? entry.config : {};
  const raw = entry.enabled ?? config.enabled;
  if (raw === undefined || raw === null || raw === true) return true;
  if (raw === false) return false;
  gaps.push({ file, line, message: `${where}: enabled is ${JSON.stringify(raw)}, which chant does not render; it was not read` });
  return false;
}

/** `base` with a `quoting:` block's schema and identifier applied. A value that isn't a boolean is a gap and keeps the base. */
export function readQuoting(base: Quoting, raw: unknown, file: string, line: number, where: string, gaps: KindReadGap[]): Quoting {
  if (raw === undefined || raw === null) return base;
  if (!isObject(raw)) {
    gaps.push({ file, line, message: `${where} is not a mapping; the quoting above it applies` });
    return base;
  }
  const out = { ...base };
  for (const key of ["schema", "identifier"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[key] = v;
    else gaps.push({ file, line, message: `${where}.${key} is ${JSON.stringify(v)}, not true or false; the quoting above it applies` });
  }
  return out;
}

/** Every `.yml` and `.yaml` file under tree-relative directory `dir`, skipping dot directories and node_modules. */
export function yamlFiles(tree: WorkspaceTree, dir: string): string[] {
  if (dir !== "" && tree.stat(dir) !== "dir") return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of tree.list(at) ?? []) {
      const path = joinPath(at, e.name);
      if (e.type === "dir") {
        if (!skippedDir(e.name)) walk(path);
      } else if (/\.ya?ml$/.test(e.name)) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

export function lines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The line (from 1) of top-level key `key`, or 1. */
export function keyLine(fileLines: string[], key: string): number {
  const re = new RegExp(`^${escapeRegExp(key)}\\s*:`);
  const i = fileLines.findIndex((l) => re.test(l));
  return i < 0 ? 1 : i + 1;
}

/**
 * The line of the first `name: <value>` entry after line `from`, or `from`
 * itself. Sources, tables and columns are listed in file order, so
 * searching on from the parent's line finds each one's own line. A file in
 * flow style has no such lines, and its entries are reported at the parent.
 */
export function nameLine(fileLines: string[], value: string | undefined, from: number): number {
  return value === undefined ? from : valueLineOf(fileLines, "name", value, from);
}

/** The line of the first `<key>:` after line `from`, or `from`. */
export function valueLine(fileLines: string[], key: string, from: number): number {
  const re = new RegExp(`^\\s*(?:-\\s+)?${escapeRegExp(key)}\\s*:`);
  for (let i = Math.max(from, 0); i < fileLines.length; i++) if (re.test(fileLines[i])) return i + 1;
  return from;
}

export function valueLineOf(fileLines: string[], key: string, value: string, from: number): number {
  const re = new RegExp(`^\\s*(?:-\\s+)?${escapeRegExp(key)}\\s*:\\s*(["']?)${escapeRegExp(value)}\\1\\s*(?:#.*)?$`);
  for (let i = Math.max(from, 0); i < fileLines.length; i++) if (re.test(fileLines[i])) return i + 1;
  return from;
}

#!/usr/bin/env tsx
/**
 * Writes packages/core/src/floor-table.data.ts, the table of every floor a
 * product may feature-detect on (#4792), from the floor constants under
 * packages/core/src.
 *
 *   npx tsx scripts/floor-table.ts           write the table
 *   npx tsx scripts/floor-table.ts --check   fail when the committed table is stale
 *
 * A floor is each `export const <NAME>_FLOOR = "<version>" | NEXT_RELEASE |
 * <OTHER>_FLOOR;` in a non-test source file, the set scripts/release-floors.ts
 * checks. Each row has the floor's name, its version (`NEXT_RELEASE` itself
 * while the floor is unreleased, so the row moves with the constant), the
 * first sentence of its doc comment as what it gates, the issue the comment
 * names, the file, and the `@intentius/chant` subpaths a product can import
 * it from. scripts/release-floors.ts runs `--check`'s comparison, and
 * `--freeze` writes the table again after it writes the floors as literals.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

export const TABLE_FILE = "packages/core/src/floor-table.data.ts";
const SRC = "packages/core/src/";
const DECL_RE = /export const ([A-Z0-9_]+_FLOOR) = (?:"(\d+\.\d+\.\d+)"|(NEXT_RELEASE)|([A-Z0-9_]+_FLOOR));/g;

/** One floor as the table lists it. `version` is a literal, or "NEXT_RELEASE" for the constant. */
export interface FloorRow {
  name: string;
  version: string;
  gates: string;
  issue?: string;
  file: string;
  modules: string[];
}

/** The doc comment that ends right before `at` in `src`, as one line of text, or "". */
export function docBefore(src: string, at: number): string {
  const before = src.slice(0, at).replace(/\s+$/, "");
  if (!before.endsWith("*/")) return "";
  const open = before.lastIndexOf("/**");
  if (open === -1) return "";
  return before
    .slice(open + 3, -2)
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join(" ")
    .replace(/\{@link\s+([^}\s]+)\s*\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The issue a floor's comment names: the first reference in its last
 * parenthesis that holds one (`(#4787)`, `(terragucci issue 1303)`), else the
 * first anywhere in it. chant issues are written `#N`.
 */
export function issueOf(doc: string): string | undefined {
  const ref = /(?:chant)?#(\d+)|([a-z][a-z-]*) issue (\d+)/g;
  const first = (text: string): string | undefined => {
    const m = new RegExp(ref.source).exec(text);
    if (!m) return undefined;
    return m[1] ? `#${m[1]}` : `${m[2]} issue ${m[3]}`;
  };
  const groups = [...doc.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]).filter((g) => first(g) !== undefined);
  return groups.length > 0 ? first(groups[groups.length - 1]) : first(doc);
}

/** The first sentence of a doc comment: up to a full stop that ends the sentence, outside backticks. */
export function firstSentence(doc: string): string {
  let tick = false;
  for (let i = 0; i < doc.length; i++) {
    if (doc[i] === "`") tick = !tick;
    else if (!tick && doc[i] === "." && (i === doc.length - 1 || doc[i + 1] === " ")) return doc.slice(0, i + 1);
  }
  return doc;
}

/**
 * The subpaths of `@intentius/chant` that serve each source file: its own
 * (`./*` serves every file under src), each named entry of the package's
 * exports, and each other file, whose module re-exports it with `export *` or
 * by name.
 */
export function modulesOf(files: string[], read: (file: string) => string, exportsMap: Record<string, unknown>): Map<string, Map<string, Set<string> | "all">> {
  // entry subpath -> its source file
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(exportsMap)) {
    if (key.includes("*")) continue;
    const target = typeof value === "string" ? value : (value as Record<string, unknown>).default;
    if (typeof target !== "string" || !target.startsWith("./src/") || !target.endsWith(".ts")) continue;
    entries.set(key === "." ? "@intentius/chant" : `@intentius/chant/${key.slice(2)}`, `packages/core/${target.slice(2)}`);
  }
  // `./*` serves every source file at its own subpath.
  for (const f of files) if (!f.endsWith(".test.ts")) entries.set(ownModule(f), f);
  const known = new Set(files);
  const resolveFrom = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.js$/, "");
    for (const c of [`${base}.ts`, `${base}/index.ts`]) if (known.has(c)) return c;
    return undefined;
  };
  // file -> (entry -> names it re-exports, or all)
  const out = new Map<string, Map<string, Set<string> | "all">>();
  const add = (file: string, entry: string, names: Set<string> | "all") => {
    const m = out.get(file) ?? new Map<string, Set<string> | "all">();
    const had = m.get(entry);
    if (had === "all" || names === "all") m.set(entry, "all");
    else m.set(entry, new Set([...(had ?? []), ...names]));
    out.set(file, m);
  };
  for (const [entry, entryFile] of entries) {
    const seen = new Set<string>();
    const walk = (file: string, names: Set<string> | "all") => {
      const key = `${file}|${names === "all" ? "*" : [...names].sort().join(",")}`;
      if (seen.has(key) || !known.has(file)) return;
      seen.add(key);
      add(file, entry, names);
      const src = read(file);
      for (const m of src.matchAll(/^export \* from "([^"]+)";/gm)) {
        const to = resolveFrom(file, m[1]);
        if (to) walk(to, names);
      }
      for (const m of src.matchAll(/^export \{([^}]*)\} from "([^"]+)";/gm)) {
        const to = resolveFrom(file, m[2]);
        if (!to) continue;
        const listed = new Set(
          m[1]
            .split(",")
            .map((s) => s.trim().replace(/^type\s+/, ""))
            .filter((s) => /_FLOOR$/.test(s) && !s.includes(" as ")),
        );
        const passed = names === "all" ? listed : new Set([...listed].filter((n) => names.has(n)));
        if (passed.size > 0) walk(to, passed);
      }
    };
    walk(entryFile, "all");
  }
  return out;
}

/** The subpath `./*` serves a source file at. */
function ownModule(file: string): string {
  return `@intentius/chant/${file.slice(SRC.length).replace(/\.ts$/, "")}`;
}

/** Every floor under packages/core/src, in file order, as rows. */
export function floorRows(files: string[], readFile: (file: string) => string, exportsMap: Record<string, unknown>): FloorRow[] {
  const cache = new Map<string, string>();
  const read = (f: string): string => {
    let src = cache.get(f);
    if (src === undefined) cache.set(f, (src = readFile(f)));
    return src;
  };
  const sources = files.filter((f) => f.startsWith(SRC) && f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== TABLE_FILE);
  const reach = modulesOf(sources, read, exportsMap);
  const raw: (FloorRow & { alias?: string })[] = [];
  for (const file of sources) {
    const src = read(file);
    for (const m of src.matchAll(DECL_RE)) {
      const doc = docBefore(src, m.index!);
      const issue = issueOf(doc);
      const entries = [...(reach.get(file) ?? new Map()).entries()].filter(([, names]) => names === "all" || names.has(m[1])).map(([e]) => e);
      const modules = [...new Set([ownModule(file), ...entries])].sort();
      raw.push({ name: m[1], version: m[2] ?? (m[3] ? "NEXT_RELEASE" : ""), alias: m[4], gates: firstSentence(doc), ...(issue ? { issue } : {}), file, modules });
    }
  }
  return raw.map(({ alias, ...row }) => {
    if (!alias) return row;
    const to = raw.find((r) => r.name === alias && !r.alias);
    if (!to) throw new Error(`${row.file}: ${row.name} is ${alias}, which no file declares with a version`);
    return { ...row, version: to.version };
  });
}

/** The table module's text. */
export function renderTable(rows: FloorRow[]): string {
  const lines = rows.map((r) => {
    const version = r.version === "NEXT_RELEASE" ? "NEXT_RELEASE" : JSON.stringify(r.version);
    const issue = r.issue ? `, issue: ${JSON.stringify(r.issue)}` : "";
    return `  { name: ${JSON.stringify(r.name)}, version: ${version}, gates: ${JSON.stringify(r.gates)}${issue}, file: ${JSON.stringify(r.file.slice(SRC.length))}, modules: ${JSON.stringify(r.modules)} },`;
  });
  return [
    "// Written by scripts/floor-table.ts (#4792) from the floor constants under",
    "// packages/core/src; run `npx tsx scripts/floor-table.ts` after adding one.",
    "// scripts/release-floors.ts fails while this file is stale.",
    'import { NEXT_RELEASE } from "./release-floors";',
    'import type { FloorRow } from "./floor-table";',
    "",
    "export const FLOOR_ROWS: readonly FloorRow[] = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The table the floors at `rev` (or in the working tree) make, and the
 * committed one, for a check. Files come from `git ls-files`, and from the
 * working tree's untracked ones too, so a floor in a file not yet added counts.
 */
export function tableAgainst(root: string, rev?: string): { want: string; have: string | undefined } {
  const read = rev ? (f: string) => git(root, ["show", `${rev}:${f}`]) : (f: string) => readFileSync(join(root, f), "utf-8");
  const files = rev
    ? git(root, ["ls-tree", "-r", "--name-only", rev, "--", "packages/core/src"]).split("\n")
    : git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/core/src"]).split("\n");
  const exportsMap = (JSON.parse(read("packages/core/package.json")) as { exports: Record<string, unknown> }).exports;
  const want = renderTable(floorRows(files.filter(Boolean), read, exportsMap));
  let have: string | undefined;
  try {
    have = read(TABLE_FILE);
  } catch {
    have = undefined;
  }
  return { want, have };
}

/** Write the table in the working tree; true when it changed. */
export function writeTable(root: string): boolean {
  const { want, have } = tableAgainst(root);
  if (want === have) return false;
  writeFileSync(join(root, TABLE_FILE), want);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(process.argv[1]), encoding: "utf-8" }).trim();
  if (process.argv.includes("--check")) {
    const { want, have } = tableAgainst(root);
    if (want !== have) {
      console.error(`${TABLE_FILE} is stale; run npx tsx scripts/floor-table.ts`);
      process.exit(1);
    }
    console.log(`${TABLE_FILE} lists every floor`);
  } else {
    console.log(writeTable(root) ? `wrote ${TABLE_FILE}` : `${TABLE_FILE} is current`);
  }
}

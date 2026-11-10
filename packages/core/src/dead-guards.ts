/**
 * `@intentius/chant/dead-guards` (#4792): find each feature-detect in a
 * product's source whose chant floor the product's pin already meets.
 *
 * A product that runs on several chant releases checks for a part before it
 * calls it, and keeps a fallback for a chant without it. Once the product
 * pins a chant that has the part, the check always passes and the fallback is
 * dead code that still gets tested and kept. `chant dev dead-guards` reads
 * the pin from the product's package.json files, scans the product's source
 * and fails naming every such check, so the product deletes it.
 *
 * What counts as a feature-detect on a floor, from the table in
 * ./floor-table.ts:
 *
 * - `floor`: a floor's name read off a module the product did not import
 *   statically (`m.CI_CHECK_HOOK_FLOOR`, `typeof m.X_FLOOR === "string"`), in
 *   a string (`exportsAll(spec, ["OP_WAVE_STAND_DOWN_FLOOR"])`), as a member
 *   of a type the product writes out for a lazily loaded chant module
 *   (`CI_CONTROL_FLOOR: string;`), or destructured from a dynamic import. A
 *   floor the file imports statically is the product using the part, so it
 *   is not a check.
 * - `module`: a chant subpath loaded with `import()` where a `catch` is near
 *   (`try { await import(specifier) } catch { return undefined }`, or
 *   `.catch(`), the shape of a chant-next.ts loader. Its floor is the lowest
 *   floor the subpath serves: a chant with that floor has the subpath.
 * - `product-floor`: a product's own constant for the chant it needs,
 *   `const CHANT_CI_FLOOR = "0.124.67"`, whose checks the pin meets.
 *
 * A line holding `chant-dead-guards: keep`, or below a comment line that
 * does, is left out: a check kept on purpose, such as one for a chant a user
 * installs beside the product.
 *
 * This module imports only Node's own modules and the floor table.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { compareChantVersions, FLOOR_TABLE, type FloorRow } from "./floor-table";

/** One feature-detect the pin meets. */
export interface DeadGuard {
  /** The file, relative to the product's directory, with `/` separators. */
  file: string;
  /** The line, from 1. */
  line: number;
  kind: "floor" | "module" | "product-floor";
  /** The floor's name, or the subpath for `module`. */
  floor: string;
  /** The floor's version. */
  version: string;
  /** The chant pin that meets it. */
  pin: string;
  /** The line's text, trimmed. */
  text: string;
}

export interface DeadGuardsOptions {
  /** The product's root. */
  productDir: string;
  /** Check every file against this chant version, in place of the package.json pins. */
  chant?: string;
  /** The floor table; chant's own by default. */
  table?: readonly FloorRow[];
}

export interface DeadGuardsResult {
  ok: boolean;
  /** Each check the pin meets, by file and line. */
  dead: DeadGuard[];
  /** Each check the pin does not meet yet, the same shape, with `pin` the pin that falls short. */
  live: DeadGuard[];
  /** Each package.json with a chant pin and the version it pins at least. */
  pins: { file: string; pin: string }[];
  /** The number of source files read. */
  files: number;
  /** Source files with no chant pin above them, which no check was made in. */
  unpinned: string[];
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "test", "tests", "__tests__", "__fixtures__", "fixtures"]);
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(?:test|spec|e2e\.test)\.[cm]?[jt]sx?$/;
const CHANT_DEPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const KEEP = "chant-dead-guards: keep";

/** The lowest version a chant range admits: `^0.124.78` is 0.124.78. Undefined for `workspace:`, `file:` and the like. */
export function pinOf(range: string): string | undefined {
  const r = range.trim();
  if (/^(?:workspace|file|link|git|github|https?):/.test(r)) return undefined;
  return /(\d+\.\d+\.\d+)/.exec(r)?.[1];
}

/** The `@intentius/chant` range a package.json names, if any. */
function chantRange(file: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const k of CHANT_DEPS) {
      const v = pkg[k]?.["@intentius/chant"];
      if (typeof v === "string") return v;
    }
  } catch {
    // not JSON; no pin
  }
  return undefined;
}

/** The product's source files, relative, skipping dependencies, builds, tests and hidden directories. */
export function productSources(productDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const at = join(dir, name);
      let st;
      try {
        st = statSync(at);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(at);
      } else if (SOURCE.test(name) && !NOT_SOURCE.test(name)) {
        out.push(relative(productDir, at).split(sep).join("/"));
      }
    }
  };
  walk(productDir);
  return out;
}

/**
 * `src` with every comment blanked to spaces (line breaks kept), and a mask
 * of which characters sit inside a string or template literal's text.
 */
export function scanSource(src: string): { code: string; inString: Uint8Array } {
  const out = src.split("");
  const inString = new Uint8Array(src.length);
  // Each open template literal's brace depth at its `${`.
  const templates: number[] = [];
  let depth = 0;
  let prev = ""; // the last significant character outside strings and comments
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const quoted = (q: string) => {
    const start = i++;
    while (i < src.length && src[i] !== q && src[i] !== "\n") {
      if (src[i] === "\\") i++;
      i++;
    }
    for (let k = start + 1; k < i && k < src.length; k++) inString[k] = 1;
    i++;
  };
  // Template text from i (just past "`" or "}") to the closing "`" or a "${".
  const templateText = () => {
    const start = i;
    while (i < src.length) {
      if (src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src[i] === "`") {
        for (let k = start; k < i; k++) inString[k] = 1;
        i++;
        return;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        for (let k = start; k < i; k++) inString[k] = 1;
        i += 2;
        templates.push(depth);
        depth++;
        return;
      }
      i++;
    }
    for (let k = start; k < src.length; k++) inString[k] = 1;
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const to = end === -1 ? src.length : end;
      blank(i, to);
      i = to;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === '"' || c === "'") {
      quoted(c);
      prev = "a";
    } else if (c === "`") {
      i++;
      templateText();
      prev = "a";
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      // A regular expression literal.
      i++;
      let cls = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) break;
        i++;
      }
      i++;
      prev = "a";
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop();
          i++;
          templateText();
          prev = "a";
          continue;
        }
      }
      if (!/\s/.test(c)) prev = /[A-Za-z0-9_$)\]]/.test(c) ? "a" : c;
      i++;
    }
  }
  return { code: out.join(""), inString };
}

/** The line of each offset, from 1. */
function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Whether `offset` in `code` (comments blanked) sits inside a `try { ... }`
 * block that has a `catch`: an open brace before it, not yet closed, that
 * follows `try`, and whose block is followed by `catch`. A `try` with only
 * `finally` catches nothing. Braces in strings count too, which a template
 * literal can throw off; the check is a heuristic, and
 * `chant-dead-guards: keep` covers a miss.
 */
export function insideTry(code: string, offset: number): boolean {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const c = code[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth > 0) depth--;
      else if (/\btry\s*$/.test(code.slice(Math.max(0, i - 8), i))) {
        let open = 0;
        for (let j = i; j < code.length; j++) {
          if (code[j] === "{") open++;
          else if (code[j] === "}" && --open === 0) {
            if (/^\s*catch\b/.test(code.slice(j + 1, j + 24))) return true;
            break;
          }
        }
      }
    }
  }
  return false;
}

/** One finding in one file, before the pin is applied. */
export interface Guard {
  line: number;
  kind: DeadGuard["kind"];
  floor: string;
  version: string;
}

/**
 * The feature-detects on a floor in one source file. `table` gives each
 * floor's version; a name two files declare takes the higher one.
 */
export function guardsIn(src: string, table: readonly FloorRow[] = FLOOR_TABLE): Guard[] {
  const floors = new Map<string, string>();
  for (const r of table) {
    const had = floors.get(r.name);
    if (had === undefined || compareChantVersions(r.version, had) > 0) floors.set(r.name, r.version);
  }
  // The lowest floor each subpath serves.
  const modules = new Map<string, string>();
  for (const r of table) {
    for (const m of r.modules) {
      const had = modules.get(m);
      if (had === undefined || compareChantVersions(r.version, had) < 0) modules.set(m, r.version);
    }
  }
  const { code, inString } = scanSource(src);
  const codeLines = code.split("\n");
  const starts = lineStarts(src);
  const lines = src.split("\n");
  const out: Guard[] = [];
  const seen = new Set<string>();
  const push = (offset: number, kind: Guard["kind"], floor: string, version: string) => {
    const line = lineAt(starts, offset);
    const key = `${line}|${kind}|${floor}`;
    if (seen.has(key)) return;
    if (lines[line - 1]?.includes(KEEP) || /^\s*(?:\/\/|\/?\*).*chant-dead-guards: keep/.test(lines[line - 2] ?? "")) return;
    seen.add(key);
    out.push({ line, kind, floor, version });
  };

  // Names bound by a static import or re-export, from anywhere: using one is
  // using the part. And the spans of those statements, which hold no check.
  const imported = new Set<string>();
  const statements: [number, number][] = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])[^"'\n]*\2/g)) {
    statements.push([m.index!, m.index! + m[0].length]);
    if (!m[0].startsWith("import")) continue;
    for (const part of m[1].split(",")) {
      const local = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (local) imported.add(local);
    }
  }
  const inStatement = (at: number) => statements.some(([a, b]) => at >= a && at < b);
  // `import * as chant from "@intentius/chant/x"`: `chant.X_FLOOR` is a use too.
  const namespaces = new Set([...code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["']/g)].map((m) => m[1]));
  const declared = new Set([...code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]*_FLOOR)\b/g)].map((m) => m[1]));

  // floor: a table name read off a module, in a string, as a type member, or destructured.
  for (const m of code.matchAll(/\b[A-Z][A-Z0-9_]*_FLOOR\b/g)) {
    const at = m.index!;
    const name = m[0];
    const version = floors.get(name);
    if (version === undefined || inStatement(at)) continue;
    if (inString[at]) {
      // A name in a string is a check when the line asks a module for it:
      // names a chant subpath or an import(), `"X_FLOOR" in m`, `m["X_FLOOR"]`.
      const text = codeLines[lineAt(starts, at) - 1] ?? "";
      if (/@intentius\/chant|\bimport\(|["'`]\s+in\s+[A-Za-z_$]/.test(text) || /[\w$\])]\s*\[\s*$/.test(code.slice(Math.max(0, at - 24), at - 1))) push(at, "floor", name, version);
      continue;
    }
    const owner = /([A-Za-z_$][\w$]*)\s*\??\.\s*$/.exec(code.slice(Math.max(0, at - 64), at));
    if (owner || /\.\s*$/.test(code.slice(Math.max(0, at - 2), at))) {
      if (!owner || !namespaces.has(owner[1])) push(at, "floor", name, version);
      continue;
    }
    if (imported.has(name) || declared.has(name)) continue;
    push(at, "floor", name, version);
  }

  // module: a chant subpath loaded with import() inside a try, or with .catch( on the load.
  for (const m of src.matchAll(/(["'`])(@intentius\/chant(?:\/[A-Za-z0-9_./-]+)?)\1/g)) {
    const at = m.index!;
    const spec = m[2];
    const version = modules.get(spec);
    if (version === undefined || inStatement(at) || !inString[at + 1]) continue;
    const end = at + m[0].length;
    let site: number | undefined;
    if (/\bimport\(\s*$/.test(code.slice(Math.max(0, at - 16), at))) {
      if (/typeof\s+import\(\s*$/.test(code.slice(Math.max(0, at - 24), at))) continue;
      site = at;
    } else {
      // `const specifier = "<subpath>"`, then `import(specifier)` below.
      const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*$/.exec(code.slice(Math.max(0, at - 64), at));
      if (!bound) continue;
      const call = new RegExp(`\\bimport\\(\\s*${bound[1].replace(/\$/g, "\\$")}\\s*\\)`).exec(code.slice(end, end + 2000));
      if (!call) continue;
      site = end + call.index;
    }
    const after = code.slice(site, site + 400);
    const caught = /^[^;\n]*?\)\s*\.catch\(/.test(after) || insideTry(code, site);
    if (caught) push(at, "module", spec, version);
  }

  // product-floor: the product's own constant for the chant it needs.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Z0-9_]*CHANT[A-Z0-9_]*_FLOOR)\s*(?::\s*string\s*)?=\s*/g)) {
    const at = m.index! + m[0].length;
    const lit = /^(["'])(\d+\.\d+\.\d+)\1/.exec(src.slice(at, at + 24));
    if (lit) push(m.index!, "product-floor", m[1], lit[2]);
  }
  return out.sort((a, b) => a.line - b.line || a.floor.localeCompare(b.floor));
}

/** The chant pin over `file` (relative to `productDir`): the nearest package.json with one, up to the product's root. */
function pinFor(productDir: string, file: string, cache: Map<string, string | undefined | null>): { pin?: string; manifest?: string } {
  for (let dir = dirname(join(productDir, file)); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    let range = cache.get(manifest);
    if (range === undefined) {
      range = existsSync(manifest) ? (chantRange(manifest) ?? null) : null;
      cache.set(manifest, range);
    }
    if (range !== null) return { pin: pinOf(range), manifest };
    if (relative(productDir, dir) === "" || dir === dirname(dir)) return {};
  }
}

/**
 * Every feature-detect in the product at `productDir` and whether its pin
 * meets it. `ok` is false when one does.
 */
export function findDeadGuards(options: DeadGuardsOptions): DeadGuardsResult {
  const { productDir, chant } = options;
  const table = options.table ?? FLOOR_TABLE;
  const files = productSources(productDir);
  const cache = new Map<string, string | undefined | null>();
  const pins = new Map<string, string>();
  const dead: DeadGuard[] = [];
  const live: DeadGuard[] = [];
  const unpinned: string[] = [];
  for (const file of files) {
    const at = pinFor(productDir, file, cache);
    const pin = chant ?? at.pin;
    if (at.manifest && at.pin) pins.set(relative(productDir, at.manifest).split(sep).join("/"), at.pin);
    if (pin === undefined) {
      unpinned.push(file);
      continue;
    }
    const src = readFileSync(join(productDir, file), "utf8");
    const lines = src.split("\n");
    for (const g of guardsIn(src, table)) {
      const row: DeadGuard = { file, ...g, pin, text: (lines[g.line - 1] ?? "").trim() };
      (compareChantVersions(pin, g.version) >= 0 ? dead : live).push(row);
    }
  }
  return { ok: dead.length === 0, dead, live, pins: [...pins].map(([file, pin]) => ({ file, pin })).sort((a, b) => a.file.localeCompare(b.file)), files: files.length, unpinned };
}

/** One dead guard as a line: `file:line: ...`. */
export function deadGuardLine(g: DeadGuard): string {
  const what = g.kind === "module" ? `loads ${g.floor} behind a catch` : g.kind === "product-floor" ? `declares ${g.floor}` : `checks ${g.floor}`;
  return `${g.file}:${g.line}: ${what}, which chant ${g.version} has; the pin ${g.pin} meets it`;
}

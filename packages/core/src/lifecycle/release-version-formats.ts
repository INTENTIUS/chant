/**
 * Stamping the release's label into manifests other than package.json (#5156).
 *
 * `release.version.files` names the files, each with a format chant knows
 * (Cargo.toml, Cargo.lock, pyproject.toml, Chart.yaml, an MCP server.json,
 * a krew plugin manifest, artifacthub-pkg.yml), a field path in a JSON, YAML
 * or TOML file, or a regular expression. Every stamp is an edit in place:
 * the file is scanned for the scalars it holds and only the text of the
 * version scalars changes, so comments, key order, quoting and layout stay
 * as committed. Nothing is parsed into a document and written back.
 *
 * The scanners below read the subset of each syntax a manifest uses: JSON
 * in full, TOML in full but for multi-line inline tables, and YAML's block
 * style (maps, sequences, plain and quoted scalars, block scalars skipped).
 * A YAML flow collection is skipped, so a version inside one is reached
 * with a `pattern` instead.
 *
 * This module reaches only Node's built-ins.
 */

import { posix } from "node:path";

/** The manifest formats chant stamps by name. */
export const MANIFEST_FORMATS = ["cargo", "cargo-lock", "pyproject", "helm", "mcp-server", "krew", "artifacthub"] as const;
export type ManifestFormat = (typeof MANIFEST_FORMATS)[number];

/** A file whose format chant knows, by name or from its file name. */
export interface ManifestFile {
  path: string;
  /** Default from the file name: `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `Chart.yaml`, `server.json`, `artifacthub-pkg.yml`. A krew manifest names `krew`. */
  format?: ManifestFormat;
  /** `helm` and `artifacthub`: stamp `appVersion` too. */
  appVersion?: boolean;
  /** `cargo-lock`: the crates whose entries take the label. Default every crate of the Cargo workspace (an entry with no `source`). */
  crates?: string[];
}

/** A field in a JSON, YAML or TOML file, by its dotted path: `version`, `spec.version`, `packages[].version`. */
export interface FieldFile {
  path: string;
  field: string;
  /** Written before the label, such as `v`. */
  prefix?: string;
}

/** A regular expression: each capture group of every match takes the label. */
export interface PatternFile {
  path: string;
  pattern: string;
  /** Written before the label, such as `v`. */
  prefix?: string;
}

export type ReleaseVersionFile = string | ManifestFile | FieldFile | PatternFile;

export class ManifestStampError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ManifestStampError";
  }
}

const BY_NAME: Record<string, ManifestFormat> = {
  "Cargo.toml": "cargo",
  "Cargo.lock": "cargo-lock",
  "pyproject.toml": "pyproject",
  "Chart.yaml": "helm",
  "server.json": "mcp-server",
  "artifacthub-pkg.yml": "artifacthub",
  "artifacthub-pkg.yaml": "artifacthub",
};

/** The path a `files` entry names. */
export function versionFilePath(entry: ReleaseVersionFile): string {
  return typeof entry === "string" ? entry : entry.path;
}

type Resolved = { kind: "manifest"; format: ManifestFormat; entry: ManifestFile } | { kind: "field"; entry: FieldFile; syntax: Syntax } | { kind: "pattern"; entry: PatternFile; re: RegExp };

type Syntax = "json" | "yaml" | "toml";

function syntaxOf(path: string): Syntax | null {
  const ext = posix.extname(path).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".toml" || posix.basename(path) === "Cargo.lock") return "toml";
  return null;
}

/** What an entry stamps, checked: a format known by name, a field in a file whose syntax the extension gives, or a pattern with a capture group. */
export function resolveVersionFile(entry: ReleaseVersionFile): Resolved {
  const path = versionFilePath(entry);
  if (typeof entry === "string" || (!("field" in entry) && !("pattern" in entry))) {
    const e: ManifestFile = typeof entry === "string" ? { path } : entry;
    const format = e.format ?? BY_NAME[posix.basename(path)];
    if (!format) {
      throw new ManifestStampError(
        "release-version-format-unknown",
        `release.version.files: chant can't tell what ${path} is from its name`,
        `Name its format, one of ${MANIFEST_FORMATS.join(", ")} ({ path: "${path}", format: "krew" }), or the field to stamp ({ path: "${path}", field: "version" }), or a pattern ({ path: "${path}", pattern: "version = \\"([^\\"]+)\\"" }).`,
      );
    }
    if (!(MANIFEST_FORMATS as readonly string[]).includes(format)) throw new ManifestStampError("release-version-invalid", `release.version.files: ${path} has format "${String(format)}", not one of ${MANIFEST_FORMATS.join(", ")}`);
    return { kind: "manifest", format, entry: e };
  }
  if ("field" in entry) {
    const syntax = syntaxOf(path);
    if (!syntax) throw new ManifestStampError("release-version-format-unknown", `release.version.files: ${path} names a field, and chant reads fields only in .json, .yaml, .yml and .toml files`, `Stamp it with a pattern: { path: "${path}", pattern: "..." }.`);
    if (parseField(entry.field).length === 0) throw new ManifestStampError("release-version-invalid", `release.version.files: ${path} names an empty field`);
    return { kind: "field", entry, syntax };
  }
  let re: RegExp;
  try {
    re = new RegExp(entry.pattern, "gm");
  } catch (err) {
    throw new ManifestStampError("release-version-invalid", `release.version.files: the pattern for ${path} is not a regular expression: ${(err as Error).message}`);
  }
  if (new RegExp(`${entry.pattern}|`).exec("")!.length < 2) {
    throw new ManifestStampError("release-version-invalid", `release.version.files: the pattern for ${path} has no capture group, so nothing in it names where the label goes`, `Put the version in parentheses: "version: ([0-9.]+)".`);
  }
  return { kind: "pattern", entry, re };
}

/* ------------------------------------------------------------------ */
/* Scalars: a value in a file, by its path, with where its text sits.  */
/* ------------------------------------------------------------------ */

/** A scalar's path: keys, and `[n]` for the nth item of a list. */
type Path = string[];

interface Scalar {
  path: Path;
  /** The value's text, without quotes. */
  value: string;
  start: number;
  end: number;
  /** A string (quoted, or a YAML plain scalar), not a number, boolean or null. */
  string: boolean;
}

/** `a.b[].c` to `["a", "b", "[]", "c"]`. */
function parseField(field: string): Path {
  const out: Path = [];
  for (const part of field.split(".")) {
    const m = /^([^[\]]*)((?:\[\])*)$/.exec(part);
    if (!m) return [];
    if (m[1]) out.push(m[1]);
    for (let i = 0; i < m[2]!.length / 2; i++) out.push("[]");
  }
  return out;
}

const isItem = (s: string): boolean => /^\[\d+\]$/.test(s);

/** Does a scalar's path match a pattern, where `[]` matches any item? */
function matches(path: Path, pattern: Path): boolean {
  return path.length === pattern.length && pattern.every((p, i) => (p === "[]" ? isItem(path[i]!) : p === path[i]));
}

/* JSON ------------------------------------------------------------- */

function jsonScalars(text: string): Scalar[] {
  JSON.parse(text);
  const out: Scalar[] = [];
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): { value: string; start: number; end: number } => {
    const start = i + 1;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    const end = i;
    i++;
    return { value: JSON.parse(text.slice(start - 1, end + 1)) as string, start, end };
  };
  const value = (path: Path): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") return void i++;
      for (;;) {
        ws();
        const key = str().value;
        ws();
        i++; // :
        value([...path, key]);
        ws();
        if (text[i++] === "}") return;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") return void i++;
      for (let n = 0; ; n++) {
        value([...path, `[${n}]`]);
        ws();
        if (text[i++] === "]") return;
      }
    }
    if (c === '"') {
      const s = str();
      out.push({ path, ...s, string: true });
      return;
    }
    const start = i;
    while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++;
    out.push({ path, value: text.slice(start, i), start, end: i, string: false });
  };
  value([]);
  return out;
}

/* TOML ------------------------------------------------------------- */

const BARE = /[A-Za-z0-9_-]+/y;

function tomlScalars(text: string): Scalar[] {
  const out: Scalar[] = [];
  const counts = new Map<string, number>();
  let i = 0;
  const fail = (what: string): never => {
    const line = text.slice(0, i).split("\n").length;
    throw new SyntaxError(`${what} on line ${line}`);
  };
  /** Spaces, tabs, and with `nl` newlines and comments. */
  const ws = (nl: boolean): void => {
    for (;;) {
      while (i < text.length && (text[i] === " " || text[i] === "\t" || (nl && (text[i] === "\n" || text[i] === "\r")))) i++;
      if (nl && text[i] === "#") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      return;
    }
  };
  const quoted = (): { value: string; start: number; end: number } => {
    const q = text[i]!;
    const triple = text.startsWith(q.repeat(3), i);
    const open = triple ? 3 : 1;
    const start = i + open;
    i = start;
    if (triple) {
      const close = text.indexOf(q.repeat(3), i);
      if (close < 0) fail("an unclosed string");
      let end = close;
      while (text[end + 3] === q) end++; // up to two quotes may end the content
      i = end + 3;
      return { value: text.slice(start, end), start, end };
    }
    while (i < text.length && text[i] !== q && text[i] !== "\n") i += q === '"' && text[i] === "\\" ? 2 : 1;
    if (text[i] !== q) fail("an unclosed string");
    const end = i;
    i++;
    return { value: q === '"' ? (JSON.parse(`"${text.slice(start, end)}"`) as string) : text.slice(start, end), start, end };
  };
  const key = (): Path => {
    const parts: Path = [];
    for (;;) {
      ws(false);
      if (text[i] === '"' || text[i] === "'") parts.push(quoted().value);
      else {
        BARE.lastIndex = i;
        const m = BARE.exec(text);
        if (!m) fail("a key was expected");
        parts.push(m![0]);
        i += m![0].length;
      }
      ws(false);
      if (text[i] !== ".") return parts;
      i++;
    }
  };
  const value = (path: Path): void => {
    ws(false);
    const c = text[i];
    if (c === '"' || c === "'") {
      out.push({ path, ...quoted(), string: true });
      return;
    }
    if (c === "[") {
      i++;
      for (let n = 0; ; n++) {
        ws(true);
        if (text[i] === "]") return void i++;
        value([...path, `[${n}]`]);
        ws(true);
        if (text[i] === ",") i++;
      }
    }
    if (c === "{") {
      i++;
      for (;;) {
        ws(true);
        if (text[i] === "}") return void i++;
        const k = key();
        if (text[i] !== "=") fail("= was expected");
        i++;
        value([...path, ...k]);
        ws(true);
        if (text[i] === ",") i++;
      }
    }
    const start = i;
    while (i < text.length && !/[\s,\]}#]/.test(text[i]!)) i++;
    if (i === start) fail("a value was expected");
    out.push({ path, value: text.slice(start, i), start, end: i, string: false });
  };
  let table: Path = [];
  for (;;) {
    ws(true);
    if (i >= text.length) return out;
    if (text.startsWith("[[", i)) {
      i += 2;
      const k = key();
      if (!text.startsWith("]]", i)) fail("]] was expected");
      i += 2;
      const id = k.join("\0");
      const n = counts.get(id) ?? 0;
      counts.set(id, n + 1);
      table = [...k, `[${n}]`];
    } else if (text[i] === "[") {
      i++;
      table = key();
      if (text[i] !== "]") fail("] was expected");
      i++;
    } else {
      const k = key();
      if (text[i] !== "=") fail("= was expected");
      i++;
      value([...table, ...k]);
    }
  }
}

/* YAML (block style) ----------------------------------------------- */

function yamlScalars(text: string): Scalar[] {
  const out: Scalar[] = [];
  const stack: Array<{ indent: number; seg: string; item: boolean }> = [];
  const counts = new Map<string, number>();
  let blockAbove: number | null = null;
  let offset = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, "");
    const indent = /^ */.exec(line)![0].length;
    const body = line.slice(indent);
    if (blockAbove !== null) {
      if (body === "" || indent > blockAbove) continue;
      blockAbove = null;
    }
    if (body === "" || body.startsWith("#") || body === "---" || body === "...") continue;
    let col = indent;
    let rest = body;
    let keyIndent = indent;
    while (/^-( |$)/.test(rest)) {
      while (stack.length && (stack[stack.length - 1]!.indent > col || (stack[stack.length - 1]!.indent === col && stack[stack.length - 1]!.item))) stack.pop();
      const parent = stack.map((s) => s.seg).join("\0");
      const n = counts.get(`${parent}\0@${col}`) ?? 0;
      counts.set(`${parent}\0@${col}`, n + 1);
      stack.push({ indent: col, seg: `[${n}]`, item: true });
      const step = /^-( +|$)/.exec(rest)![0].length;
      col += step;
      rest = rest.slice(step);
      keyIndent = col;
    }
    if (rest === "") continue;
    const km = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[][^:#]*?)\s*:(?: +|$)/.exec(rest);
    if (!km) {
      // A scalar list item: "- value".
      if (stack[stack.length - 1]?.item && stack[stack.length - 1]!.indent < keyIndent) pushValue(stack.map((s) => s.seg), rest, lineStart + keyIndent);
      continue;
    }
    while (stack.length && stack[stack.length - 1]!.indent >= keyIndent) stack.pop();
    const k = km[1]!.startsWith('"') ? (JSON.parse(km[1]!) as string) : km[1]!.startsWith("'") ? km[1]!.slice(1, -1).replace(/''/g, "'") : km[1]!;
    stack.push({ indent: keyIndent, seg: k, item: false });
    const after = rest.slice(km[0].length);
    const valueAt = lineStart + keyIndent + km[0].length;
    if (after === "" || after.startsWith("#")) continue;
    if (/^[|>]/.test(after)) {
      blockAbove = keyIndent;
      continue;
    }
    pushValue(stack.map((s) => s.seg), after, valueAt);
  }
  return out;

  function pushValue(path: Path, v: string, at: number): void {
    if (/^[{[&*!]/.test(v)) return;
    if (v.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
      if (m) out.push({ path, value: JSON.parse(m[0]) as string, start: at + 1, end: at + 1 + m[1]!.length, string: true });
      return;
    }
    if (v.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'/.exec(v);
      if (m) out.push({ path, value: m[1]!.replace(/''/g, "'"), start: at + 1, end: at + 1 + m[1]!.length, string: true });
      return;
    }
    const plain = v.replace(/\s+#.*$/, "").trimEnd();
    out.push({ path, value: plain, start: at, end: at + plain.length, string: !/^(true|false|null|~|[-+]?\d+(\.\d+)?)$/.test(plain) });
  }
}

function scalars(syntax: Syntax, text: string, file: string): Scalar[] {
  try {
    return syntax === "json" ? jsonScalars(text) : syntax === "toml" ? tomlScalars(text) : yamlScalars(text);
  } catch (err) {
    throw new ManifestStampError("release-version-invalid", `${file} is not ${syntax.toUpperCase()} chant can read: ${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Stamping                                                            */
/* ------------------------------------------------------------------ */

interface Edit {
  start: number;
  end: number;
  text: string;
}

function apply(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const find = (all: Scalar[], field: string): Scalar[] => all.filter((s) => matches(s.path, parseField(field)));

const set = (s: Scalar, text: string): Edit => ({ start: s.start, end: s.end, text });

function noField(file: string, what: string, fix?: string): ManifestStampError {
  return new ManifestStampError("release-version-no-field", `${file} has no ${what} to stamp`, fix);
}

/** A Cargo version requirement with its operator kept: `=0.1.0` to `=1.4.0`. A requirement of several comparators or a wildcard is left. */
function cargoRequirement(req: string, label: string): string | null {
  const m = /^(\s*(?:=|\^|~|>=)?\s*)(\d[^,*\s]*)\s*$/.exec(req);
  return m ? `${m[1]}${label}` : null;
}

const DEP_TABLES = new Set(["dependencies", "dev-dependencies", "build-dependencies"]);

/** The dependency a Cargo.toml scalar belongs to: its table's path and the crate's name, or null. */
function depOf(path: Path): { at: string; field: string } | null {
  // [dependencies] foo = { ... }, [workspace.dependencies], [target.'cfg(..)'.dependencies], and [dependencies.foo] tables.
  for (let d = 0; d < path.length - 2; d++) {
    if (!DEP_TABLES.has(path[d]!)) continue;
    const scope = path.slice(0, d);
    const ok = scope.length === 0 || (scope.length === 1 && scope[0] === "workspace") || (scope.length === 2 && scope[0] === "target");
    if (ok && path.length === d + 3) return { at: path.slice(0, d + 2).join("\0"), field: path[d + 2]! };
  }
  return null;
}

function stampCargo(text: string, label: string, file: string): string {
  const all = scalars("toml", text, file);
  const edits: Edit[] = [];
  for (const field of ["package.version", "workspace.package.version"]) for (const s of find(all, field)) if (s.string) edits.push(set(s, label));
  const inherits = all.some((s) => matches(s.path, ["package", "version", "workspace"]));
  if (edits.length === 0 && !inherits) throw noField(file, "[package] version or [workspace.package] version", "Give the crate a version, or name the workspace's Cargo.toml, whose [workspace.package] version its crates inherit.");
  // A path dependency inside the member carries a version requirement cargo checks against the crate at that path.
  const fileDir = posix.dirname(file);
  const deps = new Map<string, { path?: Scalar; version?: Scalar }>();
  for (const s of all) {
    const d = depOf(s.path);
    if (!d || (d.field !== "path" && d.field !== "version") || !s.string) continue;
    const e = deps.get(d.at) ?? {};
    e[d.field] = s;
    deps.set(d.at, e);
  }
  for (const { path, version } of deps.values()) {
    if (!path || !version) continue;
    const target = posix.normalize(posix.join(fileDir, path.value));
    if (target === ".." || target.startsWith("../") || posix.isAbsolute(path.value)) continue;
    const req = cargoRequirement(version.value, label);
    if (req !== null) edits.push(set(version, req));
  }
  return apply(text, edits);
}

function stampCargoLock(text: string, label: string, file: string, crates?: readonly string[]): string {
  const all = scalars("toml", text, file);
  const items = new Map<string, { name?: Scalar; version?: Scalar; source?: Scalar }>();
  for (const s of all) {
    if (s.path.length !== 3 || s.path[0] !== "package" || !isItem(s.path[1]!)) continue;
    const f = s.path[2]!;
    if (f !== "name" && f !== "version" && f !== "source") continue;
    const e = items.get(s.path[1]!) ?? {};
    e[f] = s;
    items.set(s.path[1]!, e);
  }
  const edits: Edit[] = [];
  for (const { name, version, source } of items.values()) {
    if (!name || !version) continue;
    if (crates ? crates.includes(name.value) : !source) edits.push(set(version, label));
  }
  if (edits.length === 0) throw noField(file, crates ? `entry for ${crates.join(", ")}` : "crate of the workspace (an entry with no source)");
  return apply(text, edits);
}

function stampPyproject(text: string, label: string, file: string): string {
  const all = scalars("toml", text, file);
  const edits = [...find(all, "project.version"), ...find(all, "tool.poetry.version")].filter((s) => s.string).map((s) => set(s, label));
  if (edits.length === 0) {
    const dynamic = find(all, "project.dynamic[]").some((s) => s.value === "version");
    throw noField(file, "[project] version or [tool.poetry] version", dynamic ? "The version is dynamic: stamp the file the build backend reads it from, with a pattern." : undefined);
  }
  return apply(text, edits);
}

function stampYamlTop(text: string, label: string, file: string, appVersion: boolean): string {
  const all = scalars("yaml", text, file);
  const version = find(all, "version");
  if (version.length === 0) throw noField(file, "top-level version");
  const edits = version.map((s) => set(s, label));
  if (appVersion) {
    const app = find(all, "appVersion");
    if (app.length === 0) throw noField(file, "appVersion", "Add appVersion to the file, or leave appVersion out of its release.version.files entry.");
    edits.push(...app.map((s) => set(s, label)));
  }
  return apply(text, edits);
}

function stampMcpServer(text: string, label: string, file: string): string {
  const all = scalars("json", text, file);
  const top = find(all, "version").filter((s) => s.string);
  if (top.length === 0) throw noField(file, "top-level version");
  return apply(text, [...top, ...find(all, "packages[].version").filter((s) => s.string)].map((s) => set(s, label)));
}

/** krew wants `v` and the version; each platform's `uri` names the committed version, which follows. */
function stampKrew(text: string, label: string, file: string): string {
  const all = scalars("yaml", text, file);
  const version = find(all, "spec.version");
  if (version.length === 0) throw noField(file, "spec.version");
  const was = version[0]!.value.replace(/^v/, "");
  const edits = version.map((s) => set(s, `v${label}`));
  if (was) for (const uri of find(all, "spec.platforms[].uri")) if (uri.value.includes(was)) edits.push(set(uri, uri.value.split(was).join(label)));
  return apply(text, edits);
}

function stampField(text: string, label: string, file: string, syntax: Syntax, entry: FieldFile): string {
  const found = find(scalars(syntax, text, file), entry.field);
  if (found.length === 0) throw noField(file, `field ${entry.field}`);
  const notString = found.find((s) => !s.string);
  if (notString) throw new ManifestStampError("release-version-invalid", `${file}: ${entry.field} is ${notString.value}, not a string, so a version can't take its place`);
  return apply(text, found.map((s) => set(s, `${entry.prefix ?? ""}${label}`)));
}

function stampPattern(text: string, label: string, file: string, re: RegExp, prefix: string): string {
  const edits: Edit[] = [];
  for (const m of text.matchAll(new RegExp(re.source, "gmd"))) {
    for (const span of (m as RegExpMatchArray & { indices: Array<[number, number] | undefined> }).indices.slice(1)) {
      if (span) edits.push({ start: span[0], end: span[1], text: `${prefix}${label}` });
    }
  }
  if (edits.length === 0) throw noField(file, `match for the pattern ${re.source}`);
  return apply(text, edits);
}

/** One `files` entry's file, given its text, stamped with `label`. `file` is the path relative to the member. */
export function stampVersionFile(entry: ReleaseVersionFile, text: string, label: string): string {
  const r = resolveVersionFile(entry);
  const file = posix.normalize(versionFilePath(entry));
  if (r.kind === "field") return stampField(text, label, file, r.syntax, r.entry);
  if (r.kind === "pattern") return stampPattern(text, label, file, r.re, r.entry.prefix ?? "");
  switch (r.format) {
    case "cargo":
      return stampCargo(text, label, file);
    case "cargo-lock":
      return stampCargoLock(text, label, file, r.entry.crates);
    case "pyproject":
      return stampPyproject(text, label, file);
    case "helm":
    case "artifacthub":
      return stampYamlTop(text, label, file, r.entry.appVersion === true);
    case "mcp-server":
      return stampMcpServer(text, label, file);
    case "krew":
      return stampKrew(text, label, file);
  }
}

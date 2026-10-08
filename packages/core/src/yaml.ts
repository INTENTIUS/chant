/**
 * YAML emitter and parser.
 *
 * The emitter writes the block-style YAML chant's serializers produce. The
 * parser is a vendored js-yaml loader with chant's schema (#3006): YAML 1.2 core types,
 * merge keys, `yes`/`no` booleans, and local tags such as `!reference` read
 * as strings. `splitYAMLDocuments` splits a multi-document stream. Input the
 * parser cannot read throws a `YAMLParseError` naming the line.
 */

import {
  FLOAT_TYPE,
  INT_TYPE,
  load,
  MAP_TYPE,
  NULL_TYPE,
  SEQ_TYPE,
  STR_TYPE,
  YAMLException,
} from "./vendor/js-yaml-load";

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/**
 * Emit a YAML value with proper indentation.
 *
 * - Primitives render inline.
 * - Arrays and objects render as block YAML, returning a string that starts
 *   with `\n` so the caller can append it after a key.
 * - Tagged values `{ tag, value }` emit `!tag [...]` or `!tag scalar`.
 */
/**
 * An object's entries minus those whose value is `undefined`. An `undefined`
 * property is "not supplied" in TypeScript (a declared-but-unset optional
 * build parameter, `{ x: cond ? v : undefined }`), which `JSON.stringify`
 * already omits; the YAML emitter must agree, or the same source ships
 * `key: null` under `-o out.yaml` and no key at all under `-o out.json`. An
 * explicit `null` is a value and is kept (chant #1371).
 */
function definedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).filter(([, val]) => val !== undefined);
}

export function emitYAML(value: unknown, indent: number): string {
  const prefix = "  ".repeat(indent);

  // `undefined` only reaches here as a top-level value or an array element —
  // an object entry whose value is `undefined` is dropped below, the same way
  // `JSON.stringify` omits it. A bare `undefined` renders as `null` for the
  // same reason `JSON.stringify([undefined])` is `[null]`: YAML has no way to
  // say "absent" in a sequence slot.
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    // Multiline strings use YAML literal block scalar (|)
    if (value.includes("\n")) {
      const lines = value.split("\n");
      // Trim trailing empty line if present (common for template strings)
      const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
      return "|\n" + trimmed.map((l) => `${prefix}${l}`).join("\n");
    }
    // Quote strings that could be misinterpreted
    if (
      value === "" ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      value === "yes" ||
      value === "no" ||
      value.includes(": ") ||
      value.includes("#") ||
      value.startsWith("*") ||
      value.startsWith("&") ||
      value.startsWith("!") ||
      value.startsWith("{") ||
      value.startsWith("[") ||
      value.startsWith("'") ||
      value.startsWith('"') ||
      value.startsWith("$") ||
      /^\d/.test(value) ||
      // What a YAML parser reads as something other than this string: an
      // indicator that cannot start a plain scalar, a trailing colon, edge
      // whitespace, a signed or dotted number, and the other spellings of
      // booleans, null and the float constants (#3006).
      /^[-?:](?:\s|$)|^[,\]}|>%@`]|:$|^\s|\s$|^[-+.]\d/.test(value) ||
      /^(?:true|false|null|~|yes|no|[-+]?\.(?:inf|nan))$/i.test(value)
    ) {
      // Use single quotes, escaping internal single quotes
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Object items in arrays
        const entries = definedEntries(item as Record<string, unknown>);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          const firstEmitted = emitYAML(firstVal, indent + 2);
          if (firstEmitted.startsWith("\n")) {
            lines.push(`${prefix}- ${firstKey}:${firstEmitted}`);
          } else {
            lines.push(`${prefix}- ${firstKey}: ${firstEmitted}`);
          }
          for (let i = 1; i < entries.length; i++) {
            const [key, val] = entries[i];
            const emitted = emitYAML(val, indent + 2);
            if (emitted.startsWith("\n")) {
              lines.push(`${prefix}  ${key}:${emitted}`);
            } else {
              lines.push(`${prefix}  ${key}: ${emitted}`);
            }
          }
        } else {
          // An empty mapping is still an item: `egress: [{}]` allows all
          // egress, and dropping it leaves an empty list.
          lines.push(`${prefix}- {}`);
        }
      } else {
        lines.push(`${prefix}- ${emitYAML(item, indent + 1).trimStart()}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;

    // Handle tagged values (e.g. { tag: "!reference", value: [...] })
    if ("tag" in obj && "value" in obj && typeof obj.tag === "string") {
      if (Array.isArray(obj.value)) {
        return `${obj.tag} [${(obj.value as unknown[]).map(String).join(", ")}]`;
      }
      return `${obj.tag} ${emitYAML(obj.value, indent)}`;
    }

    const entries = definedEntries(obj);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [key, val] of entries) {
      const emitted = emitYAML(val, indent + 1);
      if (emitted.startsWith("\n")) {
        lines.push(`${prefix}${key}:${emitted}`);
      } else {
        lines.push(`${prefix}${key}: ${emitted}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  return String(value);
}

/**
 * `key: value` at column `indent * 2`, for a serializer that writes a
 * document key by key. A block value follows the colon on the next line; an
 * inline one (a scalar, `{}`, `[]`) needs a space after the colon, or
 * `jobs:{}` is the plain scalar "jobs:{}" rather than a key (#3006).
 */
export function emitYAMLEntry(key: string, value: unknown, indent = 0): string {
  const emitted = emitYAML(value, indent + 1);
  return `${"  ".repeat(indent)}${key}:${emitted.startsWith("\n") ? "" : " "}${emitted}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * A document the parser cannot read. Its message and `line` name the line,
 * so `chant import` can report "YAML line N: ..." instead of a stack trace.
 */
export class YAMLParseError extends Error {
  /** 1-based line number within the text handed to the parser. */
  readonly line: number;

  constructor(line: number, message: string) {
    super(`YAML line ${line}: ${message}`);
    this.name = "YAMLParseError";
    this.line = line;
  }
}

/** A document start (`---`) or end (`...`) marker, optionally followed by a comment. */
const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:[ \t]+#.*)?[ \t]*$/;

/**
 * Booleans as YAML 1.2's core schema reads them, plus `yes` and `no`, which
 * this parser has always read as booleans and its callers expect.
 */
const BOOL = {
  tag: "tag:yaml.org,2002:bool",
  kind: "scalar",
  resolve: (data: string | null) => data !== null && /^(?:true|True|TRUE|false|False|FALSE|yes|no)$/.test(data),
  construct: (data: string) => /^(?:true|True|TRUE|yes)$/.test(data),
};

/** A tagged value written back as text, the way it appeared: `!reference [.base, script]`. */
function flowText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flowText).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([k, v]) => `${k}: ${flowText(v)}`).join(", ")}}`;
  }
  return String(value);
}

/**
 * Local tags (`!reference`, `!Ref`, `!GetAtt`) on a scalar or a sequence read
 * as the string `"<tag> <value>"`, as they always have: GitLab CI's
 * `!reference [.base, script]` is the string `"!reference [.base, script]"`.
 * A tag on a mapping has no such form and is an error.
 */
const TAGGED_SCALAR = {
  tag: "!",
  kind: "scalar",
  multi: true,
  construct: (data: string | null, tag?: string) => (data === null || data === "" ? tag : `${tag} ${data}`),
};
const TAGGED_SEQUENCE = {
  tag: "!",
  kind: "sequence",
  multi: true,
  construct: (data: unknown[] | null, tag?: string) => `${tag} ${flowText(data ?? [])}`,
};

/** The merge key `<<`, as js-yaml's own merge type reads it. */
const MERGE = {
  tag: "tag:yaml.org,2002:merge",
  kind: "scalar",
  resolve: (data: string | null) => data === "<<" || data === null,
};

/**
 * YAML 1.2's core schema (no timestamps, so a date stays a string) with merge
 * keys, `yes`/`no` booleans and local tags read as strings.
 */
const SCHEMA = {
  implicit: [NULL_TYPE, BOOL, INT_TYPE, FLOAT_TYPE, MERGE],
  explicit: [STR_TYPE, SEQ_TYPE, MAP_TYPE, TAGGED_SCALAR, TAGGED_SEQUENCE],
};

/**
 * Give every alias its own copy of the anchored value. js-yaml shares one
 * object between an anchor and its aliases, so a caller editing the alias
 * would edit the anchor too.
 */
function unshareAliases(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return unshareAliases(structuredClone(value), seen);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = unshareAliases(value[i], seen);
  } else {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) obj[key] = unshareAliases(obj[key], seen);
  }
  return value;
}

/**
 * The 1-based line to report for a js-yaml error. js-yaml marks where it
 * gave up, which for a stray line of text above a key is the key's line:
 * `a: 1\njust text\nb: 2` fails at `b: 2`, reading `just text b` as one
 * multiline key. Report the line where that key starts instead, the text
 * that is not a key.
 */
function errorLine(lines: string[], err: YAMLException): number {
  let line = err.mark?.line ?? 0;
  if (/multiline key may not be an implicit key/.test(err.reason)) {
    const indent = lines[line]?.search(/\S/) ?? -1;
    for (let k = line - 1; k >= 0; k--) {
      const prev = lines[k];
      if (prev.trim() === "" || prev.trim().startsWith("#")) continue;
      if (prev.search(/\S/) !== indent || /:(?:\s|$)/.test(prev) || /^\s*-(?:\s|$)/.test(prev)) break;
      line = k;
    }
  }
  return line + 1;
}

/**
 * Read one YAML document with js-yaml (#3006).
 *
 * Kept from the line parser this replaced: `---` and `...` lines are skipped
 * (so a stream reads as one document, as it always has), duplicate keys take
 * the last value, and a document that is not a mapping or a sequence is a
 * {@link YAMLParseError}, as is anything js-yaml rejects. An empty document is
 * `{}`.
 */
function loadDocument(content: string): unknown {
  const text = content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (DOCUMENT_MARKER.test(line) ? "" : line))
    .join("\n");
  let value: unknown;
  try {
    value = load(text, SCHEMA);
  } catch (err) {
    if (!(err instanceof YAMLException)) throw err;
    const line = errorLine(text.split("\n"), err);
    const tag = err.reason.match(/^unknown tag !<(![^>]*)>/)?.[1];
    throw new YAMLParseError(line, tag ? `the tag ${JSON.stringify(tag)} on a mapping is not supported` : err.reason);
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") {
    const line = text.split("\n").findIndex((l) => l.trim() !== "" && !l.trim().startsWith("#")) + 1;
    throw new YAMLParseError(line, `expected a mapping or a sequence, found the scalar ${JSON.stringify(value)}`);
  }
  return /[&]/.test(text) ? unshareAliases(value) : value;
}

/**
 * Parse a YAML document (or JSON document) into a plain object.
 *
 * Tries `JSON.parse` first, then js-yaml (#3006). A top-level sequence reads
 * as `{}`, since callers rely on getting a mapping back; use
 * {@link parseYAMLDocument} for the list. Throws {@link YAMLParseError} with
 * the line number on input it cannot read.
 */
export function parseYAML(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }
  const value = loadDocument(content);
  return Array.isArray(value) ? {} : (value as Record<string, unknown>);
}

/**
 * Parse one YAML (or JSON) document whose top level may be a sequence
 * (#2965). {@link parseYAML} returns `{}` for a file like `- a\n- b`; this
 * returns the list.
 */
export function parseYAMLDocument(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }
  return loadDocument(content);
}

/**
 * Split a YAML stream into its documents (#2965). A line holding only `---`
 * starts a document and a line holding only `...` ends one; either may carry
 * a trailing `# comment`. Documents that are empty or hold only comments are
 * dropped. The text of each document is returned unparsed, with `\r\n`
 * normalized to `\n`.
 */
export function splitYAMLDocuments(content: string): string[] {
  const documents: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join("\n");
    if (text.replace(/#[^\n]*/g, "").trim() !== "") documents.push(text);
    current = [];
  };
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (DOCUMENT_MARKER.test(line)) flush();
    else current.push(line);
  }
  flush();
  return documents;
}

/**
 * Coerce a scalar string to a typed value.
 */
export function parseScalar(value: string): unknown {
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  // Quoted scalars carry escapes, and stripping the quotes is only half the
  // job: a double-quoted `\n` is a newline, a single-quoted `''` is one
  // quote. Dropping that step leaves the escape sequence in the value as
  // literal characters, which is how a multiline `setup_script` reached a
  // shell as one line of `set -e\nsudo ...` (#1860).
  if (value.length >= 2) {
    if (value.startsWith('"') && value.endsWith('"')) {
      const unescaped = unescapeDoubleQuoted(value.slice(1, -1));
      // `null` means the body held a bare `"`, so this was never a single
      // well-formed scalar (`"a" + "b"`). Keep the old behaviour there.
      return unescaped ?? value.slice(1, -1);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
  }
  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;
  return value;
}

/** YAML double-quoted escapes, per the spec's escape table. */
const DQ_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: "\u2028",
  P: "\u2029",
};

/**
 * Decode the body of a double-quoted YAML scalar.
 *
 * Returns `null` when the body holds an unescaped `"`, which means the caller
 * was not looking at one quoted scalar after all.
 */
function unescapeDoubleQuoted(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') return null;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const esc = body[++i];
    if (esc === undefined) return null;
    // \xXX, \uXXXX, \UXXXXXXXX
    const width = esc === "x" ? 2 : esc === "u" ? 4 : esc === "U" ? 8 : 0;
    if (width > 0) {
      const hex = body.slice(i + 1, i + 1 + width);
      if (hex.length < width || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      out += String.fromCodePoint(parseInt(hex, 16));
      i += width;
      continue;
    }
    // An escaped line break is a line continuation: it and the following
    // indentation fold away to nothing.
    if (esc === "\n") {
      while (body[i + 1] === " " || body[i + 1] === "\t") i++;
      continue;
    }
    const mapped = DQ_ESCAPES[esc];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

/**
 * Lightweight YAML emitter and parser.
 *
 * Covers the subset of YAML used by Chant lexicons (scalars, block arrays,
 * nested objects, block scalars, tagged values, anchors, aliases and merge
 * keys). Not a full YAML implementation: flow collections are read only when
 * they are JSON. `splitYAMLDocuments` splits a multi-document stream. The
 * parser throws a `YAMLParseError` on a line it cannot place instead of
 * dropping it (#2991).
 */

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
      /^\d/.test(value)
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

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Result of parsing a YAML block. */
export interface ParseResult {
  value: unknown;
  endIndex: number;
}

/**
 * Input the parser cannot place (#2991). The parser used to skip such a line,
 * or read it as a key of whatever mapping was open at the top level, so a
 * mis-indented or unsupported construct came back as a quietly different
 * document. Now it is an error naming the line.
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

/**
 * A mapping key: a double-quoted or single-quoted scalar, which may hold a
 * colon, or a plain run of text up to the first colon.
 */
const KEY = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:"'][^:]*?)`;

/**
 * `key: value` on a line of its own (`KEY_LINE`, capturing the indent) and the
 * same after a sequence item's `- ` (`ITEM_KEY`).
 *
 * The lookahead is the rule both patterns used to miss: a `:` opens a mapping
 * only when what follows it is whitespace or the end of the line, and a plain
 * scalar may carry any other colon (YAML 1.2 §7.4.2). Written as `:\s*`, which
 * matches zero whitespace, EVERY colon opened one — so a bare URL in a
 * sequence,
 *
 *     sourceRepos:
 *     - https://github.com/INTENTIUS/behold
 *
 * came back as `{ https: "//github.com/INTENTIUS/behold" }`, and the CRD-schema
 * post-synth check (#1372) re-reading emitted YAML reported the string list
 * this file's own emitter had just written as a list of objects (#2013). By the
 * same rule `- key:value` is the scalar `"key:value"`, not a mapping.
 */
const KEY_LINE = new RegExp(String.raw`^(\s*)${KEY}:(?=\s|$)\s*(.*)$`);
const ITEM_KEY = new RegExp(String.raw`^${KEY}:(?=\s|$)\s*(.*)$`);

/**
 * A block sequence entry: `- value`, or a dash alone on its line whose value
 * is the block below it. `-1` and `---` are not entries.
 */
const SEQ_ENTRY = /^(\s*)-(?:([ \t]+)(.*))?$/;

/** A document start (`---`) or end (`...`) marker, optionally followed by a comment. */
const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:[ \t]+#.*)?[ \t]*$/;

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** The first line at or after `from` that holds content, or `lines.length`. */
function nextContentLine(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && isBlankOrComment(lines[i])) i++;
  return i;
}

function indentOf(line: string): number {
  return line.search(/\S/);
}

function isSeqEntry(line: string): boolean {
  return SEQ_ENTRY.test(line);
}

/** A key as written, with the quotes and escapes of a quoted key removed. */
function keyName(raw: string): string {
  const key = raw.trim();
  return key.startsWith('"') || key.startsWith("'") ? String(parseScalar(key)) : key;
}

/**
 * Split text into lines for the parser: `\r\n` and `\r` become `\n`, and a
 * document marker becomes a blank line. `parseYAML` has always read a
 * `---`-led file (a compose file, a GitLab CI file) by skipping the marker;
 * that is kept, now that a line the parser cannot place is an error.
 */
function toLines(content: string): string[] {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (DOCUMENT_MARKER.test(line) ? "" : line));
}

/**
 * Parse a whole document with `parse`, starting at its first content line
 * `first`, and require it to account for every line (#2991). The recursive
 * parsers stop at a line they cannot place and hand it back to their caller;
 * one that reaches the top is unplaceable, and throws.
 */
function parseWhole(
  lines: string[],
  first: number,
  parse: (lines: string[], startIndex: number, baseIndent: number) => ParseResult,
): unknown {
  const outer = anchors;
  anchors = new Map();
  try {
    const result = parse(lines, first, indentOf(lines[first]));
    const rest = nextContentLine(lines, result.endIndex);
    if (rest < lines.length) {
      throw new YAMLParseError(
        rest + 1,
        `cannot place ${JSON.stringify(lines[rest].trim())} at column ${indentOf(lines[rest]) + 1}; ` +
          "check its indentation, or the construct is one this parser does not read",
      );
    }
    return result.value;
  } finally {
    anchors = outer;
  }
}

/**
 * The anchors (`&name`) seen so far in the document being parsed, for its
 * aliases (`*name`) and merge keys (`<<: *name`). GitLab CI templates and
 * Alertmanager configs use all three; before #2991 an anchored block was
 * hoisted into its parent and an alias read as the string `"*name"`.
 * `parseWhole` gives each document its own map.
 */
let anchors = new Map<string, unknown>();

const ANCHOR = /^&([^\s,[\]{}]+)(?:[ \t]+(.*))?$/;
const ALIAS = /^\*([^\s,[\]{}]+)(?:[ \t]+#.*)?$/;
/** A flow sequence of aliases, the usual way to merge several anchors: `<<: [*a, *b]`. */
const ALIAS_LIST = /^\[\s*\*[^\s,[\]{}]+(?:\s*,\s*\*[^\s,[\]{}]+)*\s*\](?:[ \t]+#.*)?$/;

function resolveAlias(name: string, line: number): unknown {
  if (!anchors.has(name)) throw new YAMLParseError(line, `the alias *${name} has no anchor &${name} before it`);
  return structuredClone(anchors.get(name));
}

/** The merge key: its value's mappings fill in the keys a mapping does not set itself. */
const MERGE_KEY = "<<";

/**
 * Set `key` on a mapping under construction. A merge key's sources are held
 * in `merges` and applied by {@link applyMerges} once the mapping is
 * complete, because a key the mapping sets itself wins wherever it appears.
 */
function setKey(obj: Record<string, unknown>, merges: unknown[], key: string, value: unknown): void {
  if (key === MERGE_KEY) merges.push(...(Array.isArray(value) ? value : [value]));
  else obj[key] = value;
}

function applyMerges(obj: Record<string, unknown>, merges: unknown[], line: number): void {
  for (const source of merges) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new YAMLParseError(line, "a merge key (<<) takes a mapping or a list of mappings");
    }
    for (const [k, v] of Object.entries(source)) if (!(k in obj)) obj[k] = v;
  }
}

/**
 * Parse a YAML document (or JSON document) into a plain object.
 *
 * Tries `JSON.parse` first; falls back to a line-based YAML parser that
 * handles the subset of YAML commonly found in CI configuration files. Throws
 * {@link YAMLParseError} on a line it cannot place rather than dropping it.
 */
export function parseYAML(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }

  const lines = toLines(content);
  const first = nextContentLine(lines, 0);
  // A document with no content, or (see parseYAMLDocument) a top-level list,
  // reads as an empty mapping; the callers rely on getting a mapping back.
  if (first === lines.length || isSeqEntry(lines[first])) return {};
  return parseWhole(lines, first, parseYAMLLines) as Record<string, unknown>;
}

/**
 * Parse one YAML (or JSON) document whose top level may be a sequence
 * (#2965). {@link parseYAML} reads only a top-level mapping and returns `{}`
 * for a file like `- a\n- b`; its callers rely on getting a mapping back, so
 * it keeps doing that. This returns the list instead, and otherwise defers to
 * `parseYAML`.
 */
export function parseYAMLDocument(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }

  const lines = toLines(content);
  const first = nextContentLine(lines, 0);
  if (first === lines.length) return {};
  return parseWhole(lines, first, isSeqEntry(lines[first]) ? parseYAMLArray : parseYAMLLines);
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
 * A block-scalar header: `|` (literal, keep newlines) or `>` (folded, newlines →
 * spaces), with a chomping indicator (`-` strip trailing newlines, `+` keep them,
 * default clip to a single one). Returns null when `inline` isn't a block header.
 */
interface BlockScalarHeader {
  style: "literal" | "folded";
  chomp: "clip" | "strip" | "keep";
}
function blockScalarHeader(inline: string): BlockScalarHeader | null {
  const m = inline.match(/^([|>])([+-]?)(?:\s+#.*)?$/);
  if (!m) return null;
  return {
    style: m[1] === "|" ? "literal" : "folded",
    chomp: m[2] === "-" ? "strip" : m[2] === "+" ? "keep" : "clip",
  };
}

/**
 * Parse a block scalar's body — the lines indented past `parentIndent`, dedented
 * by the block's own indent (the first content line's). Handles literal/folded
 * styles and clip/strip/keep chomping, matching js-yaml. Returns the string value
 * and the index of the first line that is NOT part of the block.
 */
function parseBlockScalar(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  header: BlockScalarHeader,
): { value: string; endIndex: number } {
  const raw: string[] = [];
  let blockIndent = -1;
  let i = startIndex;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      raw.push(""); // a blank line is part of the block (kept/chomped later)
      continue;
    }
    const ni = line.search(/\S/);
    if (ni <= parentIndent) break; // dedented out of the block
    if (blockIndent === -1) blockIndent = ni;
    if (ni < blockIndent) break;
    raw.push(line.slice(blockIndent));
  }
  // Trailing blank lines belong to the block (chomping decides their fate).
  let text: string;
  if (header.style === "folded") {
    // Fold each run of non-empty lines into a space-joined paragraph; a run of N
    // blank lines between paragraphs becomes N newlines (a single blank → one
    // newline), matching YAML folded semantics.
    text = "";
    let buf: string[] = [];
    let blankRun = 0;
    let wrote = false;
    const flush = (): void => {
      if (buf.length === 0) return;
      if (wrote) text += "\n".repeat(blankRun);
      text += buf.join(" ");
      buf = [];
      blankRun = 0;
      wrote = true;
    };
    for (const l of raw) {
      if (l === "") { flush(); blankRun++; }
      else buf.push(l);
    }
    flush();
  } else {
    text = raw.join("\n");
  }
  const trailing = text.match(/\n*$/)?.[0].length ?? 0;
  const stripped = text.replace(/\n+$/, "");
  if (header.chomp === "strip") text = stripped;
  else if (header.chomp === "keep") text = stripped + "\n".repeat(Math.max(trailing, raw.length > 0 ? 1 : 0));
  else text = stripped === "" ? "" : stripped + "\n"; // clip
  return { value: text, endIndex: i };
}

/**
 * Parse indentation-based YAML lines into a key-value object: the mapping
 * whose keys sit at column `baseIndent`, starting at `startIndex`.
 *
 * It ends at the first line that is not one of its keys: a line at another
 * column, a sequence entry, or text that is not `key:`. That line goes back
 * to the caller in `endIndex`; if no caller owns it, `parseYAML` reports it
 * (#2991). This function never skips a content line.
 */
export function parseYAMLLines(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseResult {
  const result: Record<string, unknown> = {};
  const merges: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    if (indentOf(line) !== baseIndent || isSeqEntry(line)) break;
    const keyMatch = line.match(KEY_LINE);
    if (!keyMatch) break;
    const value = parseValue(keyMatch[3].trim(), lines, i, baseIndent);
    setKey(result, merges, keyName(keyMatch[2]), value.value);
    i = value.endIndex;
  }
  applyMerges(result, merges, startIndex + 1);

  return { value: result, endIndex: i };
}

/**
 * Parse the value of the key on line `at`, whose text after the colon is
 * `inline` and whose own column is `keyIndent`. Used for mapping keys and for
 * the keys of a sequence item alike.
 *
 * An empty inline value (or only a comment) means the value is the block on
 * the next content line. Blank, whitespace-only and comment lines between the
 * key and that block do not end it (#2991): Helm renders an empty `{{ if }}`
 * as exactly such a line, and treating it as the end of the value turned
 *
 *     spec:
 *
 *       serviceAccountName: collector
 *
 * into `spec: null` with `serviceAccountName` hoisted to the parent.
 *
 * The two nested shapes do NOT share a threshold (#1311), except below a
 * sequence entry (`sequenceAtKeyColumn` false), where a `-` at the entry's
 * own column is the next entry:
 *
 *   - a SEQUENCE may sit at the key's own column (valid YAML, and what
 *     kubectl and Kubernetes manifests emit);
 *   - a MAPPING must be indented past it, otherwise the next line is a
 *     sibling key and this key's value is null:
 *
 *         - name: a
 *           meta:          <- no value
 *           other: b       <- a sibling, NOT meta's content
 */
function parseValue(
  inline: string,
  lines: string[],
  at: number,
  keyIndent: number,
  sequenceAtKeyColumn = true,
): ParseResult {
  const anchor = inline.match(ANCHOR);
  if (anchor) {
    const value = parseValue((anchor[2] ?? "").trim(), lines, at, keyIndent, sequenceAtKeyColumn);
    anchors.set(anchor[1], structuredClone(value.value));
    return value;
  }
  const alias = inline.match(ALIAS);
  if (alias) return { value: resolveAlias(alias[1], at + 1), endIndex: at + 1 };
  if (ALIAS_LIST.test(inline)) {
    const names = [...inline.matchAll(/\*([^\s,[\]{}]+)/g)].map((m) => m[1]);
    return { value: names.map((name) => resolveAlias(name, at + 1)), endIndex: at + 1 };
  }
  if (inline === "" || inline.startsWith("#")) {
    const k = nextContentLine(lines, at + 1);
    if (k < lines.length) {
      const ni = indentOf(lines[k]);
      const nested = isSeqEntry(lines[k]) && sequenceAtKeyColumn ? ni >= keyIndent : ni > keyIndent;
      if (nested) return parseNode(lines, k, keyIndent);
    }
    return { value: null, endIndex: at + 1 };
  }
  if (inline.startsWith("[") || inline.startsWith("{")) {
    // Inline array or object
    try {
      return { value: JSON.parse(inline), endIndex: at + 1 };
    } catch {
      return { value: inline, endIndex: at + 1 };
    }
  }
  const header = blockScalarHeader(inline);
  if (header) return parseBlockScalar(lines, at + 1, keyIndent, header);
  return parseFlowScalar(inline, lines, at + 1, keyIndent);
}

/**
 * Parse the node that starts on content line `k`, below a key or a bare `-`
 * at column `parentIndent`: a sequence, a mapping, or a scalar written on the
 * line after its key.
 */
function parseNode(lines: string[], k: number, parentIndent: number): ParseResult {
  const line = lines[k];
  if (isSeqEntry(line)) return parseYAMLArray(lines, k, indentOf(line));
  if (KEY_LINE.test(line)) return parseYAMLLines(lines, k, indentOf(line));
  return parseValue(line.trim(), lines, k, parentIndent);
}

/**
 * The index of the quote that closes a quoted scalar opened by `quote`,
 * scanning `text` from `from`, or -1. A double-quoted scalar escapes with a
 * backslash, a single-quoted one by doubling the quote.
 */
function closingQuote(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"' && ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Whether `text` is exactly one quoted scalar, e.g. `"80:80"`. */
function isWholeQuotedScalar(text: string): boolean {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return false;
  return closingQuote(text, quote, 1) === text.length - 1;
}

/**
 * Parse a plain or quoted scalar whose first line is `first` and whose
 * continuation lines, if any, start at `from` and are indented past
 * `parentIndent`. YAML lets both kinds span lines, and go-yaml (so Helm's
 * `toYaml`) wraps long strings that way. Lines fold into one: a line break
 * becomes a space, and each blank line in between becomes a newline.
 *
 * These continuation lines used to be skipped, keeping only the first line.
 */
function parseFlowScalar(first: string, lines: string[], from: number, parentIndent: number): ParseResult {
  const quote = first[0];
  if (quote === '"' || quote === "'") {
    if (closingQuote(first, quote, 1) !== -1) return { value: parseScalar(first), endIndex: from };
    return parseMultilineQuoted(first, lines, from, parentIndent, quote);
  }

  let text = first;
  let endIndex = from;
  let blanks = 0;
  for (let j = from; j < lines.length; j++) {
    const line = lines[j];
    const t = line.trim();
    if (t === "") {
      blanks++;
      continue;
    }
    // A comment ends a plain scalar; so does a line back at the parent's column.
    if (t.startsWith("#") || indentOf(line) <= parentIndent) break;
    if (KEY_LINE.test(line)) {
      throw new YAMLParseError(
        j + 1,
        /^!\S*$/.test(first)
          ? `the tag ${JSON.stringify(first)} before a nested block is not supported`
          : `${JSON.stringify(t)} is indented under the value ${JSON.stringify(first)}, ` +
              "and a scalar cannot hold a mapping; check its indentation",
      );
    }
    text += blanks > 0 ? "\n".repeat(blanks) : " ";
    text += t;
    blanks = 0;
    endIndex = j + 1;
  }
  return { value: parseScalar(text), endIndex };
}

/**
 * The rest of a quoted scalar left open on its first line: lines up to the
 * closing quote, folded as {@link parseFlowScalar} describes. For a
 * double-quoted scalar a line ending in `\` is an escaped line break that
 * joins the next line with nothing between; it is kept as `\` + newline for
 * `unescapeDoubleQuoted`, which removes it with the indentation after it.
 */
function parseMultilineQuoted(
  first: string,
  lines: string[],
  from: number,
  parentIndent: number,
  quote: string,
): ParseResult {
  const segments = [first.slice(1)];
  for (let j = from; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() !== "" && indentOf(line) <= parentIndent) break;
    const close = closingQuote(line, quote, 0);
    if (close === -1) {
      segments.push(line);
      continue;
    }
    segments.push(line.slice(0, close));
    let body = "";
    let blanks = 0;
    let escapedBreak = false;
    segments.forEach((raw, n) => {
      const isFirst = n === 0;
      const isLast = n === segments.length - 1;
      let s = raw;
      if (!isFirst && !escapedBreak) s = s.replace(/^[ \t]+/, "");
      const endsEscaped = !isLast && quote === '"' && /(?:^|[^\\])(?:\\\\)*\\$/.test(s);
      if (!isLast && !endsEscaped) s = s.replace(/[ \t]+$/, "");
      if (!isFirst && !isLast && s === "" && !escapedBreak) {
        blanks++;
        return;
      }
      if (!isFirst) body += escapedBreak ? "\n" : blanks > 0 ? "\n".repeat(blanks) : " ";
      body += s;
      blanks = 0;
      escapedBreak = endsEscaped;
    });
    return { value: parseScalar(quote + body + quote), endIndex: j + 1 };
  }
  throw new YAMLParseError(from, `unterminated ${quote === '"' ? "double" : "single"}-quoted scalar`);
}

/**
 * Parse a block array: the `- ` entries at column `baseIndent`, starting at
 * `startIndex`. Like {@link parseYAMLLines} it ends at the first line that is
 * not one of its entries and hands that line back in `endIndex`.
 */
export function parseYAMLArray(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseResult {
  const result: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const itemMatch = line.match(SEQ_ENTRY);
    if (!itemMatch || indentOf(line) !== baseIndent) break;
    const itemValue = (itemMatch[3] ?? "").trim();

    // The column the entry's content starts at, which is where the keys of a
    // mapping entry sit: two past the dash for `- key`, more for `-   key`.
    const keyIndent = baseIndent + 1 + (itemMatch[2]?.length ?? 1);
    // A quoted scalar holding a colon (e.g. "80:80") is not a key-value pair.
    const kvMatch = isWholeQuotedScalar(itemValue) ? null : itemValue.match(ITEM_KEY);
    if (kvMatch) {
      const obj: Record<string, unknown> = {};
      const merges: unknown[] = [];
      const firstValue = parseValue(kvMatch[2].trim(), lines, i, keyIndent);
      setKey(obj, merges, keyName(kvMatch[1]), firstValue.value);
      // The entry's other keys, at the first key's column. Each value's
      // parse reports where it ended, nested block, same-column sequence
      // (#1311) and block scalar (#910) alike.
      let j = firstValue.endIndex;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (isBlankOrComment(nextLine)) {
          j++;
          continue;
        }
        if (indentOf(nextLine) !== keyIndent || isSeqEntry(nextLine)) break;
        const nextKV = nextLine.match(KEY_LINE);
        if (!nextKV) break;
        const value = parseValue(nextKV[3].trim(), lines, j, keyIndent);
        setKey(obj, merges, keyName(nextKV[2]), value.value);
        j = value.endIndex;
      }
      applyMerges(obj, merges, i + 1);
      result.push(obj);
      i = j;
      continue;
    }

    // Anything else is read the way a mapping value is: a scalar, an inline
    // list or object, an anchor or alias, a block scalar, or, for a dash alone
    // on its line (#1286), the block below it after any blank or comment
    // lines, or null. A block scalar's body (`- |`) is indented past the
    // dash's column; before #1482 the header parsed as the literal string "|"
    // and the body lines leaked into whatever came next, hoisting a
    // container's keys after `args:` to the document root.
    const item = parseValue(itemValue, lines, i, baseIndent, false);
    result.push(item.value);
    i = item.endIndex;
  }

  return { value: result, endIndex: i };
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

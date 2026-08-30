/**
 * Lightweight YAML emitter and parser.
 *
 * Covers the subset of YAML used by Chant lexicons (scalars, block arrays,
 * nested objects, tagged values). Not a full YAML implementation — use a
 * dedicated library if you need anchors, multi-document streams, or
 * block scalars.
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
 * Parse a YAML document (or JSON document) into a plain object.
 *
 * Tries `JSON.parse` first; falls back to a line-based YAML parser that
 * handles the subset of YAML commonly found in CI configuration files.
 */
export function parseYAML(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    // Fall through to YAML parsing
  }

  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  return parseYAMLLines(lines, 0, 0).value as Record<string, unknown>;
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
 * Parse indentation-based YAML lines into a key-value object.
 */
export function parseYAMLLines(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseResult {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break; // Dedented — done with this block
    if (indent > baseIndent && startIndex > 0) break; // Unexpected indent

    const keyMatch = line.match(/^(\s*)([^\s:][^:]*?):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[2].trim();
      const inlineValue = keyMatch[3].trim();

      if (inlineValue === "" || inlineValue.startsWith("#")) {
        // Check next line for array or nested object
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const nextIndent = nextLine.search(/\S/);
          if (nextLine.trimStart().startsWith("- ") && nextIndent >= indent) {
            // Same-indent arrays are valid YAML (e.g. controller-gen output):
            //   versions:
            //   - name: v1
            const arr = parseYAMLArray(lines, i + 1, nextIndent);
            result[key] = arr.value;
            i = arr.endIndex;
            continue;
          } else if (nextIndent > indent) {
            const nested = parseYAMLLines(lines, i + 1, nextIndent);
            result[key] = nested.value;
            i = nested.endIndex;
            continue;
          }
        }
        result[key] = null;
        i++;
      } else if (inlineValue.startsWith("[")) {
        // Inline array
        try {
          result[key] = JSON.parse(inlineValue);
        } catch {
          result[key] = inlineValue;
        }
        i++;
      } else if (inlineValue.startsWith("{")) {
        // Inline object
        try {
          result[key] = JSON.parse(inlineValue);
        } catch {
          result[key] = inlineValue;
        }
        i++;
      } else {
        const header = blockScalarHeader(inlineValue);
        if (header) {
          const block = parseBlockScalar(lines, i + 1, indent, header);
          result[key] = block.value;
          i = block.endIndex;
        } else {
          result[key] = parseScalar(inlineValue);
          i++;
        }
      }
    } else if (line.trimStart().startsWith("- ")) {
      break;
    } else {
      i++;
    }
  }

  return { value: result, endIndex: i };
}

/**
 * Parse the value of a key inside an array item.
 * If the inline value is empty, look ahead for a nested object or array.
 */
function parseArrayItemValue(
  inlineValue: string,
  lines: string[],
  currentIndex: number,
  keyIndent: number,
): unknown {
  if (inlineValue !== "" && !inlineValue.startsWith("#")) {
    const header = blockScalarHeader(inlineValue);
    if (header) {
      // Block scalar nested under an array-item key (e.g. `- name: x\n  run: |`).
      // The body is indented past the key's column. On a `- key: |` line the key
      // sits 2 cols past the dash; on its own line it's the line's indent (#910).
      const dash = lines[currentIndex].match(/^(\s*)- /);
      const keyIndent = dash ? dash[1].length + 2 : lines[currentIndex].search(/\S/);
      return parseBlockScalar(lines, currentIndex + 1, keyIndent, header).value;
    }
    if (inlineValue.startsWith("[")) {
      try { return JSON.parse(inlineValue); } catch { return inlineValue; }
    }
    if (inlineValue.startsWith("{")) {
      try { return JSON.parse(inlineValue); } catch { return inlineValue; }
    }
    return parseScalar(inlineValue);
  }
  // Empty inline value — check for a nested block. `keyIndent` is the key's own
  // column, and the two nested shapes do NOT share a threshold (#1311):
  //
  //   - a SEQUENCE may sit at the key's own column (valid YAML, and what
  //     kubectl and Kubernetes manifests emit);
  //   - a MAPPING must be indented past it, otherwise the next line is a
  //     sibling key and this key's value is null:
  //
  //         - name: a
  //           meta:          <- no value
  //           other: b       <- a sibling, NOT meta's content
  //
  // Testing both against `>= keyIndent` would swallow that sibling; testing
  // both against `> keyIndent` loses the same-column sequence.
  const nextIdx = currentIndex + 1;
  if (nextIdx < lines.length) {
    const nextLine = lines[nextIdx];
    if (nextLine.trim() !== "" && !nextLine.trim().startsWith("#")) {
      const ni = nextLine.search(/\S/);
      if (nextLine.trimStart().startsWith("- ")) {
        if (ni >= keyIndent) return parseYAMLArray(lines, nextIdx, ni).value;
      } else if (ni > keyIndent) {
        return parseYAMLLines(lines, nextIdx, ni).value;
      }
    }
  }
  return null;
}

/**
 * Skip past the value block belonging to a key at column `keyIndent` inside a
 * sequence item, returning the first line that is NOT part of it (#1311).
 *
 * Two shapes, and only the first is a matter of indentation:
 *
 *   - a nested MAPPING is indented past its key, so anything further right
 *     belongs to it and anything at the key's own column is a sibling;
 *   - a nested SEQUENCE may sit at the SAME column as its key, which is valid
 *     YAML and what kubectl and Kubernetes manifests both emit:
 *
 *         - name: web
 *           ports:
 *           - containerPort: 80
 *           env:                    <- a sibling, at `ports`' own column
 *
 *     An indent rule cannot separate those, so the sequence is re-parsed to
 *     find where it ends. `parseYAMLArray` already reports that as `endIndex`.
 */
function skipValueBlock(lines: string[], startIndex: number, keyIndent: number): number {
  let k = startIndex;
  while (k < lines.length && (lines[k].trim() === "" || lines[k].trim().startsWith("#"))) k++;
  if (k < lines.length) {
    const ni = lines[k].search(/\S/);
    if (ni >= keyIndent && lines[k].trimStart().startsWith("- ")) {
      return parseYAMLArray(lines, k, ni).endIndex;
    }
  }
  return skipNestedBlock(lines, startIndex, keyIndent + 1);
}

/**
 * Skip past a nested block (object or array) starting at startIndex with the given indent.
 * Returns the index of the first line that is NOT part of the nested block.
 */
function skipNestedBlock(lines: string[], startIndex: number, childIndent: number): number {
  let j = startIndex;
  while (j < lines.length) {
    const l = lines[j];
    if (l.trim() === "" || l.trim().startsWith("#")) { j++; continue; }
    const ni = l.search(/\S/);
    if (ni < childIndent) break;
    j++;
  }
  return j;
}

/**
 * Parse a block array (lines starting with `- `).
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
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < baseIndent) break;

    const itemMatch = line.match(/^(\s*)- (.*)$/);
    if (itemMatch && indent === baseIndent) {
      const itemValue = itemMatch[2].trim();
      // Check if it's a key-value pair (object item in array).
      // Skip quoted scalars — a quoted string containing a colon (e.g. "80:80")
      // must not be treated as a key-value pair.
      const isQuotedScalar =
        (itemValue.startsWith('"') && itemValue.endsWith('"')) ||
        (itemValue.startsWith("'") && itemValue.endsWith("'"));
      const kvMatch = !isQuotedScalar && itemValue.match(/^([^\s:][^:]*?):\s*(.*)$/);
      if (kvMatch) {
        const obj: Record<string, unknown> = {};
        obj[kvMatch[1].trim()] = parseArrayItemValue(kvMatch[2].trim(), lines, i, indent + 2);
        // Check for more keys at indent+2
        const nextIndent = indent + 2;
        const firstVal = kvMatch[2].trim();
        let j = firstVal === "" || firstVal.startsWith("#")
          // The nested block belongs to THIS key and is indented past it, so
          // skip lines indented more than the key's own column (#1311). Using
          // the key's column itself also swallowed the item's sibling keys,
          // which sit at exactly that column:
          //
          //     - context:          <- key at column 2
          //         cluster: c1     <- its block, column 4
          //       name: n1          <- a SIBLING at column 2, was skipped
          //
          // Only the item's first key was affected: the sibling loop below
          // already skips past its own key's column, and the block-scalar
          // branch immediately below has always used `+ 1` for this reason.
          ? skipValueBlock(lines, i + 1, nextIndent)
          : blockScalarHeader(firstVal)
            // Block body is indented past the key (nextIndent); skip it (#910).
            ? skipNestedBlock(lines, i + 1, nextIndent + 1)
            : i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) {
            j++;
            continue;
          }
          const ni = nextLine.search(/\S/);
          if (ni < nextIndent) break;
          if (ni > nextIndent) break; // belongs to a nested block already consumed
          const nextKV = nextLine.match(/^(\s*)([^\s:][^:]*?):\s*(.*)$/);
          if (nextKV) {
            const nextVal = nextKV[3].trim();
            obj[nextKV[2].trim()] = parseArrayItemValue(nextVal, lines, j, ni);
            if (nextVal === "" || nextVal.startsWith("#")) {
              // Same rule as the first key above: past this key's own column,
              // or to the end of a same-column sequence (#1311).
              j = skipValueBlock(lines, j + 1, ni);
            } else if (blockScalarHeader(nextVal)) {
              // Skip the block body (indented past this key at `ni`) (#910).
              j = skipNestedBlock(lines, j + 1, ni + 1);
            } else {
              j++;
            }
          } else {
            break;
          }
        }
        result.push(obj);
        i = j;
      } else {
        const header = blockScalarHeader(itemValue);
        if (header) {
          // A block scalar as the item itself (`- |`). Without this branch the
          // header parsed as the literal string "|" and the body lines leaked
          // into whatever came next — inside a container list that hoisted the
          // sibling keys after `args:` (securityContext, even the following
          // `containers:` key) to the document root, so post-synth checks read
          // a manifest that had lost them (#1482). The body is indented past
          // the dash's column.
          const block = parseBlockScalar(lines, i + 1, indent, header);
          result.push(block.value);
          i = block.endIndex;
        } else {
          result.push(parseScalar(itemValue));
          i++;
        }
      }
    } else {
      break;
    }
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

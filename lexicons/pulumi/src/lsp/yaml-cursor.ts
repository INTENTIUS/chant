/**
 * Where a cursor sits in a YAML document, read by indentation (#4468).
 *
 * A document being typed is rarely valid YAML, so this does not parse. It
 * reads the cursor's own line and walks up the lines above it, taking each
 * less-indented `key:` as a parent, which is how a block mapping nests. Flow
 * mappings (`{ a: 1 }`) and multi-line scalars are out of its reach; a
 * completion there just gets the keys of the nearest block parent.
 */

export interface YamlCursor {
  /** The keys of the mappings enclosing the cursor's line, outermost first. */
  parents: string[];
  /** The key on the cursor's line when the cursor is after its colon. */
  key?: string;
  /** Text typed after `key:` up to the cursor, when `key` is set. */
  valuePrefix: string;
  /** The partial key typed up to the cursor, when the cursor is in key position. */
  keyPrefix: string;
}

/**
 * A key: quoted, or plain up to the first colon followed by a space or the
 * end of the line. A stack config key carries its own colon
 * (`aws:region: us-east-1`), so a colon followed by anything else stays in
 * the key.
 */
const KEY = `("[^"]*"|'[^']*'|[^\\s#'"](?:[^#]*?[^\\s])?)`;
const KEY_LINE = new RegExp(`^(\\s*)(?:-\\s+)?${KEY}:(?:\\s|$)`);
const VALUE_LINE = new RegExp(`^(\\s*)(?:-\\s+)?${KEY}:(?:\\s+(.*))?$`);

function unquote(key: string): string {
  return /^(["']).*\1$/.test(key) ? key.slice(1, -1) : key;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The parents of line `index` whose own indent is `indent`. */
export function yamlParents(lines: string[], index: number, indent: number): string[] {
  const parents: string[] = [];
  let level = indent;
  for (let i = index - 1; i >= 0 && level > 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const lineIndent = indentOf(line);
    if (lineIndent >= level) continue;
    const m = KEY_LINE.exec(line);
    if (!m) {
      // A sequence item (`- name`) at a lower indent still bounds the level.
      level = lineIndent;
      continue;
    }
    parents.unshift(unquote(m[2].trim()));
    level = lineIndent;
  }
  return parents;
}

export function yamlCursor(content: string, line: number, character: number): YamlCursor {
  const lines = content.split("\n");
  const text = (lines[line] ?? "").slice(0, character);
  const indent = indentOf(text);
  const parents = yamlParents(lines, line, indent);

  const valueMatch = VALUE_LINE.exec(text);
  if (valueMatch) {
    return { parents, key: unquote(valueMatch[2].trim()), valuePrefix: valueMatch[3] ?? "", keyPrefix: "" };
  }
  const keyPrefix = text.trim().replace(/^-\s*/, "");
  return { parents, valuePrefix: "", keyPrefix };
}

/** The key a line declares and its full path, for hover; undefined when the line declares none. */
export function yamlKeyAt(content: string, line: number): { key: string; path: string[]; value: string } | undefined {
  const lines = content.split("\n");
  const text = lines[line] ?? "";
  const m = KEY_LINE.exec(text);
  if (!m) return undefined;
  const key = unquote(m[2].trim());
  const value = text.slice(m[0].length).replace(/\s+#.*$/, "").trim();
  return { key, path: [...yamlParents(lines, line, indentOf(text)), key], value };
}

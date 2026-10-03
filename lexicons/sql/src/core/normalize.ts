/**
 * Normalization helpers that hold in every dialect. A dialect's normalization
 * undoes what its own server rewrites (quoting, type aliases, default
 * levels), by rule over its own parse; these are the pieces that are not any
 * one database's grammar.
 */

/**
 * The name in a `-- previously: <name>` comment, when the text holds one: the
 * rename hint, before a `CREATE` for an object or on a column's line for a
 * column. The name may be quoted with backquotes or double quotes.
 */
export function previouslyIn(comments: readonly string[]): string | undefined {
  for (const c of comments) {
    const m = /^--\s*previously\s*:\s*([`"]?)([^\s`"]+)\1\s*$/i.exec(c.trim());
    if (m) return m[2];
  }
  return undefined;
}

/**
 * Split canonical text (tokens joined by single spaces) on its top-level
 * commas, outside parentheses and brackets.
 */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur: string[] = [];
  for (const tok of text.split(" ")) {
    if (tok === "(" || tok === "[") depth++;
    if (tok === ")" || tok === "]") depth--;
    if (tok === "," && depth === 0) {
      parts.push(cur.join(" "));
      cur = [];
    } else cur.push(tok);
  }
  if (cur.length) parts.push(cur.join(" "));
  return parts.filter((p) => p.length > 0);
}

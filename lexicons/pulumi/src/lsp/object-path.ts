/**
 * The keys of the object literals enclosing a position in TypeScript or JSON
 * source (#4468), read by scanning brackets rather than parsing, since the
 * document is usually mid-edit.
 *
 * `{ pulumi: { member: { dir: "|` reads as `["", "pulumi", "member"]`: one
 * entry per open `{` or `[`, each the key it is the value of, or `""` when it
 * is not a property's value (the outermost object, an array element). Strings
 * and comments are skipped, so a brace inside either does not count.
 */
export function enclosingKeys(text: string): string[] {
  const stack: string[] = [];
  let lastKeyLike: string | undefined;
  let pendingKey: string | undefined;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      lastKeyLike = text.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j])) j++;
      lastKeyLike = text.slice(i, j);
      i = j;
      continue;
    }
    if (c === ":") {
      pendingKey = lastKeyLike;
    } else if (c === "{" || c === "[") {
      stack.push(pendingKey ?? "");
      pendingKey = undefined;
    } else if (c === "}" || c === "]") {
      stack.pop();
      pendingKey = undefined;
    } else if (c === ",") {
      pendingKey = undefined;
    }
    lastKeyLike = /\s/.test(c) ? lastKeyLike : undefined;
    i++;
  }
  return stack;
}

/** The offset of `line`/`character` in `content`. */
export function offsetOf(content: string, line: number, character: number): number {
  let offset = 0;
  const lines = content.split("\n");
  for (let l = 0; l < line && l < lines.length; l++) offset += lines[l].length + 1;
  return offset + character;
}

/** Whether `path` ends with `suffix`. */
export function endsWith(path: string[], suffix: string[]): boolean {
  if (suffix.length > path.length) return false;
  return suffix.every((k, i) => path[path.length - suffix.length + i] === k);
}

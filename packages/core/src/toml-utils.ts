/**
 * Shared TOML utilities — key escaping, string unescaping, etc.
 */

/**
 * Escape a TOML key if it contains special characters.
 */
export function escapeKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Unescape a TOML basic string.
 */
export function unescapeString(val: string): string {
  return val
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Sort keys according to a preferred order, with unmatched keys at the end.
 */
export function sortKeys(keys: string[], keyOrder?: string[]): string[] {
  if (!keyOrder || keyOrder.length === 0) return keys;
  const orderMap = new Map(keyOrder.map((k, i) => [k, i]));
  return [...keys].sort((a, b) => {
    const ai = orderMap.get(a) ?? Infinity;
    const bi = orderMap.get(b) ?? Infinity;
    if (ai !== bi) return ai - bi;
    return 0; // preserve original order for unmatched
  });
}

/**
 * Strip inline comment from a value string.
 */
export function stripInlineComment(raw: string): string {
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === stringChar && raw[i - 1] !== "\\") {
        inString = false;
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === "#") {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

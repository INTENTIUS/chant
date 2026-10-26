/**
 * A root's `-backend-config` (chant#4459): the files it names in
 * `terraform.roots.<name>.backendConfigFiles` and the pairs in
 * `backendConfig`, as the flags every init the lexicon runs passes, and the
 * keys a file holds, as the readers that find a root's state before init see
 * them.
 *
 * Files go first and pairs after, because init applies later flags over
 * earlier ones and a pair is the more specific of the two. A file's path is
 * passed as written: init runs in the root's directory, so a relative path
 * resolves against it, as `varFiles` does. A reader of the file resolves it
 * the same way.
 *
 * Plain node: `op/activities/terraform.ts` imports this, and it stays out of
 * the HCL parser's dependency graph.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** The two keys of a root that say what init's `-backend-config` flags are. */
export interface BackendConfigFlags {
  backendConfigFiles?: readonly string[];
  backendConfig?: Readonly<Record<string, string>>;
}

/** The `-backend-config` values in the order init takes them: each file's path, then each `key=value` pair. Unquoted, one per flag. */
export function backendConfigValues(root: BackendConfigFlags): string[] {
  return [...(root.backendConfigFiles ?? []), ...Object.entries(root.backendConfig ?? {}).map(([k, v]) => `${k}=${v}`)];
}

/** {@link backendConfigValues} as argv: `-backend-config=<value>` each. */
export function backendConfigArgs(root: BackendConfigFlags): string[] {
  return backendConfigValues(root).map((v) => `-backend-config=${v}`);
}

/** A backend-config file's path as init in `dir` reads it: an absolute path as it is, a relative one against `dir`. */
export function backendConfigFilePath(dir: string, file: string): string {
  return isAbsolute(file) ? file : resolve(dir, file);
}

/**
 * The text of `body` with everything nested deeper than `level` braces
 * blanked, newlines kept, so only the attributes at that level are left to
 * read. Strings are read through, so a brace in one does not count.
 */
export function blankBelow(body: string, level: number): string {
  const out = body.split("");
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (depth > level && c !== "\n") out[i] = " ";
    if (inString) {
      if (c === "\\") {
        if (depth > level && body[i + 1] !== undefined && body[i + 1] !== "\n") out[i + 1] = " ";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return out.join("");
}

/**
 * The literal attributes of HCL text at brace depth `level` (0 for a file of
 * bare attributes, 1 for the body of a block given with its header): plain
 * strings, booleans and numbers, typed as init records them. A string with an
 * interpolation, and anything that is not one line of `name = literal`, is
 * left out. Comments are left to the caller to blank.
 */
export function literalAttributes(text: string, level: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of blankBelow(text, level).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\s*$/gm)) {
    const raw = m[2]!;
    if (raw.startsWith('"')) {
      const s = raw.slice(1, -1);
      if (/\$\{|%\{/.test(s)) continue;
      out[m[1]!] = s.replace(/\\(.)/g, "$1");
    } else out[m[1]!] = raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return out;
}

/** HCL text with its `#`, `//` and `/* *\/` comments blanked, strings read through. */
function withoutComments(text: string): string {
  const out = text.split("");
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      for (; i < text.length && text[i] !== "\n"; i++) out[i] = " ";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
      i--;
    }
  }
  return out.join("");
}

/** The keys one backend-config file sets: its top-level `key = "value"` lines. Throws when the file cannot be read. */
export function readBackendConfigFile(path: string): Record<string, unknown> {
  return literalAttributes(withoutComments(readFileSync(path, "utf-8")), 0);
}

/**
 * The keys a root's backend-config files set, later files over earlier ones,
 * each path resolved against `dir`; and the files that could not be read,
 * which init itself will refuse.
 */
export function backendConfigFileKeys(dir: string, files: readonly string[] = []): { config: Record<string, unknown>; unread: string[] } {
  const config: Record<string, unknown> = {};
  const unread: string[] = [];
  for (const f of files) {
    try {
      Object.assign(config, readBackendConfigFile(backendConfigFilePath(dir, f)));
    } catch {
      unread.push(f);
    }
  }
  return { config, unread };
}

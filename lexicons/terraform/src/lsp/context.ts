/**
 * Shared parsing for the terraform LSP pair (#2088).
 *
 * There is no generated `LexiconIndex` here (see `completions.ts`'s module
 * doc for why), so both providers work off two different sources instead:
 *
 *   - `terraform.roots`, read out of the project's `chant.config.{ts,json}`.
 *     `chant.config.ts` is project-authored code (`config.ts`'s own doc:
 *     "where it is evaluated is a security question"), and evaluating it is
 *     an async, sandboxed operation — `loadChantConfigUpward` — while
 *     `completionProvider`/`hoverProvider` are synchronous. So this reads the
 *     file's *text* and extracts the `terraform.roots` object literal with a
 *     small brace-matching scanner, never `eval`/`import()`. A shape the
 *     scanner cannot follow (roots built by a loop, spread from a helper)
 *     yields no roots rather than a wrong guess — the same "reachable or
 *     nothing" rule the config-loading code documents elsewhere.
 *   - the option keys a `*.op.ts` author types: `TerraformApplyOpConfig`
 *     (`composites/terraform-apply-op.ts`) and the four builders' own opts
 *     (`op/builders.ts`, `op/activities/terraform.ts`). Those are a fixed
 *     table, not read from any file.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Root resolution ─────────────────────────────────────────────────────────

export interface ResolvedTerraformRoot {
  dir?: string;
  workspace?: string;
  varFiles?: string[];
}

/** One `{`/`(`/`[` this scanner has not yet seen the matching closer for. */
interface Opener {
  char: "{" | "(" | "[";
  index: number;
}

/**
 * Every unmatched opener in `text`, in nesting order (outermost first),
 * ignoring anything inside a string or template literal. This is the one
 * pass every context-detection helper below walks backward over — cheap
 * enough per keystroke since an `*.op.ts` file and a `chant.config.ts` are
 * both small.
 */
function unmatchedOpeners(text: string): Opener[] {
  const stack: Opener[] = [];
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "{" || ch === "(" || ch === "[") {
      stack.push({ char: ch, index: i });
    } else if (ch === "}" || ch === ")" || ch === "]") {
      stack.pop();
    }
  }
  return stack;
}

/**
 * The `{ ... }` body starting at `text[openIndex] === "{"`, and the index of
 * its matching `}`. A single forward pass tracking overall nesting depth —
 * `{`/`(`/`[` all count the same way, which is safe here because the only
 * question this asks is "where does *this* brace close," never which bracket
 * kind matched which.
 */
function braceBody(text: string, openIndex: number): { body: string; closeIndex: number } | undefined {
  if (text[openIndex] !== "{") return undefined;
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return { body: text.slice(openIndex + 1, i), closeIndex: i };
    }
  }
  return undefined;
}

/** The `{ ... }` body immediately after the first top-level `key\s*:\s*` in `text`. */
function findKeyBlock(text: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*\\{`, "m");
  const m = re.exec(text);
  if (!m) return undefined;
  const openIndex = m.index + m[0].length - 1;
  return braceBody(text, openIndex)?.body;
}

/** One key/value pair per top-level entry of an object-literal body. */
function parseEntries(objText: string): Map<string, string> {
  const entries = new Map<string, string>();
  let i = 0;
  const len = objText.length;
  while (i < len) {
    while (i < len && /[\s,]/.test(objText[i])) i++;
    if (i >= len) break;

    let key: string | undefined;
    if (objText[i] === '"' || objText[i] === "'") {
      const quote = objText[i];
      let j = i + 1;
      while (j < len && objText[j] !== quote) j++;
      key = objText.slice(i + 1, j);
      i = j + 1;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(objText.slice(i));
      if (!m) break;
      key = m[0];
      i += m[0].length;
    }
    while (i < len && /\s/.test(objText[i])) i++;
    if (objText[i] !== ":") break;
    i++;
    while (i < len && /\s/.test(objText[i])) i++;

    if (objText[i] === "{") {
      const block = braceBody(objText, i);
      if (!block) break;
      // Stored without the braces: every caller re-parses an object value as
      // another set of entries (`parseTerraformRoots` does, one root at a
      // time), and `parseEntries` itself only knows how to walk a flat
      // `key: value` sequence, not a single `{ ... }`-wrapped one.
      entries.set(key, block.body);
      i = block.closeIndex + 1;
    } else {
      let depth = 0;
      let inString: string | null = null;
      let j = i;
      while (j < len) {
        const ch = objText[j];
        if (inString) {
          if (ch === "\\") j++;
          else if (ch === inString) inString = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          inString = ch;
        } else if (ch === "[" || ch === "(") {
          depth++;
        } else if (ch === "]" || ch === ")") {
          depth--;
        } else if (ch === "," && depth === 0) {
          break;
        }
        j++;
      }
      entries.set(key, objText.slice(i, j));
      i = j;
    }
  }
  return entries;
}

function unquote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const m = /^["'`]([\s\S]*)["'`]$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

function parseStringArray(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const values = inner
    .split(",")
    .map((s) => unquote(s))
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return values.length > 0 ? values : undefined;
}

/**
 * `terraform.roots`, extracted from a `chant.config.ts`/`.json`'s raw text.
 * Never executes the file. `format` distinguishes the two because JSON's
 * `roots` value is already a plain object — no brace-matching needed.
 */
export function parseTerraformRoots(
  configText: string,
  format: "ts" | "json",
): Record<string, ResolvedTerraformRoot> | undefined {
  if (format === "json") {
    try {
      const parsed = JSON.parse(configText) as { terraform?: { roots?: unknown } };
      const roots = parsed.terraform?.roots;
      if (!roots || typeof roots !== "object" || Array.isArray(roots)) return undefined;
      const result: Record<string, ResolvedTerraformRoot> = {};
      for (const [name, entry] of Object.entries(roots as Record<string, unknown>)) {
        const e = (entry ?? {}) as { dir?: unknown; workspace?: unknown; varFiles?: unknown };
        result[name] = {
          dir: typeof e.dir === "string" ? e.dir : undefined,
          workspace: typeof e.workspace === "string" ? e.workspace : undefined,
          varFiles: Array.isArray(e.varFiles) ? e.varFiles.filter((v): v is string => typeof v === "string") : undefined,
        };
      }
      return Object.keys(result).length > 0 ? result : undefined;
    } catch {
      return undefined;
    }
  }

  const terraformBlock = findKeyBlock(configText, "terraform");
  if (terraformBlock === undefined) return undefined;
  const rootsBlock = findKeyBlock(terraformBlock, "roots");
  if (rootsBlock === undefined) return undefined;

  const result: Record<string, ResolvedTerraformRoot> = {};
  for (const [name, body] of parseEntries(rootsBlock)) {
    const fields = parseEntries(body);
    result[name] = {
      dir: unquote(fields.get("dir")),
      workspace: unquote(fields.get("workspace")),
      varFiles: parseStringArray(fields.get("varFiles")),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function directoryFromUri(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return dirname(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/** Walk upward from `startDir` for the nearest `chant.config.{ts,json}`. */
function findConfigUpward(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 32; i++) {
    const tsPath = join(dir, "chant.config.ts");
    if (existsSync(tsPath)) return tsPath;
    const jsonPath = join(dir, "chant.config.json");
    if (existsSync(jsonPath)) return jsonPath;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * `terraform.roots`, resolved from the project config reachable from the
 * document at `uri`. `undefined` when `uri` is not a `file://` URI, no
 * `chant.config.*` is reachable by walking up from it, or the namespace
 * declares no roots — every case where root-name completion has nothing
 * honest to offer, so callers fall back to the option-key completions
 * instead of fabricating a root list.
 */
export function resolveRootsForUri(uri: string): Record<string, ResolvedTerraformRoot> | undefined {
  const startDir = directoryFromUri(uri);
  if (!startDir) return undefined;
  const configPath = findConfigUpward(startDir);
  if (!configPath) return undefined;
  try {
    const text = readFileSync(configPath, "utf-8");
    return parseTerraformRoots(text, configPath.endsWith(".json") ? "json" : "ts");
  } catch {
    return undefined;
  }
}

// ── Call/field context detection ────────────────────────────────────────────

/** Content of the open document up to (and a little past) the cursor line, mirroring core's `lexiconCompletions`. */
export function contentUpToCursor(content: string, line: number): string {
  return content.split("\n").slice(0, line + 1).join("\n");
}

/**
 * The name of the call whose parenthesized argument list holds the innermost
 * unmatched `{` before the cursor — `TerraformApplyOp({ ↵ name: "x", ↵ <cursor>`
 * and `terraformPlan("app", { ↵ <cursor>` both resolve to their call name,
 * regardless of which positional argument the object is.
 */
export function enclosingCallName(text: string): string | undefined {
  const stack = unmatchedOpeners(text);
  const top = stack[stack.length - 1];
  if (!top || top.char !== "{") return undefined;
  const parent = stack[stack.length - 2];
  if (!parent || parent.char !== "(") return undefined;
  let k = parent.index - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const end = k + 1;
  while (k >= 0 && /[\w$]/.test(text[k])) k--;
  const name = text.slice(k + 1, end);
  return name.length > 0 ? name : undefined;
}

/** The `key` immediately before the `{` at `braceIndex`, from `key: {`. */
function precedingObjectKey(text: string, braceIndex: number): string | undefined {
  const before = text.slice(0, braceIndex);
  const m = /(?:^|[\s,{])(["'`]?)([\w$-]+)\1\s*:\s*$/.exec(before);
  return m?.[2];
}

/**
 * The key of the innermost enclosing object literal, regardless of what
 * encloses *that* — `compensate: { <cursor>` resolves to `"compensate"` even
 * though the whole thing sits inside `TerraformApplyOp({ ... })`'s own
 * argument object, which `enclosingKeyPath` would refuse to walk through (a
 * call anywhere in the chain ends it there).
 */
export function innermostObjectKey(text: string): string | undefined {
  const stack = unmatchedOpeners(text);
  const top = stack[stack.length - 1];
  if (!top || top.char !== "{") return undefined;
  return precedingObjectKey(text, top.index);
}

/**
 * The chain of object-literal keys enclosing the cursor, outermost first —
 * `["terraform", "roots", "app"]` inside `terraform: { roots: { app: { <cursor>` —
 * for the plain-object contexts (`chant.config.ts`) that `enclosingCallName`
 * does not cover, since there is no call there at all. A brace with no `key:`
 * before it (the module's own `export default {`) contributes nothing to the
 * path rather than ending it — only a `(` anywhere in the chain does, since
 * `chant.config.ts` builds one object literal and calling anything
 * mid-declaration is not a shape this needs to follow.
 */
export function enclosingKeyPath(text: string): string[] | undefined {
  const stack = unmatchedOpeners(text);
  const path: string[] = [];
  for (const frame of stack) {
    if (frame.char !== "{") return undefined;
    const key = precedingObjectKey(text, frame.index);
    if (key) path.push(key);
  }
  return path;
}

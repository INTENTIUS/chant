/**
 * The HCL a composition reads from a root's files (chant#4438): its backend
 * and the state that backend names, its `terraform_remote_state` and
 * `terraform_estate_outputs` reads, its `live` estate, the providers its lock
 * file pins, and the local modules it calls.
 *
 * Lifted from terragucci at c493e0e (`compose.ts` `blankComments`,
 * `lockedProviders`, `localModules`, `importLiteral`, `jsonBlocks`;
 * `detect.ts` `blockBody`, `hclAttr`, `backendBlock`, `stateOf`, `estateOf`,
 * `estateOutputReads`, `liveRoots`; `linked.ts` `configFiles`), reading a
 * root's `-backend-config` from `terraform.roots.<name>.backendConfig` where
 * terragucci read `TF_CLI_ARGS_init`. Regex over text with comments blanked,
 * as there: no HCL parse runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isJsonConfigFile, listConfigFilesSafe } from "../hcl/files";
import { literal, stateAddress, type Attr, type StateKey } from "./state-address";

export type { StateKey } from "./state-address";

/**
 * HCL text with its comments blanked to spaces, newlines kept, so every
 * position in it is the same position in the text as written. Strings and
 * their escapes are read through, so a `#` or `//` in one stays.
 */
export function blankComments(text: string): string {
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

/** The text of the block that starts at `start`: up to the brace that closes its first `{`. */
export function blockBody(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf("{", start); i >= 0 && i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/**
 * An HCL block's attribute: its string, `null` when it is written as anything
 * but a plain string, undefined when it is not written.
 */
export const hclAttr =
  (body: string): Attr =>
  (name) => {
    const m = body.match(new RegExp(`(?<![\\w.-])${name}\\s*=(?!=)\\s*(.)`));
    if (!m) return undefined;
    if (m[1] !== '"') return null;
    const start = m.index! + m[0].length;
    let out = "";
    for (let i = start; i < body.length; i++) {
      if (body[i] === "\\") {
        out += body[++i] ?? "";
        continue;
      }
      if (body[i] === '"') return literal(out) ?? null;
      out += body[i];
    }
    return null;
  };

/**
 * A root's own configuration files, not its modules', as paths: the set the
 * root's `binary` reads (`.tf` and `.tf.json`, plus `.tofu` and `.tofu.json`
 * for tofu or choudoufu), from the lexicon's one lister (chant#4457).
 */
export function configFiles(dir: string, binary?: string): string[] {
  return listConfigFilesSafe(dir, binary).map((n) => join(dir, n));
}

/** One configuration file's text, comments blanked when it is HCL. */
export interface RootText {
  file: string;
  text: string;
  json: boolean;
}

/** The text of a root's own configuration files, comments blanked so positions still match. */
export function rootTexts(dir: string, binary?: string): RootText[] {
  return configFiles(dir, binary).map((f) => {
    const raw = readFileSync(f, "utf-8");
    const json = isJsonConfigFile(f);
    return { file: f, text: json ? raw : blankComments(raw), json };
  });
}

const objectOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/** A block in Terraform's JSON syntax: an object, or a list of objects whose first is taken. */
const firstOf = (v: unknown): Record<string, unknown> | undefined => objectOf(Array.isArray(v) ? v[0] : v);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The blocks of a kind in a JSON-syntax file: `{"import": [...]}` or `{"import": {...}}`. */
export function jsonBlocks(doc: unknown, kind: string): Record<string, unknown>[] {
  const v = objectOf(doc)?.[kind];
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  return v && typeof v === "object" ? [v as Record<string, unknown>] : [];
}

/** The backend a root's code declares: its type and plain-string attributes, `cloud` for a `cloud` block, undefined for neither. */
export type BackendBlock = { type: string; attrs: Record<string, string> } | { cloud: true };

/** The backend block (or `cloud` block) of the root at `dir`, from HCL or Terraform's JSON syntax. */
export function backendBlock(dir: string, binary?: string): BackendBlock | undefined {
  for (const { text, json } of rootTexts(dir, binary)) {
    if (json) {
      for (const b of jsonBlocks(parseJson(text), "terraform")) {
        if (b.cloud !== undefined) return { cloud: true };
        const backends = objectOf(b.backend) ?? {};
        const type = Object.keys(backends)[0];
        if (!type) continue;
        const body = firstOf(backends[type]) ?? {};
        return { type, attrs: Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string> };
      }
      continue;
    }
    const m = text.match(/\bbackend\s+"([^"]+)"\s*\{/);
    if (m) {
      const body = blockBody(text, m.index!);
      const attrs: Record<string, string> = {};
      for (const a of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/gm)) attrs[a[1]!] = a[2]!;
      return { type: m[1]!, attrs };
    }
    if (/^\s*cloud\s*\{/m.test(text)) return { cloud: true };
  }
  return undefined;
}

/** A `terraform_remote_state` block: its label, the state it reads, and whether it repeats (count or for_each). */
export interface RemoteStateRead extends StateKey {
  name: string;
  repeated: boolean;
}

/** What a root's code says about state: the state its backend keeps and the states its `terraform_remote_state` blocks read. */
export interface RootState {
  own?: StateKey;
  reads: RemoteStateRead[];
}

const asKey = (a: ReturnType<typeof stateAddress>): StateKey | undefined => ("unresolved" in a ? undefined : a);

/**
 * The state the root at `dir` keeps, as its backend block names it with the
 * `-backend-config` pairs over it, and the states its `terraform_remote_state`
 * blocks read. `rel` is the root's directory relative to the project, which a
 * `local` path resolves against. An address the code does not spell in plain
 * strings is left out, so nothing lines up with it.
 */
export function rootState(dir: string, rel: string, backendConfig: Readonly<Record<string, string>> = {}, binary?: string): RootState {
  const out: RootState = { reads: [] };
  const over = (get: Attr): Attr => (name) => (name in backendConfig ? (literal(backendConfig[name]) ?? null) : get(name));
  let declared = false;
  for (const { text, json } of rootTexts(dir, binary)) {
    if (json) {
      const doc = parseJson(text);
      for (const t of jsonBlocks(doc, "terraform")) {
        const backends = Object.entries(objectOf(t.backend) ?? {});
        for (const [type, v] of backends) {
          declared = true;
          const b = firstOf(v);
          out.own = asKey(stateAddress(type, over((n) => literal(b?.[n])), rel));
        }
        if (t.cloud !== undefined) {
          declared = true;
          const b = firstOf(t.cloud);
          out.own = asKey(stateAddress("cloud", (n) => literal(b?.[n] ?? firstOf(b?.workspaces)?.[n]), rel));
        }
      }
      for (const d of jsonBlocks(doc, "data")) {
        for (const [name, v] of Object.entries(objectOf(d.terraform_remote_state) ?? {})) {
          const b = firstOf(v);
          const config = objectOf(b?.config);
          const type = literal(b?.backend);
          if (!config || typeof type !== "string") continue;
          const key = asKey(stateAddress(type, (n) => literal(config[n] ?? firstOf(config.workspaces)?.[n]), rel));
          if (key) out.reads.push({ name, ...key, repeated: b?.count !== undefined || b?.for_each !== undefined });
        }
      }
      continue;
    }
    for (const m of text.matchAll(/\bbackend\s+"([^"]+)"\s*\{/g)) {
      declared = true;
      out.own = asKey(stateAddress(m[1]!, over(hclAttr(blockBody(text, m.index!))), rel));
    }
    for (const m of text.matchAll(/^\s*cloud\s*\{/gm)) {
      declared = true;
      out.own = asKey(stateAddress("cloud", hclAttr(blockBody(text, m.index!)), rel));
    }
    for (const m of text.matchAll(/\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{/g)) {
      const body = blockBody(text, m.index!);
      const type = hclAttr(body)("backend");
      if (typeof type !== "string") continue;
      const config = /\bconfig\s*=\s*\{/.exec(body);
      const get = config ? hclAttr(blockBody(body, config.index!)) : () => undefined;
      const key = asKey(stateAddress(type, get, rel));
      if (key) out.reads.push({ name: m[1]!, ...key, repeated: /^\s*(count|for_each)\s*=/m.test(body) });
    }
  }
  if (!declared) out.own = asKey(stateAddress("local", over(() => undefined), rel));
  return out;
}

/** Two addresses name one state: the same key, and the same bucket where both name one. */
export const sameState = (a: StateKey, b: StateKey): boolean => a.key === b.key && (!a.bucket || !b.bucket || a.bucket === b.bucket);

const LIVE_SIDECAR = "estate.chdf.hcl";

/**
 * A choudoufu root's estate, from its `estate.chdf.hcl` or the `live` block in
 * its `terraform` block; undefined when it declares none. A `live` block takes
 * effect only under choudoufu, so the files read are the ones choudoufu reads
 * unless `binary` names another.
 */
export function liveEstate(dir: string, binary = "choudoufu"): { live: boolean; estate?: string } {
  const sidecar = join(dir, LIVE_SIDECAR);
  if (existsSync(sidecar)) {
    const estate = hclAttr(blankComments(readFileSync(sidecar, "utf-8")))("estate");
    return { live: true, ...(typeof estate === "string" ? { estate } : {}) };
  }
  for (const { text, json } of rootTexts(dir, binary)) {
    if (json) continue;
    for (const t of text.matchAll(/^\s*terraform\s*\{/gm)) {
      const body = blockBody(text, t.index!);
      const live = body.match(/\blive\s*\{/);
      if (!live) continue;
      const estate = hclAttr(blockBody(body, live.index!))("estate");
      return { live: true, ...(typeof estate === "string" ? { estate } : {}) };
    }
  }
  return { live: false };
}

/** Each `data "terraform_estate_outputs"` block of a root: its label and the estate whose outputs it reads. */
export function estateOutputReads(dir: string, binary?: string): { name: string; estate: string }[] {
  const out: { name: string; estate: string }[] = [];
  for (const { text, json } of rootTexts(dir, binary)) {
    if (json) continue;
    for (const m of text.matchAll(/\bdata\s+"terraform_estate_outputs"\s+"([^"]+)"\s*\{/g)) {
      const e = hclAttr(blockBody(text, m.index!))("estate");
      if (typeof e === "string") out.push({ name: m[1]!, estate: e });
    }
  }
  return out;
}

/** The provider versions a root's lock file pins, by provider address. */
export function lockedProviders(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = "";
  try {
    text = readFileSync(join(dir, ".terraform.lock.hcl"), "utf-8");
  } catch {
    return out;
  }
  for (const m of text.matchAll(/^provider\s+"([^"]+)"\s*\{/gm)) {
    const v = blockBody(text, m.index!).match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
    if (v) out.set(m[1]!, v);
  }
  return out;
}

/** Local module directories the root at `dir` calls (`source = "./..."` or `"../..."`), followed through, absolute. */
export function localModules(dir: string, binary?: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(dir)];
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const { text, json } of rootTexts(at, binary)) {
      if (json) continue;
      for (const m of text.matchAll(/\bmodule\s+"[^"]+"\s*\{/g)) {
        const src = blockBody(text, m.index!).match(/\bsource\s*=\s*"(\.{1,2}\/[^"]*)"/)?.[1];
        if (!src) continue;
        const abs = resolve(at, src);
        if (seen.has(abs) || abs === resolve(dir)) continue;
        seen.add(abs);
        queue.push(abs);
      }
    }
  }
  return [...seen].sort();
}

/** `abs` relative to `from`, with `/` between parts, `.` for `from` itself. */
export const relPath = (from: string, abs: string): string => relative(from, abs).split("\\").join("/") || ".";

/** An `import` block the composed root can take as it is: a literal string id, no for_each, no provider of the root's own. */
export function importLiteral(body: string): boolean {
  if (/^\s*(for_each|provider)\s*=/m.test(body)) return false;
  return /^\s*id\s*=\s*"(?:[^"\\$%]|\\.)*"\s*$/m.test(body);
}

/** Whether a JSON-syntax `import` block takes no literal string id (or has for_each or a provider). */
export function jsonImportRefused(text: string): boolean {
  return jsonBlocks(parseJson(text), "import").some((b) => typeof b.id !== "string" || /\$\{|%\{/.test(b.id) || b.for_each !== undefined || b.provider !== undefined);
}

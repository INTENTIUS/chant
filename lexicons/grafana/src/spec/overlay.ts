/**
 * The correction overlay: checked-in patches applied to the vendored schemas
 * before type generation and validation.
 *
 * The vendored foundation-sdk schemas are stricter than Grafana's own CUE
 * (`additionalProperties: false` everywhere, `options` typed as a record
 * where the CUE says `_`, fields required that the CUE defaults) and lag it
 * (no `MatcherConfig.scope`). Each `src/spec/overlay/<name>.overlay.json`
 * lists patches for one schema. A patch is a small JSON-patch operation
 * (`add`, `replace` or `remove`, RFC 6902 paths) and cites the Grafana
 * source line it follows, so every correction is traceable and can be
 * dropped when the pin catches up.
 *
 * Applying is strict: `add` refuses a key that is already there and
 * `replace`/`remove` refuse a path that is not, so bumping the pin to a
 * schema that already carries a fix fails `npm run generate` until the
 * patch is removed.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { SchemaName } from "../pin";

export interface OverlayPatch {
  op: "add" | "replace" | "remove";
  /** JSON pointer into the vendored schema. */
  path: string;
  value?: unknown;
  /** The Grafana source this follows: `<repo path>:<line>` at the tag named in the file. */
  source: string;
  /** Why the vendored schema is wrong here. */
  why: string;
}

export interface SchemaOverlay {
  $comment?: string;
  schema: SchemaName;
  /** The Grafana tag(s) the `source` lines refer to. */
  grafana: string;
  patches: OverlayPatch[];
}

export function overlayDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "overlay");
}

export function overlayPath(name: SchemaName): string {
  return join(overlayDir(), `${name}.overlay.json`);
}

/** The overlay for one schema, or undefined when it has none. */
export function loadOverlay(name: SchemaName): SchemaOverlay | undefined {
  const path = overlayPath(name);
  if (!existsSync(path)) return undefined;
  const overlay = JSON.parse(readFileSync(path, "utf-8")) as SchemaOverlay;
  if (overlay.schema !== name) throw new Error(`grafana overlay ${path}: names schema "${overlay.schema}", expected "${name}"`);
  return overlay;
}

function unescape(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function fail(name: string, i: number, p: OverlayPatch, msg: string): never {
  throw new Error(`grafana overlay ${name} patch ${i} (${p.op} ${p.path}): ${msg}`);
}

/** A copy of `schema` with every patch applied, in order. */
export function applyOverlay(schema: Record<string, unknown>, overlay: SchemaOverlay): Record<string, unknown> {
  const out = structuredClone(schema);
  overlay.patches.forEach((p, i) => {
    if (!p.source || !p.why) fail(overlay.schema, i, p, "every patch needs a source and a why");
    if (!p.path.startsWith("/")) fail(overlay.schema, i, p, "path must be a JSON pointer");
    const tokens = p.path.slice(1).split("/").map(unescape);
    const last = tokens.pop()!;
    let parent: unknown = out;
    for (const t of tokens) {
      parent = Array.isArray(parent) ? parent[Number(t)] : (parent as Record<string, unknown> | undefined)?.[t];
      if (parent === undefined || parent === null || typeof parent !== "object") fail(overlay.schema, i, p, `no parent at "${t}"`);
    }
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) fail(overlay.schema, i, p, "bad array index");
      if (p.op === "add") parent.splice(idx, 0, structuredClone(p.value));
      else if (idx >= parent.length) fail(overlay.schema, i, p, "no such element");
      else if (p.op === "replace") parent[idx] = structuredClone(p.value);
      else parent.splice(idx, 1);
      return;
    }
    const obj = parent as Record<string, unknown>;
    const has = Object.prototype.hasOwnProperty.call(obj, last);
    if (p.op === "add") {
      if (has) fail(overlay.schema, i, p, "already present in the vendored schema; drop this patch");
      obj[last] = structuredClone(p.value);
    } else if (!has) {
      fail(overlay.schema, i, p, "not present in the vendored schema");
    } else if (p.op === "replace") {
      obj[last] = structuredClone(p.value);
    } else {
      delete obj[last];
    }
  });
  return out;
}

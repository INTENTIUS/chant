/**
 * Property-level completion and hover for the built-in components (#3361),
 * from the descriptions in upstream's `config.schema.yaml`.
 *
 * Generation writes each built-in's property tree to
 * `src/generated/properties.json`. Inside `new OtlpReceiver({ … })` the
 * cursor's position is resolved to a path of keys (`protocols.grpc`), and the
 * properties at that path are offered, with upstream's description and a short
 * type. A word under the cursor at such a position hovers with the same text.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { moduleSourceDir } from "@intentius/chant/module-source";
import type { PropertyDoc } from "../spec/parse";

type PropertyTrees = Record<string, Record<string, PropertyDoc>>;

let cached: PropertyTrees | undefined;

/** The generated property trees, or an empty set before `generate` has run. */
export function propertyTrees(): PropertyTrees {
  if (cached) return cached;
  const file = join(dirname(moduleSourceDir(import.meta.url)), "generated", "properties.json");
  cached = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as PropertyTrees) : {};
  return cached;
}

/** Test seam: replace the loaded trees. */
export function setPropertyTrees(trees: PropertyTrees | undefined): void {
  cached = trees;
}

/** Where the cursor is inside a constructor's config object. */
export interface PropertyPosition {
  className: string;
  /** The keys of the objects enclosing the cursor, outermost first. */
  path: string[];
}

/**
 * Resolve the text before the cursor to the built-in whose constructor
 * argument holds it and the keys of the objects around it. Undefined when the
 * cursor is not inside `new X({ … })`.
 */
export function propertyPosition(before: string): PropertyPosition | undefined {
  const re = /\bnew\s+(\w+)\s*\(\s*\{/g;
  let match: RegExpExecArray | null;
  let last: { className: string; start: number } | undefined;
  while ((match = re.exec(before)) !== null) last = { className: match[1], start: match.index + match[0].length };
  if (!last) return undefined;

  // Walk from the constructor's `{`: each `{` opens the object of the key
  // written just before it; `[` opens a list whose objects share that key.
  const stack: Array<string | null> = [];
  let pendingKey: string | null = null;
  let i = last.start;
  const text = before;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(text, i);
      const literal = text.slice(i + 1, end - 1);
      // A quoted key: `"k8s.pod.name": …`
      if (/^\s*:/.test(text.slice(end))) pendingKey = literal;
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (ident) {
      if (/^\s*:/.test(text.slice(i + ident[0].length))) pendingKey = ident[0];
      i += ident[0].length;
      continue;
    }
    if (ch === "{" || ch === "[") {
      // A list keeps its key, so its objects resolve to the list's items.
      stack.push(ch === "[" ? `[${pendingKey ?? ""}` : pendingKey);
      pendingKey = null;
    } else if (ch === "}" || ch === "]") {
      if (stack.length === 0) return undefined; // the constructor's object closed
      stack.pop();
    } else if (ch === "," || ch === "(" || ch === ")") {
      pendingKey = null;
    }
    i++;
  }

  const path: string[] = [];
  let inList: string | undefined;
  for (const entry of stack) {
    if (entry === null) {
      if (inList === undefined) return undefined; // an object whose key is unknown
      inList = undefined; // an item of the list just entered
      continue;
    }
    if (entry.startsWith("[")) {
      inList = entry.slice(1);
      if (inList) path.push(inList);
      continue;
    }
    path.push(entry);
    inList = undefined;
  }
  if (inList !== undefined) return undefined; // directly inside a list, not an item
  return { className: last.className, path };
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, text.length);
}

/** The properties at a path of a built-in's tree, or undefined when the path leaves it. */
export function propertiesAt(position: PropertyPosition): Record<string, PropertyDoc> | undefined {
  let level: Record<string, PropertyDoc> | undefined = propertyTrees()[position.className];
  for (const key of position.path) {
    level = level?.[key]?.properties;
    if (!level) return undefined;
  }
  return level;
}

/** Markdown for one property: its type, deprecation and upstream description. */
export function propertyMarkdown(name: string, doc: PropertyDoc, className: string): string {
  const lines = [`**${name}**: \`${doc.type}\`${doc.deprecated ? " (deprecated)" : ""}`];
  if (doc.description) lines.push("", doc.description);
  lines.push("", `\`${className}\` config, from upstream config.schema.yaml.`);
  return lines.join("\n");
}

/**
 * Output rendering for `chant kube get`/`describe` (chant #1079).
 *
 * kubectl's own `-o` vocabulary, minus the one form the issue says to drop
 * openly rather than half-implement: `-o go-template[-file]` is Go template
 * syntax, and chant does not carry a Go template engine — {@link parseOutput}
 * refuses it by name rather than pretending a partial implementation covers
 * it. `-o jsonpath` and `-o custom-columns` are "tractable" per the issue's
 * own notes, and are implemented here as a deliberately small subset: dot
 * paths, bracket indices, and a `[*]` wildcard — the paths kubectl one-liners
 * actually use — not the full jsonpath grammar (filters, `range`/`end`
 * templates). `-o chant` is chant's own addition: a live object rendered as
 * the typed source that would declare it, reusing `./import/live-export.ts`
 * and the lexicon's own `K8sGenerator` — the same machinery `chant import`
 * uses, so every read is an adoption path, per the issue's framing.
 */

import type { K8sObject } from "@intentius/chant-k8s-client";
import { dump } from "js-yaml";
import { buildExportFromObjects } from "../import/live-export";
import { K8sGenerator } from "../import/generator";
import type { KubeVerdict } from "./verdict";

export type OutputFormat =
  | { kind: "text" }
  | { kind: "wide" }
  | { kind: "json" }
  | { kind: "yaml" }
  | { kind: "name" }
  | { kind: "chant" }
  | { kind: "jsonpath"; expr: string }
  | { kind: "custom-columns"; spec: string };

/** Parse an `-o`/`--output` value. Throws on `go-template[-file]`. */
export function parseOutput(value: string | undefined): OutputFormat {
  if (value === undefined || value === "" || value === "text") return { kind: "text" };
  if (value === "wide") return { kind: "wide" };
  if (value === "json") return { kind: "json" };
  if (value === "yaml") return { kind: "yaml" };
  if (value === "name") return { kind: "name" };
  if (value === "chant") return { kind: "chant" };
  if (value.startsWith("jsonpath=")) return { kind: "jsonpath", expr: value.slice("jsonpath=".length) };
  if (value.startsWith("custom-columns=")) return { kind: "custom-columns", spec: value.slice("custom-columns=".length) };
  if (value === "go-template" || value === "go-template-file" || value.startsWith("go-template")) {
    throw new Error(
      "-o go-template is not supported — chant kube does not carry a Go template engine, and a partial " +
        "implementation would be worse than none. Use -o jsonpath=, -o custom-columns=, or -o chant instead.",
    );
  }
  throw new Error(`unsupported -o value: ${value}`);
}

// ── table rendering (text / wide) ──────────────────────────────────────────

export interface KubeRow {
  namespace?: string;
  name: string;
  kind: string;
  status: string;
  age?: string;
  verdict?: KubeVerdict;
  labels?: Record<string, string>;
  object: K8sObject;
}

/** kubectl-style relative age, e.g. "45s", "12m", "3h", "5d". */
export function relativeAge(creationTimestamp: string | undefined, now: number = Date.now()): string {
  if (!creationTimestamp) return "<unknown>";
  const then = Date.parse(creationTimestamp);
  if (Number.isNaN(then)) return "<unknown>";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** Render a fixed-width table. `columns` is header → per-row value. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export function renderKubeTable(rows: KubeRow[], opts: { allNamespaces: boolean; wide: boolean; showVerdict: boolean }): string {
  if (rows.length === 0) return "No resources found.";
  const headers: string[] = [];
  if (opts.allNamespaces) headers.push("NAMESPACE");
  headers.push("NAME", "STATUS", "AGE");
  if (opts.showVerdict) headers.push("CHANT");
  if (opts.wide) headers.push("LABELS");

  const cells = rows.map((r) => {
    const row: string[] = [];
    if (opts.allNamespaces) row.push(r.namespace ?? "");
    row.push(r.name, r.status, r.age ?? "<unknown>");
    if (opts.showVerdict) row.push(r.verdict ?? "unavailable");
    if (opts.wide) row.push(labelsText(r.labels));
    return row;
  });

  return renderTable(headers, cells);
}

function labelsText(labels: Record<string, string> | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return "<none>";
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

// ── json / yaml / name ─────────────────────────────────────────────────────

/** kubectl wraps >1 item in a synthetic List; a single item is printed bare. */
function asPrintable(objects: readonly K8sObject[]): unknown {
  if (objects.length === 1) return objects[0];
  return { apiVersion: "v1", kind: "List", items: objects, metadata: {} };
}

export function renderJson(objects: readonly K8sObject[]): string {
  return JSON.stringify(asPrintable(objects), null, 2);
}

export function renderYaml(objects: readonly K8sObject[]): string {
  return dump(asPrintable(objects));
}

/** `kubectl get -o name`: `<lowercased-kind>.<group>/<name>` (`<lowercased-kind>/<name>` for the core group). */
export function renderName(objects: readonly K8sObject[]): string {
  return objects
    .map((o) => {
      const [group] = (o.apiVersion ?? "").includes("/") ? [o.apiVersion!.split("/")[0]] : [""];
      const kind = (o.kind ?? "").toLowerCase();
      const prefix = group ? `${kind}.${group}` : kind;
      return `${prefix}/${o.metadata?.name ?? ""}`;
    })
    .join("\n");
}

// ── -o chant ────────────────────────────────────────────────────────────────

/** Render live objects as the typed chant source that would declare them. */
export function renderChantSource(objects: readonly K8sObject[]): string {
  const ir = buildExportFromObjects(objects as unknown[]);
  const files = new K8sGenerator().generate(ir);
  return files.map((f) => f.content).join("\n\n");
}

// ── jsonpath (subset) ───────────────────────────────────────────────────────

type PathSegment = { key: string } | { index: number } | { wildcard: true };

function parsePath(path: string): PathSegment[] {
  // ".a.b[0].c[*]" → segments; a leading "." (or none) both mean "from root".
  const segments: PathSegment[] = [];
  const re = /\.([^.[\]]+)|\[(\*|\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path))) {
    if (match[1] !== undefined) segments.push({ key: match[1] });
    else if (match[2] === "*") segments.push({ wildcard: true });
    else segments.push({ index: Number(match[2]) });
  }
  return segments;
}

function evalPath(root: unknown, segments: readonly PathSegment[]): unknown[] {
  let current: unknown[] = [root];
  for (const seg of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;
      if ("wildcard" in seg) {
        if (Array.isArray(value)) next.push(...value);
        else if (typeof value === "object") next.push(...Object.values(value as Record<string, unknown>));
        continue;
      }
      if ("index" in seg) {
        if (Array.isArray(value)) next.push(value[seg.index]);
        continue;
      }
      if (typeof value === "object") next.push((value as Record<string, unknown>)[seg.key]);
    }
    current = next;
  }
  return current;
}

function scalarText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Evaluate a kubectl-style jsonpath template against one root value: literal
 * text passes through, `{"..."}` is a quoted literal, `{.a.b[*].c}` extracts
 * and space-joins matches. Multiple `{...}` blocks concatenate directly, as
 * kubectl's own `-o jsonpath` does.
 */
export function evalJsonPath(template: string, root: unknown): string {
  let out = "";
  const re = /\{([^}]*)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template))) {
    out += template.slice(lastIndex, match.index);
    const inner = match[1];
    if (inner.startsWith('"') && inner.endsWith('"')) {
      out += inner.slice(1, -1);
    } else {
      const segments = parsePath(inner);
      out += evalPath(root, segments).map(scalarText).join(" ");
    }
    lastIndex = match.index + match[0].length;
  }
  out += template.slice(lastIndex);
  return out;
}

/** `-o jsonpath=`: kubectl runs the whole template once per top-level object printed. */
export function renderJsonPath(expr: string, objects: readonly K8sObject[]): string {
  const root = asPrintable(objects);
  return evalJsonPath(expr, root);
}

// ── custom-columns ──────────────────────────────────────────────────────────

interface ColumnSpec {
  header: string;
  path: PathSegment[];
}

function parseCustomColumns(spec: string): ColumnSpec[] {
  return spec.split(",").map((entry) => {
    const colon = entry.indexOf(":");
    if (colon === -1) throw new Error(`custom-columns entry "${entry}" is missing ":" — expected HEADER:.json.path`);
    const header = entry.slice(0, colon);
    const path = entry.slice(colon + 1);
    return { header, path: parsePath(path.startsWith(".") ? path : `.${path}`) };
  });
}

export function renderCustomColumns(spec: string, objects: readonly K8sObject[]): string {
  const columns = parseCustomColumns(spec);
  const headers = columns.map((c) => c.header);
  const rows = objects.map((o) => columns.map((c) => evalPath(o, c.path).map(scalarText).join(",") || "<none>"));
  return renderTable(headers, rows);
}

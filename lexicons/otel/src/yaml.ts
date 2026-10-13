/**
 * The collector YAML emitter.
 *
 * Its style is the one collector configs are usually written in, and the one
 * the k8s lexicon's `GkeOtelCollector` wrote by hand before it moved onto this
 * lexicon:
 *
 * - top-level sections in the order receivers, processors, exporters,
 *   connectors, extensions, service, separated by a blank line;
 * - two-space indent;
 * - a list of scalars in flow style (`receivers: [otlp, batch]`), any other
 *   list in block style with `- ` indented under its key;
 * - strings plain where YAML reads them back as the same string, double-quoted
 *   otherwise (`"true"`, `"8080"`, `"a: b"`, `"${env:X}"` inside a flow list).
 *
 * The output always parses back to the value it was given.
 */

import type { CollectorConfig } from "./model";

const SECTION_ORDER = ["receivers", "processors", "exporters", "connectors", "extensions", "service"] as const;

const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~"]);
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** True when `s` can be written unquoted and still read back as the string `s`. */
export function isPlainSafe(s: string, flow: boolean): boolean {
  if (s === "") return false;
  if (/^\s|\s$/.test(s)) return false;
  if (/[\n\r\t\u0000-\u001f\u007f]/.test(s)) return false;
  if (RESERVED.has(s.toLowerCase())) return false;
  if (!Number.isNaN(Number(s))) return false;
  if (/^[-+]?\.(inf|nan)$/i.test(s)) return false;
  if (/^0[xob]/i.test(s)) return false;
  if (/^\d+(:\d+)+$/.test(s)) return false;
  if (LEADING_INDICATOR.test(s)) return false;
  if (s.includes(": ") || s.includes(" #") || s.endsWith(":")) return false;
  if (flow && /[,[\]{}]/.test(s)) return false;
  return true;
}

function scalar(v: unknown, flow: boolean): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : JSON.stringify(String(v));
  if (typeof v === "string") return isPlainSafe(v, flow) ? v : JSON.stringify(v);
  return JSON.stringify(String(v));
}

function key(k: string): string {
  return isPlainSafe(k, false) ? k : JSON.stringify(k);
}

function emitMap(obj: Record<string, unknown>, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const kk = key(k);
    if (v === null) {
      out.push(`${pad}${kk}:`);
    } else if (isPlainObject(v)) {
      if (Object.values(v).every((x) => x === undefined)) {
        out.push(`${pad}${kk}: {}`);
      } else {
        out.push(`${pad}${kk}:`);
        emitMap(v, indent + 2, out);
      }
    } else if (Array.isArray(v)) {
      emitList(kk, v, indent, out);
    } else {
      out.push(`${pad}${kk}: ${scalar(v, false)}`);
    }
  }
}

function emitList(kk: string, list: unknown[], indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (list.length === 0) {
    out.push(`${pad}${kk}: []`);
    return;
  }
  if (list.every((x) => isScalar(x))) {
    out.push(`${pad}${kk}: [${list.map((x) => scalar(x, true)).join(", ")}]`);
    return;
  }
  out.push(`${pad}${kk}:`);
  for (const item of list) emitItem(item, indent + 2, out);
}

function emitItem(item: unknown, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (isPlainObject(item) && Object.values(item).some((x) => x !== undefined)) {
    const lines: string[] = [];
    emitMap(item, indent + 2, lines);
    lines[0] = `${pad}- ${lines[0].slice(indent + 2)}`;
    out.push(...lines);
  } else if (isPlainObject(item)) {
    out.push(`${pad}- {}`);
  } else if (Array.isArray(item)) {
    if (item.length === 0) {
      out.push(`${pad}- []`);
    } else if (item.every((x) => isScalar(x))) {
      out.push(`${pad}- [${item.map((x) => scalar(x, true)).join(", ")}]`);
    } else {
      out.push(`${pad}-`);
      for (const inner of item) emitItem(inner, indent + 2, out);
    }
  } else {
    out.push(`${pad}- ${scalar(item, false)}`);
  }
}

export interface EmitOptions {
  /** Comment lines (without `# `) written above the config. */
  header?: string[];
}

/** Print a collector config as YAML. Empty sections are left out. */
export function emitCollectorYaml(config: CollectorConfig, options: EmitOptions = {}): string {
  const blocks: string[] = [];
  if (options.header && options.header.length > 0) {
    blocks.push(options.header.map((l) => `# ${l}`).join("\n"));
  }
  const cfg = config as Record<string, unknown>;
  const known = new Set<string>(SECTION_ORDER);
  const order = [...SECTION_ORDER, ...Object.keys(cfg).filter((k) => !known.has(k))];
  for (const section of order) {
    const value = cfg[section];
    if (value === undefined) continue;
    if (isPlainObject(value) && Object.values(value).every((x) => x === undefined)) continue;
    const lines: string[] = [];
    emitMap({ [section]: value }, 0, lines);
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0) return "";
  return `${blocks.join("\n\n")}\n`;
}

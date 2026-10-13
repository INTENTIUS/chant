/** How the importers report what they could not carry: warnings, and the edits that make the source equal the rebuilt output. */

import type { ImportEdit } from "./edits";

/** `a`, `a and b`, `a, b and c`. */
export function list(keys: string[]): string {
  return keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
}

/** Collects edits, and warnings grouped by what they are about. */
export class Report {
  readonly edits: ImportEdit[] = [];
  private readonly headlines: string[] = [];
  private readonly grouped = new Map<string, { subject: string; keys: string[]; why: string; kind: "drop" | "replace" }>();

  /** A warning of its own. */
  warn(message: string): void {
    this.headlines.push(message);
  }

  /** `key` of `subject`, at `path`, is not carried. No warning when `why` is undefined (it is at Grafana's default). */
  drop(path: string, subject: string, key: string, why?: string): void {
    this.edits.push({ op: "remove", path });
    if (why !== undefined) this.note("drop", subject, key, why);
  }

  /**
   * The value at `path` is written as `value`. No warning when `why` is
   * undefined (Grafana reads both the same); otherwise the warning reads
   * `<subject>: <key> <why>`.
   */
  replace(path: string, value: unknown, subject: string, key: string, why?: string): void {
    this.edits.push({ op: "replace", path, value });
    if (why !== undefined) this.note("replace", subject, key, why);
  }

  edit(edit: ImportEdit): void {
    this.edits.push(edit);
  }

  private note(kind: "drop" | "replace", subject: string, key: string, why: string): void {
    const k = `${kind}\u0000${subject}\u0000${why}`;
    const g = this.grouped.get(k) ?? { subject, keys: [], why, kind };
    g.keys.push(key);
    this.grouped.set(k, g);
  }

  warnings(): string[] {
    const out = [...this.headlines];
    for (const g of this.grouped.values()) {
      const n = g.keys.length;
      const why = g.why === NO_PROP ? `(no prop takes ${n === 1 ? "it" : "them"})` : g.why;
      if (n === 0 || g.keys[0] === "") out.push(`${g.subject} ${why}`);
      else if (g.kind === "replace") out.push(`${g.subject}: ${list(g.keys)} ${why}`);
      else out.push(`${g.subject}: ${list(g.keys)} ${n === 1 ? "is" : "are"} not carried ${why}`);
    }
    return out;
  }
}

/** The `why` of a key no prop takes. */
export const NO_PROP = "(no prop takes it)";

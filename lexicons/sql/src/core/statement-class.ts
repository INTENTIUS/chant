/**
 * What the statement classifiers (`../clickhouse/plan/statements.ts`,
 * `../postgres/plan/statements.ts`) answer, in one shape for both dialects
 * (#4407). They read a migration file's statements offline and give each the
 * class the schema-diff classifier gives the same change, citing its rule.
 * Nothing runs against a server.
 */

import type { ClassifierRule } from "./classifier";

/** One change a statement makes, under one rule. */
export interface StatementClassified {
  rule: string;
  /** The rule's class, e.g. `rebuild`, `concurrently`. */
  class: string;
  /** The class as a report names it, e.g. `REBUILD`. */
  label: string;
  title: string;
  /** Postgres: the lock the rule's restriction names, e.g. `SHARE`. */
  lock?: string;
  /** Data is removed and not recoverable. */
  destructive?: boolean;
  note?: string;
}

/**
 * - `classified`: every change has a rule.
 * - `undecided`: the statement alone cannot say which of `candidates` applies
 *   (a column type change is a rewrite, or a rebuild when the column is in a
 *   key); the answer `classifyDisruption()` calls `unknown`.
 * - `unclassified`: a schema change no rule covers; `note` says what.
 * - `data`: the statement reads or writes rows or the session, not the schema.
 */
export type StatementOutcome = "classified" | "undecided" | "unclassified" | "data";

export interface StatementVerdict {
  /** 1-based position among the file's up statements. */
  index: number;
  /** The statement's first line, cut to 120 characters. */
  sql: string;
  outcome: StatementOutcome;
  /** `classified`: one entry per change in the statement (an `ALTER TABLE` can hold several). */
  changes: StatementClassified[];
  /** `undecided`: the rules that could apply, in the order a reader should weigh them. */
  candidates?: StatementClassified[];
  note?: string;
}

/** A statement's own text cut for a note: the first line, at most 120 characters. */
export function sqlHead(sql: string): string {
  const line = sql.split(/\r?\n/).find((l) => l.trim() !== "" && !l.trim().startsWith("--")) ?? sql;
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

/** The pieces of a classified change from a dialect's rule table. */
export function classifiedOf<C extends string>(
  rules: Readonly<Record<string, ClassifierRule<C>>>,
  labels: Readonly<Record<C, string>>,
  id: string,
  extra: Partial<StatementClassified> = {},
): StatementClassified {
  const r = rules[id];
  if (!r) throw new Error(`no classifier rule ${id}`);
  return { rule: id, class: r.class, label: labels[r.class], title: r.title, ...extra };
}

/** Lock names, longest first so `SHARE UPDATE EXCLUSIVE` is not read as `SHARE`. */
const LOCK = /\b(ACCESS EXCLUSIVE|SHARE UPDATE EXCLUSIVE|SHARE ROW EXCLUSIVE|ROW EXCLUSIVE|ROW SHARE|EXCLUSIVE|SHARE)\b/;

/** The first lock a rule's restriction names, or undefined when it names none. */
export const lockOf = (restriction: string): string | undefined => LOCK.exec(restriction)?.[1];

/**
 * Split a statement's tokens' text into the pieces between top-level commas
 * (an `ALTER TABLE`'s actions). Parentheses and brackets nest.
 */
export function splitTopLevel(words: readonly string[]): string[][] {
  const out: string[][] = [[]];
  let depth = 0;
  for (const w of words) {
    if (w === "(" || w === "[") depth++;
    else if (w === ")" || w === "]") depth--;
    if (w === "," && depth === 0) out.push([]);
    else out[out.length - 1]!.push(w);
  }
  return out.filter((a) => a.length > 0);
}

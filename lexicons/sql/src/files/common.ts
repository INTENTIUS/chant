/** What reading a file of DDL shares across dialects. */

import type { Token } from "../core/tokens";

export interface ReadOptions {
  /** Names the DDL in errors: a file's path, a command. */
  origin: string;
  /**
   * The Postgres schema (ClickHouse database) for the names the DDL leaves
   * unqualified, as an ORM does when the schema comes from its connection.
   */
  schema?: string;
}

/** A file of DDL with statements that declare nothing chant can hold: each problem names its statement. */
export class SqlFileError extends Error {
  constructor(
    readonly origin: string,
    readonly problems: readonly string[],
  ) {
    super(
      `${origin}: ${problems.length === 1 ? "a statement" : `${String(problems.length)} statements`} chant cannot read as declarations:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "SqlFileError";
  }
}

/** The statements of a file, each as its tokens (trivia kept inside, trimmed at the ends), split on top-level `;`. */
export function splitTokens(tokens: readonly Token[], isTrivia: (t: Token) => boolean): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  const flush = () => {
    let from = 0;
    let to = current.length;
    while (from < to && isTrivia(current[from]!)) from++;
    while (to > from && isTrivia(current[to - 1]!)) to--;
    if (to > from) out.push(current.slice(from, to));
    current = [];
  };
  for (const t of tokens) {
    if (t.kind === "punct" && t.text === ";") flush();
    else current.push(t);
  }
  flush();
  return out;
}

export const tokensText = (tokens: readonly Token[]): string => tokens.map((t) => t.text).join("");

/** A statement's first line, for a message. */
export const firstLine = (s: string): string => (s.split("\n")[0] ?? "").slice(0, 100);

/** A name as SQL text: bare when it is a plain lower-case identifier, else double-quoted. */
export const quoteBare = (name: string): string => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/**
 * The tagged-template plumbing every dialect's tags share: reading a
 * template's raw parts, what a non-reference interpolation splices in, and
 * the error a tag throws with the template line it happened on.
 *
 * Tokenizing and parsing the spliced statement is the dialect's own.
 */

/** A spliced value meant as a string literal. A dialect's `literal()` makes one with its own quoting. */
export class SqlLiteral {
  constructor(readonly sql: string) {
    Object.freeze(this);
  }
}

/** An error from a tag: the statement kind, the template line, and what went wrong. */
export class SqlTemplateError extends Error {
  constructor(
    tag: string,
    message: string,
    readonly part: number,
    readonly offset: number,
  ) {
    super(`${tag}\`...\`: ${message}`);
    this.name = "SqlTemplateError";
  }
}

/**
 * A template's parts as the SQL reads them: the raw text, so a backslash in a
 * regex or an escape stays as written, with the two escapes a template
 * literal forces undone. `` \` `` is a backquote and `\${` is `${`; neither
 * can be written in a template any other way.
 */
export function templateParts(strings: TemplateStringsArray | readonly string[]): string[] {
  const raw = (strings as TemplateStringsArray).raw ?? strings;
  return raw.map(unescapeTemplateDelimiters);
}

export function unescapeTemplateDelimiters(part: string): string {
  return part.replace(/\\(`|\$\{)/g, "$1");
}

/** Where interpolation `index` sits in the template, for a message: the line of the template it is on. */
export function interpolationLine(parts: readonly string[], index: number): number {
  return parts.slice(0, index + 1).join("${}").split("\n").length;
}

/** A value's kind, for a message. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? `an object (${Object.prototype.toString.call(value)})` : `a ${typeof value}`;
}

/**
 * The SQL text a non-reference value splices in, or an error message: a
 * string is SQL text, a number, bigint or boolean its literal, `null` is
 * `NULL`, a {@link SqlLiteral} its quoted form. Anything else has no SQL form.
 */
export function spliceText(value: unknown): string | { error: string } {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : { error: `the number ${value} has no SQL form` };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "NULL";
  if (value instanceof SqlLiteral) return value.sql;
  if (value === undefined) {
    return {
      error:
        "undefined. A column is referenced through `.columns` (`${events.columns.user_id}`, not " +
        "`${events.user_id}`), and a column name that does not exist is undefined too",
    };
  }
  return { error: `${describeValue(value)}, which has no SQL form` };
}

/** `o` without its `undefined` and `false` fields, so props hold only what the DDL says. */
export const stripUnset = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false)) as T;

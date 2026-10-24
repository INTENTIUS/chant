/**
 * Typed filters for the contract reads (#4363): `--where <field><op><value>`
 * and `--since <time>`, in place of an embedded SQL engine.
 *
 * Each read declares the fields it can be filtered on and their types
 * ({@link FilterFields}). A clause naming a field the read doesn't declare, an
 * operator its type doesn't take, or a value that isn't of its type is a
 * {@link FilterError} before anything is read, so a typo never filters to an
 * empty answer. Several `--where` clauses all have to hold.
 *
 * Operators: `=` and `!=` for every type; `<`, `<=`, `>` and `>=` for
 * numbers, times and text (text compares by code point); `~` for text, which
 * holds when the field contains the value. The value `null` matches a field
 * that is null or absent, with `=` and `!=` only.
 *
 * A field of type `json` holds an object: a clause can name a key under it
 * with dots (`labels.team=core`), and the value is compared as the type it
 * holds there (a number with a number, a boolean with `true` or `false`, any
 * other value as text). A JSON text is parsed first, so a ledger row that
 * keeps the object as text filters the same way.
 *
 * A null or absent field matches only `=null` and `!=` with a value other
 * than null; the other operators never hold for it.
 *
 * Pure: no I/O, so a bundle that filters rows loads nothing else.
 */

export type FilterFieldType = "text" | "number" | "boolean" | "time" | "json";

/** The fields a read can be filtered on, by name, with their types. */
export type FilterFields = Readonly<Record<string, FilterFieldType>>;

/** Every operator, longest first so `!=` is not read as `=`. */
export const WHERE_OPERATORS = ["!=", "<=", ">=", "=", "<", ">", "~"] as const;
export type WhereOperator = (typeof WHERE_OPERATORS)[number];

/** One parsed `--where` clause. */
export interface WhereClause {
  /** The field as written, with any path under a `json` field. */
  field: string;
  /** The declared field the clause starts at. */
  base: string;
  /** The keys under a `json` field, or `[]`. */
  path: string[];
  type: FilterFieldType;
  op: WhereOperator;
  /** The value as written. */
  raw: string;
  /** The value read as the field's type: a number for `number` and `time` (epoch ms), a boolean, a string, or null. */
  value: string | number | boolean | null;
}

/** A clause or a `--since` that can't be applied. The message is for a person. */
export class FilterError extends Error {}

const ORDERED: readonly WhereOperator[] = ["<", "<=", ">", ">="];

/**
 * An instant from an ISO 8601 date or time, or from a span back from `now`:
 * `<n>m`, `<n>h`, `<n>d` or `<n>w`. Epoch milliseconds, or null when `text`
 * is neither.
 */
export function parseInstant(text: string, now: Date = new Date()): number | null {
  const span = /^(\d+)([mhdw])$/.exec(text.trim());
  if (span) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[span[2] as "m" | "h" | "d" | "w"];
    return now.getTime() - Number(span[1]) * unit;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(text.trim())) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/** `--since <time>` as an ISO instant, or a {@link FilterError}. */
export function parseSince(text: string, now: Date = new Date()): string {
  const ms = parseInstant(text, now);
  if (ms === null) throw new FilterError(`--since takes an ISO 8601 date or time, or a span back from now such as 24h or 7d, not ${JSON.stringify(text)}`);
  return new Date(ms).toISOString();
}

/** The declared field a dotted name starts at: the whole name, or its longest declared `json` prefix. */
function resolveField(name: string, fields: FilterFields): { base: string; path: string[]; type: FilterFieldType } | null {
  if (Object.prototype.hasOwnProperty.call(fields, name)) return { base: name, path: [], type: fields[name] };
  const parts = name.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const base = parts.slice(0, i).join(".");
    if (Object.prototype.hasOwnProperty.call(fields, base) && fields[base] === "json") return { base, path: parts.slice(i), type: "json" };
  }
  return null;
}

/** Parse each `--where` against the fields a read declares. Throws a {@link FilterError}. */
export function parseWhere(exprs: readonly string[], fields: FilterFields, now: Date = new Date()): WhereClause[] {
  const names = Object.keys(fields).join(", ");
  return exprs.map((expr) => {
    const m = /^([A-Za-z_][\w.-]*)\s*(!=|<=|>=|=|<|>|~)(.*)$/s.exec(expr);
    if (!m) throw new FilterError(`--where takes <field><op><value>, with op one of ${WHERE_OPERATORS.join(" ")}, not ${JSON.stringify(expr)}`);
    const [, field, op, rawValue] = m as unknown as [string, string, WhereOperator, string];
    const raw = rawValue.trim();
    const found = resolveField(field, fields);
    if (!found) throw new FilterError(`--where ${field}: no such field; this read filters on ${names}`);
    const { base, path, type } = found;
    if (type === "json" && path.length === 0) throw new FilterError(`--where ${field}: holds an object; name a key under it, such as ${field}.<key>`);
    const clause = (value: WhereClause["value"]): WhereClause => ({ field, base, path, type, op, raw, value });
    if (raw === "null") {
      if (op !== "=" && op !== "!=") throw new FilterError(`--where ${field}${op}null: null takes = or != only`);
      return clause(null);
    }
    if (op === "~" && type !== "text" && type !== "json") throw new FilterError(`--where ${field}~: ~ (contains) takes a text field; ${field} is ${type}`);
    switch (type) {
      case "number": {
        const n = Number(raw);
        if (raw === "" || !Number.isFinite(n)) throw new FilterError(`--where ${field}: ${field} is a number, not ${JSON.stringify(raw)}`);
        return clause(n);
      }
      case "boolean": {
        if (ORDERED.includes(op)) throw new FilterError(`--where ${field}${op}: a boolean takes = or != only`);
        if (raw !== "true" && raw !== "false") throw new FilterError(`--where ${field}: ${field} is true or false, not ${JSON.stringify(raw)}`);
        return clause(raw === "true");
      }
      case "time": {
        const ms = parseInstant(raw, now);
        if (ms === null) throw new FilterError(`--where ${field}: ${field} is a time; give an ISO 8601 date or time, or a span back from now such as 24h or 7d, not ${JSON.stringify(raw)}`);
        return clause(ms);
      }
      default:
        return clause(raw);
    }
  });
}

/** The value at a clause's field in `row`, parsing a JSON text on the way into a `json` field. */
function valueAt(row: unknown, c: WhereClause): unknown {
  let v: unknown = row;
  for (const key of c.base.split(".")) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
  for (const key of c.path) {
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    v = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined;
  }
  return v;
}

function compare(a: number | string, b: number | string, op: WhereOperator): boolean {
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "~": return String(a).includes(String(b));
  }
}

/** Whether one clause holds for `row`. */
export function clauseHolds(row: unknown, c: WhereClause): boolean {
  const v = valueAt(row, c);
  if (c.value === null) return c.op === "=" ? v === null || v === undefined : v !== null && v !== undefined;
  if (v === null || v === undefined) return c.op === "!=";
  switch (c.type) {
    case "number":
      return typeof v === "number" && compare(v, c.value as number, c.op);
    case "boolean":
      return typeof v === "boolean" ? (c.op === "=") === (v === c.value) : false;
    case "time": {
      const ms = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
      return !Number.isNaN(ms) && compare(ms, c.value as number, c.op);
    }
    case "text":
      return typeof v === "string" && compare(v, c.value as string, c.op);
    case "json": {
      // Compared as the type the value holds there.
      if (typeof v === "number" && c.op !== "~") {
        const n = Number(c.raw);
        return Number.isFinite(n) && compare(v, n, c.op);
      }
      if (typeof v === "boolean") return (c.raw === "true" || c.raw === "false") && (c.op === "=" || c.op === "!=") ? (c.op === "=") === (String(v) === c.raw) : false;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return compare(s, c.raw, c.op);
    }
  }
}

/** Whether every clause holds for `row`. */
export function matchesWhere(row: unknown, clauses: readonly WhereClause[]): boolean {
  return clauses.every((c) => clauseHolds(row, c));
}

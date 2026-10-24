/**
 * The Postgres to ClickHouse type map (#4399).
 *
 * A type either maps with no judgment (`note` absent) or carries a `note`
 * naming what the map could not keep. Only the first kind is mechanical: the
 * translator writes no diagnostic for it. A type this file does not know (an
 * enum, a domain, an extension type) maps to `String` with a note, because a
 * mirror still has to hold the value.
 *
 * Source types and defaults are from the Postgres data types chapter
 * (https://www.postgresql.org/docs/current/datatype.html): `timestamp` and
 * `time` take a precision of 0 to 6 and default to microseconds, `numeric`
 * with no precision holds any value, `money` is a fixed-point type with a
 * locale-set scale, `float(n)` is `real` for n up to 24 and `double
 * precision` above.
 *
 * Target types are ClickHouse types of the pinned server (`../../spec/pin.ts`);
 * `types.test.ts` checks every family this file writes against the generated
 * catalog.
 */

export interface MappedType {
  ok: true;
  /** The ClickHouse type, before `Nullable`. */
  type: string;
  /** The declared maximum length of a character type, when it has one. */
  maxLength?: number;
  /** The column is `serial`, `bigserial` or `smallserial`: an integer with a sequence behind it. */
  serial?: boolean;
  /** The column is an array. ClickHouse cannot make an `Array` `Nullable`. */
  array?: boolean;
  /** Present when the map is a judgment: what was lost or chosen. */
  note?: { message: string; evidence: string[] };
}

export type TypeMapping = MappedType;

interface ParsedType {
  /** Lower case words of the type, schema prefix and quotes removed: `timestamp with time zone`. */
  base: string;
  args: number[];
  /** Array dimensions. */
  dims: number;
  raw: string;
}

/** Split a column type as written into its words, its parenthesised arguments and its array dimensions. */
export function parseType(text: string): ParsedType {
  let rest = text.trim();
  let dims = 0;
  for (;;) {
    const m = /\s*\[\s*\d*\s*\]\s*$/.exec(rest);
    if (!m) break;
    rest = rest.slice(0, m.index);
    dims++;
  }
  const arrayWord = /\s+array(\s*\[\s*\d*\s*\])?$/i.exec(rest);
  if (arrayWord) {
    rest = rest.slice(0, arrayWord.index);
    dims++;
  }
  const args: number[] = [];
  rest = rest.replace(/\(([^)]*)\)/g, (_all, inner: string) => {
    for (const part of inner.split(",")) {
      const n = Number(part.trim());
      if (Number.isFinite(n)) args.push(n);
    }
    return " ";
  });
  const base = rest
    .replace(/"/g, "")
    .replace(/^pg_catalog\./i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return { base, args, dims, raw: text.trim() };
}

const STRING_NOTE = (what: string, evidence: string[]) => ({ message: `${what} is read as String.`, evidence });

function mapScalar(t: ParsedType): MappedType {
  const { base, args } = t;
  switch (base) {
    case "smallint":
    case "int2":
      return { ok: true, type: "Int16" };
    case "integer":
    case "int":
    case "int4":
      return { ok: true, type: "Int32" };
    case "bigint":
    case "int8":
      return { ok: true, type: "Int64" };
    case "smallserial":
    case "serial2":
      return { ok: true, type: "Int16", serial: true };
    case "serial":
    case "serial4":
      return { ok: true, type: "Int32", serial: true };
    case "bigserial":
    case "serial8":
      return { ok: true, type: "Int64", serial: true };
    case "real":
    case "float4":
      return { ok: true, type: "Float32" };
    case "double precision":
    case "float8":
      return { ok: true, type: "Float64" };
    case "float":
      return { ok: true, type: (args[0] ?? 53) <= 24 ? "Float32" : "Float64" };
    case "numeric":
    case "decimal": {
      if (args.length === 0) {
        return {
          ok: true,
          type: "Decimal(38, 18)",
          note: {
            message: "numeric with no precision is read as Decimal(38, 18).",
            evidence: ["Postgres stores up to 131072 digits before the point and 16383 after; a ClickHouse Decimal has a fixed precision and scale", "a value that does not fit fails the insert"],
          },
        };
      }
      const p = args[0]!;
      const s = args[1] ?? 0;
      if (p > 76 || s < 0 || s > p) {
        return {
          ok: true,
          type: "Decimal(76, 38)",
          note: { message: `numeric(${String(p)}, ${String(s)}) is read as Decimal(76, 38).`, evidence: ["ClickHouse Decimal holds at most 76 digits"] },
        };
      }
      return { ok: true, type: `Decimal(${String(p)}, ${String(s)})` };
    }
    case "money":
      return {
        ok: true,
        type: "Decimal(19, 2)",
        note: { message: "money is read as Decimal(19, 2).", evidence: ["money takes its scale from the lc_monetary setting of the source server, and two decimals is the common one"] },
      };
    case "boolean":
    case "bool":
      return { ok: true, type: "Bool" };
    case "text":
    case "varchar":
    case "character varying":
    case "name":
    case "citext":
      return { ok: true, type: "String", ...(args[0] !== undefined ? { maxLength: args[0] } : {}) };
    case "char":
    case "character":
    case "bpchar":
      return {
        ok: true,
        type: "String",
        ...(args[0] !== undefined ? { maxLength: args[0] } : {}),
        ...(args[0] !== undefined && args[0] > 1 ? { note: STRING_NOTE("char(n)", ["Postgres pads a char(n) value with spaces to n characters; a String keeps the value as it is loaded"]) } : {}),
      };
    case "bytea":
      return { ok: true, type: "String" };
    case "uuid":
      return { ok: true, type: "UUID" };
    case "date":
      return { ok: true, type: "Date32" };
    case "time":
    case "time without time zone":
      return { ok: true, type: `Time64(${String(args[0] ?? 6)})` };
    case "timetz":
    case "time with time zone":
      return { ok: true, type: "String", note: STRING_NOTE("timetz", ["a time of day with an offset has no ClickHouse type; the offset is kept in the text"]) };
    case "timestamp":
    case "timestamp without time zone":
      return { ok: true, type: `DateTime64(${String(args[0] ?? 6)})` };
    case "timestamptz":
    case "timestamp with time zone":
      return { ok: true, type: `DateTime64(${String(args[0] ?? 6)}, 'UTC')` };
    case "interval":
      return { ok: true, type: "String", note: STRING_NOTE("interval", ["a ClickHouse Interval type cannot be stored in a column", "the value is kept as Postgres prints it"]) };
    case "json":
    case "jsonb":
      return { ok: true, type: "JSON" };
    case "oid":
      return { ok: true, type: "UInt32" };
    case "inet":
    case "cidr":
      return {
        ok: true,
        type: "IPv6",
        note: { message: `${base} is read as IPv6.`, evidence: ["an IPv6 column holds an IPv4 address in its mapped form", "the prefix length of a network is not kept"] },
      };
    case "xml":
    case "macaddr":
    case "macaddr8":
    case "tsvector":
    case "tsquery":
    case "bit":
    case "bit varying":
    case "varbit":
    case "point":
    case "line":
    case "lseg":
    case "box":
    case "path":
    case "polygon":
    case "circle":
      return { ok: true, type: "String", note: STRING_NOTE(base, [`ClickHouse has no ${base} type`, "the value is kept as Postgres prints it"]) };
    default:
      return {
        ok: true,
        type: "String",
        note: STRING_NOTE(t.raw, [`${t.raw} is not a built-in type chant maps (an enum, a domain, a composite or an extension type)`, "the value is kept as Postgres prints it; an enum could be an Enum8 or Enum16 once its labels are settled"]),
      };
  }
}

/** Map a column type as the declaration wrote it. */
export function mapPostgresType(text: string): TypeMapping {
  const t = parseType(text);
  const inner = mapScalar(t);
  if (t.dims === 0) return inner;
  let type = inner.type;
  for (let i = 0; i < t.dims; i++) type = `Array(${type})`;
  return {
    ok: true,
    type,
    array: true,
    ...(inner.serial ? { serial: true } : {}),
    note: {
      message: `${t.raw} is read as ${type}.`,
      evidence: [
        ...(inner.note ? [inner.note.message] : []),
        "ClickHouse cannot make an Array Nullable, so a NULL array is stored as an empty one",
        "Postgres does not enforce the declared dimensions or lengths of an array",
      ],
    },
  };
}

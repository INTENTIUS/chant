import { checkOf, tablesOf } from "./postgres-helpers";
import { parametersOf, parseType, projectOf, resolveType, typeLabel, type ParsedType, type PgProject } from "./postgres-names";

/**
 * SQLPG120: a type modifier that does not fit the type.
 *
 * Doc: https://www.postgresql.org/docs/18/datatype-numeric.html,
 * https://www.postgresql.org/docs/18/datatype-character.html,
 * https://www.postgresql.org/docs/18/datatype-datetime.html,
 * https://www.postgresql.org/docs/18/datatype-bit.html. The server refuses a
 * modifier on a type that takes none (`bigint(8)`), `numeric` precision
 * outside 1 to 1000 or scale outside -1000 to 1000 (0 to the precision before
 * 15), `varchar(n)` or `char(n)` outside 1 to 10485760, `timestamp`, `time`
 * or `interval` precision outside 0 to 6, `bit(n)` below 1, and `float(p)`
 * outside 1 to 53. The parameters and ranges are the lexicon's type overlay.
 * Only built-in types are checked: a declared or extension type's modifiers
 * are its own (`geometry(Point, 4326)`).
 */
export const sqlpg120 = checkOf({ id: "SQLPG120", description: "A type modifier that does not fit the type" }, (ctx, report) => {
  const p = projectOf(ctx);
  const check = (entity: string, sqlName: string, what: string, text: string | undefined, serial: boolean) => {
    const t = parseType(text);
    if (!t) return;
    const problem = modifierProblem(p, t, serial);
    if (problem) report({ severity: "error", message: `${entity} (${sqlName}) ${what} ${text!.trim()}: ${problem}`, entity });
  };
  for (const t of tablesOf(ctx)) for (const c of t.columns) check(t.export, t.sqlName, `column ${c.name} has type`, c.type, true);
  for (const o of p.objects) {
    if (o.type === "Postgres::Domain") check(o.export, o.sqlName as string, "is a domain over", o.dataType as string | undefined, false);
    if (o.type === "Postgres::Sequence") check(o.export, o.sqlName as string, "is a sequence of", o.dataType as string | undefined, false);
  }
});

const int = (s: string): number | undefined => (/^[+-]?\d+$/.test(s.trim()) ? Number(s.trim()) : undefined);

function modifierProblem(p: PgProject, t: ParsedType, serial: boolean): string | undefined {
  if (t.schema !== undefined || t.quoted) return undefined;
  const mods = t.modifiers;
  if (t.name === "float" && mods) {
    const n = mods.length === 1 ? int(mods[0]!) : undefined;
    if (mods.length !== 1) return "float takes one precision";
    if (n !== undefined && (n < 1 || n > 53)) return `float precision ${n} is outside 1 to 53`;
    return undefined;
  }
  const r = resolveType(p, t, { serial });
  if (r.kind !== "builtin") return undefined;
  const params = parametersOf(r.canonical);
  if (t.fields !== undefined) {
    const fields = params.find((a) => a.kind === "keyword")?.values ?? [];
    if (!fields.includes(t.fields)) return `${t.fields} is not an interval field (${fields.join(", ")})`;
  }
  if (!mods) return undefined;
  const numbers = params.filter((a) => a.kind === "number");
  if (numbers.length === 0) return `${typeLabel(t)} takes no type modifier`;
  if (mods.length > numbers.length) return `${typeLabel(t)} takes at most ${numbers.length} modifier${numbers.length === 1 ? "" : "s"}`;
  const values = mods.map(int);
  for (let i = 0; i < mods.length; i++) {
    const v = values[i];
    const spec = numbers[i]!;
    if (v === undefined || !spec.range) continue;
    let [lo, hi] = spec.range;
    // numeric's scale: 0 to the precision before 15, -1000 to 1000 since.
    if (r.canonical === "numeric" && spec.name === "scale" && p.major < 15) {
      lo = 0;
      hi = values[0] ?? hi;
    }
    if (v < lo || v > hi) return `${spec.name} ${v} is outside ${lo} to ${hi}${r.canonical === "numeric" && spec.name === "scale" && p.major < 15 ? ` at Postgres ${p.major}` : ""}`;
  }
  return undefined;
}

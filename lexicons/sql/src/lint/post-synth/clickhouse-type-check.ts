/**
 * Checking a ClickHouse column type against the pinned catalog, for SQLCH121
 * (the family), SQLCH122 (its parameters) and SQLCH123 (a wrapper the server
 * refuses). One walk over the type answers all three; each check keeps the
 * findings with its own id.
 *
 * Families come from `system.data_type_families` (`TYPE_FAMILIES`): a name is
 * case-sensitive unless the catalog marks it case-insensitive, and an alias
 * resolves to its family. Parameters come from the `TYPE_PARAMETERS` overlay.
 * The walk goes into every parameter that is itself a type, so `UInt46`
 * inside `Array(Map(String, UInt46))` is found.
 */

import { CLICKHOUSE_VERSION, TYPE_FAMILIES } from "../../generated/clickhouse";
import { TYPE_PARAMETERS, type TypeParameter } from "../../clickhouse/overlays/types";
import { numericParam, readType, typeTokens, type TypeParam } from "../../clickhouse/type-syntax";
import type { Token } from "../../clickhouse/tokens";
import { checkOf } from "./clickhouse-helpers";
import { clickhouseObjects, type OutputObject } from "./sql-helpers";

export interface TypeFinding {
  checkId: "SQLCH121" | "SQLCH122" | "SQLCH123";
  /** What is wrong, without the column: `UInt46 is not a type family ClickHouse 26.8.15.10 has`. */
  detail: string;
}

type FamilySpec = { canonical: string; caseInsensitive: boolean };
const FAMILIES = TYPE_FAMILIES as Readonly<Record<string, FamilySpec | undefined>>;
const FOLDED = new Map<string, FamilySpec>();
const BY_LOWER = new Map<string, string>();
for (const [name, spec] of Object.entries(FAMILIES)) {
  if (spec?.caseInsensitive) FOLDED.set(name.toLowerCase(), spec);
  BY_LOWER.set(name.toLowerCase(), name);
}

/** A family by name as the server resolves it: exactly, or in any case when the catalog marks it case-insensitive. */
export function familyOf(name: string): FamilySpec | undefined {
  return FAMILIES[name] ?? FOLDED.get(name.toLowerCase());
}

/** The MySQL-compatible words the parser keeps after a type (`INT(11) UNSIGNED`); the server ignores them. */
const MODIFIERS = new Set(["UNSIGNED", "SIGNED", "AUTO_INCREMENT", "ZEROFILL"]);

/**
 * What `Nullable(...)` cannot hold. `Tuple` is not here: the pinned server
 * takes `Nullable(Tuple(...))` when `enable_nullable_tuple_type` is on, a
 * setting of the server's profile that the build cannot see.
 */
const NOT_INSIDE_NULLABLE: Record<string, string> = {
  Array: "make the elements Nullable instead, Array(Nullable(T)), or drop Nullable: an empty array stands for no value",
  Map: "make the values Nullable instead, Map(K, Nullable(V)), or drop Nullable",
  Nested: "make the fields Nullable instead",
  LowCardinality: "write LowCardinality(Nullable(T)) instead",
  Variant: "drop Nullable: a Variant already holds NULL",
  Nullable: "drop one Nullable",
};

/** Families whose parameters are settings or expressions rather than types and literals; left to the server. */
const OPAQUE = new Set(["JSON", "Dynamic"]);

/** Families whose one repeated parameter needs at least one value. */
const NEEDS_ONE = new Set(["Enum", "Enum8", "Enum16", "Nested", "Variant"]);

const isName = (t: Token | undefined) => t?.kind === "ident" || t?.kind === "qident";

/** Every finding for one column type, in the order the walk meets them. */
export function typeFindings(type: string, version: string): TypeFinding[] {
  const tokens = typeTokens(type);
  if (!tokens) return [];
  const out: TypeFinding[] = [];
  walk(tokens, version, out);
  return out;
}

function walk(tokens: readonly Token[], version: string, out: TypeFinding[], named = false): string | undefined {
  const syntax = readType(tokens);
  if (!syntax) return undefined;
  let words = syntax.words;
  // A named tuple or Nested element, `a String`: the first word is the element's name.
  if (named && words.length >= 2 && !familyOf(words.map((w) => w.text).join(" "))) {
    const at = tokens.indexOf(words[0]!);
    return walk(tokens.slice(at + 1), version, out);
  }
  if (words.some((w) => w.kind !== "ident")) return undefined;
  // `INT UNSIGNED` is a family of its own; `Int32 UNSIGNED` is Int32 with a modifier the server ignores.
  let spec = familyOf(words.map((w) => w.text).join(" "));
  while (!spec && words.length > 1 && MODIFIERS.has(words[words.length - 1]!.text.toUpperCase())) {
    words = words.slice(0, -1);
    spec = familyOf(words.map((w) => w.text).join(" "));
  }
  const written = words.map((w) => w.text).join(" ");
  if (!spec) {
    const other = BY_LOWER.get(written.toLowerCase());
    const hint = other ? ` (it has ${other}, and that name is case-sensitive)` : "";
    out.push({ checkId: "SQLCH121", detail: `${written} is not a type family ClickHouse ${version} has${hint}` });
    return undefined;
  }
  const family = spec.canonical;
  if (OPAQUE.has(family)) return family;
  const expected: readonly TypeParameter[] = TYPE_PARAMETERS[family] ?? [];
  let params = syntax.params;
  const say = (detail: string) => out.push({ checkId: "SQLCH122", detail });

  if (params === undefined) {
    const required = expected.filter((p) => !p.optional && !p.repeated);
    if (required.length > 0) say(`${written} needs its ${required.map((p) => p.name).join(" and ")}`);
    else if (NEEDS_ONE.has(family)) say(`${written} needs at least one ${expected[0]!.name}`);
    return family;
  }
  // `AggregateFunction(1, uniq, UInt64)`: a leading number is the function's state version.
  if (family === "AggregateFunction" && params[0] && numericParam(params[0]) !== undefined) params = params.slice(1);

  if (expected.length === 0) {
    if (params.length > 0) say(`${written} takes no parameters, and ${written}(${params.map((p) => p.text).join(", ")}) gives ${params.length}`);
    return family;
  }
  const repeated = expected[expected.length - 1]!.repeated === true;
  if (!repeated && params.length > expected.length) {
    say(`${written} takes at most ${expected.length} parameter${expected.length === 1 ? "" : "s"} (${expected.map((p) => p.name).join(", ")}), and is given ${params.length}`);
    return family;
  }
  const required = expected.filter((p) => !p.optional && !p.repeated).length;
  if (params.length < required) {
    say(`${written} needs its ${expected.slice(params.length, required).map((p) => p.name).join(" and ")}`);
    return family;
  }
  if (params.length === 0 && NEEDS_ONE.has(family)) {
    say(`${written} needs at least one ${expected[0]!.name}`);
    return family;
  }

  params.forEach((param, i) => {
    const p = expected[Math.min(i, expected.length - 1)]!;
    checkParam(written, family, p, param, version, out);
  });
  return family;
}

function checkParam(written: string, family: string, p: TypeParameter, param: TypeParam, version: string, out: TypeFinding[]): void {
  if (p.kind === "number" && p.range) {
    const value = numericParam(param);
    if (value !== undefined && (value < p.range[0] || value > p.range[1])) {
      out.push({ checkId: "SQLCH122", detail: `${written} ${p.name} ${param.text} is outside ${p.range[0]} to ${p.range[1]}` });
    }
    return;
  }
  if (p.kind !== "type" && p.kind !== "named-type") return;
  const inner = walk(param.tokens, version, out, p.kind === "named-type" && isName(param.tokens.find((t) => t.kind !== "ws" && t.kind !== "comment")));
  if (family === "Nullable" && inner !== undefined && NOT_INSIDE_NULLABLE[inner]) {
    out.push({ checkId: "SQLCH123", detail: `Nullable cannot hold ${inner}; ${NOT_INSIDE_NULLABLE[inner]}` });
  }
}

/** Each declared column type in the build: tables, views that list their columns, and dictionary attributes. */
export function* columnTypes(objects: readonly OutputObject[]): Generator<{ object: OutputObject; column: string; type: string }> {
  for (const o of objects) {
    if (!/^ClickHouse::(Table|View|MaterializedView|Dictionary)$/.test(o.type)) continue;
    const columns = (o.columns ?? []) as Array<{ name: string; type?: string }>;
    for (const c of columns) if (c.type) yield { object: o, column: c.name, type: c.type };
  }
}

/** The body of one of the three type checks: every column type's findings with that id. */
export function reportTypeFindings(id: TypeFinding["checkId"]): Parameters<typeof checkOf>[1] {
  return (ctx, report) => {
    for (const { object, column, type } of columnTypes(clickhouseObjects(ctx))) {
      for (const f of typeFindings(type, CLICKHOUSE_VERSION)) {
        if (f.checkId !== id) continue;
        report({ severity: "error", message: `${object.export} (${object.name}): column ${column} ${type}: ${f.detail}`, entity: object.export });
      }
    }
  };
}

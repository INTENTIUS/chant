import { AGGREGATE_COMBINATORS, CLICKHOUSE_VERSION, FUNCTIONS, TABLE_FUNCTIONS } from "../../generated/clickhouse";
import type { FunctionSpec } from "../../clickhouse/catalog-types";
import { isTrivia, tokenizeText, type Token } from "../../clickhouse/tokens";
import { checkOf, isTable } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

const BY_NAME = FUNCTIONS as Readonly<Record<string, FunctionSpec | undefined>>;
const FOLDED = new Map<string, FunctionSpec>();
for (const [name, spec] of Object.entries(BY_NAME)) if (spec?.caseInsensitive) FOLDED.set(name.toLowerCase(), spec);

/**
 * Words followed by `(` that are not function calls: SQL keywords that take
 * parentheses, and the names ClickHouse's parser reads with a syntax of their
 * own (`EXTRACT(DAY FROM d)`, `TRIM(BOTH ' ' FROM s)`, `DATE_ADD(...)`), in
 * any case.
 */
const NOT_CALLS = new Set(
  (
    "and or not in is as on by to like ilike between case when then else end any all some global exists array interval " +
    "extract substring position trim ltrim rtrim " +
    "dateadd date_add timestamp_add timestampadd datesub date_sub timestamp_sub timestampsub datediff date_diff timestampdiff timestamp_diff " +
    "grouping over filter where set delete group with select from values distinct using asc desc nulls"
  ).split(" "),
);

/** `ZSTD(3)` after `CODEC` in a TTL `RECOMPRESS` is a codec, not a call. */
const SKIPS_GROUP = new Set(["codec"]);

const lookup = (name: string): FunctionSpec | undefined => BY_NAME[name] ?? FOLDED.get(name.toLowerCase());

const TABLE_FUNCTION_NAMES = new Set(TABLE_FUNCTIONS);

/**
 * A catalog function, or an aggregate function with combinator suffixes
 * (`countIf`, `sumState`, `uniqMerge`). A table function (`numbers`) counts
 * too: it is a name the server has, and where it does not belong is the
 * server's to say.
 */
export function isKnownFunction(name: string): boolean {
  if (lookup(name) || TABLE_FUNCTION_NAMES.has(name)) return true;
  // Strip combinators from the end, longest first, and look for an aggregate underneath.
  const suffixes = [...AGGREGATE_COMBINATORS].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const base = queue.pop()!;
    for (const s of suffixes) {
      if (base.length <= s.length || !base.endsWith(s)) continue;
      const rest = base.slice(0, -s.length);
      if (seen.has(rest)) continue;
      seen.add(rest);
      const spec = lookup(rest);
      const aggregate = spec && (spec.aggregate || (spec.aliasOf !== undefined && lookup(spec.aliasOf)?.aggregate));
      if (aggregate) return true;
      queue.push(rest);
    }
  }
  return false;
}

/** The names an expression calls: an identifier directly followed by `(`, outside strings and quoted names. */
export function calledNames(expr: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenizeText(expr, 0).filter((t) => !isTrivia(t));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    if (t.kind !== "ident" || next?.kind !== "punct" || next.text !== "(") continue;
    const prev = tokens[i - 1];
    if (prev?.kind === "punct" && prev.text === ".") continue;
    const lower = t.text.toLowerCase();
    if (SKIPS_GROUP.has(lower)) {
      let depth = 0;
      for (i = i + 1; i < tokens.length; i++) {
        const x = tokens[i]!;
        if (x.kind === "punct" && x.text === "(") depth++;
        else if (x.kind === "punct" && x.text === ")" && --depth === 0) break;
      }
      continue;
    }
    if (NOT_CALLS.has(lower)) continue;
    out.push(t.text);
  }
  return out;
}

/**
 * SQLCH127: an expression the table declares calls a function the pinned
 * server does not have: `DEFAULT noww()`, `PARTITION BY toYYYYMMM(at)`.
 *
 * Read in each column's `DEFAULT`, `MATERIALIZED`, `ALIAS`, `EPHEMERAL` and
 * TTL expression, in `ORDER BY`, `PRIMARY KEY`, `PARTITION BY`, `SAMPLE BY`
 * and the table TTL, and in each skip index expression. A name counts when it
 * is in `system.functions` (case as the catalog says, aliases included), is an
 * aggregate function with combinator suffixes, or is a function the project
 * declares with `func`.
 */
export const sqlch127 = checkOf({ id: "SQLCH127", description: "An expression calls a function the pinned server does not have" }, (ctx, report) => {
  const objects = clickhouseObjects(ctx);
  const declared = new Set(objects.filter((o) => o.type === "ClickHouse::Function").map((o) => o.name));
  for (const t of objects.filter(isTable)) {
    const places: Array<[string, string | undefined]> = [];
    for (const c of t.columns) {
      if (c.default?.expr) places.push([`column ${c.name} ${c.default.kind}`, c.default.expr]);
      if (c.ttl) places.push([`column ${c.name} TTL`, c.ttl]);
    }
    places.push(["ORDER BY", t.orderBy], ["PRIMARY KEY", t.primaryKey], ["PARTITION BY", t.partitionBy], ["SAMPLE BY", t.sampleBy], ["TTL", t.ttl]);
    for (const ix of t.indexes ?? []) places.push([`index ${ix.name}`, ix.expr]);
    for (const [where, expr] of places) {
      if (!expr) continue;
      const reported = new Set<string>();
      for (const name of calledNames(expr)) {
        if (reported.has(name) || declared.has(name) || isKnownFunction(name)) continue;
        reported.add(name);
        report({
          severity: "error",
          message: `${t.export} (${t.name}): ${where} calls ${name}(), which ClickHouse ${CLICKHOUSE_VERSION} does not have and the project does not declare with func`,
          entity: t.export,
        });
      }
    }
  }
});

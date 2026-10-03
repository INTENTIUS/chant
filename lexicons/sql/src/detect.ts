/**
 * What a parsed sql document looks like. Kept free of the plugin and the
 * TypeScript compiler so it bundles for edge runtimes, like the other
 * lexicons' `detect` modules.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The entity type prefix each dialect's build output carries. */
const TYPE_PREFIX: Record<string, string> = { clickhouse: "ClickHouse::", postgres: "Postgres::" };

/**
 * The sql lexicon's build output (`chant build --lexicon sql`): a JSON
 * document with a `dialect` (`clickhouse` or `postgres`), an `applyOrder` list
 * and an `objects` list whose entries carry a type of that dialect
 * (`ClickHouse::Table`, `Postgres::Table`). This is how a project that already
 * uses the lexicon is recognized from its built output.
 */
export function looksLikeSqlBuild(data: unknown): boolean {
  if (!isObject(data)) return false;
  if (typeof data.dialect !== "string") return false;
  const prefix = TYPE_PREFIX[data.dialect];
  if (!prefix) return false;
  if (!Array.isArray(data.applyOrder) || !Array.isArray(data.objects)) return false;
  return data.objects.length > 0 && data.objects.every((o) => isObject(o) && typeof o.type === "string" && o.type.startsWith(prefix));
}

export function detectTemplate(data: unknown): boolean {
  return looksLikeSqlBuild(data);
}

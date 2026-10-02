/**
 * What a parsed sql document looks like. Kept free of the plugin and the
 * TypeScript compiler so it bundles for edge runtimes, like the other
 * lexicons' `detect` modules.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The sql lexicon's build output (`chant build --lexicon sql`): a JSON
 * document with a `dialect`, an `applyOrder` list and an `objects` list whose
 * entries carry a `ClickHouse::` type. This is how a project that already
 * uses the lexicon is recognized from its built output.
 */
export function looksLikeSqlBuild(data: unknown): boolean {
  if (!isObject(data)) return false;
  if (typeof data.dialect !== "string") return false;
  if (!Array.isArray(data.applyOrder) || !Array.isArray(data.objects)) return false;
  return data.objects.length > 0 && data.objects.every((o) => isObject(o) && typeof o.type === "string" && /^[A-Za-z]+::/.test(o.type));
}

export function detectTemplate(data: unknown): boolean {
  return looksLikeSqlBuild(data);
}

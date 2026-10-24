/** Kept apart from the translator so the plugin can ask it without loading the translator. */

/** Text that looks like Postgres DDL or like a Postgres declaration, and not like ClickHouse or T-SQL. */
export function looksLikePostgres(content: string): boolean {
  if (/\bENGINE\s*=/i.test(content) || /^\s*GO\s*$/im.test(content)) return false;
  return /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\b/i.test(content) || /@intentius\/chant-lexicon-sql\/postgres/.test(content);
}

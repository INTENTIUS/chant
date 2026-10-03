/**
 * Managed-provider knowledge for the Postgres dialect (#3282): which roles
 * and schemas a provider owns, which extensions it lets a customer create,
 * and which statements it refuses. See ./types.ts for what a list means and
 * how stale one can be.
 */

import { aurora } from "./aurora";
import { azure } from "./azure";
import { cloudSql } from "./cloud-sql";
import { neon } from "./neon";
import { rds } from "./rds";
import { supabase } from "./supabase";
import { POSTGRES_PROVIDERS, type PostgresProvider, type ProviderData, type RefusedStatement } from "./types";

export { POSTGRES_PROVIDERS, COMMON_REFUSED } from "./types";
export type { PostgresProvider, ProviderData, ProviderSource, RefusedStatement, ProviderSetting } from "./types";

const DATA: Record<PostgresProvider, ProviderData> = {
  rds,
  aurora,
  "cloud-sql": cloudSql,
  azure,
  neon,
  supabase,
};

/** The data for one provider. */
export function providerData(provider: PostgresProvider): ProviderData {
  return DATA[provider];
}

export const isPostgresProvider = (v: unknown): v is PostgresProvider =>
  typeof v === "string" && (POSTGRES_PROVIDERS as readonly string[]).includes(v);

/** Role and schema names fold to lower case unless quoted; the lists are lower case. */
const fold = (name: string) => name.toLowerCase();

/**
 * Whether the provider lets a customer create the extension. `undefined` when
 * the provider's list is partial and does not name it: the answer is unknown,
 * not no.
 */
export function providerAllowsExtension(provider: PostgresProvider, name: string): boolean | undefined {
  const data = DATA[provider];
  if (data.allowedExtensions.includes(fold(name))) return true;
  return data.extensionListComplete ? false : undefined;
}

/** A live object as import or describe sees it: its kind and name, schema-less for roles, schemas and extensions. */
export interface LiveObjectRef {
  kind: "role" | "schema" | "extension";
  name: string;
}

/**
 * Whether the provider owns a live object, so import and describe can read it
 * as foreign (not the project's to declare or change). A role or schema the
 * provider created, an extension the provider installs, or a `pg_` built-in
 * role. Names are compared case-folded.
 */
export function isProviderOwned(provider: PostgresProvider, object: LiveObjectRef): boolean {
  const data = DATA[provider];
  const name = fold(object.name);
  switch (object.kind) {
    case "role":
      return data.reservedRoles.includes(name) || name.startsWith("pg_");
    case "schema":
      return data.reservedSchemas.includes(name);
    case "extension":
      return data.providerExtensions.includes(name);
  }
}

/** Reduce a statement to what the refused-statement patterns match: comments and strings removed, upper case, whitespace collapsed. */
export function normalizeStatement(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** The refused-statement entry a statement matches on the provider, if any. */
export function refusedStatement(provider: PostgresProvider, sql: string): RefusedStatement | undefined {
  const text = normalizeStatement(sql);
  return DATA[provider].refusedStatements.find((r) => r.pattern.test(text));
}

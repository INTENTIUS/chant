/**
 * Live export: `chant import --from <env>` writes the server's schema as
 * `database`, `table` and `view` declarations.
 *
 * Every object in the environment's databases is read with `SHOW CREATE`, the
 * server's canonical form, which is the baseline #3046 question 5 asks for.
 * By default what the server adds on its own is left out (settings at their
 * default, a view's inferred column list), so the declaration says what an
 * author would; `verbatim` keeps the statement as the server printed it.
 *
 * - `selector.type` is an entity type (`ClickHouse::Table`); `selector.name` is
 *   an object name, `db.name` or `name`.
 * - `owned` keeps the objects whose comment carries chant's ownership marker
 *   (`../ownership.ts`), the trailer the applier stamps. The trailer itself is
 *   never written into a declaration: `readLiveSchema` takes it off.
 * - a migration runner's history table (`schema_migrations`,
 *   `goose_db_version`) is left out with a warning (#3676), as on Postgres.
 * - A SQL user-defined function belongs to no database, and every project's
 *   functions sit side by side on a server (#3718). Without a selector, an
 *   import adopts only the functions the imported objects use (and those
 *   functions call), and the ones `sql.profiles.<env>.importFunctions` names;
 *   a warning names the rest. ClickHouse stores a call as the function's body
 *   (#3745), so a use is found by that body (`./inlined.ts`) as well as by
 *   the name. A function carries no comment, so `owned` does
 *   not apply to it.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { bindClickHouse, type BindOptions } from "../live/bind";
import { readLiveSchema } from "../live/catalog";
import { objectsToIR, stripServerDefaults, type ImportedObject } from "./ir";
import { isChantManaged } from "../ownership";
import { CLICKHOUSE_ENTITY_TYPES } from "../entities";
import { isTrivia, tokenizeText } from "../tokens";
import { unquote } from "../parser";
import type { LiveObject } from "../live/catalog";
import { inlinedFunctions } from "./inlined";

/** The functions among `names` a statement calls: a name followed by `(`. */
export function calledFunctions(ddl: string, names: ReadonlySet<string>): string[] {
  const tokens = tokenizeText(ddl, 0).filter((t) => !isTrivia(t));
  const out = new Set<string>();
  tokens.forEach((t, i) => {
    if (t.kind !== "ident" && t.kind !== "qident") return;
    const next = tokens[i + 1];
    if (next?.kind !== "punct" || next.text !== "(") return;
    const name = t.kind === "qident" ? unquote(t.text) : t.text;
    if (names.has(name)) out.add(name);
  });
  return [...out];
}

/** Whether `patterns` (names, or prefixes ending in `*`) name a function. */
const named = (patterns: readonly string[], name: string) => patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));

/**
 * The functions an import adopts (#3718): those the objects call, those
 * whose bodies the objects hold in place of a call (#3745, `./inlined.ts`),
 * those `patterns` name, and the functions those call in turn; and the rest.
 */
export function scopedFunctions(objects: readonly LiveObject[], functions: readonly LiveObject[], patterns: readonly string[] = []): { adopted: LiveObject[]; skipped: string[] } {
  const byName = new Map(functions.map((f) => [f.name, f]));
  const names = new Set(byName.keys());
  const adopted = new Set<string>(functions.filter((f) => named(patterns, f.name)).map((f) => f.name));
  for (const o of objects) for (const n of calledFunctions(o.statement, names)) adopted.add(n);
  for (const n of inlinedFunctions(objects.map((o) => o.statement), functions)) adopted.add(n);
  const queue = [...adopted];
  while (queue.length > 0) {
    for (const n of calledFunctions(byName.get(queue.pop()!)!.statement, names)) {
      if (!adopted.has(n)) {
        adopted.add(n);
        queue.push(n);
      }
    }
  }
  return { adopted: functions.filter((f) => adopted.has(f.name)), skipped: functions.filter((f) => !adopted.has(f.name)).map((f) => f.name) };
}

export interface ExportOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  stack?: string;
  region?: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}

export async function exportResources(options: ExportOptions): Promise<ExportedTemplate> {
  const target = await bindClickHouse(options);
  const all = await readLiveSchema(target);
  const isFunction = (o: LiveObject) => o.type === CLICKHOUSE_ENTITY_TYPES.function;
  // A selector picks what it names, functions included; without one, functions go with what calls them (#3718).
  const live = options.selector ? all : all.filter((o) => !isFunction(o));
  const selected = live.filter((o) => {
    if (options.owned && !isChantManaged(o.comment)) return false;
    if (options.selector?.type && o.type !== options.selector.type) return false;
    const name = options.selector?.name;
    if (name !== undefined && name !== o.name && name !== `${o.database}.${o.name}`) return false;
    return true;
  });
  const warnings: string[] = [];
  if (!options.selector) {
    const { adopted, skipped } = scopedFunctions(selected.filter((o) => !o.foreign), all.filter(isFunction), target.importFunctions);
    selected.push(...adopted);
    if (skipped.length > 0) {
      warnings.push(
        `${skipped.length} SQL function${skipped.length === 1 ? "" : "s"} on the server ${skipped.length === 1 ? "is" : "are"} not imported, since no imported object uses ${skipped.length === 1 ? "it" : "them"}: ${skipped.join(", ")}. Name ${skipped.length === 1 ? "it" : "them"} in sql.profiles.${options.environment}.importFunctions to import ${skipped.length === 1 ? "it" : "them"}.`,
      );
    }
  }
  const objects: ImportedObject[] = selected
    // The `default` database exists on every server; declaring it would make apply create what is there.
    .filter((o) => !(o.type === "ClickHouse::Database" && o.name === "default"))
    .filter((o) => {
      if (!o.foreign) return true;
      warnings.push(`${o.database ? `${o.database}.` : ""}${o.name} is kept by ${o.foreign}; left out, since declaring it would have chant change what that tool owns`);
      return false;
    })
    .map((o) => ({
      type: o.type,
      ...(o.database ? { database: o.database } : {}),
      name: o.name,
      ddl: options.verbatim ? o.statement : stripServerDefaults(o.statement),
    }));
  return objectsToIR(objects, warnings) as ExportedTemplate;
}

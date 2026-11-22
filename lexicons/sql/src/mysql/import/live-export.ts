/**
 * Live export for MySQL (#5449): `chant import --from <env>` writes the
 * server's databases, tables and views as declarations.
 *
 * Every object in the environment's databases is read with `SHOW CREATE`
 * (`../live/catalog.ts`). By default what the server adds on its own is left
 * out (`stripServerDefaults` in `./generator.ts`); `verbatim` keeps each
 * statement as the server printed it, less its version comments.
 *
 * - `selector.type` is an entity type (`MySQL::Table`); `selector.name` an
 *   object name, `db.name` or `name`.
 * - `owned` keeps the tables whose comment carries chant's ownership marker.
 *   The trailer itself is never written into a declaration. A view or a
 *   database carries no comment, so `owned` leaves them out.
 * - A migration runner's history table (`schema_migrations`,
 *   `_prisma_migrations`, `flyway_schema_history`) is left out with a warning.
 * - An object of a kind no declaration holds (a trigger, a routine, an
 *   event, a partitioned table; `../live/undeclarable.ts`) fails the import,
 *   which names every one of them. `skipUndeclarable` imports the rest and
 *   lists them as warnings.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { bindMysql, type MysqlBindOptions } from "../live/bind";
import { checkServer, databasesInScope, readLiveSchema, type LiveMysqlObject } from "../live/catalog";
import { readUndeclarable } from "../live/undeclarable";
import { mysqlObjectsToIR, stripServerDefaults, type ImportedMysqlObject } from "./generator";
import { unversioned } from "../canonical";
import { isChantManaged, stripMarker } from "../../core/ownership";
import { refuseUndeclarable } from "../../core/undeclarable";
import { foreignTool } from "../../core/foreign-tables";
import { MYSQL_ENTITY_TYPES } from "../entities";
import { withTableComment } from "../apply/apply";
import { isTrivia, tokenizeText } from "../tokens";
import { parseMysqlCreate } from "../parser";
import { quoteIdent } from "../names";

/** `SHOW CREATE TABLE` names the table alone; the declaration names its database too. */
export function qualifiedStatement(statement: string, database: string | undefined): string {
  if (database === undefined) return statement;
  const tokens = tokenizeText(statement, 0);
  let node;
  try {
    node = parseMysqlCreate(tokens);
  } catch {
    return statement;
  }
  if (node.statement !== "table" && node.statement !== "view") return statement;
  const name = tokens.slice(node.name.from, node.name.to).filter((t) => !isTrivia(t));
  if (name.length !== 1) return statement;
  const at = tokens.indexOf(name[0]!);
  return tokens.slice(0, at).map((t) => t.text).join("") + `${quoteIdent(database)}.` + tokens.slice(at).map((t) => t.text).join("");
}

export interface MysqlExportOptions extends Omit<MysqlBindOptions, "environment"> {
  environment: string;
  stack?: string;
  region?: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
  skipUndeclarable?: boolean;
  /** A catalog reader in place of the server's (tests). */
  readLive?: typeof readLiveSchema;
}

/** A table's statement with chant's ownership trailer taken off its comment. */
function withoutMarker(o: LiveMysqlObject): string {
  if (o.type !== MYSQL_ENTITY_TYPES.table || !o.comment || stripMarker(o.comment) === o.comment) return o.statement;
  const own = stripMarker(o.comment);
  const ddl = withTableComment(unversioned(o.statement), own);
  // An empty comment is no comment.
  return own === "" ? ddl.replace(/\s*COMMENT = ''\s*$/, "") : ddl;
}

export async function exportMysqlResources(options: MysqlExportOptions): Promise<ExportedTemplate> {
  const { target, client } = await bindMysql(options);
  try {
    await checkServer(client);
    const databases = await databasesInScope(client, target.databases);
    const warnings: string[] = [];
    // A selector or an owned import asks only for what chant can hold.
    const refused = new Set<string>();
    if (!options.selector && !options.owned) {
      const undeclarable = await readUndeclarable(client, databases);
      for (const u of undeclarable.unread) warnings.push(`the server was not checked for objects of one kind chant cannot declare, so some may be left out: ${u}`);
      refuseUndeclarable("mysql", undeclarable.objects, options.skipUndeclarable, warnings);
      // A partitioned table left out with --skip-undeclarable is not also read as a table.
      for (const u of undeclarable.objects) if (u.kind === "partitioned table") refused.add(`${u.schema}.${u.name}`);
    }
    const all = (await (options.readLive ?? readLiveSchema)(client, { databases })).filter((o) => !refused.has(`${o.database}.${o.name}`));
    const selected = all.filter((o) => {
      if (options.owned && !(o.type === MYSQL_ENTITY_TYPES.table && isChantManaged(o.comment))) return false;
      if (options.selector?.type && o.type !== options.selector.type) return false;
      const name = options.selector?.name;
      if (name !== undefined && name !== o.name && name !== `${o.database}.${o.name}`) return false;
      return true;
    });
    const objects: ImportedMysqlObject[] = [];
    for (const o of selected) {
      const tool = o.type === MYSQL_ENTITY_TYPES.table ? foreignTool(o.name) : undefined;
      if (tool) {
        warnings.push(`${o.database}.${o.name} is kept by ${tool}; left out, since declaring it would have chant change what that tool owns`);
        continue;
      }
      const statement = qualifiedStatement(unversioned(withoutMarker(o)), o.database);
      objects.push({ type: o.type, ...(o.database !== undefined ? { database: o.database } : {}), name: o.name, ddl: options.verbatim ? unversioned(statement).trim() : stripServerDefaults(statement) });
    }
    return mysqlObjectsToIR(objects, warnings) as ExportedTemplate;
  } finally {
    await client.end();
  }
}

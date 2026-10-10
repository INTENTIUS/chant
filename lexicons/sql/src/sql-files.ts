/**
 * Plain `.sql` files as a schema source (#3646): DDL read into the same
 * declarations the tagged templates make. Also at the package root.
 *
 * - {@link readSqlFile}: the objects a file of DDL declares, each with its
 *   export name, type, qualified name and DDL.
 * - {@link sqlFileDeclarations}: the same file as TypeScript, one `schema.ts`
 *   of `table`, `view`, ... templates, as `chant import <file>.sql` writes it.
 * - {@link sqlFileEntities}: the declarations themselves, with the references
 *   between the files' objects, and to objects declared elsewhere, as
 *   interpolations, so dependency order comes from the graph. The build uses
 *   it for every `.sql` file in the source directory.
 *
 * Postgres reads each `CREATE`, `GRANT`, `REVOKE` and `ALTER DEFAULT
 * PRIVILEGES` as an object, with `COMMENT ON`, `ALTER TABLE ... ROW LEVEL
 * SECURITY` and `ALTER TABLE ... ADD <table constraint>` folded into the
 * object they finish; ClickHouse reads `CREATE DATABASE`, `TABLE`, `VIEW`,
 * `MATERIALIZED VIEW`, `DICTIONARY`, `FUNCTION`, `USER`, `ROLE` and `ROW
 * POLICY`, and `GRANT` (#3711). Any other statement, and any
 * statement that does not parse, throws a {@link SqlFileError} naming every
 * such statement: none is left out.
 *
 * A name is a reference where it is qualified (`app.users`), or bare where an
 * object is named (`REFERENCES users`, `FROM users`, an index's table, a
 * column of an enum type) and an object declared without a schema has it.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { SqlDialect } from "./dialects";
import { SqlFileError, type ReadOptions } from "./files/common";
import { postgresTag, readPostgres, templateStrings } from "./files/postgres";
import { clickhouseTag, readClickHouse } from "./files/clickhouse";
import { exportNames as pgExportNames, objectsToIR as pgObjectsToIR, type ImportedPgObject } from "./postgres/import/ir";
import { exportNames as chExportNames, objectsToIR as chObjectsToIR, type ImportedObject } from "./clickhouse/import/ir";
import { PostgresGenerator, postgresTemplates, type PgTemplateItem, type TemplateBody } from "./postgres/import/generator";
import { ClickHouseGenerator, clickhouseTemplates } from "./clickhouse/import/generator";
import { isPostgresObject } from "./postgres/entities";
import { isClickHouseObject } from "./clickhouse/entities";

export { SqlFileError };
export type { ReadOptions as SqlFileOptions };

/** One object a file of DDL declares. */
export interface SqlFileObject {
  /** The export it is declared as. */
  export: string;
  /** Its entity type, `Postgres::Table`. */
  type: string;
  /** `schema.name` (Postgres), `database.name` (ClickHouse); the name alone when the DDL does not qualify it. */
  name: string;
  /** Its statements: the CREATE, then what was folded into it. */
  ddl: string;
  /** The file it came from, the `origin` it was read under. */
  origin: string;
}

/** A file to read: its DDL and the name errors give it. */
export interface SqlFileSource extends ReadOptions {
  ddl: string;
}

type Imported = ImportedPgObject | ImportedObject;

const qualifierOf = (o: Imported): string | undefined => ("schema" in o ? o.schema : "database" in o ? o.database : undefined);
const qualifiedName = (o: Imported): string => (qualifierOf(o) ? `${qualifierOf(o)}.${o.name}` : o.name);

function readObjects(dialect: SqlDialect, sources: readonly SqlFileSource[]): Array<Imported & { origin: string }> {
  const out: Array<Imported & { origin: string }> = [];
  for (const source of sources) {
    const problems: string[] = [];
    const objects = dialect === "postgres" ? readPostgres(source.ddl, source, problems) : readClickHouse(source.ddl, source, problems);
    if (problems.length > 0) throw new SqlFileError(source.origin, problems);
    out.push(...objects.map((o) => ({ ...o, origin: source.origin })));
  }
  return out;
}

/** Export names for objects read from files, unique across them. */
function namesFor(dialect: SqlDialect, objects: readonly Imported[]): string[] {
  return dialect === "postgres" ? pgExportNames(objects as ImportedPgObject[]) : chExportNames(objects as ImportedObject[]);
}

/** The objects a file of DDL declares. Throws a {@link SqlFileError} naming each statement it cannot read. */
export function readSqlFile(dialect: SqlDialect, ddl: string, options: ReadOptions): SqlFileObject[] {
  const objects = readObjects(dialect, [{ ...options, ddl }]);
  const names = namesFor(dialect, objects);
  return objects.map((o, i) => ({ export: names[i]!, type: o.type, name: qualifiedName(o), ddl: o.ddl, origin: o.origin }));
}

/**
 * A file of DDL as TypeScript declarations: the `schema.ts` `chant import`
 * writes, with `header` as comment lines at its top, and the objects in it.
 */
export function sqlFileDeclarations(dialect: SqlDialect, ddl: string, options: ReadOptions & { header?: string }): { content: string; objects: SqlFileObject[] } {
  const objects = readObjects(dialect, [{ ...options, ddl }]);
  if (objects.length === 0) throw new SqlFileError(options.origin, ["the DDL creates no objects"]);
  const ir = dialect === "postgres" ? pgObjectsToIR(objects as ImportedPgObject[]) : chObjectsToIR(objects as ImportedObject[]);
  const files = dialect === "postgres" ? new PostgresGenerator(options.header).generate(ir) : new ClickHouseGenerator(options.header).generate(ir);
  const [file] = files;
  if (!file) throw new SqlFileError(options.origin, ["the DDL creates no objects"]);
  return {
    content: file.content,
    objects: ir.resources.map((r, i) => ({ export: r.logicalId, type: r.type, name: qualifiedName(objects[i]!), ddl: objects[i]!.ddl, origin: options.origin })),
  };
}

/** Where an entity read from a `.sql` file came from: its `origin`. Undefined for any other entity. */
export function sqlFileOf(entity: unknown): string | undefined {
  return typeof entity === "object" && entity !== null ? ((entity as Record<symbol, unknown>)[FROM_FILE] as string | undefined) : undefined;
}

const FROM_FILE = Symbol.for("chant.sql.fromFile");

/** A declared entity as a template target: its export, type and name. */
function targetOf(dialect: SqlDialect, exportName: string, entity: Declarable): PgTemplateItem | undefined {
  const p = (entity as unknown as { props: { schema?: string; database?: string; name?: string; ddl?: string } }).props;
  if (typeof p.name !== "string") return undefined;
  const qualifier = dialect === "postgres" ? p.schema : p.database;
  return {
    exportName,
    type: entity.entityType,
    ...(qualifier ? (dialect === "postgres" ? { schema: qualifier } : { database: qualifier }) : {}),
    name: p.name,
    ddl: typeof p.ddl === "string" ? p.ddl : "",
  } as PgTemplateItem;
}

function templates(dialect: SqlDialect, items: readonly PgTemplateItem[], targets: readonly PgTemplateItem[]): { order: PgTemplateItem[]; bodies: Map<string, TemplateBody> } {
  return dialect === "postgres" ? postgresTemplates(items, targets) : (clickhouseTemplates(items, targets) as { order: PgTemplateItem[]; bodies: Map<string, TemplateBody> });
}

/** The entities of one dialect in a set, by export name. */
function ofDialect(dialect: SqlDialect, entities: ReadonlyMap<string, Declarable> | undefined): Map<string, Declarable> {
  const is = dialect === "postgres" ? isPostgresObject : isClickHouseObject;
  return new Map([...(entities ?? new Map<string, Declarable>())].filter(([, e]) => is(e)));
}

/**
 * The declarations the files make, by export name. `known` holds the
 * entities declared elsewhere (the project's tagged templates): a file's
 * reference to one of them is an interpolation of it, as an import would
 * write it, and an export name or an object one of them already declares is
 * an error naming both.
 */
export function sqlFileEntities(dialect: SqlDialect, sources: readonly SqlFileSource[], options: { known?: ReadonlyMap<string, Declarable> } = {}): Map<string, Declarable> {
  const objects = readObjects(dialect, sources);
  const names = namesFor(dialect, objects);
  const known = ofDialect(dialect, options.known);
  const problems: string[] = [];

  const items: PgTemplateItem[] = objects.map((o, i) => ({ exportName: names[i]!, type: o.type, ...("schema" in o && o.schema ? { schema: o.schema } : {}), ...("database" in o && o.database ? { database: o.database } : {}), name: o.name, ddl: o.ddl }) as PgTemplateItem);
  const origin = new Map(objects.map((o, i) => [names[i]!, o.origin]));
  const knownItems = [...known].map(([n, e]) => targetOf(dialect, n, e)).filter((t): t is PgTemplateItem => t !== undefined);
  const declared = new Map(knownItems.map((t) => [`${t.type} ${qualifiedName(t as Imported)}`, t.exportName]));
  const seen = new Map<string, string>();
  const where = (at: string | undefined) => (sources.length > 1 && at ? `${at}: ` : "");
  const label = sources.length === 1 ? sources[0]!.origin : "the .sql files";
  for (const [i, it] of items.entries()) {
    const what = `${it.type} ${qualifiedName(it as Imported)}`;
    const at = objects[i]!.origin;
    const q = qualifiedName(it as Imported);
    if (options.known?.has(it.exportName)) problems.push(`${where(at)}${q} is exported as ${it.exportName}, a name another declaration already has; rename that one`);
    const other = declared.get(what);
    if (other) problems.push(`${where(at)}${q} is declared twice, here and as ${other}; leave it to one of them`);
    const again = seen.get(what);
    if (again) problems.push(`${where(at)}${q} is declared twice, here and in ${again}; leave it to one of them`);
    seen.set(what, at);
  }
  if (problems.length > 0) throw new SqlFileError(label, problems);

  const { order, bodies } = templates(dialect, items, [...items, ...knownItems]);
  const built = new Map<string, Declarable>();
  const failed = new Set<string>();
  const tagOf = dialect === "postgres" ? postgresTag : clickhouseTag;
  for (const it of order) {
    const body = bodies.get(it.exportName)!;
    const values = body.refs.map((r) => built.get(r) ?? known.get(r));
    const missing = body.refs.find((_, i) => values[i] === undefined);
    if (missing !== undefined) {
      failed.add(it.exportName);
      // What references an object that failed is not reported again.
      if (failed.has(missing)) continue;
      problems.push(`${where(origin.get(it.exportName))}${qualifiedName(it as Imported)} and ${missing} reference each other, which no declaration can; break the cycle`);
      continue;
    }
    try {
      const entity = tagOf(it.type)!(templateStrings(body.parts), ...values);
      Object.defineProperty(entity, FROM_FILE, { value: origin.get(it.exportName), enumerable: false });
      built.set(it.exportName, entity);
    } catch (e) {
      failed.add(it.exportName);
      problems.push(`${where(origin.get(it.exportName))}${qualifiedName(it as Imported)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (problems.length > 0) throw new SqlFileError(label, problems);
  // In the files' order, not the dependency order.
  return new Map(items.filter((it) => built.has(it.exportName)).map((it) => [it.exportName, built.get(it.exportName)!]));
}

/**
 * The objects read from `.sql` files that each other object names in its
 * DDL as text, by export name: a tagged template cannot import a file's
 * object, so it names it, and this is the edge the dependency order needs.
 * Empty when no object came from a file.
 */
export function sqlFileReferences(dialect: SqlDialect, objects: ReadonlyMap<string, Declarable>): Map<string, string[]> {
  const fromFiles = [...objects].filter(([, e]) => sqlFileOf(e) !== undefined);
  const out = new Map<string, string[]>();
  if (fromFiles.length === 0) return out;
  const targets = fromFiles.map(([n, e]) => targetOf(dialect, n, e)).filter((t): t is PgTemplateItem => t !== undefined);
  for (const [name, entity] of objects) {
    if (sqlFileOf(entity) !== undefined) continue;
    const item = targetOf(dialect, name, entity);
    if (!item || !item.ddl) continue;
    const refs = templates(dialect, [item], targets).bodies.get(name)?.refs ?? [];
    if (refs.length > 0) out.set(name, [...new Set(refs)]);
  }
  return out;
}

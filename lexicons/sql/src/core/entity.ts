/**
 * The entity base every dialect's objects share: the Declarable fields core
 * reads, the hidden-property construction that keeps them out of a build's
 * props, and the column references (`${t.columns.x}`) a relation hands out.
 *
 * A dialect subclasses {@link SqlObject} with its own entity types
 * (`ClickHouse::Table`), builds its entities with {@link makeSqlEntity} on its
 * subclass's prototype, and recognizes its own objects by their type prefix.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { AttrRef } from "@intentius/chant/attrref";

/** The lexicon every dialect's entities belong to. */
export const SQL_LEXICON = "sql";

/** The members a schema object has besides its props, in every dialect. */
export abstract class SqlObject implements Declarable {
  declare readonly [DECLARABLE_MARKER]: true;
  declare readonly lexicon: "sql";
  declare readonly entityType: string;
  declare readonly kind: "resource";
  /** The name the object is referred to by in SQL, qualified as the dialect writes it. */
  declare readonly sqlName: string;
  /** The parsed definition; each entity kind narrows it. */
  declare readonly props: object;
  /**
   * Everything the DDL references, enumerable so core's dependency graph and
   * `chant graph` see the edges.
   */
  declare readonly dependsOn: readonly unknown[];
}

const hidden = (target: object, key: string | symbol, value: unknown) =>
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });

/**
 * One entity on `prototype` (a dialect's {@link SqlObject} subclass). Every
 * field but `dependsOn` is hidden, so a build's props are the parsed
 * definition alone. With `columnNames`, the entity gets a frozen `columns`
 * record holding one {@link AttrRef} per column.
 */
export function makeSqlEntity<T extends SqlObject>(
  prototype: T,
  entityType: string,
  sqlName: string,
  props: object,
  columnNames: readonly string[] | undefined,
  dependsOn: unknown[],
): T {
  const entity = Object.create(prototype) as T;
  hidden(entity, DECLARABLE_MARKER, true);
  hidden(entity, "lexicon", SQL_LEXICON);
  hidden(entity, "entityType", entityType);
  hidden(entity, "kind", "resource");
  hidden(entity, "props", props);
  hidden(entity, "sqlName", sqlName);
  if (columnNames) {
    const columns: Record<string, AttrRef> = {};
    for (const name of columnNames) columns[name] = new AttrRef(entity, name);
    hidden(entity, "columns", Object.freeze(columns));
  }
  Object.defineProperty(entity, "dependsOn", { value: dependsOn, enumerable: true });
  return entity;
}

/** Whether `value` is a sql lexicon entity whose type starts with `typePrefix` (`ClickHouse::`). */
export function isSqlObjectOf(value: unknown, typePrefix: string): value is SqlObject {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).lexicon === SQL_LEXICON &&
    typeof (value as SqlObject).sqlName === "string" &&
    typeof (value as Declarable).entityType === "string" &&
    (value as Declarable).entityType.startsWith(typePrefix)
  );
}

/** A column reference: an AttrRef whose parent `isOwner` accepts. */
export function isColumnRefOf(value: unknown, isOwner: (parent: unknown) => boolean): value is AttrRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<AttrRef>;
  if (typeof v.attribute !== "string" || typeof v.parent?.deref !== "function") return false;
  return isOwner(v.parent.deref());
}

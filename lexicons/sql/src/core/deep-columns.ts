/**
 * A table's columns in `chant lifecycle diff --live` (#4944), for both
 * dialects.
 *
 * - Each column is addressed by its name, so a changed default reads
 *   `columns[#country].default.expr` instead of `columns[3].default.expr`,
 *   and a column added or dropped on the server does not move the path of
 *   every column after it. The plans compare columns by name too.
 * - A ClickHouse table keeps its columns in an order an ALTER can change
 *   (SQLCH209), so its tree carries that order as one value, `columnOrder`:
 *   the declared names on the declared side, and on the live side the order
 *   the server holds the columns both sides have.
 * - A column the server has and the declaration does not is a change an
 *   apply would make (it drops the column, where the apply may delete), on
 *   no declared property, so the reader reports it as pending and leaves it
 *   out of the live tree. Before #4944 it showed as unclaimed fields
 *   `columns[N].*`, which are not drift.
 */

import type { DeepArrayElement, DeepPendingChange } from "@intentius/chant/deep-observation";

type Props = Record<string, unknown>;

/** The entity types whose `columns` are keyed by name. */
const NAMED_COLUMN_TYPES: ReadonlySet<string> = new Set(["ClickHouse::Table", "ClickHouse::Dictionary", "Postgres::Table", "Postgres::ForeignTable"]);

/** The entity types whose column order is compared (ClickHouse; Postgres cannot move a column, so its order is not drift). */
const ORDERED_COLUMN_TYPES: ReadonlySet<string> = new Set(["ClickHouse::Table", "ClickHouse::Dictionary"]);

/** The key a table's column takes in a deep path: its name. Undefined for any other array. */
export function columnOrderKey(element: DeepArrayElement): string | undefined {
  if (element.pattern !== "columns" || !NAMED_COLUMN_TYPES.has(element.entityType)) return undefined;
  const name = (element.element as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** The names of a tree's columns, in its order. */
export function columnNames(props: Props): string[] {
  const columns = Array.isArray(props.columns) ? (props.columns as unknown[]) : [];
  return columns.map((c) => (c as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === "string");
}

/** `columnOrder` as the deep tree holds it. */
const orderText = (names: readonly string[]) => names.join(", ");

/** A declared ClickHouse table's tree with its `columnOrder`. Any other tree as it is. */
export function withDeclaredColumnOrder(tree: Props, entityType: string): Props {
  if (!ORDERED_COLUMN_TYPES.has(entityType)) return tree;
  const names = columnNames(tree);
  return names.length > 0 ? { ...tree, columnOrder: orderText(names) } : tree;
}

/**
 * The live `columnOrder` of a ClickHouse table: the declaration's own value
 * when the columns both sides have stand in the same order, else the order
 * the server holds them in. Undefined when the declaration lists no columns,
 * as {@link withDeclaredColumnOrder} then writes none.
 */
export function liveColumnOrder(declared: readonly string[], live: readonly string[]): string | undefined {
  if (declared.length === 0) return undefined;
  const both = new Set(declared.filter((n) => live.includes(n)));
  const liveOrder = live.filter((n) => both.has(n));
  return orderText(liveOrder) === orderText(declared.filter((n) => both.has(n))) ? orderText(declared) : orderText(liveOrder);
}

/**
 * The live tree without the columns the declaration does not have, and those
 * columns as pending changes on the entity (#4944). A live column the
 * declaration renames (`-- previously: <name>`) is not one: an apply renames
 * it. A declaration that lists no columns (a view's, inferred) has none.
 */
export function undeclaredColumns(input: {
  entity: string;
  entityType: string;
  /** The table's qualified name, `shop.events`. */
  qualified: string;
  declared: Props;
  live: Props;
  /** The old names the declaration's `-- previously:` hints give. */
  previously?: Iterable<string>;
}): { live: Props; pending: DeepPendingChange[] } {
  const { live } = input;
  const declared = new Set(columnNames(input.declared));
  if (!NAMED_COLUMN_TYPES.has(input.entityType) || declared.size === 0 || !Array.isArray(live.columns)) return { live, pending: [] };
  const renamed = new Set(input.previously ?? []);
  const kept: unknown[] = [];
  const pending: DeepPendingChange[] = [];
  for (const c of live.columns as unknown[]) {
    const { name, type } = (c ?? {}) as { name?: unknown; type?: unknown };
    if (typeof name !== "string" || declared.has(name) || renamed.has(name)) {
      kept.push(c);
      continue;
    }
    pending.push({
      subject: `column ${input.qualified}.${name}`,
      change: `the server has column ${name}${typeof type === "string" && type !== "" ? ` ${type}` : ""}, which the declaration does not`,
      entities: [input.entity],
    });
  }
  return pending.length === 0 ? { live, pending } : { live: { ...live, columns: kept }, pending };
}

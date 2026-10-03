/**
 * `RefreshedView`: a materialized view with the unique index that lets it refresh concurrently.
 *
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` needs at least one unique index
 * over plain columns, and without it every refresh takes an ACCESS EXCLUSIVE
 * lock that blocks readers (SQLPG111). The composite declares the view and
 * that index together, so a view cannot be added without one. The view reads
 * `source` by reference, so the build orders them and the view's lineage
 * names the source's columns.
 */

import { Composite } from "@intentius/chant/composite";
import { index, view, type PostgresIndex, type PostgresRelation, type PostgresSchema, type PostgresView } from "../postgres/entities";

export interface RefreshedViewProps {
  /** The view's name, unqualified. The index is `<name>_key`. */
  name: string;
  /** The schema the view lives in: the entity, or its name (default `public`). */
  schema?: PostgresSchema | string;
  /** The table or view the materialized view reads, as the entity. */
  source: PostgresRelation;
  /** The select list, each computed item aliased: `region, count(*) AS orders, sum(total) AS revenue`. */
  select: string;
  /** The grouping key: `region`. */
  groupBy: string;
  /** The columns of the unique index, which must identify one row of the result (default `groupBy`). */
  uniqueOn?: string;
}

export type RefreshedViewMembers = {
  view: PostgresView;
  uniqueIndex: PostgresIndex;
};

/** A materialized view over a source, with the unique index that allows REFRESH ... CONCURRENTLY. */
export const RefreshedView = Composite<RefreshedViewProps, RefreshedViewMembers>((props) => {
  const schema = props.schema ?? "public";
  const summary = view`
    CREATE MATERIALIZED VIEW ${schema}.${props.name} AS
    SELECT ${props.select}
    FROM ${props.source}
    GROUP BY ${props.groupBy}`;
  const key = index`
    CREATE UNIQUE INDEX ${`${props.name}_key`} ON ${summary} (${props.uniqueOn ?? props.groupBy})`;
  return { view: summary, uniqueIndex: key };
}, "RefreshedView");

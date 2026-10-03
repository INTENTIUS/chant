/**
 * `JoinTable`: the table of a many-to-many relation, with both foreign keys indexed.
 *
 * The primary key is `(<leftColumn>, <rightColumn>)`, which also serves
 * lookups from the left side. The reverse index on `(<rightColumn>,
 * <leftColumn>)` serves lookups from the right and keeps deletes of a
 * referenced row off a table scan (SQLPG102). Each foreign key cascades by
 * default, so deleting a row on either side removes its links.
 */

import { Composite } from "@intentius/chant/composite";
import { index, table, type PostgresIndex, type PostgresSchema, type PostgresTable } from "../postgres/entities";

export interface JoinTableProps {
  /** The table's name, unqualified. The reverse index is `<name>_reverse_idx`. */
  name: string;
  /** The schema the table lives in: the entity, or its name (default `public`). */
  schema?: PostgresSchema | string;
  /** The table on the left of the relation, as the entity. */
  left: PostgresTable;
  /** The column on the left table the key references (default `id`). */
  leftKey?: string;
  /** The join table's column holding the left key: `user_id`. */
  leftColumn: string;
  /** The left column's type (default `bigint`). */
  leftType?: string;
  /** The table on the right of the relation, as the entity. */
  right: PostgresTable;
  /** The column on the right table the key references (default `id`). */
  rightKey?: string;
  /** The join table's column holding the right key: `team_id`. */
  rightColumn: string;
  /** The right column's type (default `bigint`). */
  rightType?: string;
  /** What happens to a link when the row it references is deleted (default `CASCADE`). */
  onDelete?: string;
}

export type JoinTableMembers = {
  table: PostgresTable;
  reverseIndex: PostgresIndex;
};

/** The table of a many-to-many relation: two foreign keys, a composite primary key and the reverse index. */
export const JoinTable = Composite<JoinTableProps, JoinTableMembers>((props) => {
  const schema = props.schema ?? "public";
  const links = table`
    CREATE TABLE ${schema}.${props.name} (
      ${props.leftColumn} ${props.leftType ?? "bigint"} NOT NULL REFERENCES ${props.left} (${props.leftKey ?? "id"}) ON DELETE ${props.onDelete ?? "CASCADE"},
      ${props.rightColumn} ${props.rightType ?? "bigint"} NOT NULL REFERENCES ${props.right} (${props.rightKey ?? "id"}) ON DELETE ${props.onDelete ?? "CASCADE"},
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (${props.leftColumn}, ${props.rightColumn})
    )`;
  const reverse = index`
    CREATE INDEX ${`${props.name}_reverse_idx`} ON ${links} (${props.rightColumn}, ${props.leftColumn})`;
  return { table: links, reverseIndex: reverse };
}, "JoinTable");

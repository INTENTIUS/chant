/**
 * The shapes of the generated Postgres tables (`src/generated/postgres.ts`).
 * The data is generated; these types are not, so the generated module stays
 * data and a reader of it has one place to look for what a field means.
 *
 * The generated types are the union of every supported major's catalog. A
 * name that is not in all of them carries a {@link VersionRange}, in the
 * generated `VERSION_RANGES` table and as `@since` / `@until` on the member's
 * JSDoc. `since` is the first major with the name and is absent when that is
 * the oldest supported major; `until` is the last major with it and is absent
 * when that is the newest.
 */

import type { ArgumentKind, ClauseArgument } from "./overlays/kinds";
import type { StorageParameterType } from "./overlays/storage";

export type { ArgumentKind, ClauseArgument, StorageParameterType };

export interface VersionRange {
  /** The first supported major that has this name. Absent: the oldest. */
  readonly since?: number;
  /** The last supported major that has this name. Absent: the newest. */
  readonly until?: number;
}

/** True when `range` (or no range) covers `major`. */
export function availableAt(range: VersionRange | undefined, major: number): boolean {
  if (!range) return true;
  return (range.since === undefined || major >= range.since) && (range.until === undefined || major <= range.until);
}

export interface SettingSpec {
  /** `bool`, `integer`, `real`, `string` or `enum`, as `pg_settings.vartype` says (the newest major that has the setting). */
  type: string;
  /** When a value can be changed: `postmaster`, `sighup`, `superuser`, `user`... */
  context: string;
  category: string;
  unit?: string;
  default?: string;
  min?: string;
  max?: string;
}

export interface StorageParameterSpec {
  type: StorageParameterType;
  /** The relation kinds that accept it: `table`, `toast`, `view`, `materialized view`, `index:btree`... */
  targets: readonly string[];
}

export interface ColumnTypeSpec {
  /** The `pg_type` name (`int4`), when it differs from the SQL name. */
  catalogName?: string;
  /** `typcategory`: `N` numeric, `S` string, `D` date and time... */
  category: string;
  /** Spellings that stand for this type (`int`, `int4`). */
  aliases: readonly string[];
  /** The type's parameters, from the overlay; none when it takes none. */
  parameters: readonly ClauseArgument[];
}

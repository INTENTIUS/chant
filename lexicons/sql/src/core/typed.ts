/**
 * Typed columns (#3751): the types that carry a relation's columns from the
 * declarations `chant sql types` generates to `tsc`, in every dialect.
 *
 * Each dialect declares an empty `SqlSchema` interface keyed by qualified
 * name, and the generated `sql-types.d.ts` augments it. A tag given the name
 * as its type argument (`` table<"shop.orders">`CREATE TABLE ...` ``) returns
 * a relation whose `columns` are that entry's, each a {@link Column} branded
 * with its SQL type. The tag's interpolations are typed by the entry's
 * `slots`: the generator writes, per `${}` position, the column a foreign key
 * or a sort key there must be ({@link KeyColumn}, {@link NotNullColumn}).
 *
 * A relation with no type argument, or one the generated file does not list
 * yet, keeps unchecked columns: any name type-checks and every slot takes
 * them, so a project adopts the type argument one declaration at a time.
 *
 * The runtime half is the record of those slots: a tag notes which `${}`
 * feeds a foreign key's column list or a sort key, off the serialized output
 * as `setInterpolationFields` keeps its record, for the generator to read.
 */

import type { AttrRef } from "@intentius/chant/attrref";

declare const columnBrand: unique symbol;
declare const checkedBrand: unique symbol;
declare const relationName: unique symbol;
declare const unnamedBrand: unique symbol;

/** What the generator knows about a column. */
export interface ColumnTraits {
  /** The row type `RowOf` gives the column, before `| null`. */
  readonly ts: unknown;
  readonly nullable: boolean;
  /**
   * How the column compares in a key. Postgres: the catalog category letter
   * (`N`, `S`), or the type itself for the user-defined category, an enum or
   * a row type; a domain compares as its base. ClickHouse: the type family.
   */
  readonly cmp: string;
}

/**
 * A column reference branded with its SQL type, spelled as the catalog
 * spells it. `Checked` is true for a column the generated declarations type,
 * false for an unchecked one; it is a discriminant, so a slot's error names
 * the checked member it wanted.
 */
export interface Column<SqlType extends string = string, T extends ColumnTraits = ColumnTraits, Checked extends boolean = true> extends AttrRef {
  readonly [columnBrand]: { readonly sqlType: SqlType; readonly traits: T };
  readonly [checkedBrand]: Checked;
}

/** A column of a relation the declarations do not cover: any name type-checks, and it fits every slot. */
export type UncheckedColumn = Column<string, ColumnTraits, false>;

/** Any column, checked or not: what a relation annotated without a name (`PostgresTable`) holds. */
export type AnyColumn = Column<string, ColumnTraits, boolean>;

/**
 * What a slot takes besides its checked column: an unchecked relation's
 * column, which reads as `| undefined` under `noUncheckedIndexedAccess`. A
 * checked relation's columns are named properties, so nothing of theirs gets
 * through here.
 */
type Unchecked = UncheckedColumn | undefined;

/** A `${}` that must be a column comparing as `Cmp`: the referenced column of a foreign key. */
export type KeyColumn<Cmp extends string> = Unchecked | Column<string, { readonly ts: unknown; readonly nullable: boolean; readonly cmp: Cmp }>;

/** A `${}` that must be a column that cannot be NULL: an element of a ClickHouse sort key. */
export type NotNullColumn = Unchecked | Column<string, { readonly ts: unknown; readonly nullable: false; readonly cmp: string }>;

/**
 * The name a relation's type carries when its tag has no type argument. Its
 * columns are unchecked, and `RowOf` refuses it.
 */
export type Unnamed = string & { readonly [unnamedBrand]: true };

/** Carries a relation's declared name on its type, so `RowOf<typeof t>` can find its entry. */
export interface Named<N extends string> {
  readonly [relationName]?: N;
}

/**
 * The columns of relation `N` in `Registry` (a dialect's `SqlSchema`):
 * unchecked for an {@link Unnamed} relation or a name the registry does not
 * list, any column for the bare annotation (`N` is `string`), and the
 * entry's own otherwise.
 */
export type ColumnsIn<Registry, N extends string> = [N] extends [Unnamed]
  ? Readonly<Record<string, UncheckedColumn>>
  : string extends N
    ? Readonly<Record<string, AnyColumn>>
    : N extends keyof Registry
      ? Registry[N] extends { readonly columns: infer C } ? C : never
      : Readonly<Record<string, UncheckedColumn>>;

/** The interpolations a tag for relation `N` takes: the entry's slots, then anything. */
export type SlotsIn<Registry, N extends string> = N extends keyof Registry
  ? Registry[N] extends { readonly slots: infer S extends readonly unknown[] } ? [...S, ...unknown[]] : unknown[]
  : unknown[];

type RowFromColumns<C> = {
  -readonly [K in keyof C]: C[K] extends Column<string, infer T> ? (T["nullable"] extends true ? T["ts"] | null : T["ts"]) : unknown;
};

/** A relation's row: `T` is its name or a relation's type carrying one. */
export type RowIn<Registry, T> = T extends string
  ? RowFromColumns<ColumnsIn<Registry, T>>
  : T extends Named<infer N> ? RowFromColumns<ColumnsIn<Registry, N>> : never;

// ── Composite members ───────────────────────────────────────────────────

/** Whether `S` is a name the type system knows: a literal, not `string` and not {@link Unnamed}. */
type Known<S> = [S] extends [Unnamed] ? false : string extends S ? false : true;

/** A piece of a name a composite's props give: the literal, the name a {@link Named} entity carries, or {@link Unnamed}. */
type NamePiece<V> = [V] extends [string]
  ? Known<V> extends true ? V : Unnamed
  : [V] extends [Named<infer N>] ? (Known<N> extends true ? N : Unnamed) : Unnamed;

/**
 * chant#3787 — the qualified name of a relation a Postgres composite declares
 * as `${schema}.${name}${suffix}`: `schema` is the composite's `schema` prop (a
 * string, or a schema whose tag was given its name, `schema<"app">`), `name`
 * its `name` prop. Postgres folds both, as the build does. {@link Unnamed},
 * so the columns stay unchecked, when either piece is not a known literal.
 */
export type PostgresMemberName<Schema, Name, Suffix extends string = ""> = [NamePiece<Schema>, NamePiece<Name>] extends [
  infer S extends string,
  infer N extends string,
]
  ? Known<S> extends true
    ? Known<N> extends true
      ? `${Lowercase<S>}.${Lowercase<N>}${Suffix}`
      : Unnamed
    : Unnamed
  : Unnamed;

/**
 * chant#3787 — the name of a relation a ClickHouse composite declares,
 * `${name}${suffix}`, where `name` is its `name` prop as written (`events` or
 * `analytics.events`). ClickHouse does not fold names. {@link Unnamed} when
 * the name is not a known literal.
 */
export type ClickHouseMemberName<Name, Suffix extends string = ""> = NamePiece<Name> extends infer N extends string
  ? Known<N> extends true
    ? `${N}${Suffix}`
    : Unnamed
  : Unnamed;

// ── The slot record ─────────────────────────────────────────────────────

/**
 * One `${}` the generator types. `references`: a column in a foreign key's
 * referenced column list, paired with `column`, the referencing table's own
 * column at that position. `sortKey`: a bare element of a ClickHouse
 * `ORDER BY` or `PRIMARY KEY`.
 */
export type TypedSlot = { readonly index: number; readonly kind: "references"; readonly column: string } | { readonly index: number; readonly kind: "sortKey" };

const TYPED_SLOTS = Symbol.for("chant.sql.typedSlots");

/** Record the typed slots on an entity: non-enumerable and symbol-keyed, so no serializer sees it. */
export function setTypedSlots(entity: object, slots: readonly TypedSlot[]): void {
  if (slots.length === 0 || !Object.isExtensible(entity)) return;
  Object.defineProperty(entity, TYPED_SLOTS, { value: Object.freeze([...slots]), enumerable: false, writable: false, configurable: true });
}

/** What {@link setTypedSlots} recorded on an entity; empty when nothing was. */
export function getTypedSlots(entity: object): readonly TypedSlot[] {
  return ((entity as Record<symbol, unknown>)[TYPED_SLOTS] as readonly TypedSlot[] | undefined) ?? [];
}

/**
 * A relation's key in `SqlSchema`: `schema.name` (Postgres) or
 * `database.name` (ClickHouse), unquoted and with Postgres's folding
 * applied, or the name alone when the DDL does not qualify it.
 */
export function relationKey(props: { readonly schema?: string; readonly database?: string; readonly name: string }): string {
  const qualifier = props.schema ?? props.database;
  return qualifier ? `${qualifier}.${props.name}` : props.name;
}

import type { PostgresRelation, PostgresTable, RowOf } from "@intentius/chant-lexicon-sql/postgres";
import { legacy, orders } from "../src/schema";
import type { recent } from "../src/mixed";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>(): T | undefined => undefined;

export type Order = RowOf<typeof orders>;
// Declared only in src/users.sql: no TypeScript binding, so by name.
export type User = RowOf<"shop.users">;
ok<Equal<Order, { id: string; customer_id: string; email: string; amount: string; placed_at: Date; refunded_at: Date | null; gift: boolean }>>();
ok<Equal<User, { id: string; tags: string[] | null; profile: unknown }>>();
ok<Equal<RowOf<"shop.orders">, Order>>();
ok<Equal<RowOf<typeof recent>, { id: string | null; total: string | null; n: unknown }>>();

// A typed table is still a table.
const takesTable = (t: PostgresTable) => t.sqlName;
const takesRelation = (t: PostgresRelation) => t.columns;
takesTable(orders);
takesRelation(orders);
takesTable(legacy);

export type Typo = RowOf<"shop.ordrs">;
export type Untyped = RowOf<typeof legacy>;

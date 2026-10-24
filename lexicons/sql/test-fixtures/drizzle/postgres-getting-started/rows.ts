// A Drizzle select over the generated schema has the row the declaration gives.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { orderTotals, orders, users } from "./schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <_T extends true>(): void => {};

const db = drizzle(async () => ({ rows: [] }));

// orders: id and user_id are bigint, read as number (drizzle's mode "number"); status is the enum; amount is numeric, a string; placed_at is timestamptz.
const selectOrders = db.select().from(orders).where(eq(orders.user_id, 1));
type OrderRow = Awaited<typeof selectOrders>[number];
assert<
  Equal<
    OrderRow,
    {
      id: number;
      user_id: number;
      invoice_no: number;
      status: "placed" | "paid" | "shipped" | "cancelled";
      amount: string;
      placed_at: Date;
    }
  >
>();

// users: email is NOT NULL text.
assert<Equal<typeof users.$inferSelect, { id: number; email: string; created_at: Date }>>();

// An insert needs the NOT NULL columns that have no default; a GENERATED ALWAYS identity column is not insertable.
assert<Equal<typeof orders.$inferInsert, { user_id: number; amount: string; invoice_no?: number; status?: "placed" | "paid" | "shipped" | "cancelled"; placed_at?: Date }>>();

// A view's columns are nullable, as Postgres says; an expression's type is unknown.
const selectTotals = db.select().from(orderTotals);
type TotalsRow = Awaited<typeof selectTotals>[number];
assert<Equal<TotalsRow["user_id"], number | null>>();
assert<Equal<TotalsRow["email"], string | null>>();
assert<Equal<TotalsRow["order_count"], unknown>>();

// A column the declaration does not have is an error.
// @ts-expect-error
void db.select({ nope: orders.nope }).from(orders);

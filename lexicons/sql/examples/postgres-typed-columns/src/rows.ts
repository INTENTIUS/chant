import type { RowOf } from "@intentius/chant-lexicon-sql/postgres";
import type { orders } from "./schema";

// { id: string; customer_id: string; amount: string; placed_at: Date; refunded_at: Date | null }
export type Order = RowOf<typeof orders>;

export function isRefunded(order: Order): boolean {
  return order.refunded_at !== null;
}

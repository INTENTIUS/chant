/**
 * Effect receipts kept on the database server itself, in every dialect
 * (concepts/effect-receipts.mdx).
 *
 * A receipt is the proof that one effect ran, kept where the effect happened.
 * A migration Op's backfill copies data on the server, so its receipts are
 * rows on the same server, bound to the object they witness, and read and
 * written over the connection the copy already uses. They die with the data
 * when the Op's onFailure drops it, which a receipt kept in git would not.
 *
 * A dialect's store implements this interface over its own client and keeps
 * the receipts in a table whose comment carries the ownership trailer with
 * the `receipts` key (`./ownership.ts`), so schema reads leave it out. It is
 * not registered as the global `receiptRead` / `receiptWrite` activities,
 * which would take over every other lexicon's `effect()` steps in the run.
 */

import type { ReceiptStore } from "@intentius/chant/op/receipt-store";

/** The receipt's address: `<stack>/<env>/<effect>`, the same fields an ownership marker carries. */
export function receiptAddress(identity: { stack?: string; env?: string }, effect: string): string {
  return `${identity.stack || "-"}/${identity.env || "-"}/${effect}`;
}

/** A receipt store on a database server. */
export interface SqlReceiptStore extends ReceiptStore {
  /** Every receipt whose address starts with `prefix`, latest value each: one query for a whole backfill. */
  readAll(prefix: string): Promise<Map<string, string>>;
}

/**
 * Shared cycle helpers.
 */

import type { ForgejoClient } from "../auth/client.js";
import type { RateBudget } from "../reconcile/runner.js";
import { BudgetExhaustedError } from "../reconcile/runner.js";

/** True when the error message looks like an HTTP 404 from the client. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

/**
 * Charge one budget unit, throwing `BudgetExhaustedError` first if drained.
 * The runner converts that into deferred work rather than a failure.
 */
export function charge(budget: RateBudget, n = 1): void {
  if (budget.exhausted) throw new BudgetExhaustedError();
  budget.use(n);
}

/**
 * Collect every page of a Forgejo list endpoint. Forgejo returns a bare JSON
 * array per page; we advance until a short (or empty) page. Each page is one
 * budget unit. A 404 (resource absent) yields an empty list.
 */
export async function paginate<T>(
  client: ForgejoClient,
  path: string,
  budget: RateBudget,
  limit = 50,
): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: T[] = [];
  for (let page = 1; ; page++) {
    charge(budget);
    let chunk: T[];
    try {
      chunk = await client.request<T[]>("GET", `${path}${sep}limit=${limit}&page=${page}`);
    } catch (err) {
      if (isNotFound(err)) return out;
      throw err;
    }
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    out.push(...chunk);
    if (chunk.length < limit) break;
  }
  return out;
}

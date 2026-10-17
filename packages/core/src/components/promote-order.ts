/**
 * The environment `chant components promote` reads from, given the member's
 * promotion order (#4030, see `../workspace/promotion-order.ts`). These
 * refusals are promote's own and are not codes of the workspace read contract.
 */

import type { PromotionStep } from "../workspace/promotion-order";

/** The refusals `components promote` gives for the declared order. Stable: scripts may match on them. */
export const PROMOTE_ORDER_CODES = [
  /** `--from` is more than one step behind `--to` in the declared order, and `--allow-skip` was not given. */
  "promote-skips-environment",
  /** `--to` is the first step of the declared order, so no environment comes before it to default `--from` to. */
  "promote-no-previous-environment",
  /** `--from` was left out and `--to` is not a step of the declared order, so there is nothing to default it from. */
  "promote-to-not-in-order",
] as const;
export type PromoteOrderCode = (typeof PROMOTE_ORDER_CODES)[number];

export interface PromotionRefusal {
  error: { code: PromoteOrderCode; message: string; fix: string };
}

/**
 * The environment a promote reads from. With an order declared, `--from`
 * defaults to the step before `to`, and a `--from` that skips a step is
 * refused unless `allowSkip`. Without an order, or when `to` or `from` is not
 * a step of it, the order has nothing to say and `from` is returned as given
 * (`undefined` is the caller's to refuse, as before).
 */
export function resolvePromotionSource(opts: {
  order: readonly PromotionStep[];
  to: string;
  from?: string;
  allowSkip?: boolean;
}): { from: string | undefined } | PromotionRefusal {
  const { order, to, from, allowSkip } = opts;
  const names = order.map((s) => s.name);
  const list = names.join(", ");
  const toAt = names.indexOf(to);
  if (from === undefined) {
    if (order.length === 0) return { from: undefined };
    if (toAt < 0) {
      return {
        error: {
          code: "promote-to-not-in-order",
          message: `--from was not given, and "${to}" is not a step of the declared promotion order (${list})`,
          fix: `Pass --from <env>, or add "${to}" to the environments array of this member's chant.config.ts.`,
        },
      };
    }
    if (toAt === 0) {
      return {
        error: {
          code: "promote-no-previous-environment",
          message: `"${to}" is the first step of the declared promotion order (${list}), so there is no environment to promote from`,
          fix: `Deploy "${to}" with chant run --env ${to}, or pass --from <env> to promote from an environment outside the order.`,
        },
      };
    }
    return { from: names[toAt - 1] };
  }
  const fromAt = names.indexOf(from);
  if (toAt >= 0 && fromAt >= 0 && fromAt < toAt - 1 && !allowSkip) {
    const skipped = names.slice(fromAt + 1, toAt);
    return {
      error: {
        code: "promote-skips-environment",
        message: `promoting ${from} to ${to} skips ${skipped.join(", ")} in the declared promotion order (${list})`,
        fix: `Promote to ${skipped[0]} first, or pass --allow-skip to promote ${from} to ${to} anyway.`,
      },
    };
  }
  return { from };
}

/**
 * Notify under a product's words (#4610). The event schema stays
 * `chant.notify/v1`; a product's words set its `source`, the header prefix
 * of the signed webhook, and the nouns and verbs in the summary.
 *
 * ```ts
 * import { driftNotifyFields, productSendOptions } from "@intentius/chant/ci-product";
 * import { makeNotifyEvent, sendNotify } from "@intentius/chant/notify";
 *
 * const fields = driftNotifyFields(words, { changed: ["shop-dev"], fingerprint });
 * await sendNotify(config, makeNotifyEvent(fields), productSendOptions(words));
 * ```
 */

import { CHANT_WORDS, isChantWords, type CiProductNotifyWords, type CiProductWords } from "./ci-product-words";
import type { NotifyFields, SendNotifyOptions } from "./notify";

/** The notify slots of `words`, chant's when a caller built words before #4610. */
export function productNotifyWords(words: CiProductWords): CiProductNotifyWords {
  return words.notify ?? CHANT_WORDS.notify;
}

/** The event's `source` under `words`: `notify.source`, else the product's name. */
export function productNotifySource(words: CiProductWords): string {
  return productNotifyWords(words).source;
}

/**
 * `options` with the product's header prefix, unless the caller names one.
 * chant's own words leave `options` as they are, so chant sends `x-chant`.
 */
export function productSendOptions(words: CiProductWords, options: SendNotifyOptions = {}): SendNotifyOptions {
  if (options.prefix !== undefined || isChantWords(words)) return options;
  return { ...options, prefix: productNotifyWords(words).headers };
}

/** What a drift notice concerns. */
export interface DriftNotifyInput {
  /** The members whose refresh found drift. */
  changed: string[];
  missing?: string[];
  /** The members whose refresh failed, so drift there is unknown. */
  failed?: string[];
  fingerprint?: string;
  project?: string;
  environment?: string;
  reportUrl?: string;
}

/**
 * A `drift` event under `words`: `2 stacks drifted: shop-dev, shop-prod` for
 * plywood, `1 member drifted: net` for chant, with the failed refreshes
 * named after them.
 */
export function driftNotifyFields(words: CiProductWords, input: DriftNotifyInput): NotifyFields {
  const [one, many] = words.noun;
  const n = input.changed.length;
  const failed = input.failed ?? [];
  const what = n > 0 ? `${n} ${n === 1 ? one : many} drifted: ${input.changed.join(", ")}` : `no ${many} drifted`;
  const summary = failed.length > 0 ? `${what}; ${failed.length} ${failed.length === 1 ? one : many} could not be refreshed: ${failed.join(", ")}` : what;
  return {
    source: productNotifySource(words),
    event: "drift",
    summary,
    targets: input.changed,
    drift: {
      changed: input.changed,
      ...(input.missing?.length ? { missing: input.missing } : {}),
      ...(failed.length > 0 ? { failed } : {}),
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    },
    ...(input.project !== undefined ? { project: input.project } : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.reportUrl !== undefined ? { reportUrl: input.reportUrl } : {}),
  };
}

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
import { driftIssueRecords, driftRunFingerprint, type DriftRunStack } from "./drift-issue";

/**
 * The first chant whose Slack and Teams messages take a product's words, a
 * drift event's `rerunUrl` and the relay's name (#4818): `notify.message` in
 * the words, `message` in sendNotify's options, and the third argument of
 * `slackMessage` and `teamsMessage`.
 */
export const NOTIFY_MESSAGE_WORDS_FLOOR = "0.124.78";

/** The notify slots of `words`, chant's when a caller built words before #4610. */
export function productNotifyWords(words: CiProductWords): CiProductNotifyWords {
  return words.notify ?? CHANT_WORDS.notify;
}

/** The event's `source` under `words`: `notify.source`, else the product's name. */
export function productNotifySource(words: CiProductWords): string {
  return productNotifyWords(words).source;
}

/**
 * `options` with the product's header prefix, unless the caller names one,
 * and its message words (`notify.message`, #4818) under the caller's
 * `message`. chant's own words with no message words leave `options` as they
 * are, so chant sends `x-chant`.
 */
export function productSendOptions(words: CiProductWords, options: SendNotifyOptions = {}): SendNotifyOptions {
  const own = productNotifyWords(words);
  const out = own.message ? { ...options, message: { ...own.message, ...options.message } } : options;
  if (options.prefix !== undefined || isChantWords(words)) return out;
  return { ...out, prefix: own.headers };
}

/** What a drift notice concerns. */
export interface DriftNotifyInput {
  /** The members whose refresh found drift. Left out, the {@link stacks} with drift records, in their order. */
  changed?: string[];
  missing?: string[];
  /** The members whose refresh failed, so drift there is unknown. */
  failed?: string[];
  /** The run's fingerprint. Left out, `driftRunFingerprint` of the {@link stacks}. */
  fingerprint?: string;
  /**
   * Each member's drift records, as the run read them (#4944). The notice
   * then names the members with drift and carries the run's fingerprint, so
   * a product passes what it read instead of computing either.
   */
  stacks?: readonly DriftRunStack[];
  project?: string;
  environment?: string;
  reportUrl?: string;
}

/**
 * A `drift` event under `words`: `2 stacks drifted: shop-dev, shop-prod` for
 * plywood, `1 member drifted: net` for chant, with the failed refreshes
 * named after them. Given `stacks`, the drifted members and the
 * fingerprint come from their records (#4944).
 */
export function driftNotifyFields(words: CiProductWords, input: DriftNotifyInput): NotifyFields {
  const [one, many] = words.noun;
  const changed = input.changed ?? (input.stacks ?? []).filter((s) => driftIssueRecords(s.records).length > 0).map((s) => s.stack);
  const fingerprint = input.fingerprint ?? (input.stacks ? driftRunFingerprint(input.stacks) : undefined);
  const n = changed.length;
  const failed = input.failed ?? [];
  const what = n > 0 ? `${n} ${n === 1 ? one : many} drifted: ${changed.join(", ")}` : `no ${many} drifted`;
  const summary = failed.length > 0 ? `${what}; ${failed.length} ${failed.length === 1 ? one : many} could not be refreshed: ${failed.join(", ")}` : what;
  return {
    source: productNotifySource(words),
    event: "drift",
    summary,
    targets: changed,
    drift: {
      changed,
      ...(input.missing?.length ? { missing: input.missing } : {}),
      ...(failed.length > 0 ? { failed } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    },
    ...(input.project !== undefined ? { project: input.project } : {}),
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.reportUrl !== undefined ? { reportUrl: input.reportUrl } : {}),
  };
}

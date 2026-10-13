/**
 * How much a work item holds, for the `slice-tier` decision point (#3150).
 *
 * The point picks the smallest builder tier that can build an item, from five
 * inputs every orchestrator must compute the same way, so chant computes
 * them. They are read through the `work-item` output like any other field:
 *
 *   work-item.criteria      the item's acceptance criteria, counted
 *   work-item.files         distinct paths the item names in backticks
 *   work-item.words         words in the item's text
 *   work-item.fits_<tier>   whether criteria, files and words are each within
 *                           that tier's limits (`fits_small`, `fits_medium`)
 *
 * The item's text is what a person asked (`source.ask.said`, or the answer
 * to the box's intent, `source.intent.answer`), the record's Markdown body
 * with its heading lines left out, and each acceptance criterion's text. A
 * path is a backticked token with a `/` between two parts, such as
 * `app/server.ts` or `design/screens/`, or a file name with an extension of
 * one to five letters, such as `README.md`. Words are runs of non-blank
 * characters.
 *
 * The limits are the work kind's `work.tier.limits`, else
 * {@link DEFAULT_TIER_LIMITS}: small holds at most 10 criteria, 5 files and
 * 150 words, medium 20, 10 and 300. A tier with no limits, such as large,
 * has no `fits_` input; an item that fits neither small nor medium is large.
 * These are the sizing defaults studio's factory used (arugula-salad/studio
 * `queue.mjs` `sizing()`), so a point's answers keep their meaning.
 */

/** A field of `value` by dotted path, or undefined. */
function fieldOf(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const part of path.split(".")) {
    if (at === null || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** What one tier may hold. A limit left out is not checked. */
export interface TierLimit {
  criteria?: number;
  files?: number;
  words?: number;
}

/** The limits when the work kind declares none. */
export const DEFAULT_TIER_LIMITS: Readonly<Record<string, TierLimit>> = Object.freeze({
  small: { criteria: 10, files: 5, words: 150 },
  medium: { criteria: 20, files: 10, words: 300 },
});

export interface WorkItemSize {
  criteria: number;
  files: number;
  words: number;
}

const HEADING = /^\s*#/;
const PATH_LIKE = /^[\w@.-]+(\/[\w@.*-]+)+\/?$|^[\w@-][\w@.-]*\.[a-z]{1,5}$/i;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Measure a work item from its front matter (`data`) and Markdown body.
 * `acceptanceField` is the work kind's `work.acceptance.field`, `acceptance`
 * when it names none.
 */
export function measureWorkItem(data: Record<string, unknown> | null, body: string, acceptanceField = "acceptance"): WorkItemSize {
  const d = data ?? {};
  const acceptance = Array.isArray(d[acceptanceField]) ? (d[acceptanceField] as unknown[]) : [];
  const said = str(fieldOf(d, "source.ask.said")) || str(fieldOf(d, "source.intent.answer"));
  const bodyLines = body.split("\n").filter((l) => !HEADING.test(l));
  const criteriaText = acceptance.map((c) => (typeof c === "string" ? c : str((c as { text?: unknown } | null)?.text)));
  const text = [said, ...bodyLines, ...criteriaText].join("\n");
  const files = new Set([...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((t) => PATH_LIKE.test(t)));
  return { criteria: acceptance.length, files: files.size, words: text.split(/\s+/).filter(Boolean).length };
}

/** Whether `size` is within `limit`: each limit given is at least the measure. */
export function fitsTier(size: WorkItemSize, limit: TierLimit | undefined): boolean {
  if (!limit) return false;
  return (["criteria", "files", "words"] as const).every((k) => limit[k] === undefined || size[k] <= limit[k]!);
}

/**
 * The slice-tier inputs' fields for a measured item: `criteria`, `files`,
 * `words` and `fits_<tier>` for each tier `limits` names.
 */
export function sizeFields(size: WorkItemSize, limits: Readonly<Record<string, TierLimit>> = DEFAULT_TIER_LIMITS): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = { criteria: size.criteria, files: size.files, words: size.words };
  for (const [tier, limit] of Object.entries(limits)) out[`fits_${tier}`] = fitsTier(size, limit);
  return out;
}

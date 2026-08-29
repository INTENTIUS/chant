/**
 * Per-change disruption classification (#1665).
 *
 * The change set says WHAT a pending change is (`create`/`update`/`delete`/…).
 * It says nothing about what applying it costs. An `update` that flips a tag
 * and an `update` that rebuilds a database read identically, and the second one
 * is the one that wakes somebody up.
 *
 * The knowledge that separates them is spec knowledge. CloudFormation's
 * registry schema declares `createOnlyProperties` per type; Kubernetes' SSA
 * schema knows which field changes roll a workload. Core owns neither, and
 * hardcoding either here would put per-provider replacement rules in the tool
 * — the same mistake `postSynthChecks` exists to avoid. So core defines the
 * contract and the reporting, and the lexicon that compiled the spec supplies
 * the answer, via {@link LexiconPlugin.classifyDisruption}.
 *
 * The invariant that makes the field trustworthy is that `unknown` is the
 * default and the only fallback. No classifier, a classifier that says nothing
 * about an entry, a classifier that throws, a classifier that returns a level
 * outside the vocabulary — all of them land on `unknown`, never on `in-place`.
 * A confident "this mutates in place" is only ever a lexicon's own claim.
 */
import type { AttributeChange } from "./live-diff";
import type { ChangeSet, ChangeSetEntry } from "./change-set";

/**
 * How much applying one pending change hurts.
 *
 * - `in-place` — the provider mutates the existing resource. No new identity,
 *   no window where it is absent.
 * - `rolling` — the resource survives, but its workload is replaced
 *   incrementally (a Deployment's pod template changing). Disruptive to what
 *   is running, not to the resource.
 * - `replace` — a new resource is created and the old one removed. The
 *   physical id changes; anything holding the old one has to be updated.
 * - `destroy` — replacement that removes the old resource FIRST. There is a
 *   window with nothing there, and whatever the old one held is gone.
 * - `unknown` — nobody could say. The honest value, and the default: it is
 *   what a change gets when no lexicon classifies it, and it must never be
 *   read as "probably fine".
 */
export type Disruption = "in-place" | "rolling" | "replace" | "destroy" | "unknown";

/** Every level, most disruptive last — also the guard core validates a lexicon's answer against. */
export const DISRUPTION_LEVELS: readonly Disruption[] = [
  "in-place",
  "rolling",
  "replace",
  "destroy",
  "unknown",
];

/** Ordering for "the worst thing in this plan", with `unknown` above every confident verdict. */
const DISRUPTION_RANK: Record<Disruption, number> = {
  "in-place": 0,
  rolling: 1,
  replace: 2,
  destroy: 3,
  unknown: 4,
};

/** One pending change put to a lexicon for classification. */
export interface DisruptionQuery {
  /** The change set entry's `name` — the key a verdict comes back under. */
  name: string;
  /** Resource type, when the observation reported one. */
  type?: string;
  /** The attribute-level changes the entry carries. */
  deltas: AttributeChange[];
}

/** A lexicon's answer for one query. */
export interface DisruptionVerdict {
  disruption: Disruption;
  /** The attribute paths that forced the verdict — empty or absent when none did. */
  because?: string[];
  /** One line of human-readable backing, naming the spec knowledge behind the call. */
  detail?: string;
}

/**
 * The shape of {@link LexiconPlugin.classifyDisruption}. Keyed by query `name`;
 * a name the lexicon says nothing about degrades to `unknown`, so a partial
 * answer is a valid answer.
 */
export type DisruptionClassifier = (options: {
  environment: string;
  changes: DisruptionQuery[];
}) => Record<string, DisruptionVerdict> | Promise<Record<string, DisruptionVerdict>>;

/** The verdict every fallback path produces. */
export function unknownDisruption(detail: string): DisruptionVerdict {
  return { disruption: "unknown", detail };
}

/**
 * Annotate one lexicon's change set with a disruption verdict per `update`.
 *
 * Only `update` entries are asked about: every other action already carries its
 * blast radius in the action itself. Called once per lexicon, before the plan
 * merges the change sets, so `classify` is always the lexicon that produced the
 * entries — the only party that can map its own observation's attribute paths
 * back onto spec properties.
 *
 * Returns a new change set; the input is not mutated.
 */
export async function annotateDisruption(
  cs: ChangeSet,
  environment: string,
  classify?: DisruptionClassifier,
): Promise<ChangeSet> {
  const updates = cs.entries.filter((e) => e.action === "update");
  if (updates.length === 0) return cs;

  const who = updates[0].lexicon ? `the ${updates[0].lexicon} lexicon` : "this lexicon";

  let verdicts: Record<string, DisruptionVerdict> = {};
  let fallback: string | undefined;

  if (!classify) {
    fallback = `${who} does not classify disruption — replacement semantics are spec knowledge it has not published`;
  } else {
    try {
      verdicts = (await classify({
        environment,
        changes: updates.map((e) => ({
          name: e.name,
          ...(e.type ? { type: e.type } : {}),
          deltas: e.deltas ?? [],
        })),
      })) ?? {};
    } catch (err) {
      // A broken classifier is not evidence of anything. It must not be able to
      // leave a confident verdict behind, and it must not fail the plan either.
      verdicts = {};
      fallback = `${who}'s disruption classifier failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const entries = cs.entries.map((e) => {
    if (e.action !== "update") return e;
    const verdict = resolveVerdict(verdicts[e.name], fallback, who);
    const annotated: ChangeSetEntry = {
      ...e,
      disruption: verdict.disruption,
      ...(verdict.because && verdict.because.length > 0 ? { disruptionBecause: verdict.because } : {}),
      ...(verdict.detail ? { disruptionDetail: verdict.detail } : {}),
    };
    return annotated;
  });

  return { ...cs, entries };
}

function resolveVerdict(
  verdict: DisruptionVerdict | undefined,
  fallback: string | undefined,
  who: string,
): DisruptionVerdict {
  if (fallback) return unknownDisruption(fallback);
  if (!verdict) return unknownDisruption(`${who} returned no verdict for this change`);
  if (!DISRUPTION_LEVELS.includes(verdict.disruption)) {
    return unknownDisruption(
      `${who} returned "${String(verdict.disruption)}", which is not a disruption level`,
    );
  }
  return verdict;
}

/** Count `update` entries per level. Entries with no verdict at all are not counted. */
export function summarizeDisruption(cs: ChangeSet): Record<Disruption, number> {
  const counts: Record<Disruption, number> = {
    "in-place": 0,
    rolling: 0,
    replace: 0,
    destroy: 0,
    unknown: 0,
  };
  for (const e of cs.entries) {
    if (e.action === "update" && e.disruption) counts[e.disruption]++;
  }
  return counts;
}

/** The most disruptive verdict in the set, or undefined when nothing was classified. */
export function worstDisruption(cs: ChangeSet): Disruption | undefined {
  let worst: Disruption | undefined;
  for (const e of cs.entries) {
    if (e.action !== "update" || !e.disruption) continue;
    if (!worst || DISRUPTION_RANK[e.disruption] > DISRUPTION_RANK[worst]) worst = e.disruption;
  }
  return worst;
}

/**
 * Warnings a plan should print on stderr — so a `--json` or `--report gitlab-mr`
 * consumer, whose shape has no column for disruption, still hears about the
 * expensive rows. Same discipline as the unobserved warning (#1089).
 */
export function disruptionNotices(cs: ChangeSet): string[] {
  const counts = summarizeDisruption(cs);
  const notices: string[] = [];
  const replacing = counts.replace + counts.destroy;
  if (replacing > 0) {
    notices.push(
      `${replacing} update(s) replace the resource rather than mutating it in place` +
        (counts.destroy > 0
          ? `, ${counts.destroy} of them by deleting it first — that window has nothing in it.`
          : "."),
    );
  }
  if (counts.unknown > 0) {
    notices.push(
      `${counts.unknown} update(s) could not be classified — no lexicon could say whether applying them replaces the resource. Unknown is not "in place".`,
    );
  }
  return notices;
}

/** Render one entry's verdict for the human plan, or "" when there is none. */
export function renderDisruption(entry: ChangeSetEntry): string {
  if (!entry.disruption) return "";
  return ` — ${entry.disruption}${entry.disruptionDetail ? `: ${entry.disruptionDetail}` : ""}`;
}

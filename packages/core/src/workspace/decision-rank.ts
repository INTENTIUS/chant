/**
 * How decisions are ranked, most relevant first: the order of `why.decisions`
 * in the intent graph (#3034) and of a gate's `decisions` in `workspace
 * status` (#3616). One comparator, so the two reads can't drift apart.
 */

/** Why a decision is in `why`, most relevant first (#3034). */
export type WhyRelevance = "carried" | "path" | "contract" | "issue" | "member" | "related";

const ORDER: readonly WhyRelevance[] = ["carried", "path", "contract", "issue", "member", "related"];

/** What the ranking reads of one decision. */
export interface DecisionRankKey {
  /** The decision's node id, `record:<kind>/<id>`: the last tie-break. */
  id: string;
  /** Not superseded. */
  current: boolean;
  relevance: WhyRelevance;
  /** How many of the region's current lines were made as its own work; 0 when history isn't read. */
  lines: number;
  /** Its state is one its kind closes. */
  closed: boolean;
  /** The length of its longest `path:` entry covering the region: a narrower path is more specific. */
  specificity: number;
  /** The date of the commit that decided it, or null. */
  decidedOn: string | null;
}

/** Current first, then relevance, own lines, closed, specificity, newest decided, and id. */
export function compareDecisionRank(a: DecisionRankKey, b: DecisionRankKey): number {
  return (
    Number(b.current) - Number(a.current) ||
    ORDER.indexOf(a.relevance) - ORDER.indexOf(b.relevance) ||
    b.lines - a.lines ||
    Number(b.closed) - Number(a.closed) ||
    b.specificity - a.specificity ||
    (b.decidedOn ?? "").localeCompare(a.decidedOn ?? "") ||
    a.id.localeCompare(b.id)
  );
}

import { NEXT_RELEASE } from "./release-floors";

/**
 * The first chant whose checkout step runs on a branch or tag run (#5437):
 * with history, the run's commit is fetched to `refs/chant/want`, apart from
 * the `refs/heads/*` and `refs/tags/*` refspecs, and then moved onto its
 * remote-tracking ref. Before, two refspecs wrote `refs/remotes/origin/<branch>`
 * and git exited 128.
 */
export const CHECKOUT_FETCH_FLOOR = NEXT_RELEASE;

/**
 * Ask which builder tier builds a work item: the `slice-tier` point the
 * reference workspace declares in `decisions/points.json`.
 *
 * `read` reads work item W-002 through the read contract, and each of the
 * point's `work-item.*` inputs takes its field. A table row answers when one
 * matches; otherwise the model decider's backend is asked, and its answer is
 * recorded as a proposal a person confirms with `chant workspace points
 * answer`. The step returns the answer record.
 */

import { Op, phase } from "@intentius/chant/op";
import { decide } from "@intentius/chant-lexicon-systemone";

export default Op({
  name: "tier-work",
  overview: "Ask which builder tier builds W-002, and record the answer",
  phases: [phase("Decide", [decide("slice-tier", { read: { "work-item": "W-002" }, subject: "W-002" })])],
});

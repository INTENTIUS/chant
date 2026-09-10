/**
 * The questions. Everything augur declares is here.
 *
 * A profile is a traffic level to predict the estate at, written the way the
 * answer will be read. chant parses none of it and defaults none of it: the
 * string goes to the engine verbatim, and an engine that does not understand a
 * level refuses rather than substituting one it likes better.
 *
 * Two levels, deliberately different — AUG101 reports two profiles naming the
 * same level, since identical questions are one request asked twice and a
 * delta between the answers that is zero by construction.
 */

import { Profile } from "@intentius/chant-lexicon-augur";

export const steady = new Profile({
  traffic: "100 rps, p50",
  description: "An ordinary weekday afternoon on the checkout path",
});

export const peak = new Profile({
  traffic: "1000 rps, p99",
  description: "Friday evening, the hour the estate is sized for",
});

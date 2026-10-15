import type { Serializer } from "@intentius/chant/serializer";

/**
 * The e2b lexicon declares no resources: it is a place to run Ops, not a
 * platform to describe. A build that somehow hands it entities gets an empty
 * document rather than an invented format.
 */
export const e2bSerializer: Serializer = {
  name: "e2b",
  rulePrefix: "E2B",
  serialize() {
    return "";
  },
};

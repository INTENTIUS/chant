import type { Declarable, Serializer } from "@intentius/chant";

/**
 * systemone serializer.
 *
 * A stub, deliberately. This lexicon is verbs only: a decision point's
 * question lives in the workspace's points file and its answers are records,
 * so there is no resource to declare and nothing for chant to write. What the
 * lexicon adds is the `decide` Op activity and the checks around it.
 *
 * `name` is the key `build()` files this lexicon's output under, and
 * `rulePrefix` is what every `SYS*` id is checked against.
 */
export const systemoneSerializer: Serializer = {
  name: "systemone",
  rulePrefix: "SYS",

  serialize(_entities: Map<string, Declarable>): string {
    return "";
  },
};

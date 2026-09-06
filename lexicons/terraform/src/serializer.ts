import type { Declarable, Serializer } from "@intentius/chant";

/**
 * terraform serializer.
 *
 * A stub, deliberately. The entities this lexicon carries come from `.tf`
 * files that already exist on disk (`buildRoots()` parses the roots named in
 * `terraform.roots`), so there is nothing for chant to write back: emitting
 * HCL here would put a second, generated copy of the estate beside the
 * authored one. The lexicon's value is what the entities let the rest of
 * chant do with the root (post-synth checks, `chant audit`, the Op surface),
 * not a rendered artifact.
 *
 * `name` and `rulePrefix` are the two members the `Serializer` contract
 * requires, and both are load-bearing: `name` is the key `build()` files this
 * lexicon's output under, and `rulePrefix` is what every `TF*` id is checked
 * against.
 */
export const terraformSerializer: Serializer = {
  name: "terraform",
  rulePrefix: "TF",

  serialize(_entities: Map<string, Declarable>): string {
    return "";
  },
};

import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * The same one-root shape `examples/getting-started` uses. What differs is
 * `src/`, which holds two Ops over that one root: `app-plan` for the pull
 * request and `app-apply` for the push that follows the merge. Both live in
 * `src/` since chant #2101, so `chant dev check-lexicon`'s example build
 * discovers them and runs core's own OPS012/OPS013 over their steps.
 */
export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "terraform",
    roots: {
      app: { dir: "./terraform" },
    },
  },
} satisfies ChantConfig;

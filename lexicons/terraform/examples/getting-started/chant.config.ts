import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * `terraform.roots` names the root modules chant reads. `dir` is relative to
 * this file, which is the project root: a `.tf` tree usually lives beside the
 * typed source rather than inside it.
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

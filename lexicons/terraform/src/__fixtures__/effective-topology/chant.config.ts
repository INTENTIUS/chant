import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

export default {
  lexicons: ["terraform"],
  terraform: {
    roots: {
      net: { dir: "./net" },
    },
  },
} satisfies ChantConfig;

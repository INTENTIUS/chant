import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

export default {
  lexicons: ["terraform"],
  terraform: {
    roots: {
      app: { dir: "./app" },
    },
  },
} satisfies ChantConfig;

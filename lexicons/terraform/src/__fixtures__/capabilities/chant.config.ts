import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

export default {
  lexicons: ["terraform"],
  // The estates hold the findings these rules report on purpose.
  lint: { rules: { TF022: "off", TF030: "off", TF033: "off" } },
  terraform: {
    roots: {
      ledger: { dir: "./ledger" },
      catalog: { dir: "./catalog" },
      findings: { dir: "./findings" },
    },
  },
} satisfies ChantConfig;

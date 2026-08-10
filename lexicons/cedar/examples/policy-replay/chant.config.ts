import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

export default {
  lexicons: ["cedar"],
  cedar: {
    schema: "schema.cedarschema",
  },
} satisfies ChantConfig;

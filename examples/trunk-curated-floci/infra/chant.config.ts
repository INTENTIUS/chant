import type { ChantConfig } from "@intentius/chant";

// The AWS lexicon synthesizes the template; environments are the promotion order.
export default {
  environments: ["staging", "prod"],
  lexicons: ["aws"],
} satisfies ChantConfig;

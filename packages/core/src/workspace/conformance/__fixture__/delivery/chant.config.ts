import type { ChantConfig } from "@intentius/chant";

// The member's one lexicon is declared by path (#2520), so the workspace
// needs no package beyond @intentius/chant.
export default {
  lexicons: [{ name: "fixture", module: "./lexicon/index.ts" }],
} satisfies ChantConfig;

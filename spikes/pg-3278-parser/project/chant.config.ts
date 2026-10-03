import type { ChantConfig } from "@intentius/chant";

// The spike lexicon is declared by module path (chant #2520): nothing is installed or published for it.
export default {
  lexicons: [{ name: "sql", module: "./lexicon/index.ts", root: "./lexicon" }],
} satisfies ChantConfig;

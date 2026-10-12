import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

// `lint.policies` registers the project's own checks. They run in `chant build`
// and `chant lint` over the parsed schema, and read it through
// `@intentius/chant-lexicon-sql/read`.
export default {
  lexicons: ["sql"],
  sql: { dialect: "postgres" },
  lint: { policies: ["policies/columns.ts"] },
} satisfies ChantConfig;

import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default { lexicons: ["sql"], sql: { dialect: "postgres" } } satisfies ChantConfig;

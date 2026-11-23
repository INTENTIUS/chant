import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-cedar";

// Named here because detection scans the source text for lexicon imports, and
// policies.ts shows the aws lexicon's `import` in a doc comment. Detection
// would load aws too, which a cedar-only checkout has not generated.
export default {
  lexicons: ["cedar"],
} satisfies ChantConfig;

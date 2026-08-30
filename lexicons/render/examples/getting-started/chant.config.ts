import type { ChantConfig } from "@intentius/chant";

// The render lexicon (loads the Public API applier activities: renderApply /
// renderDelete) plus temporal (the base activities: chantBuild, httpCheck).
// `chant run render` resolves each Op step's `fn` against these.
export default { lexicons: ["render", "temporal"] } satisfies ChantConfig;

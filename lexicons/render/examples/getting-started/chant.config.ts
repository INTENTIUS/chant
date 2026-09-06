import type { ChantConfig } from "@intentius/chant";

// The render lexicon loads the Public API applier activities (renderApply /
// renderDelete); the base activities (chantBuild, httpCheck) are core's own.
// `chant run render` resolves each Op step's `fn` against both.
export default { lexicons: ["render"] } satisfies ChantConfig;

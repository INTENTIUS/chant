import type { ChantConfig } from "@intentius/chant";

// The fly lexicon (loads the flaps applier + mudflaps lifecycle activities:
// flyApply / flapsUp / flapsDown) plus temporal (the base activities: chantBuild,
// httpCheck). `chant run fly` resolves each Op step's `fn` against these.
export default { lexicons: ["fly", "temporal"] } satisfies ChantConfig;

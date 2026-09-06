import type { ChantConfig } from "@intentius/chant";

// The fly lexicon (loads the flaps applier + mudflaps lifecycle activities:
// flyApply / flapsUp / flapsDown). The base activities (chantBuild, httpCheck)
// and the Op DSL are core's, so they need no entry here. `chant run
// fly-reconcile` resolves each Op step's `fn` against both.
export default { lexicons: ["fly"] } satisfies ChantConfig;

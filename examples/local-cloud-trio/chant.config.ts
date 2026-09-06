import type { ChantConfig } from "@intentius/chant";

// All three cloud lexicons — so `chant run` loads each cloud's applier
// activity (aws → floci/nativeApply, azure → azApply, gcp → gcpApply). The
// base activities are core's and are always loaded.
export default { lexicons: ["aws", "azure", "gcp"] } satisfies ChantConfig;

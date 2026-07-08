import type { ChantConfig } from "@intentius/chant";

// All three cloud lexicons plus temporal — so `chant run` loads each cloud's
// applier activity (aws → floci/nativeApply, azure → azApply, gcp → gcpApply).
export default { lexicons: ["aws", "azure", "gcp", "temporal"] } satisfies ChantConfig;

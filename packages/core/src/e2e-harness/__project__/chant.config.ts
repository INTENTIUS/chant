import type { ChantConfig } from "@intentius/chant";

/** The e2e harness's compose project (chant#4587): floci, Forgejo, forgejo-runner, and the sql emulator behind a profile. */
export default { lexicons: ["docker"] } satisfies ChantConfig;

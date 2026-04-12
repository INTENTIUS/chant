/**
 * chant configuration — Temporal worker profiles.
 *
 * The `temporal.profiles` object is the single source of truth for how this project's
 * Temporal worker connects to Temporal Cloud. Importing this config in worker.ts means
 * connection configuration is version-controlled and TypeScript-checked — a missing
 * `taskQueue` or wrong namespace is a compile error, not a runtime failure after 5 minutes.
 *
 * Usage in worker.ts:
 *   import config from "../chant.config.ts";
 *   const profile = config.temporal.profiles[config.temporal.defaultProfile ?? "cloud"];
 */

import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

export default {
  temporal: {
    profiles: {
      cloud: {
        address:    process.env.TEMPORAL_ADDRESS   ?? "crdb-deploy.a2dd6.tmprl.cloud:7233",
        namespace:  process.env.TEMPORAL_NAMESPACE ?? "crdb-deploy.a2dd6",
        taskQueue:  "crdb-deploy",
        tls:        true,
        apiKey:     { env: "TEMPORAL_API_KEY" },
      },
      local: {
        address:    "localhost:7233",
        namespace:  "default",
        taskQueue:  "crdb-deploy",
        autoStart:  true,
      },
    },
    defaultProfile: "cloud",
  } satisfies TemporalChantConfig,
};

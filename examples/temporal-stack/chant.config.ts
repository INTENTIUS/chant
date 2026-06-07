/**
 * chant configuration — Temporal worker profiles.
 *
 * Import this in your worker.ts to get a typed, version-controlled connection profile:
 *
 *   import config from "./chant.config.ts";
 *   const profile = config.temporal.profiles[config.temporal.defaultProfile ?? "local"];
 */

import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

export default {
  temporal: {
    profiles: {
      local: {
        address:   "localhost:7233",
        namespace: "my-app",
        taskQueue: "my-app",
        autoStart: true,
      },
    },
    defaultProfile: "local",
  } satisfies TemporalChantConfig,
};

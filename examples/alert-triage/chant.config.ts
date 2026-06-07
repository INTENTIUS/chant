import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

// `lexicons` is read by chant. `ownership` stamps a stack-identity marker on
// every resource, so the lifecycle dial / drift source can scope to chant-owned
// resources (cf. the getting-started example). `temporal` profiles are read by
// the hand-written worker (activities/worker.ts) and the triage client
// (app/triage-client.ts) — this app is raw Temporal, not a chant Op, so there is
// no generated Op worker.
export default {
  lexicons: ["k8s", "temporal"],
  ownership: { stack: "alert-triage", env: "local" },
  temporal: {
    profiles: {
      local: {
        address: "localhost:7233",
        namespace: "default",
        taskQueue: "alert-triage",
        autoStart: true,
      },
    },
    defaultProfile: "local",
  } satisfies TemporalChantConfig,
};

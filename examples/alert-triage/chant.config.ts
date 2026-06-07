import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

// `lexicons` is read by chant; `temporal` is read by the generated Op worker
// when you run the triage Op with `--temporal` (the gate makes it Temporal-bound).
export default {
  lexicons: ["k8s", "temporal"],
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

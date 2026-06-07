import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

// `lexicons` is read by chant; `temporal` is read by the generated Op worker
// when you run an Op with `--temporal` (L3+). L1/L2 need nothing here at runtime.
export default {
  lexicons: ["k8s", "temporal"],
  temporal: {
    profiles: {
      local: {
        address: "localhost:7233",
        namespace: "default",
        taskQueue: "getting-started-deploy",
        autoStart: true,
      },
    },
    defaultProfile: "local",
  } satisfies TemporalChantConfig,
};

import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

// `lexicons` is read by chant; `temporal` is read by the generated Op worker
// when you run an Op with `--temporal` (L3+). `ownership` stamps a marker on each
// resource so the L4 dial (reconcile/apply) can scope to chant-owned resources.
// L1/L2 need nothing here at runtime.
export default {
  lexicons: ["k8s", "temporal"],
  ownership: { stack: "getting-started", env: "local" },
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

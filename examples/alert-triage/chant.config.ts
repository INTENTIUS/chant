import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

// `lexicons` is read by chant. `sourceDir` scopes lifecycle builds to `src/`
// (this is a mixed-layout project — chant infra in src/ next to app/ and
// activities/ that import @temporalio and start servers on load), so
// `chant lifecycle plan/diff/snapshot` only synthesizes the infra. `ownership`
// stamps a stack-identity marker on every resource, so the lifecycle dial /
// drift source can scope to chant-owned resources (cf. the getting-started
// example). `temporal` profiles are read by the hand-written worker
// (activities/worker.ts) and the triage client (app/triage-client.ts) — this
// app is raw Temporal, not a chant Op, so there is no generated Op worker.
export default {
  lexicons: ["k8s", "temporal"],
  sourceDir: "src",
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

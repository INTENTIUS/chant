import type { TemporalChantConfig } from "@intentius/chant-lexicon-temporal";

// fly provides the deploy activities; temporal provides the Op DSL and the
// generated durable worker. The `temporal` profile is read when you run the Op
// with `--temporal`: it auto-starts a local `temporal server start-dev` and runs
// the deploy as a durable workflow against it.
export default {
  lexicons: ["fly", "temporal"],
  temporal: {
    profiles: {
      local: { address: "localhost:7233", namespace: "default", taskQueue: "fly-durable", autoStart: true },
    },
    defaultProfile: "local",
  } satisfies TemporalChantConfig,
};

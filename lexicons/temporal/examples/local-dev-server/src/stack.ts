import { TemporalDevStack } from "@intentius/chant-lexicon-temporal";

/**
 * Local dev stack: a single-container Temporal dev server (via
 * `temporal server start-dev`) plus a default namespace, wired together by
 * the TemporalDevStack composite.
 */
export const { server, ns } = TemporalDevStack({
  namespace: "my-app",
  retention: "7d",
});

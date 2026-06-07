import { TemporalDevStack } from "@intentius/chant-lexicon-temporal";

export const { server, ns } = TemporalDevStack({
  namespace: "my-app",
  retention: "14d",
  description: "Application namespace — managed by chant",
});

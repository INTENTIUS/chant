import { HelmLibrary } from "@intentius/chant-lexicon-helm";

export const { chart, helpers } = HelmLibrary({
  name: "common-lib",
  version: "1.0.0",
  description: "Shared helper templates for all microservices",
  dependencies: [
    { name: "common", version: "1.x.x", repository: "https://charts.bitnami.com/bitnami" },
  ],
});

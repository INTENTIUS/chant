import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP008 fail case: a terraform-apply step deploys "azure", which the test marks signalOnly. */
export const dns: Component = {
  name: "dns",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      { kind: "terraform-apply", root: "dns" },
      { kind: "terraform-apply", root: "azure" },
    ]),
  ],
};

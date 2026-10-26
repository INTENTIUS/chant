import type { Component } from "../../../../../../components/component";
import { phase } from "../../../../../../components/component";

/** COMP008 pass case: the component deploys only its own root, "dns". */
export const dns: Component = {
  name: "dns",
  archetype: "infra",
  dependsOn: [],
  deploy: [phase("Apply", [{ kind: "terraform-apply", root: "dns" }])],
};

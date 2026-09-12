import { phase, type Component } from "@intentius/chant/components";

/**
 * The seed of every fan-out in this estate.
 *
 * `dependsOn: []` is the honest statement here: nothing in the project produces
 * a value `network` consumes. Everything downstream of it says so in its own
 * file, which is why no file anywhere lists the estate's order.
 */
export const network: Component = {
  name: "network",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Apply", [
      { kind: "cfn-deploy", stack: "network", template: "dist/network.template.json" },
    ]),
  ],
};

// edge sits on app: it routes to the port app listens on, and records the
// subnet app's worker landed in.
//
// Types only, and stackOutput() written as the plain data it returns, so a
// checkout with no node_modules evaluates the file (see network.component.ts).
import type { Component } from "@intentius/chant/components";

export const edge: Component = {
  name: "edge",
  archetype: "service",
  dependsOn: ["app"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "terraform-apply",
          root: "edge",
          noRollback: "demo roots on an emulator; a reset applies the base again",
          vars: {
            listener_port: { stackOutput: { stack: "app", name: "listener_port" } },
            worker_subnet_id: { stackOutput: { stack: "app", name: "worker_subnet_id" } },
          },
        },
      ],
    },
  ],
};

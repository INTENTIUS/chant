// app sits on network. It states the edge twice: dependsOn, which orders the
// run, and the vars that fill the root's variables with network's outputs
// (roots/app/main.tf declares them).
//
// Types only, and stackOutput() written as the plain data it returns, so a
// checkout with no node_modules evaluates the file (see network.component.ts).
import type { Component } from "@intentius/chant/components";

export const app: Component = {
  name: "app",
  archetype: "service",
  dependsOn: ["network"],
  deploy: [
    {
      phase: "Apply",
      steps: [
        {
          kind: "terraform-apply",
          root: "app",
          noRollback: "demo roots on an emulator; a reset applies the base again",
          vars: {
            vpc_id: { stackOutput: { stack: "network", name: "vpc_id" } },
            subnet_a_id: { stackOutput: { stack: "network", name: "subnet_a_id" } },
            http_proxy_port: { stackOutput: { stack: "network", name: "http_proxy_port" } },
            admin_port: { stackOutput: { stack: "network", name: "admin_port" } },
          },
        },
      ],
    },
  ],
};

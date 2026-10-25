// The seed of the estate: nothing in the project produces a value network
// reads, so it depends on nothing.
//
// The file imports types only, and writes what phase() would return as plain
// data, so a checkout with no node_modules evaluates it: behold draws the
// components from its view checkout of the demo repo.
import type { Component } from "@intentius/chant/components";

export const network: Component = {
  name: "network",
  archetype: "infra",
  dependsOn: [],
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "network", noRollback: "demo roots on an emulator; a reset applies the base again" }] }],
};

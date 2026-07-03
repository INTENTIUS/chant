// chant-disable COMP004 -- graduates to `chant run --temporal`; the Node 1 gate is a deliberate human-approval wait, see docs/components/orchestration.mdx
import type { Component } from "../../../../../../components/component";
import { gate, phase } from "../../../../../../components/component";

/** COMP004 pass case: a genuine gate, opted out via a file-level disable directive with a documented reason — the intended path for a component that graduates to the Temporal backend. */
export const neo4jCluster: Component = {
  name: "neo4j-cluster",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Seed", [
      { kind: "cfn-deploy", template: "archive:neo4j-az0-0.template.json" },
      { kind: "code-deploy", instance: 0, revision: "@Seed.templateUri" },
      { kind: "wait-cluster-healthy", size: 1 },
    ]),
    phase("Node 1", [
      gate("approve-neo4j-node-1", { description: "Confirm the seed node is healthy before rolling to node 1", timeout: "24h" }),
      { kind: "cfn-deploy", template: "archive:neo4j-1.template.json" },
      { kind: "code-deploy", instance: 1, revision: "@Seed.templateUri" },
      { kind: "wait-cluster-healthy", quorum: true },
    ]),
  ],
};

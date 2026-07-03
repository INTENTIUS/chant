import type { Component } from "../../../../../../components/component";
import { gate, phase } from "../../../../../../components/component";

/** COMP004 fail case: a gate step with no disable directive — flagged, since the local executor cannot run it. */
export const neo4jCluster: Component = {
  name: "neo4j-cluster",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    phase("Seed", [
      { kind: "cfn-deploy", template: "archive:neo4j-az0-0.template.json" },
      { kind: "wait-cluster-healthy", size: 1 },
    ]),
    phase("Node 1", [
      gate("approve-neo4j-node-1", { description: "Confirm the seed node is healthy before rolling to node 1" }),
      { kind: "cfn-deploy", template: "archive:neo4j-1.template.json" },
      { kind: "wait-cluster-healthy", quorum: true },
    ]),
  ],
};

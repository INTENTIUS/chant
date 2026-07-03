/**
 * Pilot: Neo4j per-instance fan-out cluster (#555, epic #551).
 *
 * Exercises the fan-out axis: one component composing N per-instance
 * mini-compositions (`cfn-deploy` + `code-deploy` + a health wait), seeded
 * first, then rolled through the remaining instances one at a time behind a
 * `wait-cluster-healthy` gate. See composition-and-wiring.mdx#fan-out-is-composition-not-orchestrator-knowledge.
 *
 * The JSON projection of this pilot is authoritative at
 * ../__fixtures__/neo4j-fanout.json (already schema-validated by
 * component-schema.test.ts) — this module is the real typed `Component`
 * authoring form (#560, ../component.ts) that composes to that same
 * document; see ./pilots.test.ts, which asserts the two never diverge.
 */

import type { Component, Phase } from "../component";
import { gate, phase } from "../component";

/** One Neo4j instance's mini-composition: provision, code-deploy the build, then wait for cluster health. */
interface Neo4jInstanceConfig {
  /** Cluster-relative instance index (0 = seed). */
  index: number;
  /** Phase display name. */
  label: string;
  /** Availability-zone-qualified CloudFormation template for this instance. */
  template: string;
  /**
   * Health condition to satisfy before moving to the next instance. The seed
   * instance only needs itself up (`size: 1`); every subsequent instance
   * requires quorum across whatever is live so far.
   */
  health: { size: number } | { quorum: true };
  /** Optional human gate placed before this instance's steps (rolling instances only, never the seed). */
  approval?: { signalName: string; description: string; timeout: string };
}

const SEED: Neo4jInstanceConfig = {
  index: 0,
  label: "Seed",
  template: "archive:neo4j-az0-0.template.json",
  health: { size: 1 },
};

/**
 * Followers roll one at a time after the seed is healthy. Node 1 carries an
 * explicit approval gate — composed the same way any other step is, never as
 * driver knowledge — so a human confirms the seed before the cluster starts
 * fanning out further; later nodes roll unattended once that first rollout is
 * trusted.
 */
const FOLLOWERS: Neo4jInstanceConfig[] = [
  {
    index: 1,
    label: "Node 1",
    template: "archive:neo4j-1.template.json",
    health: { quorum: true },
    approval: {
      signalName: "approve-neo4j-node-1",
      description: "Confirm the seed node is healthy before rolling to node 1",
      timeout: "24h",
    },
  },
  {
    index: 2,
    label: "Node 2",
    template: "archive:neo4j-2.template.json",
    health: { quorum: true },
  },
];

/** Build one instance's mini-composition phase — the unit that repeats N times for an N-node cluster. */
function instancePhase(instance: Neo4jInstanceConfig): Phase {
  const steps = [
    ...(instance.approval ? [gate(instance.approval.signalName, instance.approval)] : []),
    { kind: "cfn-deploy", template: instance.template },
    { kind: "code-deploy", instance: instance.index, revision: "@Seed.templateUri" },
    { kind: "wait-cluster-healthy", ...instance.health },
  ];
  return phase(instance.label, steps);
}

export const neo4jCluster: Component = {
  name: "neo4j-cluster",
  archetype: "infra",
  dependsOn: [],
  deploy: [
    instancePhase(SEED),
    // Array.map over instance configs — the fan-out is authored here, in the
    // composition, never known by the orchestrator (composition-and-wiring.mdx).
    ...FOLLOWERS.map(instancePhase),
  ],
};

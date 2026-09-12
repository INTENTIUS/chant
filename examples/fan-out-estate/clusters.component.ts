import { phase, stackOutput, type Component } from "@intentius/chant/components";

/**
 * The two clusters, both downstream of `network`.
 *
 * Each one states the edge twice, and the two statements have to agree or the
 * deploy fails. `dependsOn: ["network"]` is what the fan-out reads to order the
 * run. The `inputs` block is what CloudFormation reads to fill the stack's
 * parameters, and those parameters are declared in each cluster's own
 * `params.ts` under `src/` and read by its `resources.ts`. Drop the
 * `dependsOn` and the `stackOutput` call still needs a deployed `network`;
 * drop the `inputs` and the stack has no values for parameters it cannot
 * synthesize without.
 *
 * The two components are written out rather than generated from a loop, which
 * is the form the rest of the repository's component files take: what a reader
 * sees is what discovery reads.
 */

export const clusterA: Component = {
  name: "cluster-a",
  archetype: "infra",
  dependsOn: ["network"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "cluster-a",
        template: "dist/cluster-a.template.json",
        // Keys are the parameter names, which are the export names in
        // src/cluster-a/params.ts.
        inputs: {
          clusterATopicArn: stackOutput("network", "TopicArn"),
          clusterAQueueUrl: stackOutput("network", "QueueUrl"),
        },
      },
    ]),
  ],
};

export const clusterB: Component = {
  name: "cluster-b",
  archetype: "infra",
  dependsOn: ["network"],
  deploy: [
    phase("Apply", [
      {
        kind: "cfn-deploy",
        stack: "cluster-b",
        template: "dist/cluster-b.template.json",
        inputs: {
          clusterBTopicArn: stackOutput("network", "TopicArn"),
          clusterBQueueUrl: stackOutput("network", "QueueUrl"),
        },
      },
    ]),
  ],
};

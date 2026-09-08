/**
 * ALB multi-service deploy Op — this example's deploy verb.
 *
 * Demonstrates the Op pattern: a named, phased workflow declared as
 * infrastructure code. `chant run alb-deploy` executes it in-process from this
 * directory, which is why the paths below are relative to it.
 *
 * Phases:
 *   1. Build (parallel) — synthesize both projects concurrently
 *   2. Deploy           — apply the two stacks in dependency order
 *   3. Verify           — snapshot the deployed state
 */
import { Op, phase, build, lifecycleSnapshot } from "@intentius/chant/op";
import { awsApply } from "@intentius/chant-lexicon-aws/op/builders";

export default Op({
  name: "alb-deploy",
  overview: "Build and deploy the ALB multi-service stack to the target environment",

  // Discovery keys, not runtime state (#2118). `chant run list` prints them and
  // a reader filters declarations on them; nothing registers them anywhere.
  // What one run did — its phase outcomes, drift, approvals — is a fact about
  // that run, and lands on the run ledger with these labels copied alongside.
  labels: {
    Environment: "staging",
    Estate: "shared-alb",
  },

  phases: [
    phase("Build", [
      build("."),
      build("../gitlab-aws-alb-services"),
    ], { parallel: true }),

    // Sequential and in this order: the services stack takes the ALB listener,
    // cluster and subnets published by the infra stack as parameters.
    phase("Deploy", [
      awsApply("templates/template.json", { stackName: "shared-alb" }),
      awsApply("../gitlab-aws-alb-services/templates/template.json", { stackName: "shared-alb-services" }),
    ]),

    phase("Verify", [
      lifecycleSnapshot("staging"),
    ]),
  ],
});

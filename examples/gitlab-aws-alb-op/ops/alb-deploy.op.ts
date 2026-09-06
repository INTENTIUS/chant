/**
 * ALB multi-service deploy Op.
 *
 * Demonstrates the Op pattern: a named, phased workflow declared as
 * infrastructure code. `chant run alb-deploy` executes it in-process.
 *
 * Phases:
 *   1. Build (parallel) — build all three services concurrently
 *   2. Deploy           — apply manifests sequentially (ordered by dependency)
 *   3. Verify           — wait for rollout, then snapshot state
 */
import { Op, phase, build, waitForStack, lifecycleSnapshot } from "@intentius/chant/op";
import { kubectlApply } from "@intentius/chant-lexicon-k8s/op/builders";

export default Op({
  name: "alb-deploy",
  overview: "Build and deploy the ALB multi-service stack to the target environment",

  // Auto-injected into workflow.upsertSearchAttributes() at workflow start
  // alongside OpName. Each phase boundary additionally upserts Phase. These
  // attributes must be registered server-side via SearchAttribute resources.
  labels: {
    Environment: "staging",
    Region: "us-east-1",
  },

  phases: [
    phase("Build", [
      build("examples/gitlab-aws-alb-infra"),
      build("examples/gitlab-aws-alb-api"),
      build("examples/gitlab-aws-alb-ui"),
    ], { parallel: true }),

    phase("Deploy", [
      kubectlApply("dist/alb-infra.yaml"),
      kubectlApply("dist/alb-api.yaml"),
      kubectlApply("dist/alb-ui.yaml"),
    ]),

    phase("Verify", [
      waitForStack("alb-api", { namespace: "alb" }),
      waitForStack("alb-ui", { namespace: "alb" }),
      lifecycleSnapshot("staging"),
    ]),
  ],
});

import { Op, phase, activity, flociUp, build, flociDown } from "@intentius/chant-lexicon-temporal";

/**
 * Boot a local Floci AWS emulator, build and deploy a CloudFormation stack to it,
 * then tear the emulator down — a fully local AWS deploy loop with no account
 * (issue #704).
 *
 * `chant run local-aws` executes this in-process via the local executor. Requires
 * Docker + the `aws` and `curl` CLIs on PATH. `flociUp` sets `AWS_ENDPOINT_URL`
 * and test creds in the process env, so the `cloudformation` apply targets the
 * emulator automatically; it is idempotent, so re-runs reuse a running container.
 * `dockerSocket: true` lets Floci start its ECR backing registry.
 */
export default Op({
  name: "local-aws",
  overview: "Floci up → build → cfn deploy → Floci down: a no-account local AWS deploy",
  taskQueue: "local-aws",
  phases: [
    phase("Emulator", [
      flociUp({ dockerSocket: true }),
    ]),
    phase("Build", [
      build("."),
    ]),
    phase("Deploy", [
      activity("nativeApply", { target: "cloudformation", env: "local", output: "dist/stack.json" }),
    ]),
    phase("Teardown", [
      flociDown(),
    ]),
  ],
});

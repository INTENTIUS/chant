import type { ChantConfig } from "@intentius/chant";

/**
 * The `local` environment declares Floci's endpoint so `--live` reads reach the
 * emulator without the caller having to export AWS_ENDPOINT_URL — an ambient
 * value still wins if one is set (see docs: Config File > environments).
 *
 * `ownership` is what makes the live reads answer "is this mine?" from the
 * resource's own tags rather than from a state file, which is the axis chant's
 * lifecycle model turns on.
 */
export default {
  lexicons: ["aws", "k8s"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4566" }],
  // Without this, observation assumes one stack per environment and looks for a
  // stack named `local`; the component deploys `cc-canonical`.
  stacks: [{ name: "cc-canonical", src: "src" }],
  ownership: { stack: "cc-aws-canonical", env: "local" },
  // The k8s half binds to the cluster's own kubeconfig context, not a port
  // (behold#106). `aws eks update-kubeconfig` names the context by cluster ARN,
  // and Floci's account id is fixed, so this is deterministic on the emulator —
  // against real AWS the account id differs and this line changes with it.
  k8s: { profiles: { local: { context: "arn:aws:eks:us-east-1:000000000000:cluster/cc-eks" } } },
} satisfies ChantConfig;

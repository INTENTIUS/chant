import { Op, phase, shell, activity, flociUp, flociDown } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the S3 bucket to a local Floci (emulated AWS) via CloudFormation.
 * `chant run aws`. Requires Docker + the `aws` CLI. Floci emulates the
 * CloudFormation control plane, so `nativeApply(cloudformation)` runs unchanged.
 */
export default Op({
  name: "aws",
  overview: "AWS: S3 bucket → Floci (CloudFormation), local, no account",
  taskQueue: "trio-aws",
  phases: [
    phase("Emulator", [flociUp({ dockerSocket: true })]),
    phase("Build", [shell("npx chant build src/aws --lexicon aws -o dist/aws.json")]),
    phase("Apply", [activity("nativeApply", { target: "cloudformation", env: "trio-aws", output: "dist/aws.json" })]),
    phase("Verify", [shell("aws --endpoint-url http://localhost:4566 s3api head-bucket --bucket chant-trio-bucket")]),
    phase("Teardown", [flociDown()]),
  ],
});

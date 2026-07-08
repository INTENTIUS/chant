import { Op, phase, build, awsApply, flociUp, flociDown, httpCheck } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the S3 bucket to a local Floci (emulated AWS) via CloudFormation.
 * `chant run aws`. Requires Docker. `awsApply` calls the CloudFormation API
 * directly (create-or-update + poll) against Floci's CFN control plane — the
 * direct twin of azApply/gcpApply, no `aws` CLI. Every phase is a modeled
 * activity — boot, build, apply, verify, teardown — with no raw shell.
 */
export default Op({
  name: "aws",
  overview: "AWS: S3 bucket → Floci (CloudFormation API), local, no account",
  taskQueue: "trio-aws",
  phases: [
    phase("Emulator", [flociUp({ dockerSocket: true })]),
    phase("Build", [build(".", { script: "build:aws" })]),
    phase("Apply", [awsApply("dist/aws.json", { stackName: "trio-aws", endpoint: "http://localhost:4566" })]),
    phase("Verify", [httpCheck("http://localhost:4566/chant-trio-bucket")]),
    phase("Teardown", [flociDown()]),
  ],
});

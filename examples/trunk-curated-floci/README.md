# trunk-curated-floci

A workspace on the `trunk-curated` workflow, for the [From Zero to a Promoted Release](https://intentius.io/chant/tutorials/zero-to-promoted-release/) tutorial.

- `chant.workspace.json` names the workflow and a `ci.green` block whose `check` phase runs before a merge.
- `infra/` is the one member. `src/` synthesizes an S3 bucket and an SQS queue with the AWS lexicon, `chant.config.ts` declares `staging` and `prod`, and `infra.component.ts` deploys one stack per environment with `cfn-deploy`, behind a `release` gate.

The tutorial runs it against Floci, a local AWS emulator, with no AWS account. `test/trunk-curated-floci-e2e.sh` (`just trunk-curated-floci-e2e`) runs the tutorial's steps and checks both stacks exist.

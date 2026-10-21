# trunk-curated-floci

A chant project for the [From Zero to a Promoted Release](https://intentius.io/chant/tutorials/zero-to-promoted-release/) tutorial, which makes it a workspace on the `trunk-curated` workflow with `chant workspace init` and `chant ci init`.

- `src/` synthesizes an S3 bucket and an SQS queue with the AWS lexicon.
- `chant.config.ts` declares `staging` and `prod`, the promotion order.
- `infra.component.ts` deploys one stack per environment with `cfn-deploy`, behind a `release` gate.

The tutorial runs it against Floci, a local AWS emulator, with no AWS account. `test/trunk-curated-floci-e2e.sh` (`just trunk-curated-floci-e2e`) runs the tutorial's steps and checks both stacks exist.

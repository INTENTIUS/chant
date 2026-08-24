// The effect receipt behind the gated migration in local-aws-migrate.op.ts
// (chant #1835, epic #1703).
//
// A receipt is the declared witness that a one-shot, out-of-band effect (here
// a demo schema seed) has run. The aws row materializes it as an
// `AWS::SSM::Parameter` — plain String, at
// /chant-receipts/local-op-quickstart/local/demo-schema-seed, derived from
// chant.config.ts's ownership block — readable with plain `aws ssm
// get-parameter` and read-only IAM, no chant binary needed. `chant build ops`
// renders the row into the template's Metadata for visibility; the only
// writer is the `effect()` step, on success, last.
//
// `flavor: "hash"` digests the inputs into the expectation, so bumping
// `schemaVersion` re-proposes the seed on the next run; presence alone would
// never fire again.
// The narrow module import keeps this file dependency-light: an .op.ts file
// (and everything it pulls in) is loaded by op discovery, which should not
// drag the whole aws lexicon surface behind one receipt declaration.
import { EffectReceipt } from "@intentius/chant-lexicon-aws/effect-receipt-row";

export const schemaSeeded = EffectReceipt("schemaSeeded", {
  effect: "demo-schema-seed",
  flavor: "hash",
  inputs: { schemaVersion: 1 },
});

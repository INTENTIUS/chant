// chant #1984 — the smallest project `chant scenario check` can be run
// against. It exists because no corpus example declares a `Scenario`, and the
// no-egress guard has to drive the real command rather than its parts.
//
// `given` is a fixture FILE, not `snapshot(env)`: the file path is the branch
// that reaches nothing, and the environment branch is the one that runs
// `git fetch` — enumerated as a shell-out rather than guarded.
import { Scenario, snapshot } from "@intentius/chant";
import { Bucket } from "@intentius/chant-lexicon-aws";

export const assetBucket = new Bucket({ BucketName: "chant-egress-guard-fixture" });

export const bucketAlreadyExists = Scenario("the fixture bucket is already deployed", {
  given: snapshot("fixtures/baseline.json"),
  expect: { noop: true },
});

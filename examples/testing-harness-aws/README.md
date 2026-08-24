# testing-harness-aws — deploy, assert, destroy per suite

The worked example for `@intentius/chant/testing` (#1224): a vitest suite that
deploys a real instance of its stack once, asserts against the live resources,
and tears it down — against a local AWS emulator (Floci), for $0 and no
account.

- `src/infra.ts` — the stack under test: an S3 bucket + an SQS queue. Every
  physical name folds in the CloudFormation stack name, which the harness sets
  to the per-run environment, so parallel suites never collide.
- `chant.config.ts` — what the harness needs from a project: `ownership.stack`
  (destroy is marker-scoped) and a `"test-*"` environments pattern entry that
  legalizes the derived `test-<suite>-<nonce>` names and carries the default
  emulator endpoint.
- `harness.e2e.test.ts` — the suite: `deployStack` in `beforeAll`, assertions
  against the returned outputs and the live stack, `destroy()` in `afterAll`.
  It also proves teardown survives a failing test, by running
  `fixtures/failing-suite.test.ts` in a child vitest and checking from outside
  that the fixture's environment is gone even though its one test failed.

## Run it

Needs Docker only (the suite boots and removes its own Floci container, on
port 4602 by default — override with `FLOCI_PORT`):

```bash
just testing-harness-e2e
```

Without Docker the suite skips cleanly. It is on-demand, not part of the
gating CI — the same standing as the other Floci e2e runs.

## The suite shape

```ts
import { deployStack, type DeployedStack } from "@intentius/chant/testing";

let stack: DeployedStack;

beforeAll(async () => {
  stack = await deployStack({ dir: "src", suite: "harness-aws" });
});

afterAll(async () => {
  if (stack) await stack.destroy();
});

test("the queue is declared", () => {
  expect(stack.entities.has("taskQueue")).toBe(true);
});
```

`deployStack` builds the project the way `chant build` would (build
parameters, the ownership marker) and applies the output additively through
the local Op executor. `destroy()` runs the marker-scoped teardown of exactly
this suite's environment — the same sweep as
`chant lifecycle teardown <env> --yes`, in-process. A crashed suite recovers
the same way: rerun destroy, or run the CLI verb against the leaked env name.

## Emulator or real cloud

The suite exports `AWS_ENDPOINT_URL` (via the aws lexicon's `flociUp`), and
ambient endpoint variables always win. Drop the emulator boot and use real
credentials, and the identical suite runs against a real account — the
`"test-*"` entry's declared endpoint only applies when nothing ambient is set.

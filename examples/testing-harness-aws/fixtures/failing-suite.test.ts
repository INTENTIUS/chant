/**
 * The survival fixture for harness.e2e.test.ts (#1224): a suite whose one
 * test deliberately fails AFTER a successful deploy, proving `afterAll`'s
 * `destroy()` still sweeps the environment. Never meaningful on its own —
 * harness.e2e.test.ts runs it in a child vitest with `HARNESS_FIXTURE_ENV`
 * (the env to deploy into) and `HARNESS_FIXTURE_SENTINEL` (where to record
 * that the deploy really landed before the failure), and asserts from outside
 * that the exit code is red and the stack is gone. Skips without those vars.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deployStack, type DeployedStack } from "@intentius/chant/testing";

const env = process.env.HARNESS_FIXTURE_ENV;
const sentinel = process.env.HARNESS_FIXTURE_SENTINEL;
const srcDir = join(import.meta.dirname, "..", "src");

describe.skipIf(!env || !sentinel || !process.env.AWS_ENDPOINT_URL)(
  "harness fixture: a failing suite still tears down",
  () => {
    let stack: DeployedStack;

    beforeAll(async () => {
      stack = await deployStack({ dir: srcDir, env: env! });
      // Record that the deploy landed live BEFORE the deliberate failure, so
      // the outer suite can tell "teardown after failure" from "never deployed".
      const res = await fetch(`${process.env.AWS_ENDPOINT_URL}/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          Action: "DescribeStacks",
          Version: "2010-05-15",
          StackName: stack.env,
        }).toString(),
      });
      writeFileSync(sentinel!, JSON.stringify({ env: stack.env, liveStatus: await res.text() }));
    }, 240_000);

    afterAll(async () => {
      if (stack) await stack.destroy();
    }, 240_000);

    test("deliberately fails after a successful deploy", () => {
      expect("this fixture deliberately fails").toBe("green");
    });
  },
);

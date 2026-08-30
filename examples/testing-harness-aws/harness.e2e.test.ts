/**
 * The worked example for `@intentius/chant/testing` (#1224), against Floci.
 *
 * One suite, the whole harness contract:
 *
 * 1. `deployStack` in `beforeAll` — build + additive apply of `src/` into a
 *    per-run `test-<suite>-<nonce>` environment on a local Floci;
 * 2. assertions against the returned outputs AND the live stack, through
 *    `assertLive` — which verifies the ownership marker, so a same-named
 *    resource from another env cannot satisfy one;
 * 3. `destroy()` in `afterAll` — the marker-scoped sweep of exactly that env;
 * 4. the survival proof: a fixture suite whose test deliberately fails still
 *    tears its environment down (afterAll runs on assertion failure), asserted
 *    from outside by running the fixture in a child vitest and checking its
 *    stack is gone.
 *
 * On-demand only — NOT part of the gating CI, exactly like the Floci shell
 * e2es (test/components-aws-e2e.sh, test/aws-teardown-e2e.sh). Run it:
 *
 *   just testing-harness-e2e
 *
 * Gated twice: on `CHANT_HARNESS_E2E` (so a plain `npx vitest run` never boots
 * Docker) and on a reachable Docker daemon (skip, not fail, without one).
 * Override the emulator port with FLOCI_PORT (default 4602 — clashing with
 * neither a Floci on 4566 nor the other aws e2e runs on 4598/4599/4601).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deployStack, testEnvName, type DeployedStack } from "@intentius/chant/testing";

const wanted = !!process.env.CHANT_HARNESS_E2E;
const docker =
  wanted &&
  (() => {
    try {
      execSync("docker info", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
if (wanted && !docker) console.log("SKIP: docker not installed or daemon not reachable");

const exampleDir = import.meta.dirname;
const repoRoot = resolve(exampleDir, "..", "..");
const srcDir = join(exampleDir, "src");
const FLOCI_PORT = Number(process.env.FLOCI_PORT ?? 4602);
const FLOCI_NAME = "chant-floci-harness-e2e";

/** DescribeStacks via the CFN Query API — the raw form POST the applier uses. */
async function describeStack(stackName: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${process.env.AWS_ENDPOINT_URL}/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Action: "DescribeStacks", Version: "2010-05-15", StackName: stackName }).toString(),
  });
  return { status: res.status, text: await res.text() };
}

describe.skipIf(!wanted || !docker)("live-stack test harness against Floci (#1224)", () => {
  let stack: DeployedStack;

  beforeAll(async () => {
    // Boot the emulator through the aws lexicon's own activity — idempotent,
    // and it exports AWS_ENDPOINT_URL + throwaway creds into this process,
    // which is the "ambient wins" half of the harness's emulator switch.
    const { flociUp } = await import("@intentius/chant-lexicon-aws/op/activities");
    await flociUp({ name: FLOCI_NAME, port: FLOCI_PORT });

    stack = await deployStack({ dir: srcDir, suite: "harness-aws" });
  }, 240_000);

  afterAll(async () => {
    try {
      if (stack) await stack.destroy();
    } finally {
      const { flociDown } = await import("@intentius/chant-lexicon-aws/op/activities");
      await flociDown({ name: FLOCI_NAME });
    }
  }, 240_000);

  test("the deploy landed in a nonce'd test env", () => {
    expect(stack.env).toMatch(/^test-harness-aws-[a-z0-9]{6}$/);
    expect(stack.entities.has("dataBucket")).toBe(true);
    expect(stack.entities.has("taskQueue")).toBe(true);
  });

  test("the built output is the deployed template, ownership marker included", () => {
    const output = stack.outputs.get("aws");
    expect(output).toBeDefined();
    const template = JSON.parse(typeof output === "string" ? output : output!.primary);
    const types = Object.values(template.Resources as Record<string, { Type: string }>).map((r) => r.Type);
    expect(types).toContain("AWS::S3::Bucket");
    expect(types).toContain("AWS::SQS::Queue");
    // The identity destroy() sweeps on, stamped at the template level — the
    // applier turns this block into the stack's own tags.
    expect(template.Metadata["chant:ownership"]).toEqual({
      "chant:managed-by": "chant",
      "chant:stack": "testing-harness-aws",
      "chant:env": stack.env,
    });
  });

  test("assertLive verifies each entity against this deploy's marker", async () => {
    // The identity read (#1998): aws resolves the marker from the stack's own
    // tags, so the assertion checks WHICH deploy answered, not just that
    // something with the right name exists.
    const bucket = await stack.assertLive("dataBucket");
    expect(bucket.type).toBe("AWS::S3::Bucket");
    expect(bucket.ownership).toBe("owned");
    expect(bucket.marker).toEqual({ stack: "testing-harness-aws", env: stack.env });

    const queue = await stack.assertLive("taskQueue", { status: "CREATE_COMPLETE" });
    expect(queue.type).toBe("AWS::SQS::Queue");
    expect(queue.marker).toEqual({ stack: "testing-harness-aws", env: stack.env });
  });

  test("the marker really gates the assertion — another env's identity cannot satisfy it", async () => {
    // Same live resource, same read, a marker naming a different env. Without
    // the marker on the observation this passed, which is what made the
    // assertion above worth nothing.
    const { assertLiveEntity, LiveAssertionError } = await import("@intentius/chant/lifecycle/assert-live");
    const { awsPlugin } = await import("@intentius/chant-lexicon-aws");
    const output = stack.outputs.get("aws");
    const buildOutput = typeof output === "string" ? output : (output?.primary ?? "");

    await expect(
      assertLiveEntity({
        plugin: awsPlugin,
        name: "dataBucket",
        entityType: "AWS::S3::Bucket",
        props: {},
        buildOutput,
        environment: stack.env,
        marker: { stack: "testing-harness-aws", env: "some-other-env" },
      }),
    ).rejects.toThrow(LiveAssertionError);
  });

  test("an entity the deploy never built has no assertion to make", async () => {
    await expect(stack.assertLive("nonesuch")).rejects.toThrow(/no such entity/);
  });

  test("destroy sweeps the env, and only the env (proven after afterAll by rerun)", async () => {
    // destroy() itself runs in afterAll; here, prove it is idempotent and
    // marker-scoped by running it early once — the env is gone after this,
    // and the afterAll destroy() over the clean env plans nothing.
    const report = await stack.destroy();
    expect(report.environment).toBe(stack.env);
    expect(report.outcomes).toEqual([
      expect.objectContaining({ name: stack.env, type: "AWS::CloudFormation::Stack", outcome: "deleted" }),
    ]);

    const after = await describeStack(stack.env);
    expect(after.text).toMatch(/does not exist/i);
  });

  test("teardown survives an assertion failure (fixture suite, asserted from outside)", async () => {
    const env = testEnvName("harness-fixture");
    const sentinel = join(tmpdir(), `chant-harness-fixture-${env}.json`);
    rmSync(sentinel, { force: true });

    const child = spawnSync(
      "npx",
      ["vitest", "run", "examples/testing-harness-aws/fixtures/failing-suite.test.ts"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...process.env, HARNESS_FIXTURE_ENV: env, HARNESS_FIXTURE_SENTINEL: sentinel },
        timeout: 240_000,
      },
    );

    // The suite failed (the deliberate assertion), not the machinery.
    expect(child.status).not.toBe(0);
    expect(child.stdout + child.stderr).toContain("deliberately fails");

    // The deploy really happened before the failing assertion...
    expect(existsSync(sentinel)).toBe(true);
    const deployed = JSON.parse(readFileSync(sentinel, "utf-8")) as { env: string; liveStatus: string };
    expect(deployed.env).toBe(env);
    expect(deployed.liveStatus).toContain("CREATE_COMPLETE");
    rmSync(sentinel, { force: true });

    // ...and the fixture's afterAll still swept its environment.
    const after = await describeStack(env);
    expect(after.text).toMatch(/does not exist/i);
  }, 240_000);
});

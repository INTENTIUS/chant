/**
 * `cfn-deploy`'s plan and apply against Floci (#3997), through the real
 * executor (`aws` CLI). Set CHANT_FLOCI_ENDPOINT to a running Floci, for
 * example `docker run -d -p 4611:4566 floci/floci` and
 * `CHANT_FLOCI_ENDPOINT=http://localhost:4611`. Skipped without it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CfnPlanMovedError, createCfnDeployCapability } from "./apply";
import { defaultCloudExecutor } from "./cloud-executor";

const endpoint = process.env.CHANT_FLOCI_ENDPOINT;

describe.skipIf(!endpoint)("cfn-deploy plan against Floci (#3997)", () => {
  const stack = `chant-plan-${process.pid}-${Date.now()}`;
  const ctx = { env: "local", component: stack };
  const saved = { ...process.env };
  let dir: string;
  let template: string;
  const aws = (...args: string[]): string => execFileSync("aws", ["--endpoint-url", endpoint!, ...args], { encoding: "utf8" });
  // The change sets still open on the stack. Floci also lists executed ones, as EXECUTE_COMPLETE.
  const changeSets = (): string[] =>
    ((JSON.parse(aws("cloudformation", "list-change-sets", "--stack-name", stack)) as { Summaries?: Array<{ ChangeSetName: string; ExecutionStatus?: string }> }).Summaries ?? [])
      .filter((c) => c.ExecutionStatus !== "EXECUTE_COMPLETE")
      .map((c) => c.ChangeSetName);
  const write = (resources: Record<string, unknown>): void => writeFileSync(template, JSON.stringify({ Resources: resources }));
  const topic = (name: string) => ({ Type: "AWS::SNS::Topic", Properties: { DisplayName: name } });

  beforeAll(() => {
    Object.assign(process.env, { AWS_ENDPOINT_URL: endpoint, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1" });
    dir = mkdtempSync(join(tmpdir(), "cfn-plan-floci-"));
    template = join(dir, "stack.template.json");
  });

  afterAll(() => {
    try {
      aws("cloudformation", "delete-stack", "--stack-name", stack);
    } catch { /* never created */ }
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("plans a create, an update and no change, applies what it planned, and refuses a plan the template moved past", async () => {
    const capability = createCfnDeployCapability(defaultCloudExecutor());

    write({ Topic: topic("a") });
    const created = await capability.plan!(ctx, { stack, template });
    expect(created.changeSet!.entries.map((e) => [e.address, e.action])).toEqual([["Topic", "create"]]);
    // The plan left no stack behind: the empty one its CREATE change set made is gone.
    await expect(capability.outputs!(ctx, { stack, template })).resolves.toEqual({});
    const first = await capability.run({ ...ctx, plans: { [stack]: created.artifact } }, { stack, template });
    expect(first.stackStatus).toBe("CREATE_COMPLETE");

    write({ Topic: topic("b"), Queue: { Type: "AWS::SQS::Queue" } });
    const updated = await capability.plan!(ctx, { stack, template });
    expect(updated.changeSet!.entries.map((e) => [e.address, e.action]).sort()).toEqual([["Queue", "create"], ["Topic", "update"]]);
    expect(changeSets()).toEqual([]);

    // The template moves after the plan: run refuses and leaves no change set.
    write({ Topic: topic("b"), Queue: { Type: "AWS::SQS::Queue" }, Dlq: { Type: "AWS::SQS::Queue" } });
    await expect(capability.run({ ...ctx, plans: { [stack]: updated.artifact } }, { stack, template })).rejects.toBeInstanceOf(CfnPlanMovedError);
    expect(changeSets()).toEqual([]);

    write({ Topic: topic("b"), Queue: { Type: "AWS::SQS::Queue" } });
    const second = await capability.run({ ...ctx, plans: { [stack]: updated.artifact } }, { stack, template });
    expect(second.stackStatus).toBe("UPDATE_COMPLETE");

    const same = await capability.plan!(ctx, { stack, template });
    expect(same.changeSet!.entries).toEqual([]);
    expect(changeSets()).toEqual([]);
  }, 600_000); // each `aws` call takes seconds, and a plan or a run makes several
});

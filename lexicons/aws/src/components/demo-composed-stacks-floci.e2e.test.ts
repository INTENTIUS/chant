/**
 * `examples/demo-composed-stacks` through the pull-request loop against
 * Floci (#4448): both scenarios, each from a fresh base, through `chant
 * components pr-plan`, one approval and `chant components pr-apply`, as
 * #4430 ran them by hand.
 *
 * - The edit act: every value known at plan, one approval, pr-apply exits 0,
 *   and any round after an upstream applied is covered by that approval.
 * - The create act: app's read of network's new `SubnetBId` is known after
 *   apply, one approval, pr-apply exits 0, the round that plans app again is
 *   `covered` with `filledInputs` naming the id, and app's parameter holds
 *   network's real subnet id, and so does edge's, through app's
 *   `WorkerSubnetId` output.
 *
 * Each act copies the example with its stack names and SSM names made the
 * run's own, builds the templates with the example's `npm run build`, and
 * deletes its stacks after. Set CHANT_FLOCI_ENDPOINT to a running Floci, for
 * example `docker run -d -p 4611:4566 floci/floci` and
 * `CHANT_FLOCI_ENDPOINT=http://localhost:4611`; the `aws` CLI must be on
 * PATH. Skipped otherwise, with the reason named.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PrMember, PrReport } from "@intentius/chant/pr-loop";
import { openScenarioLoop, type ScenarioLoop } from "@intentius/chant-test-utils/pr-loop-harness";
import { awsPlugin } from "../plugin";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const EXAMPLE = join(REPO, "examples", "demo-composed-stacks");
const TIMEOUT = 900_000;
const STACKS = ["network", "app", "edge"];

const endpoint = process.env.CHANT_FLOCI_ENDPOINT?.replace(/\/+$/, "");
function hasAwsCli(): boolean {
  try {
    execFileSync("aws", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const missing = !endpoint
  ? "CHANT_FLOCI_ENDPOINT is not set (for example `docker run -d -p 4611:4566 floci/floci` and CHANT_FLOCI_ENDPOINT=http://localhost:4611)"
  : !hasAwsCli()
    ? "the aws CLI is not on PATH"
    : undefined;

const aws = (...args: string[]): unknown => JSON.parse(execFileSync("aws", ["--endpoint-url", endpoint!, "--output", "json", ...args], { encoding: "utf8" }) || "{}");

interface Stack {
  Outputs?: { OutputKey: string; OutputValue: string }[];
  Parameters?: { ParameterKey: string; ParameterValue: string }[];
}
const stack = (name: string): Stack => (aws("cloudformation", "describe-stacks", "--stack-name", name) as { Stacks: Stack[] }).Stacks[0]!;
const ssm = (name: string): string => (aws("ssm", "get-parameter", "--name", name) as { Parameter: { Value: string } }).Parameter.Value;
const byComponent = (r: PrReport): Record<string, PrMember> => Object.fromEntries(r.members.map((m) => [m.component, m]));
const total = (r: PrReport, action: "create" | "update" | "replace" | "delete"): number => r.members.reduce((n, m) => n + m.counts[action], 0);

/**
 * The example's names made this run's own: the CloudFormation stack each
 * component deploys (and `stacks[]`, which names the same stacks), and the
 * SSM parameter paths and tags. Component names, and so `stackOutput` reads,
 * stay as they are.
 */
function rewrite(id: string) {
  return (rel: string, text: string): string => {
    let out = text.replaceAll("chant-compose", id);
    if (rel === "chant.config.ts") out = out.replace(/name: "(network|app|edge)", src:/g, `name: "${id}-$1", src:`);
    if (rel.endsWith(".component.ts")) out = out.replace(/(kind: "cfn-deploy",\s*stack: ")(network|app|edge)"/g, `$1${id}-$2"`);
    return out;
  };
}

function actSuite(scenario: string, tests: (ctx: { loop: () => ScenarioLoop; id: string }) => void): void {
  describe.skipIf(missing !== undefined)(`demo-composed-stacks, ${scenario}, on Floci${missing ? `: skipped, ${missing}` : ""}`, () => {
    const id = `cs-${scenario.replace("chant-compose-", "")}-${Date.now().toString(36)}`;
    let loop: ScenarioLoop | undefined;

    beforeAll(async () => {
      loop = await openScenarioLoop({
        example: EXAMPLE,
        repo: REPO,
        plugins: [awsPlugin],
        env: "demo",
        rewrite: rewrite(id),
        // The templates, as the pipeline's "Build the templates" step builds them.
        prepare: (dir) => void execFileSync("npm", ["run", "build"], { cwd: dir, encoding: "utf8" }),
        processEnv: { AWS_ENDPOINT_URL: endpoint!, AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1" },
      });
      // The base, as the demo host applies it before a scenario.
      expect(await loop.applyBase()).toBe(0);
    }, TIMEOUT);

    afterAll(async () => {
      await loop?.close();
      for (const s of [...STACKS].reverse()) {
        try {
          aws("cloudformation", "delete-stack", "--stack-name", `${id}-${s}`);
        } catch {
          // never created
        }
      }
    });

    tests({ loop: () => loop!, id });
  });
}

actSuite("chant-compose-edit", ({ loop, id }) => {
  test("one pr-plan digest over the three stacks, every value known at plan", async () => {
    const { code, report: plan } = await loop().open(1, "chant-compose-edit");
    expect(code).toBe(0);
    expect(plan.status).toBe("planned");
    expect([...plan.selection.changed].sort()).toEqual(["app", "edge", "network"]);
    expect(plan.members.map((m) => [m.component, m.status])).toEqual([
      ["network", "planned"],
      ["app", "planned"],
      ["edge", "planned"],
    ]);
    for (const m of plan.members) expect(m.unknownInputs).toBeUndefined();
    expect([total(plan, "create"), total(plan, "update"), total(plan, "delete")]).toEqual([3, 3, 0]);
    expect(plan.changeSet.digest).toBe(plan.digest);
    expect(plan.approval).toEqual({ status: "pending" });
  }, TIMEOUT);

  test("one approval, and pr-apply exits 0: no round asks for an approval of its own", async () => {
    const plan = loop().report("plan");
    await loop().approve(1, "pr-apply", plan.digest);
    expect(await loop().merge(1)).toBe(0);
    const applied = loop().report("apply");
    expect(applied.digest).toBe(plan.digest);
    expect(applied.status).toBe("applied");
    for (const r of applied.rounds ?? []) {
      expect(r.status).toBe("applied");
      expect(r.covered?.digest).toBe(plan.digest);
    }
    expect(applied.members.map((m) => [m.component, m.status])).toEqual([
      ["network", "applied"],
      ["app", "applied"],
      ["edge", "applied"],
    ]);
    expect(ssm(`/${id}/upstream`)).toBe("http://app:8090");
    expect(ssm(`/${id}/admin-upstream`)).toBe("http://app:9000");
  }, TIMEOUT);
});

actSuite("chant-compose-create", ({ loop, id }) => {
  test("one pr-plan digest, app's and edge's reads of the new subnet id known after apply", async () => {
    const { code, report: plan } = await loop().open(1, "chant-compose-create");
    expect(code).toBe(0);
    expect(plan.status).toBe("planned");
    const m = byComponent(plan);
    expect(m.app!.unknownInputs).toEqual(["network.SubnetBId"]);
    expect(m.app!.reads?.find((r) => r.upstream === "network")?.unknown).toEqual(["SubnetBId"]);
    // edge reads app's ListenerPort, which the preview knows, and app's WorkerSubnetId, which it does not.
    expect(m.edge!.unknownInputs).toEqual(["app.WorkerSubnetId"]);
    expect(m.edge!.reads?.find((r) => r.upstream === "app")?.unknown).toEqual(["WorkerSubnetId"]);
    expect([total(plan, "create"), total(plan, "update"), total(plan, "delete")]).toEqual([3, 1, 0]);
    expect(plan.approval).toEqual({ status: "pending" });
  }, TIMEOUT);

  test("one approval, and pr-apply exits 0: the round is covered with filledInputs, and app and edge hold the real id", async () => {
    const plan = loop().report("plan");
    await loop().approve(1, "pr-apply", plan.digest);
    expect(await loop().merge(1)).toBe(0);
    const applied = loop().report("apply");
    expect(applied.digest).toBe(plan.digest);
    expect(applied.status).toBe("applied");
    const rounds = applied.rounds ?? [];
    for (const r of rounds) expect(r.status).toBe("applied");
    const filled = rounds.find((r) => r.components.includes("app"));
    expect(filled?.covered?.digest).toBe(plan.digest);
    expect(filled?.covered?.filledInputs).toContain("network.SubnetBId");
    expect(filled?.notCovered).toBeUndefined();
    const edgeRound = rounds.find((r) => r.components.includes("edge"));
    expect(edgeRound?.covered?.digest).toBe(plan.digest);
    expect(edgeRound?.covered?.filledInputs).toContain("app.WorkerSubnetId");

    const subnetB = stack(`${id}-network`).Outputs?.find((o) => o.OutputKey === "SubnetBId")?.OutputValue;
    expect(subnetB).toMatch(/^subnet-/);
    expect(stack(`${id}-app`).Parameters?.find((p) => p.ParameterKey === "appSubnetBId")?.ParameterValue).toBe(subnetB);
    expect(stack(`${id}-edge`).Parameters?.find((p) => p.ParameterKey === "edgeWorkerSubnetId")?.ParameterValue).toBe(subnetB);
    expect(ssm(`/${id}/worker-subnet`)).toBe(subnetB);
    expect(ssm(`/${id}/allowlist`)).toBe("10.0.1.0/24,10.0.2.0/24");
  }, TIMEOUT);
});

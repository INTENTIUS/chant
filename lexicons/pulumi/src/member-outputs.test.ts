/**
 * The Pulumi engine's member outputs (#4455): a chant member's parameter
 * planned against a Pulumi stack output, read through `pulumiOutputSource`.
 *
 * The estate is the three-cloud demo's once AWS moves to Pulumi: `dns`
 * reads `awsEndpoint`, which the `aws` member's stack publishes. `records`
 * is dns's deploy, a fake step that plans its parameters the way
 * `cfn-deploy` does (a hole when an input is not known yet). The pulumi
 * and plunge runners are fakes that answer the hand-written fixtures in
 * `testdata/pulumi-outputs`; no binary runs here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "@intentius/chant/components/capability";
import { registerCapabilityPlugins } from "@intentius/chant/components/capability-plugin-loader";
import type { CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { starterCapabilityPlugin } from "@intentius/chant/components/starter-plugin";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { applyPrSet, approvalOf, decidePrGate, planPrSet, readOnlyLedger, type PrPlanSet } from "@intentius/chant/components/pr-run";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import {
  MEMBER_OUTPUTS_KIND,
  memberOutputsCapability,
  memberOutputsComponent,
  memberOutputsMemberName,
  MemberOutputsPendingError,
  type EngineMemberRef,
} from "@intentius/chant/components/verbs/member-outputs";
import { pulumiCapabilityPlugin } from "./capability-plugin";
import { pulumiMemberPlannedOutputs, pulumiOutputSource } from "./member-outputs";
import { previewPulumiMemberRead, runAllowedPulumi, type PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const text = (...path: string[]) => readFileSync(join(testdata, ...path), "utf-8");
const AWS_DIR = join(testdata, "pulumi-outputs");
const PLUNGE_DIR = join(testdata, "plunge-outputs");
const OLD = "web-old.execute-api.localhost.localstack.cloud";

function fake(answer: (args: string[]) => string): { run: PulumiRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: PulumiRunner = async (args) => {
    calls.push(args);
    return { stdout: answer(args) };
  };
  return { run, calls };
}

/** The aws member, as a pulumi CLI that answers `stack output` and `preview` from the fixtures. */
function awsCli(state: { preview: string }) {
  return fake((args) => (args[0] === "stack" ? text("pulumi-outputs", "stack-output.json") : text("pulumi-outputs", state.preview)));
}

describe("the allow-list", () => {
  test("stack output reaches the runner only with --json and secrets blinded", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of [["stack", "output"], ["stack", "output", "--json", "--show-secrets"], ["stack", "output", "--json", "--show-secrets=true"], ["stack", "export"], ["stack", "select", "local"]]) {
      await expect(runAllowedPulumi(run, args, "/tmp")).rejects.toThrow(/stack output --json --show-secrets=false/);
    }
    expect(calls).toEqual([]);
    await runAllowedPulumi(run, ["stack", "output", "--json", "--show-secrets=false"], "/tmp");
    expect(calls).toEqual([["stack", "output", "--json", "--show-secrets=false"]]);
  });
});

describe("pulumiOutputSource", () => {
  const ref: EngineMemberRef = { member: "aws", kind: "pulumi", dir: AWS_DIR, workspaceRoot: testdata };
  const ctx: DeployContext = { env: "local", component: "aws" };

  test("applied values come from pulumi stack output --json --show-secrets=false, the secret left out", async () => {
    const cli = awsCli({ preview: "preview-settled.json" });
    const outputs = await pulumiOutputSource({ run: cli.run }).applied(ctx, ref);
    expect(outputs).toEqual({ awsEndpoint: OLD });
    expect(cli.calls).toEqual([["stack", "output", "--json", "--show-secrets=false"]]);
    expect(JSON.stringify(outputs)).not.toContain("secret");
  });

  test("applied values come from the checked-in export when chant must not run pulumi", async () => {
    const cli = fake(() => {
      throw new Error("pulumi must not run");
    });
    expect(await pulumiOutputSource({ applied: "export", run: cli.run }).applied(ctx, ref)).toEqual({ awsEndpoint: OLD });
    expect(cli.calls).toEqual([]);
  });

  test("planned values: a settled preview knows awsEndpoint and has nothing to apply", async () => {
    const cli = awsCli({ preview: "preview-settled.json" });
    const planned = await pulumiOutputSource({ run: cli.run }).planned(ctx, ref);
    expect(planned).toMatchObject({ known: { awsEndpoint: OLD }, unknown: [], changes: false });
    expect(planned.planDigest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(cli.calls).toEqual([["preview", "--json"]]);
  });

  test("planned values: a replaced API makes awsEndpoint unknown, the secret is neither known nor unknown", async () => {
    const read = await previewPulumiMemberRead({ member: "aws", dir: AWS_DIR, run: awsCli({ preview: "preview-replaced.json" }).run });
    const planned = pulumiMemberPlannedOutputs("aws", read);
    expect(planned).toMatchObject({ known: {}, unknown: ["awsEndpoint"], changes: true, planDigest: read.part.member.planDigest });
  });

  test("a member on plunge runs the same commands under plunge, never pulumi", async () => {
    const pulumi = fake(() => {
      throw new Error("pulumi must not run for a plunge member");
    });
    const plunge = awsCli({ preview: "preview-settled.json" });
    const source = pulumiOutputSource({ run: pulumi.run, plunge: plunge.run });
    const plungeRef = { ...ref, dir: PLUNGE_DIR };
    expect(await source.applied(ctx, plungeRef)).toEqual({ awsEndpoint: OLD });
    expect((await source.planned(ctx, plungeRef)).known).toEqual({ awsEndpoint: OLD });
    expect(plunge.calls).toEqual([["stack", "output", "--json", "--show-secrets=false"], ["preview", "--json"]]);
    expect(pulumi.calls).toEqual([]);
  });

  test("a failed preview throws, naming the member", async () => {
    const run: PulumiRunner = async () => {
      throw Object.assign(new Error("exit 255"), { stderr: "error: no stack selected" });
    };
    await expect(pulumiOutputSource({ run }).planned(ctx, ref)).rejects.toThrow(/Pulumi member "aws" failed: error: no stack selected/);
  });

  test("the lexicon's capability plugin contributes the source and no verbs", () => {
    expect(pulumiCapabilityPlugin.capabilities()).toEqual([]);
    expect(pulumiCapabilityPlugin.engineOutputSources!().map((s) => s.kinds)).toEqual([["pulumi"]]);
  });
});

// ── dns planned against the aws member's output ────────────────────────────────

interface RecordsInput {
  inputs: Record<string, unknown>;
}

const ESTATE: DriverComponent[] = [
  memberOutputsComponent("aws") as unknown as DriverComponent,
  {
    name: "records",
    dependsOn: ["aws"],
    deploy: [{ phase: "Apply", steps: [{ kind: "fake-records", inputs: { awsEndpoint: { stackOutput: { stack: "aws", name: "awsEndpoint" } } } }] }],
  },
];

function world(initial: { preview: string }) {
  const state = {
    preview: initial.preview,
    stackOutput: text("pulumi-outputs", "stack-output.json"),
    recordsPlanned: [] as Array<{ inputs: Record<string, unknown>; unresolved?: string[] }>,
    recordsRan: [] as Array<Record<string, unknown>>,
  };
  const pulumi: PulumiRunner = async (args) => ({ stdout: args[0] === "stack" ? state.stackOutput : text("pulumi-outputs", state.preview) });
  const lookup = async (_cwd: string, member: string): Promise<EngineMemberRef> => {
    if (member !== "aws") throw new Error(`no member ${member}`);
    return { member, kind: "pulumi", dir: AWS_DIR, workspaceRoot: testdata };
  };
  const dns: CapabilityPlugin = {
    name: "fake-dns",
    version: "0.0.0",
    capabilities: () =>
      [
        {
          kind: "fake-records",
          async plan(ctx: DeployContext, input: RecordsInput) {
            state.recordsPlanned.push({ inputs: { ...input.inputs }, ...(ctx.unresolvedInputs ? { unresolved: [...ctx.unresolvedInputs] } : {}) });
            const planDigest = computePlanDigest("fake-records", { inputs: input.inputs, unresolved: ctx.unresolvedInputs ?? [] });
            const holes = ctx.unresolvedInputs?.length ? [{ address: "records", reason: `inputs from ${ctx.unresolvedInputs.join(", ")}; re-checked on apply` }] : [];
            return {
              member: "records",
              planDigest,
              artifact: { planDigest },
              changeSet: { member: { member: "records", lexicon: "aws", planner: "chant", status: "planned", planDigest, holes }, entries: [] },
            };
          },
          async run(_ctx: DeployContext, input: RecordsInput) {
            state.recordsRan.push({ ...input.inputs });
            return {};
          },
        },
      ] as never,
  };
  // The lexicon's plugin, its source on the fake runner; the starter set's member-outputs with the test's lookup.
  const pulumiPlugin: CapabilityPlugin = { ...pulumiCapabilityPlugin, engineOutputSources: () => [pulumiOutputSource({ run: pulumi })] };
  const starter = { ...starterCapabilityPlugin, capabilities: () => starterCapabilityPlugin.capabilities().filter((c) => c.kind !== MEMBER_OUTPUTS_KIND).concat([memberOutputsCapability({ lookup }) as never]) };
  const registry = registerCapabilityPlugins(new CapabilityRegistry(), [starter as CapabilityPlugin, pulumiPlugin, dns]);
  return { registry, state };
}

const NOW = "2026-10-25T00:00:00Z";

describe("dns against a Pulumi output (#4455)", () => {
  test("an applied Pulumi output feeds dns's parameter when the change does not touch the member", async () => {
    const w = world({ preview: "preview-settled.json" });
    const plan = planFanOut({ components: ESTATE, changed: ["records"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "local" });
    expect(set.failed).toBe(false);
    expect(w.state.recordsPlanned).toEqual([{ inputs: { awsEndpoint: OLD } }]);
    expect(set.deployedOutputs).toEqual({ aws: ["awsEndpoint"] });
    const records = set.members.find((m) => m.member === "records")!;
    expect(records.unknownInputs).toBeUndefined();
  });

  test("a known planned Pulumi output feeds dns's parameter when the change touches the member", async () => {
    const w = world({ preview: "preview-settled.json" });
    const plan = planFanOut({ components: ESTATE, changed: ["aws"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "local" });
    expect(w.state.recordsPlanned).toEqual([{ inputs: { awsEndpoint: OLD } }]);
    expect(set.plannedOutputs).toEqual({ aws: ["awsEndpoint"] });
    expect(set.doc.members.find((m) => m.member === memberOutputsMemberName("aws"))!.holes).toEqual([]);
  });

  test("an unknown Pulumi output holds dns back, naming the member and the output", async () => {
    const w = world({ preview: "preview-replaced.json" });
    const plan = planFanOut({ components: ESTATE, changed: ["aws"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "local" });
    expect(set.failed).toBe(false);

    expect(w.state.recordsPlanned).toEqual([{ inputs: {}, unresolved: ["aws"] }]);
    const records = set.members.find((m) => m.member === "records")!;
    expect(records.unknownInputs).toEqual(["aws.awsEndpoint"]);
    expect(records.reads).toEqual([{ upstream: "aws", outputs: ["awsEndpoint"], unknown: ["awsEndpoint"] }]);
    expect(set.doc.members.find((m) => m.member === memberOutputsMemberName("aws"))!.holes).toEqual([
      { address: "aws.awsEndpoint", type: "output", reason: "aws.awsEndpoint is known only after aws applies; what reads it is planned again then" },
    ]);

    // Merged before aws's own pipeline applied: the read refuses, so records is blocked behind it.
    const early = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "local", set });
    expect(early.members.find((m) => m.member === "records")).toMatchObject({ status: "blocked", blockedBy: "aws" });
    expect(w.state.recordsRan).toEqual([]);

    // Once aws applied: records is held back with the reason, and planned again against the applied value.
    const NEW = "web-new.execute-api.localhost.localstack.cloud";
    w.state.stackOutput = JSON.stringify({ awsEndpoint: NEW, apiKey: "[secret]" });
    w.state.preview = "preview-settled.json";
    const decideNothing = async ({ gate, set: round }: { gate: string; set: PrPlanSet }) => {
      const check = await decidePrGate(readOnlyLedger(memoryGateLedgerPort()), { op: "pr-12", gate, digest: round.doc.digest, now: NOW });
      return { satisfied: check.satisfied, approval: approvalOf(check) };
    };
    const held = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "local", set, decideRound: decideNothing });
    expect(held.status).toBe("waiting");
    expect(held.members.find((m) => m.member === "records")).toMatchObject({
      status: "waiting",
      round: 2,
      held: "its plan read aws.awsEndpoint before that output applied as another value",
    });
    expect(w.state.recordsRan).toEqual([]);
  });

  test("run refuses while the stack's preview has changes left", async () => {
    const w = world({ preview: "preview-replaced.json" });
    const capability = w.registry.resolve(MEMBER_OUTPUTS_KIND);
    await expect(capability.run({ env: "local", component: "aws" }, { member: "aws" } as never)).rejects.toBeInstanceOf(MemberOutputsPendingError);
    w.state.preview = "preview-settled.json";
    await expect(capability.run({ env: "local", component: "aws" }, { member: "aws" } as never)).resolves.toEqual({ member: "aws", outputs: { awsEndpoint: OLD } });
  });
});

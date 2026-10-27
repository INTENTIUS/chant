/**
 * The Pulumi engine's member outputs (#4455): a chant member's parameter
 * planned against a Pulumi stack output, read through `pulumiOutputSource`.
 *
 * The estate: `records` reads `vpcId`, which the `aws` member's stack
 * publishes. `records` is a fake step that plans its parameters the way
 * `cfn-deploy` does (a hole when an input is not known yet). The pulumi and
 * plunge runners are fakes that answer the fixtures in
 * `testdata/pulumi-outputs` and `testdata/plunge-outputs`, recorded for
 * #4475 from pulumi 3.272.0 and plunge running the plunge corpus's aws-ts
 * program on floci (see their READMEs): `stack output --json
 * --show-secrets=false` prints a secret output as the string `"[secret]"`,
 * and `preview --json` plans no stack outputs, so a settled preview gives
 * the export's and a preview with changes leaves every output unknown. No
 * binary runs here.
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
import { previewPulumiMemberRead, pulumiMemberStackOutputs, runAllowedPlunge, runAllowedPulumi, type PulumiRunner } from "./run";

const testdata = join(import.meta.dirname, "testdata");
const text = (...path: string[]) => readFileSync(join(testdata, ...path), "utf-8");
const AWS_DIR = join(testdata, "pulumi-outputs");
const PLUNGE_DIR = join(testdata, "plunge-outputs");
const OLD = "vpc-05097b38";
/** What `stack output` printed, the blinded secret left out. */
const withoutSecret = (file: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(JSON.parse(text(file, "stack-output.json")) as Record<string, unknown>).filter(([, v]) => v !== "[secret]"));
const APPLIED = withoutSecret("pulumi-outputs");
const PLUNGE_APPLIED = withoutSecret("plunge-outputs");

function fake(answer: (args: string[]) => string): { run: PulumiRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: PulumiRunner = async (args) => {
    calls.push(args);
    return { stdout: answer(args) };
  };
  return { run, calls };
}

/** The aws member, as a pulumi CLI that answers `stack output` and `preview` from the fixtures. */
function awsCli(state: { preview: string; outputs?: string }) {
  return fake((args) => (args[0] === "stack" ? text(state.outputs ?? "pulumi-outputs", "stack-output.json") : text("pulumi-outputs", state.preview)));
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

  test("stack output may name its stack, and a --stack with no name, or a flag for one, is refused (#4514)", async () => {
    const { run, calls } = fake(() => "{}");
    for (const args of [
      ["stack", "output", "--json", "--show-secrets=false", "--stack"],
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "--show-secrets"],
      ["stack", "output", "--json", "--show-secrets=false", "--stack", ""],
    ]) {
      await expect(runAllowedPulumi(run, args, "/tmp")).rejects.toThrow(/stack output --json --show-secrets=false/);
      await expect(runAllowedPlunge(run, args, "/tmp")).rejects.toThrow(/plunge stack output --json --show-secrets=false/);
    }
    expect(calls).toEqual([]);
    await runAllowedPulumi(run, ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"], "/tmp");
    await runAllowedPlunge(run, ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"], "/tmp");
    expect(calls).toEqual([
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"],
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"],
    ]);
  });
});

describe("pulumiOutputSource", () => {
  const ref: EngineMemberRef = { member: "aws", kind: "pulumi", dir: AWS_DIR, workspaceRoot: testdata };
  const ctx: DeployContext = { env: "local", component: "aws" };

  test("applied values come from pulumi stack output --json --show-secrets=false, the secret left out", async () => {
    const cli = awsCli({ preview: "preview-settled.json" });
    const outputs = await pulumiOutputSource({ run: cli.run }).applied(ctx, ref);
    expect(outputs).toEqual(APPLIED);
    expect(outputs.vpcId).toBe(OLD);
    expect(outputs).not.toHaveProperty("dbPasswordValue");
    // --stack (#4514): the workspace declares no stack, so the one the export's URNs name.
    expect(cli.calls).toEqual([["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"]]);
    expect(JSON.stringify(outputs)).not.toContain("[secret]");
  });

  test("applied values come from the checked-in export when chant must not run pulumi", async () => {
    const cli = fake(() => {
      throw new Error("pulumi must not run");
    });
    // The export's stack outputs are the same values stack output printed; its secret is ciphertext, left out.
    expect(await pulumiOutputSource({ applied: "export", run: cli.run }).applied(ctx, ref)).toEqual(APPLIED);
    expect(cli.calls).toEqual([]);
  });

  test("planned values: a settled preview plans no stack outputs and nothing to apply, so the export's stand", async () => {
    const cli = awsCli({ preview: "preview-settled.json" });
    const planned = await pulumiOutputSource({ run: cli.run }).planned(ctx, ref);
    expect(planned).toMatchObject({ known: APPLIED, unknown: [], changes: false });
    expect(planned.planDigest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(cli.calls).toEqual([["preview", "--json", "--show-sames", "--stack", "floci"]]);
  });

  test("planned values: a preview with changes (a replaced VPC) leaves every output unknown, the secret neither known nor unknown", async () => {
    const read = await previewPulumiMemberRead({ member: "aws", dir: AWS_DIR, run: awsCli({ preview: "preview-replaced.json" }).run });
    const planned = pulumiMemberPlannedOutputs("aws", { ...read, exported: JSON.parse(text("pulumi-outputs", "stack-export.json")) });
    expect(planned).toMatchObject({ known: {}, unknown: Object.keys(APPLIED).sort(), changes: true, planDigest: read.part.member.planDigest });
    expect(planned.unknown).not.toContain("dbPasswordValue");
  });

  test("a member on plunge runs the same commands under plunge, never pulumi", async () => {
    const pulumi = fake(() => {
      throw new Error("pulumi must not run for a plunge member");
    });
    const plunge = awsCli({ preview: "preview-settled.json", outputs: "plunge-outputs" });
    const source = pulumiOutputSource({ run: pulumi.run, plunge: plunge.run });
    const plungeRef = { ...ref, dir: PLUNGE_DIR };
    // plunge prints stack output exactly as pulumi does, the secret as "[secret]" (recorded).
    expect(await source.applied(ctx, plungeRef)).toEqual(PLUNGE_APPLIED);
    expect((await source.planned(ctx, plungeRef)).known).toEqual(PLUNGE_APPLIED);
    expect(plunge.calls).toEqual([
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "floci"],
      ["preview", "--json", "--show-sames", "--stack", "floci"],
    ]);
    expect(pulumi.calls).toEqual([]);
  });

  test("both reads pass the declared stack over the export's (#4514)", async () => {
    const cli = awsCli({ preview: "preview-settled.json" });
    await pulumiMemberStackOutputs({ dir: AWS_DIR, stack: "prod", run: cli.run });
    const read = await previewPulumiMemberRead({ member: "aws", dir: AWS_DIR, stack: "prod", run: cli.run });
    expect(cli.calls).toEqual([
      ["stack", "output", "--json", "--show-secrets=false", "--stack", "prod"],
      ["preview", "--json", "--show-sames", "--stack", "prod"],
    ]);
    expect(read.part.member.scope).toBe("prod");
  });

  test("a member with no export and no declared stack reads the selected stack, passing no --stack (#4514)", async () => {
    const dir = join(testdata, "pulumi-unexported");
    const cli = fake((args) => (args[0] === "stack" ? "{}" : text("pulumi-outputs", "preview-settled.json")));
    const source = pulumiOutputSource({ run: cli.run });
    const unexported = { ...ref, dir };
    await source.applied(ctx, unexported);
    await previewPulumiMemberRead({ member: "aws", dir, run: cli.run });
    expect(cli.calls).toEqual([
      ["stack", "output", "--json", "--show-secrets=false"],
      ["preview", "--json", "--show-sames"],
    ]);
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
    deploy: [{ phase: "Apply", steps: [{ kind: "fake-records", inputs: { vpcId: { stackOutput: { stack: "aws", name: "vpcId" } } } }] }],
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
    expect(w.state.recordsPlanned).toEqual([{ inputs: { vpcId: OLD } }]);
    expect(set.deployedOutputs).toEqual({ aws: Object.keys(APPLIED).sort() });
    const records = set.members.find((m) => m.member === "records")!;
    expect(records.unknownInputs).toBeUndefined();
  });

  test("a known planned Pulumi output feeds dns's parameter when the change touches the member", async () => {
    const w = world({ preview: "preview-settled.json" });
    const plan = planFanOut({ components: ESTATE, changed: ["aws"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "local" });
    expect(w.state.recordsPlanned).toEqual([{ inputs: { vpcId: OLD } }]);
    expect(set.plannedOutputs).toEqual({ aws: Object.keys(APPLIED).sort() });
    expect(set.doc.members.find((m) => m.member === memberOutputsMemberName("aws"))!.holes).toEqual([]);
  });

  test("an unknown Pulumi output holds dns back, naming the member and the output", async () => {
    const w = world({ preview: "preview-replaced.json" });
    const plan = planFanOut({ components: ESTATE, changed: ["aws"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "local" });
    expect(set.failed).toBe(false);

    expect(w.state.recordsPlanned).toEqual([{ inputs: {}, unresolved: ["aws"] }]);
    const records = set.members.find((m) => m.member === "records")!;
    expect(records.unknownInputs).toEqual(["aws.vpcId"]);
    expect(records.reads).toEqual([{ upstream: "aws", outputs: ["vpcId"], unknown: ["vpcId"] }]);
    // Every output the stack publishes is unknown while its preview has changes: one hole each.
    const holes = set.doc.members.find((m) => m.member === memberOutputsMemberName("aws"))!.holes;
    expect(holes).toHaveLength(Object.keys(APPLIED).length);
    expect(holes).toContainEqual({ address: "aws.vpcId", type: "output", reason: "aws.vpcId is known only after aws applies; what reads it is planned again then" });

    // Merged before aws's own pipeline applied: the read refuses, so records is blocked behind it.
    const early = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "local", set });
    expect(early.members.find((m) => m.member === "records")).toMatchObject({ status: "blocked", blockedBy: "aws" });
    expect(w.state.recordsRan).toEqual([]);

    // Once aws applied: records is held back with the reason, and planned again against the applied value.
    const NEW = "vpc-0new";
    w.state.stackOutput = JSON.stringify({ ...APPLIED, vpcId: NEW, dbPasswordValue: "[secret]" });
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
      held: "its plan read aws.vpcId before that output applied as another value",
    });
    expect(w.state.recordsRan).toEqual([]);
  });

  test("run refuses while the stack's preview has changes left", async () => {
    const w = world({ preview: "preview-replaced.json" });
    const capability = w.registry.resolve(MEMBER_OUTPUTS_KIND);
    await expect(capability.run({ env: "local", component: "aws" }, { member: "aws" } as never)).rejects.toBeInstanceOf(MemberOutputsPendingError);
    w.state.preview = "preview-settled.json";
    await expect(capability.run({ env: "local", component: "aws" }, { member: "aws" } as never)).resolves.toEqual({ member: "aws", outputs: APPLIED });
  });
});

/**
 * `member-outputs` (#4455): a chant member's parameter planned against
 * another workspace member's output, read through that member's engine.
 *
 * The estate is the three-cloud demo's: `dns` reads `azureEndpoint`, which
 * the `azure` member publishes. `azure` is a choudoufu member, read through
 * a fake engine source standing in for the terraform lexicon's
 * `choudoufuOutputSource`; `records` is dns's deploy, a fake step that
 * plans its parameters the way `cfn-deploy` does (a hole when an input is
 * not known yet).
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "../capability";
import { registerCapabilityPlugins } from "../capability-plugin-loader";
import type { CapabilityPlugin } from "../capability-plugin";
import { starterCapabilityPlugin } from "../starter-plugin";
import { planFanOut } from "../fan-out";
import { applyPrSet, approvalOf, decidePrGate, planPrSet, readOnlyLedger, type PrPlanSet } from "../pr-run";
import { memoryGateLedgerPort } from "../../op/gate";
import { computePlanDigest } from "../../lifecycle/plan-digest";
import { deployUnits } from "../deploy-units";
import type { DriverComponent } from "../driver";
import {
  EngineOutputSourceMissingError,
  MEMBER_OUTPUTS_KIND,
  memberOutputsCapability,
  memberOutputsComponent,
  memberOutputsMemberName,
  MemberOutputsPendingError,
  type EngineMemberRef,
  type EngineOutputSource,
  type EnginePlannedOutputs,
} from "./member-outputs";

interface RecordsInput {
  inputs: Record<string, unknown>;
}

/** dns's two components: the azure member's outputs, and the records reading `azureEndpoint`. */
const ESTATE: DriverComponent[] = [
  memberOutputsComponent("azure") as unknown as DriverComponent,
  {
    name: "records",
    dependsOn: ["azure"],
    deploy: [{ phase: "Apply", steps: [{ kind: "fake-records", inputs: { azureEndpoint: { stackOutput: { stack: "azure", name: "azureEndpoint" } } } }] }],
  },
];

const WORKSPACE = "/ws";
const lookup = async (_cwd: string, member: string): Promise<EngineMemberRef> => {
  if (member !== "azure") throw new Error(`no member ${member}`);
  return { member, kind: "choudoufu", dir: `${WORKSPACE}/azure`, workspaceRoot: WORKSPACE };
};

function world() {
  const w = {
    /** What the azure estate's outputs are now. */
    applied: { azureEndpoint: "web.old.azurecontainerapps.io" } as Record<string, unknown>,
    /** What azure's plan says. */
    plan: { known: { azureEndpoint: "web.old.azurecontainerapps.io" }, unknown: [] as string[], planDigest: "sha256:azure-plan", changes: false } as EnginePlannedOutputs,
    /** What each plan of records saw. */
    recordsPlanned: [] as Array<{ inputs: Record<string, unknown>; unresolved?: string[] }>,
    recordsRan: [] as Array<Record<string, unknown>>,
    refs: [] as EngineMemberRef[],
  };
  const source: EngineOutputSource = {
    kinds: ["choudoufu"],
    async applied(_ctx, ref) {
      w.refs.push(ref);
      return { ...w.applied };
    },
    async planned(_ctx, ref) {
      w.refs.push(ref);
      return { ...w.plan, known: { ...w.plan.known }, unknown: [...w.plan.unknown] };
    },
  };
  const plugin: CapabilityPlugin = {
    name: "fake-dns",
    version: "0.0.0",
    capabilities: () =>
      [
        {
          kind: "fake-records",
          async plan(ctx: DeployContext, input: RecordsInput) {
            w.recordsPlanned.push({ inputs: { ...input.inputs }, ...(ctx.unresolvedInputs ? { unresolved: [...ctx.unresolvedInputs] } : {}) });
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
            w.recordsRan.push({ ...input.inputs });
            return {};
          },
        },
      ] as never,
    engineOutputSources: () => [source],
  };
  // The registry the CLI builds: the starter set, whose member-outputs gets the plugins' sources bound.
  const starter = { ...starterCapabilityPlugin, capabilities: () => starterCapabilityPlugin.capabilities().filter((c) => c.kind !== MEMBER_OUTPUTS_KIND).concat([memberOutputsCapability({ lookup }) as never]) };
  const registry = registerCapabilityPlugins(new CapabilityRegistry(), [starter as CapabilityPlugin, plugin]);
  return { registry, state: w };
}

const NOW = "2026-10-25T00:00:00Z";

describe("member-outputs", () => {
  test("is in the starter set, and a registry built without a source for the member's kind refuses by name", async () => {
    expect(starterCapabilityPlugin.capabilities().map((c) => c.kind)).toContain(MEMBER_OUTPUTS_KIND);
    const bare = memberOutputsCapability({ lookup });
    await expect(bare.outputs!({ env: "prod", component: "azure" }, { member: "azure" })).rejects.toBeInstanceOf(EngineOutputSourceMissingError);
    await expect(bare.outputs!({ env: "prod", component: "azure" }, { member: "azure" })).rejects.toThrow(/member "azure" is kind choudoufu.*Add "terraform"/);
  });

  test("the component is a deploy unit named after the member", () => {
    expect(deployUnits(memberOutputsComponent("azure").deploy)).toEqual([{ unit: "azure", lexicon: "workspace" }]);
  });

  test("an applied output feeds dns's parameter when the change does not touch the member", async () => {
    const w = world();
    const plan = planFanOut({ components: ESTATE, changed: ["records"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    expect(set.failed).toBe(false);
    expect(w.state.recordsPlanned).toEqual([{ inputs: { azureEndpoint: "web.old.azurecontainerapps.io" } }]);
    expect(set.deployedOutputs).toEqual({ azure: ["azureEndpoint"] });
    expect(w.state.refs[0]).toEqual({ member: "azure", kind: "choudoufu", dir: "/ws/azure", workspaceRoot: "/ws" });
    const records = set.members.find((m) => m.member === "records")!;
    expect(records.unknownInputs).toBeUndefined();
    expect(records.reads).toEqual([{ upstream: "azure", outputs: ["azureEndpoint"] }]);
  });

  test("a planned output the member's plan knows feeds dns's parameter when the change touches the member", async () => {
    const w = world();
    w.state.plan = { known: { azureEndpoint: "web.new.azurecontainerapps.io" }, unknown: [], planDigest: "sha256:azure-v2", changes: true };
    const plan = planFanOut({ components: ESTATE, changed: ["azure"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    expect(w.state.recordsPlanned).toEqual([{ inputs: { azureEndpoint: "web.new.azurecontainerapps.io" } }]);
    expect(set.plannedOutputs).toEqual({ azure: ["azureEndpoint"] });
    const azure = set.doc.members.find((m) => m.member === memberOutputsMemberName("azure"))!;
    expect(azure.holes).toEqual([]);
    // The approval binds the member's plan: another plan of azure moves the set's digest.
    const moved = world();
    moved.state.plan = { ...w.state.plan, planDigest: "sha256:azure-v3" };
    const again = await planPrSet({ components: ESTATE, plan, registry: moved.registry, env: "prod" });
    expect(again.doc.digest).not.toBe(set.doc.digest);
  });

  test("an unknown upstream output holds dns back, naming the member and the output", async () => {
    const w = world();
    w.state.plan = { known: {}, unknown: ["azureEndpoint"], planDigest: "sha256:azure-new-app", changes: true };
    const plan = planFanOut({ components: ESTATE, changed: ["azure"] });
    const set = await planPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod" });
    expect(set.failed).toBe(false);

    // records was planned without the value, told whose output it waits on.
    expect(w.state.recordsPlanned).toEqual([{ inputs: {}, unresolved: ["azure"] }]);
    const records = set.members.find((m) => m.member === "records")!;
    expect(records.unknownInputs).toEqual(["azure.azureEndpoint"]);
    expect(records.reads).toEqual([{ upstream: "azure", outputs: ["azureEndpoint"], unknown: ["azureEndpoint"] }]);
    expect(set.doc.members.find((m) => m.member === "records")!.holes).toEqual([{ address: "records", reason: "inputs from azure; re-checked on apply" }]);
    // The member's own part names the output.
    expect(set.doc.members.find((m) => m.member === memberOutputsMemberName("azure"))!.holes).toEqual([
      { address: "azure.azureEndpoint", type: "output", reason: "azure.azureEndpoint is known only after azure applies; what reads it is planned again then" },
    ]);

    // On merge, before azure's own pipeline applied: the read refuses, so records is blocked behind it and nothing reads a stale value.
    const early = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", set });
    expect(early.members.find((m) => m.member === "records")).toMatchObject({ status: "blocked", blockedBy: "azure" });
    expect(w.state.recordsRan).toEqual([]);

    // Once azure applied: records is held back with the reason, and planned again against the value azure applied as.
    w.state.applied = { azureEndpoint: "web.new.azurecontainerapps.io" };
    w.state.plan = { known: { azureEndpoint: "web.new.azurecontainerapps.io" }, unknown: [], planDigest: "sha256:azure-applied", changes: false };
    const decideNothing = async ({ gate, set: round }: { gate: string; set: PrPlanSet }) => {
      const check = await decidePrGate(readOnlyLedger(memoryGateLedgerPort()), { op: "pr-12", gate, digest: round.doc.digest, now: NOW });
      return { satisfied: check.satisfied, approval: approvalOf(check) };
    };
    const held = await applyPrSet({ components: ESTATE, plan, registry: w.registry, env: "prod", set, decideRound: decideNothing });
    expect(held.status).toBe("waiting");
    expect(held.members.find((m) => m.member === "records")).toMatchObject({
      status: "waiting",
      round: 2,
      held: "its plan read azure.azureEndpoint before that output applied as another value",
    });
    expect(w.state.recordsPlanned.at(-1)).toEqual({ inputs: { azureEndpoint: "web.new.azurecontainerapps.io" } });
    expect(w.state.recordsRan).toEqual([]);
  });

  test("run reads and never applies: a member with changes left refuses, one without answers its applied outputs", async () => {
    const w = world();
    const capability = w.registry.resolve(MEMBER_OUTPUTS_KIND);
    w.state.plan = { ...w.state.plan, changes: true };
    await expect(capability.run({ env: "prod", component: "azure" }, { member: "azure" } as never)).rejects.toBeInstanceOf(MemberOutputsPendingError);
    w.state.plan = { ...w.state.plan, changes: false };
    await expect(capability.run({ env: "prod", component: "azure" }, { member: "azure" } as never)).resolves.toEqual({
      member: "azure",
      outputs: { azureEndpoint: "web.old.azurecontainerapps.io" },
    });
  });
});

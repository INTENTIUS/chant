/**
 * A composed run as an op wave (#4842): a wave marked `together` on
 * `terraform-apply` plans its roots as one composed run through the group
 * methods (`./compose-group.ts`, chant's `ComposedRun`) and applies it in
 * one call, as terragucci's `waves.compose` does. The run is a fake
 * `ComposedRunner`, so nothing here runs a binary; the composition is real,
 * read from roots written to a temporary project.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { memoryGateLedgerPort, runOpWave, type OpWavesSpec } from "@intentius/chant/op";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { TerraformConfig } from "../config";
import type { ComposedRunApply, ComposedRunner, ComposedRunPlan } from "../compose/estate";
import { composeGroup, type GroupRunnerOptions } from "./compose-group";
import { terraformApplyCapability } from "./capability-plugin";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-compose-op-wave-"));
  made.push(dir);
  const roots: Record<string, string> = {
    "roots/a/main.tf": 'resource "terraform_data" "x" {\n  input = "a"\n}\n\noutput "id" {\n  value = terraform_data.x.output\n}\n',
    "roots/b/main.tf": 'variable "a_id" {\n  type = string\n}\n\nresource "terraform_data" "x" {\n  input = var.a_id\n}\n',
  };
  for (const [path, text] of Object.entries(roots)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const terraform = { binary: "tofu", roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" } }, compose: { enabled: true } } as unknown as TerraformConfig;

const part = (root: string): ChangeSetPart => ({
  member: { member: root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest: `jcs1-sha256:${root}`, holes: [] },
  entries: [{ member: root, address: "terraform_data.x", type: "terraform_data", action: "create" }] as never,
});

function composedPlan(digest: string): ComposedRunPlan {
  const member = (root: string) => ({
    member: root,
    planDigest: `jcs1-sha256:${root}`,
    changeSet: part(root),
    outputs: { known: {}, unknown: ["id"] },
    shape: { member: root, entries: [{ logicalId: "terraform_data.x", action: "create" }], unknownInputs: [] },
    slice: {},
    counts: { add: 1, change: 0, destroy: 0, changes: 1, destroys: 0 },
    reads: [],
  });
  return { members: { a: member("a"), b: member("b") }, digest, planFile: "/w/composed.tfplan", text: "", texts: {}, generated: [], counts: { add: 2, change: 0, destroy: 0, changes: 2, destroys: 0 }, summary: "Plan: 2 to add, 0 to change, 0 to destroy." } as unknown as ComposedRunPlan;
}

const appliedBoth: ComposedRunApply = {
  ok: true,
  members: { a: { status: "applied", planned: 1, done: 1, outputs: { id: "a-1" } }, b: { status: "applied", planned: 1, done: 1, outputs: {} } },
} as unknown as ComposedRunApply;

/** `terraform-apply` with its group methods on a fake run: each plan answers the next of `digests`. */
function capability(dir: string, digests: string[]): { registry: CapabilityRegistry; calls: string[]; built: GroupRunnerOptions[] } {
  const calls: string[] = [];
  const built: GroupRunnerOptions[] = [];
  const g = composeGroup({
    project: async () => ({ projectRoot: dir, terraform }),
    runner: (o): ComposedRunner => {
      built.push(o);
      return {
        plan: async () => {
          calls.push(`plan lock=${o.lock}`);
          return composedPlan(digests.shift() ?? "sha256:composed-1");
        },
        apply: async () => {
          calls.push("apply");
          return appliedBoth;
        },
        release: async () => void calls.push("release"),
      } as ComposedRunner;
    },
    identity: async () => undefined,
    env: {},
    log: () => {},
  });
  const cap = { ...terraformApplyCapability, planGroup: g.planGroup, runGroup: g.runGroup } as unknown as Capability<never, unknown>;
  return { registry: new CapabilityRegistry().register(cap), calls, built };
}

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  step: { kind: "terraform-apply", root: "{target}" },
  waves: [
    {
      name: "wave-1",
      together: true,
      gate: "never",
      runs: [{ target: "a" }, { target: "b", dependsOn: ["a"], input: { vars: { a_id: { stackOutput: { stack: "a", name: "id" } } } } }],
    },
  ],
};

const wave = (cwd: string, registry: CapabilityRegistry) =>
  runOpWave({ spec, specFile: "waves.json", wave: 1, cwd, show: () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) }), gates: memoryGateLedgerPort(), capabilities: registry, log: () => {} });

describe("a composed run as a together op wave (#4842)", () => {
  test("plans the roots as one composed run without locks, and applies that same plan under them in one call", async () => {
    const dir = project();
    const { registry, calls, built } = capability(dir, ["sha256:composed-1", "sha256:composed-1"]);
    const result = await wave(dir, registry);
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(["plan lock=false", "release", "plan lock=true", "apply", "release"]);
    expect(built[0]!.composition.members).toEqual(["a", "b"]);
    expect(built[0]!.vars).toEqual({ a: undefined, b: { a_id: { stackOutput: { stack: "a", name: "id" } } } });
    expect(result.applied).toEqual(["a", "b"]);
    expect(result.decision?.members.map((m) => m.member)).toEqual(["a", "b"]);
  });

  test("a composed plan that moved since the wave was decided applies nothing, and the wave exits 4", async () => {
    const dir = project();
    const { registry, calls } = capability(dir, ["sha256:composed-1", "sha256:composed-2"]);
    const result = await wave(dir, registry);
    expect(result.exitCode).toBe(4);
    expect(result.moved).toEqual(["a", "b"]);
    expect(calls).not.toContain("apply");
  });
});

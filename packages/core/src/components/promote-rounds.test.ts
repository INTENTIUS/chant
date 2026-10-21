/**
 * Rounds and per-wave gates at promote (#4168 step 4): a dependent planned
 * against its upstream's planned outputs is planned again once the upstream
 * applied as another value, and `--wave-gate` checks each wave.
 */

import { describe, expect, test } from "vitest";
import { composeChangeSet, type ChangeSetDocument } from "../change-set";
import type { DriverComponent, DriverRunResult, ReleaseGateBinding } from "./driver";
import { movedInputs, renameGates, runPromotionInRounds } from "./promote-rounds";

const sha = (c: string) => `sha256:${c.repeat(64)}`;

const net: DriverComponent = { name: "net", deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "tf", name: "net" }] }] };
const svc: DriverComponent = {
  name: "svc",
  dependsOn: ["net"],
  deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "tf", name: "svc", vpc: { stackOutput: { stack: "net", name: "id" } } }] }],
};

/** A change set of one planned member per name, each at the digest given; `writes` adds an update of that member's `vpc`. */
const doc = (members: Record<string, string>, writes: Record<string, string> = {}): ChangeSetDocument =>
  composeChangeSet(
    Object.entries(members).map(([member, digest]) => ({
      member: { member, lexicon: "terraform", planner: "terraform" as const, status: "planned" as const, planDigest: digest, holes: [] },
      entries: writes[member]
        ? [{ member, lexicon: "terraform", planner: "terraform" as const, address: `${member}.main`, type: "x", name: "main", action: "update" as const, attributes: [{ path: "vpc", after: writes[member] }] }]
        : [],
    })),
  );

const approved = doc({ net: sha("1"), svc: sha("2") }, { svc: "vpc-new" });
const binding: ReleaseGateBinding = { op: "release", planDigest: approved.digest, releaseDigest: sha("r") };

/** A run that applies every component and leaves `exposes` as its outputs, recording what it was handed. */
function runner(exposes: Record<string, Record<string, unknown>>) {
  const calls: Array<{ names: string[]; gates: string[]; binding: string; outputs: Record<string, Record<string, unknown>> }> = [];
  const run = async (components: DriverComponent[], outputs: Record<string, Record<string, unknown>>, b: ReleaseGateBinding): Promise<DriverRunResult> => {
    const gates = components.flatMap((c) => c.deploy.flatMap((p) => p.steps.filter((s) => (s as { kind?: string }).kind === "gate").map((s) => (s as { gate: string }).gate)));
    calls.push({ names: components.map((c) => c.name), gates, binding: b.planDigest, outputs });
    const out = { ...outputs };
    for (const c of components) if (exposes[c.name]) out[c.name] = exposes[c.name];
    return {
      order: components.map((c) => c.name),
      waves: [components.map((c) => c.name)],
      results: components.map((c) => ({ component: c.name, ok: true, status: "ok" as const, records: [] })),
      ok: true,
      status: "ok",
      componentOutputs: out,
    };
  };
  return { run, calls };
}

const bindings: string[][] = [];
const bind = async (d: ChangeSetDocument, gates: string[]): Promise<ReleaseGateBinding> => {
  bindings.push(gates);
  return { op: "release", planDigest: d.digest, releaseDigest: sha("r") };
};

describe("movedInputs", () => {
  test("names each reference that resolves to another value than its plan read", () => {
    expect(movedInputs(svc, { net: { id: "vpc-new" } }, { net: { id: "vpc-new" } })).toEqual([]);
    expect(movedInputs(svc, { net: { id: "vpc-new" } }, { net: { id: "vpc-other" } })).toEqual(["net.id"]);
    expect(movedInputs(svc, undefined, { net: { id: "x" } })).toEqual([]);
  });
});

describe("renameGates", () => {
  test("renames every gate, nested phases included, and drops the old key", () => {
    const c: DriverComponent = { name: "x", deploy: [{ phase: "A", steps: [{ phase: "B", steps: [{ kind: "gate", signalName: "old" }] }, { kind: "gate", gate: "g" }] }] };
    const renamed = renameGates(c, (g) => `${g}-round-2`);
    expect(JSON.stringify(renamed)).toContain('"gate":"old-round-2"');
    expect(JSON.stringify(renamed)).toContain('"gate":"g-round-2"');
    expect(JSON.stringify(renamed)).not.toContain("signalName");
  });
});

describe("runPromotionInRounds", () => {
  test("an upstream that applies as its plan said leaves the dependent under the approval it has", async () => {
    const { run, calls } = runner({ net: { id: "vpc-new" } });
    const result = await runPromotionInRounds({
      components: [svc, net],
      outputs: {},
      binding,
      approved,
      reads: { svc: { net: { id: "vpc-new" } } },
      run,
      replan: async () => { throw new Error("not planned again"); },
      bind,
    });
    expect(result.run.status).toBe("ok");
    expect(result.stages).toEqual([]);
    expect(calls.map((c) => [c.names, c.binding])).toEqual([[["net"], approved.digest], [["svc"], approved.digest]]);
    expect(calls[1].outputs).toEqual({ net: { id: "vpc-new" } });
    expect(result.completed).toEqual(["net", "svc"]);
  });

  test("an upstream that applies as another value plans the dependent again; a covered plan applies under the approval", async () => {
    const { run, calls } = runner({ net: { id: "vpc-other" } });
    const result = await runPromotionInRounds({
      components: [net, svc],
      outputs: {},
      binding,
      approved,
      reads: { svc: { net: { id: "vpc-new" } } },
      run,
      replan: async () => doc({ svc: sha("2") }, { svc: "vpc-new" }),
      bind,
    });
    expect(result.stages).toEqual([]);
    expect(calls[1]).toMatchObject({ names: ["svc"], binding: approved.digest, gates: ["prod-release"] });
  });

  test("a moved plan the approval does not cover waits at <gate>-round-2, bound to the new digest", async () => {
    const { run, calls } = runner({ net: { id: "vpc-other" } });
    const fresh = doc({ svc: sha("9") }, { svc: "vpc-other" });
    const result = await runPromotionInRounds({
      components: [net, svc],
      outputs: {},
      binding,
      approved,
      reads: { svc: { net: { id: "vpc-new" } } },
      run,
      replan: async (only, outputs) => {
        expect([...only]).toEqual(["svc"]);
        expect(outputs).toEqual({ net: { id: "vpc-other" } });
        return fresh;
      },
      bind,
    });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ kind: "round", number: 2, components: ["svc"], digest: fresh.digest, status: "applied" });
    expect(result.stages[0].notCovered[0]).toMatch(/svc/);
    expect(calls[1]).toMatchObject({ names: ["svc"], binding: fresh.digest, gates: ["prod-release-round-2"] });
  });

  test("--wave-gate checks every wave after the first and names one gate per wave", async () => {
    const { run, calls } = runner({ net: { id: "vpc-new" } });
    const fresh = doc({ svc: sha("8") }, { svc: "vpc-other" });
    const result = await runPromotionInRounds({
      components: [net, svc],
      outputs: {},
      binding,
      approved,
      reads: { svc: { net: { id: "vpc-new" } } },
      waveGate: "deploy",
      run,
      replan: async () => fresh,
      bind,
    });
    expect(result.stages[0]).toMatchObject({ kind: "wave", number: 2, digest: fresh.digest });
    expect(calls[1].gates).toEqual(["deploy-wave-2"]);
  });

  test("a stage whose components declare no gate stops with nothing more deployed", async () => {
    const plain: DriverComponent = { ...svc, deploy: [{ phase: "Apply", steps: [{ kind: "tf", name: "svc", vpc: { stackOutput: { stack: "net", name: "id" } } }] }] };
    const { run, calls } = runner({ net: { id: "vpc-other" } });
    const result = await runPromotionInRounds({
      components: [net, plain],
      outputs: {},
      binding,
      approved,
      reads: { svc: { net: { id: "vpc-new" } } },
      run,
      replan: async () => doc({ svc: sha("9") }, { svc: "vpc-other" }),
      bind,
    });
    expect(result.run.status).toBe("fail");
    expect(result.stages[0]).toMatchObject({ status: "failed" });
    expect(result.stages[0].message).toMatch(/no gate/);
    expect(calls.map((c) => c.names)).toEqual([["net"]]);
  });

  test("a resume skips what applied and starts from the outputs it kept", async () => {
    const { run, calls } = runner({});
    const result = await runPromotionInRounds({
      components: [net, svc],
      outputs: { net: { id: "vpc-new" } },
      binding,
      approved,
      reads: { svc: { net: { id: "vpc-new" } } },
      completed: ["net"],
      run,
      replan: async () => { throw new Error("not planned again"); },
      bind,
    });
    expect(calls.map((c) => c.names)).toEqual([["svc"]]);
    expect(result.completed).toEqual(["net", "svc"]);
  });

  test("a gated wave stops the run and leaves what applied", async () => {
    const calls: string[][] = [];
    const result = await runPromotionInRounds({
      components: [net, svc],
      outputs: {},
      binding,
      approved,
      reads: {},
      run: async (components, outputs) => {
        calls.push(components.map((c) => c.name));
        return {
          order: ["net"],
          waves: [["net"]],
          results: [{ component: "net", ok: false, status: "gated", records: [] }],
          ok: false,
          status: "gated",
          gatedComponent: "net",
          componentOutputs: outputs,
        };
      },
      replan: async () => approved,
      bind,
    });
    expect(result.run.status).toBe("gated");
    expect(result.run.gatedComponent).toBe("net");
    expect(calls).toEqual([["net"]]);
    expect(result.completed).toEqual([]);
  });
});

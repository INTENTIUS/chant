/**
 * Reads a capability finds in its steps' files (#4466): each becomes a
 * `stackOutput()` reference in the reader's step and a `dependsOn` on the
 * upstream, so it orders the fan-out and counts as a read.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeclaredRead, type DeclaredReadMember } from "./capability";
import { applyDeclaredReads, declaredReadsOf, withDeclaredReads } from "./declared-reads";
import { planFanOut } from "./fan-out";
import { unresolvedWiringReferences } from "./driver";
import { capabilitySteps } from "./wave-plan";
import type { DriverComponent } from "./driver";

const stack = (name: string, extra: Record<string, unknown> = {}, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", stack: name, ...extra }] }],
});

function registry(reads: (members: readonly DeclaredReadMember[]) => DeclaredRead[]) {
  const asked: DeclaredReadMember[][] = [];
  const r = new CapabilityRegistry();
  const unused = async (): Promise<never> => {
    throw new Error("not called here");
  };
  r.register({
    kind: "fake-stack",
    run: unused,
    declaredReads(_ctx: unknown, members: readonly DeclaredReadMember[]) {
      asked.push([...members]);
      return reads(members);
    },
  } as never);
  r.register({ kind: "fake-plain", run: unused } as never);
  return { registry: r, asked };
}

describe("declared reads (#4466)", () => {
  test("a read becomes a stackOutput() reference at its place and a dependsOn, so the reader orders after the upstream", async () => {
    const components = [stack("app"), stack("network")];
    const { registry: r, asked } = registry(() => [{ reader: "app", upstream: "network", output: "VpcId", at: "/imports/network-VpcId" }]);
    const out = await withDeclaredReads(components, r, "/project");
    expect(asked[0]!.map((m) => m.component)).toEqual(["app", "network"]);
    const app = out.find((c) => c.name === "app")!;
    expect(app.dependsOn).toEqual(["network"]);
    expect(capabilitySteps(app.deploy)[0]).toEqual({
      kind: "fake-stack",
      stack: "app",
      imports: { "network-VpcId": { stackOutput: { stack: "network", name: "VpcId" } } },
    });
    // The read is now one core sees: no value for network's VpcId yet.
    const { kind: _kind, ...rest } = capabilitySteps(app.deploy)[0]!;
    expect(unresolvedWiringReferences(rest, {}).map((x) => x.ref)).toEqual(["network.VpcId"]);
    // And it orders the fan-out.
    const plan = planFanOut({ components: out, changed: ["app", "network"] });
    expect(plan.waves).toEqual([["network"], ["app"]]);
    // The upstream is untouched.
    expect(out.find((c) => c.name === "network")).toBe(components[1]);
  });

  test("a place the declaration already fills is left as it is, and adds no dependsOn", () => {
    const declared = stack("app", { imports: { "network-VpcId": "vpc-pinned" } });
    const [out] = applyDeclaredReads([declared], [{ reader: "app", upstream: "network", output: "VpcId", at: "/imports/network-VpcId", index: 0, kind: "fake-stack" }]);
    expect(out!.dependsOn).toEqual([]);
    expect(capabilitySteps(out!.deploy)[0]).toMatchObject({ imports: { "network-VpcId": "vpc-pinned" } });
  });

  test("a dependsOn already declared is not repeated", () => {
    const declared = stack("app", {}, ["network"]);
    const [out] = applyDeclaredReads([declared], [{ reader: "app", upstream: "network", output: "VpcId", at: "/imports/a", index: 0, kind: "fake-stack" }]);
    expect(out!.dependsOn).toEqual(["network"]);
  });

  test("the read goes into the step of the reported kind and index, and an escaped pointer unescapes", () => {
    const declared: DriverComponent = {
      name: "app",
      deploy: [
        { phase: "Build", steps: [{ kind: "fake-plain", note: "x" }] },
        { phase: "Apply", steps: [{ kind: "fake-stack", stack: "one" }, { kind: "fake-stack", stack: "two" }] },
      ],
    };
    const [out] = applyDeclaredReads([declared], [{ reader: "app", upstream: "network", output: "Arn", at: "/imports/a~1b~0c", index: 1, kind: "fake-stack" }]);
    const steps = capabilitySteps(out!.deploy);
    expect(steps[0]).toEqual({ kind: "fake-plain", note: "x" });
    expect(steps[1]).toEqual({ kind: "fake-stack", stack: "one" });
    expect(steps[2]).toEqual({ kind: "fake-stack", stack: "two", imports: { "a/b~c": { stackOutput: { stack: "network", name: "Arn" } } } });
  });

  test("a read of itself, or of a component the project does not have, is dropped; a capability that throws reports none", async () => {
    const components = [stack("app"), stack("network")];
    const { registry: r } = registry(() => [
      { reader: "app", upstream: "app", output: "X", at: "/imports/x" },
      { reader: "app", upstream: "elsewhere", output: "X", at: "/imports/y" },
    ]);
    expect(await declaredReadsOf(components, r, "/project")).toEqual([]);
    const { registry: throwing } = registry(() => {
      throw new Error("unreadable");
    });
    expect(await declaredReadsOf(components, throwing, "/project")).toEqual([]);
    expect(await withDeclaredReads(components, throwing, "/project")).toEqual(components);
  });
});

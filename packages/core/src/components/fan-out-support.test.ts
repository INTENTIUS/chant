/**
 * Discovery to plan (#2420).
 *
 * The join is the part that had no caller: `componentsForUnits` turns a
 * stack-level change signal into components, and `planFanOut` needs the whole
 * component set to order a subset of it. These tests hold that seam to the
 * selection semantics `chant run --components all` already has, so the two
 * commands cannot disagree about which components exist.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Component } from "./component";

const discoverComponentsMock = vi.fn();
const loadChantConfigMock = vi.fn();

vi.mock("./discover", () => ({
  discoverComponents: (...args: unknown[]) => discoverComponentsMock(...args),
}));

vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});

const { deriveFanOut } = await import("./fan-out-support");

function component(name: string, dependsOn: string[] = [], over: Partial<Component> = {}): Component {
  return {
    name,
    dependsOn,
    deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: `${name}-stack` }] }],
    ...over,
  };
}

const ESTATE = [
  component("network"),
  component("cluster-a", ["network"]),
  component("cluster-b", ["network"]),
  component("app-one", ["cluster-a"]),
  component("app-two", ["cluster-b"]),
  component("billing"),
];

function discovers(components: Component[]): void {
  discoverComponentsMock.mockResolvedValue({
    components: new Map(components.map((c) => [c.name, { component: c, exportName: c.name, filePath: `${c.name}.component.ts` }])),
    sourceFiles: [],
    errors: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadChantConfigMock.mockResolvedValue({ config: { lexicons: ["aws"] } });
  discovers(ESTATE);
});

describe("joining a stack-level signal to components", () => {
  test("a changed stack selects the component that deploys it, and everything downstream", async () => {
    const derived = await deriveFanOut({ path: "/project", units: { changed: ["network-stack"] } });

    expect(derived.success).toBe(true);
    expect(derived.signal.changed).toEqual(["network"]);
    expect(derived.plan.order).toEqual(["network", "cluster-a", "cluster-b", "app-one", "app-two"]);
    expect(derived.plan.waves).toEqual([["network"], ["cluster-a", "cluster-b"], ["app-one", "app-two"]]);
    expect(derived.plan.skipped).toEqual([{ component: "billing", reason: "unaffected" }]);
  });

  test("ordering a subset works, and the dependency outside it is seeded rather than run", async () => {
    const derived = await deriveFanOut({ path: "/project", units: { changed: ["cluster-a-stack"] } });

    expect(derived.plan.order).toEqual(["cluster-a", "app-one"]);
    expect(derived.plan.seeds).toEqual(["network"]);
  });

  test("a changed stack no component deploys is reported, never dropped", async () => {
    const derived = await deriveFanOut({
      path: "/project",
      units: { changed: ["network-stack", "legacy-stack"] },
    });

    expect(derived.signal.unclaimed).toEqual(["legacy-stack"]);
    expect(derived.signal.changed).toEqual(["network"]);
  });

  test("an indeterminate stack the walk does not reach stays the third outcome", async () => {
    const derived = await deriveFanOut({
      path: "/project",
      units: { changed: ["app-one-stack"], indeterminate: ["billing-stack"] },
    });

    expect(derived.plan.order).toEqual(["app-one"]);
    expect(derived.plan.indeterminate).toEqual(["billing"]);
    expect(derived.plan.skipped).toContainEqual({ component: "billing", reason: "indeterminate" });
  });

  test("a component a build parameter turned off sits out, exactly as it does under `run --components all`", async () => {
    discovers([...ESTATE.filter((c) => c.name !== "app-two"), component("app-two", ["cluster-b"], { enabled: false })]);

    const derived = await deriveFanOut({ path: "/project", units: { changed: ["network-stack"] } });

    expect(derived.components.map((c) => c.name)).not.toContain("app-two");
    expect(derived.plan.order).not.toContain("app-two");
  });

  test("the whole graph is refused by name before anything is selected", async () => {
    discovers([component("a", ["b"]), component("b", ["a"]), component("network")]);

    await expect(deriveFanOut({ path: "/project", units: { changed: ["network-stack"] } })).rejects.toThrow(/cycle/i);
  });

  test("a discovery failure comes back as an error rather than an empty fan-out", async () => {
    discoverComponentsMock.mockResolvedValue({
      components: new Map(),
      sourceFiles: [],
      errors: [{ message: "app-one.component.ts failed to import" }],
    });

    const derived = await deriveFanOut({ path: "/project", units: { changed: ["network-stack"] } });
    expect(derived.success).toBe(false);
    expect(derived.error).toContain("failed to import");
  });
});

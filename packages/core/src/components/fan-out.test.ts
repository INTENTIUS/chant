/**
 * The subset planner (#2417).
 *
 * The property under test throughout: order comes from the full graph, and
 * execution comes from the selection. Those are different sets, and conflating
 * them is what makes a fan-out either wrong or useless.
 */

import { describe, test, expect } from "vitest";
import { componentsForUnits, planFanOut, UnknownComponentError } from "./fan-out";
import { DependencyCycleError, UnknownDependencyError, type DriverComponent } from "./driver";

const c = (name: string, dependsOn?: string[]): DriverComponent =>
  ({ name, deploy: [], ...(dependsOn ? { dependsOn } : {}) });

/** net → two clusters → apps, the shape the issue's proof asks for. */
const ESTATE: DriverComponent[] = [
  c("net"),
  c("cluster-a", ["net"]),
  c("cluster-b", ["net"]),
  c("app-one", ["cluster-a"]),
  c("app-two", ["cluster-a"]),
  c("app-three", ["cluster-b"]),
  c("billing"),
];

describe("selection", () => {
  test("a change at the root reaches everything downstream of it, and nothing else", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    expect(plan.order).toEqual(["net", "cluster-a", "cluster-b", "app-one", "app-three", "app-two"]);
    // `billing` shares no edge with the change, so it does not run.
    expect(plan.skipped).toEqual([{ component: "billing", reason: "unaffected" }]);
  });

  test("a change at a leaf propagates to nothing", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["app-three"] });
    expect(plan.order).toEqual(["app-three"]);
    expect(plan.skipped.map((s) => s.component)).toEqual([
      "app-one", "app-two", "billing", "cluster-a", "cluster-b", "net",
    ]);
  });

  test("no apply precedes its dependency", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    const position = new Map(plan.order.map((name, i) => [name, i]));
    for (const name of plan.order) {
      for (const dep of ESTATE.find((e) => e.name === name)!.dependsOn ?? []) {
        if (position.has(dep)) expect(position.get(dep)!).toBeLessThan(position.get(name)!);
      }
    }
  });
});

describe("waves", () => {
  test("independent branches share a wave", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["net"] });
    expect(plan.waves).toEqual([["net"], ["cluster-a", "cluster-b"], ["app-one", "app-three", "app-two"]]);
  });

  test("the derivation does not depend on the order components were declared in", () => {
    // The printed derivation is part of what an operator approves, so it has to
    // be a fact about the graph rather than about the file layout.
    const a = planFanOut({ components: ESTATE, changed: ["net"] });
    const b = planFanOut({ components: [...ESTATE].reverse(), changed: ["net"] });
    expect(b.order).toEqual(a.order);
    expect(b.waves).toEqual(a.waves);
  });

  test("an unselected dependency does not hold its dependents back a wave", () => {
    // Only the apps changed. `cluster-a` is already applied and seeded, so
    // `app-one` belongs in wave 1 rather than waiting behind a component that
    // is not running at all.
    const plan = planFanOut({ components: ESTATE, changed: ["app-one", "app-three"] });
    expect(plan.waves).toEqual([["app-one", "app-three"]]);
    expect(plan.seeds).toEqual(["cluster-a", "cluster-b"]);
  });
});

describe("diamonds", () => {
  const DIAMOND = [c("root"), c("left", ["root"]), c("right", ["root"]), c("join", ["left", "right"])];

  test("a component reachable by two paths applies once, after both paths", () => {
    const plan = planFanOut({ components: DIAMOND, changed: ["root"] });
    expect(plan.order).toEqual(["root", "left", "right", "join"]);
    expect(plan.order.filter((n) => n === "join")).toHaveLength(1);
    expect(plan.waves).toEqual([["root"], ["left", "right"], ["join"]]);
  });
});

describe("refusals", () => {
  test("a cycle is refused before anything is selected, even away from the change", () => {
    const withCycle = [...ESTATE, c("ping", ["pong"]), c("pong", ["ping"])];
    // The change touches `net`, which shares no edge with the cycle. A broken
    // graph is still broken.
    expect(() => planFanOut({ components: withCycle, changed: ["net"] })).toThrow(DependencyCycleError);
  });

  test("a dependsOn naming a component the project does not have is refused", () => {
    expect(() => planFanOut({ components: [c("app", ["ghost"])], changed: ["app"] }))
      .toThrow(UnknownDependencyError);
  });

  test("a changed name that is not a component is refused, naming what is known", () => {
    expect(() => planFanOut({ components: ESTATE, changed: ["nett"] }))
      .toThrow(/changed names "nett".*known: app-one, app-three/s);
    expect(() => planFanOut({ components: ESTATE, changed: ["nett"] })).toThrow(UnknownComponentError);
  });

  test("an indeterminate name that is not a component is refused too", () => {
    expect(() => planFanOut({ components: ESTATE, changed: [], indeterminate: ["ghost"] }))
      .toThrow(UnknownComponentError);
  });
});

describe("indeterminate", () => {
  test("one the walk reaches is selected like any other dependent", () => {
    // Reachability is a fact about the graph. Whether `app-one`'s own inputs
    // could be read from a source diff has no bearing on `cluster-a` having moved.
    const plan = planFanOut({ components: ESTATE, changed: ["cluster-a"], indeterminate: ["app-one"] });
    expect(plan.order).toContain("app-one");
    expect(plan.indeterminate).toEqual([]);
  });

  test("one the walk does not reach is reported, not decided", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["cluster-b"], indeterminate: ["billing"] });
    expect(plan.order).not.toContain("billing");
    expect(plan.indeterminate).toEqual(["billing"]);
    // And it is not quietly filed as unaffected, which would be a claim the
    // diff could not support.
    expect(plan.skipped).toContainEqual({ component: "billing", reason: "indeterminate" });
  });

  test("every non-selected component is accounted for exactly once", () => {
    const plan = planFanOut({ components: ESTATE, changed: ["cluster-a"], indeterminate: ["billing"] });
    const accounted = [...plan.order, ...plan.skipped.map((s) => s.component)].sort();
    expect(accounted).toEqual(ESTATE.map((e) => e.name).sort());
  });
});

describe("the binding digest", () => {
  test("re-deriving an unchanged fan-out produces the same digest", () => {
    const a = planFanOut({ components: ESTATE, changed: ["net"] });
    const b = planFanOut({ components: [...ESTATE].reverse(), changed: ["net"] });
    expect(b.digest).toBe(a.digest);
  });

  test("a different selection is a different approval", () => {
    const root = planFanOut({ components: ESTATE, changed: ["net"] });
    const leaf = planFanOut({ components: ESTATE, changed: ["app-three"] });
    expect(leaf.digest).not.toBe(root.digest);
  });

  test("the same selection over changed content is a different approval", () => {
    const before = planFanOut({ components: ESTATE, changed: ["net"], inputDigests: { net: "sha256:aa" } });
    const after = planFanOut({ components: ESTATE, changed: ["net"], inputDigests: { net: "sha256:bb" } });
    expect(after.digest).not.toBe(before.digest);
  });

  test("it looks like every other plan digest, so `chant approve --plan` accepts it", () => {
    expect(planFanOut({ components: ESTATE, changed: ["net"] }).digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("joining a stack-level change signal to components", () => {
  /** Two components claiming stacks by their deploy steps, the way `--live` already reads them. */
  const DEPLOYERS: DriverComponent[] = [
    { name: "edge", deploy: [{ phase: "Deploy", steps: [{ kind: "cfn-deploy", stack: "edge-stack" }] }] },
    { name: "core", deploy: [{ phase: "Deploy", steps: [{ kind: "cfn-deploy", stack: "core-stack" }] }] },
    {
      name: "mixed",
      deploy: [{ phase: "Deploy", steps: [
        { kind: "cfn-deploy", stack: "core-stack" },
        { kind: "helm-upgrade", release: "mixed-release" },
      ] }],
    },
  ];

  test("a component deploying a changed stack is changed", () => {
    const signal = componentsForUnits(DEPLOYERS, { changed: ["core-stack"] });
    expect(signal.changed).toEqual(["core", "mixed"]);
    expect(signal.indeterminate).toEqual([]);
    expect(signal.unclaimed).toEqual([]);
  });

  test("a component deploying only an indeterminate stack is indeterminate", () => {
    const signal = componentsForUnits(DEPLOYERS, { changed: [], indeterminate: ["edge-stack"] });
    expect(signal.changed).toEqual([]);
    expect(signal.indeterminate).toEqual(["edge"]);
  });

  test("certainty wins: one changed unit decides a component that also has an unjudgeable one", () => {
    const signal = componentsForUnits(DEPLOYERS, {
      changed: ["core-stack"],
      indeterminate: ["mixed-release"],
    });
    expect(signal.changed).toContain("mixed");
    expect(signal.indeterminate).not.toContain("mixed");
  });

  test("a changed stack no component claims is reported, not dropped", () => {
    const signal = componentsForUnits(DEPLOYERS, { changed: ["core-stack", "orphan-stack"] });
    expect(signal.unclaimed).toEqual(["orphan-stack"]);
  });

  test("the join feeds the planner directly", () => {
    const graph: DriverComponent[] = [
      { name: "core", deploy: [{ phase: "Deploy", steps: [{ kind: "cfn-deploy", stack: "core-stack" }] }] },
      { name: "edge", dependsOn: ["core"], deploy: [{ phase: "Deploy", steps: [{ kind: "cfn-deploy", stack: "edge-stack" }] }] },
    ];
    const signal = componentsForUnits(graph, { changed: ["core-stack"] });
    const plan = planFanOut({ components: graph, changed: signal.changed, indeterminate: signal.indeterminate });
    expect(plan.order).toEqual(["core", "edge"]);
  });
});

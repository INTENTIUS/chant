import { describe, expect, test } from "vitest";
import { adjacencyOf, walkBreadthFirst } from "./graph-walk";

const edges = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
  { from: "c", to: "a" },
  { from: "c", to: "d" },
];
const idx = adjacencyOf(edges);
const out = (id: string) => (idx.out.get(id) ?? []).map((e) => ({ far: e.to, hops: [e] }));

describe("walkBreadthFirst", () => {
  test("offers every node at its shortest depth first, and ends on a cycle", () => {
    const first = new Map<string, number>();
    const found = walkBreadthFirst("a", {
      steps: out,
      arrive: ({ id, depth }) => {
        if (!first.has(id)) first.set(id, depth);
        return false;
      },
    });
    expect(found).toBeNull();
    expect([...first]).toEqual([["b", 1], ["c", 2], ["a", 3], ["d", 3]]);
  });

  test("stops on the first accepted arrival and returns its hops", () => {
    const found = walkBreadthFirst("a", { steps: out, arrive: ({ id }) => id === "d" });
    expect(found?.depth).toBe(3);
    expect(found?.hops.map((h) => `${h.from}->${h.to}`)).toEqual(["a->b", "b->c", "c->d"]);
  });

  test("min and max bound which arrivals are offered and how far it steps", () => {
    const offered: string[] = [];
    walkBreadthFirst("a", { steps: out, min: 2, max: 2, arrive: ({ id }) => (offered.push(id), false) });
    expect(offered).toEqual(["c"]);
  });

  test("walks from several starts at once", () => {
    const offered = new Set<string>();
    walkBreadthFirst(["c", "b"], { steps: out, arrive: ({ id }) => (offered.add(id), false) });
    expect([...offered].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

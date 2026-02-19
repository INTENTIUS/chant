import { describe, test, expect } from "bun:test";
import { topoSort } from "./topo-sort";

interface Node {
  id: string;
  deps: string[];
}

describe("topoSort", () => {
  test("returns empty array for empty input", () => {
    const result = topoSort<Node>([], (n) => n.id, (n) => n.deps);
    expect(result).toEqual([]);
  });

  test("returns single node", () => {
    const nodes: Node[] = [{ id: "A", deps: [] }];
    const result = topoSort(nodes, (n) => n.id, (n) => n.deps);
    expect(result.map((n) => n.id)).toEqual(["A"]);
  });

  test("sorts dependencies before dependents", () => {
    const nodes: Node[] = [
      { id: "C", deps: ["B"] },
      { id: "A", deps: [] },
      { id: "B", deps: ["A"] },
    ];
    const result = topoSort(nodes, (n) => n.id, (n) => n.deps);
    const ids = result.map((n) => n.id);

    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("B"));
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("C"));
  });

  test("handles diamond dependency", () => {
    const nodes: Node[] = [
      { id: "D", deps: ["B", "C"] },
      { id: "B", deps: ["A"] },
      { id: "C", deps: ["A"] },
      { id: "A", deps: [] },
    ];
    const result = topoSort(nodes, (n) => n.id, (n) => n.deps);
    const ids = result.map((n) => n.id);

    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("B"));
    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("C"));
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("D"));
    expect(ids.indexOf("C")).toBeLessThan(ids.indexOf("D"));
  });

  test("handles independent nodes", () => {
    const nodes: Node[] = [
      { id: "A", deps: [] },
      { id: "B", deps: [] },
      { id: "C", deps: [] },
    ];
    const result = topoSort(nodes, (n) => n.id, (n) => n.deps);
    expect(result).toHaveLength(3);
  });

  test("ignores deps pointing to nodes not in the input", () => {
    const nodes: Node[] = [
      { id: "A", deps: ["X"] }, // X not in nodes
      { id: "B", deps: ["A"] },
    ];
    const result = topoSort(nodes, (n) => n.id, (n) => n.deps);
    const ids = result.map((n) => n.id);
    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("B"));
  });
});

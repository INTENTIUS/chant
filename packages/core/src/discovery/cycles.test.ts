import { describe, test, expect } from "bun:test";
import { detectCycles, normalizeCycleKey } from "./cycles";

describe("detectCycles", () => {
  test("returns empty array for empty graph", () => {
    const graph = {};
    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  test("returns empty array for single node with no edges", () => {
    const graph = {
      A: [],
    };
    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  test("returns empty array for acyclic graph with multiple nodes", () => {
    const graph = {
      A: ["B", "C"],
      B: ["D"],
      C: ["D"],
      D: [],
    };
    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  test("returns empty array for linear chain", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: ["D"],
      D: [],
    };
    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  test("detects simple self-loop", () => {
    const graph = {
      A: ["A"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["A"]);
  });

  test("detects simple two-node cycle", () => {
    const graph = {
      A: ["B"],
      B: ["A"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["A", "B"]);
  });

  test("detects three-node cycle", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: ["A"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["A", "B", "C"]);
  });

  test("detects longer cycle", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: ["D"],
      D: ["E"],
      E: ["A"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("detects cycle with branching paths", () => {
    const graph = {
      A: ["B", "C"],
      B: ["D"],
      C: ["D"],
      D: ["A"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    // The cycle should be detected from one of the paths
    expect(cycles[0]).toContain("A");
    expect(cycles[0]).toContain("D");
  });

  test("detects multiple independent cycles", () => {
    const graph = {
      A: ["B"],
      B: ["A"],
      C: ["D"],
      D: ["C"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(2);
  });

  test("detects cycle in complex graph with acyclic parts", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: ["D"],
      D: ["B", "E"],
      E: [],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["B", "C", "D"]);
  });

  test("handles graph with nodes that have no outgoing edges", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: ["A"],
      D: [],
      E: ["D"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["A", "B", "C"]);
  });

  test("handles disconnected components with one containing cycle", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: [],
      D: ["E"],
      E: ["D"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["D", "E"]);
  });

  test("detects nested cycles", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      C: ["A", "D"],
      D: ["E"],
      E: ["D"],
    };
    const cycles = detectCycles(graph);
    // Should detect at least one cycle
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });

  test("handles graph with multiple edges from same node", () => {
    const graph = {
      A: ["B", "C", "D"],
      B: ["E"],
      C: ["E"],
      D: ["E"],
      E: ["A"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0][0]).toBe("A");
    expect(cycles[0][cycles[0].length - 1]).toBe("E");
  });

  test("handles nodes referenced as neighbors but not defined as keys", () => {
    const graph = {
      A: ["B"],
      B: ["C"],
      // C is referenced but not defined
    };
    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  test("preserves node IDs correctly in cycle path", () => {
    const graph = {
      node1: ["node2"],
      node2: ["node3"],
      node3: ["node1"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["node1", "node2", "node3"]);
  });

  test("handles graph with numeric-like string node IDs", () => {
    const graph = {
      "1": ["2"],
      "2": ["3"],
      "3": ["1"],
    };
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["1", "2", "3"]);
  });

  test("accepts Map<string, Set<string>> input", () => {
    const graph = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["C"])],
      ["C", new Set(["A"])],
    ]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(["A", "B", "C"]);
  });

  test("deduplicates equivalent cycles from different starting nodes", () => {
    // Both A->B->C->A and B->C->A->B are the same cycle
    const graph = new Map<string, Set<string>>([
      ["A", new Set(["B"])],
      ["B", new Set(["C"])],
      ["C", new Set(["A"])],
    ]);
    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(1);
  });
});

describe("normalizeCycleKey", () => {
  test("rotates to lexicographically smallest node", () => {
    expect(normalizeCycleKey(["C", "A", "B", "C"])).toBe("A,B,C");
  });

  test("handles single-node cycle", () => {
    expect(normalizeCycleKey(["A", "A"])).toBe("A");
  });
});

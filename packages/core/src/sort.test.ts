import { describe, test, expect } from "bun:test";
import { topologicalSort } from "./sort";
import { BuildError } from "./errors";

describe("topologicalSort", () => {
  test("returns empty array for empty dependencies", () => {
    const dependencies = {};
    const result = topologicalSort(dependencies);
    expect(result).toEqual([]);
  });

  test("returns single node with no dependencies", () => {
    const dependencies = {
      A: [],
    };
    const result = topologicalSort(dependencies);
    expect(result).toEqual(["A"]);
  });

  test("sorts linear dependency chain", () => {
    const dependencies = {
      A: [],
      B: ["A"],
      C: ["B"],
      D: ["C"],
    };
    const result = topologicalSort(dependencies);
    expect(result).toEqual(["A", "B", "C", "D"]);
  });

  test("sorts diamond dependency pattern", () => {
    const dependencies = {
      A: [],
      B: ["A"],
      C: ["A"],
      D: ["B", "C"],
    };
    const result = topologicalSort(dependencies);

    // A must come first, D must come last
    expect(result[0]).toBe("A");
    expect(result[3]).toBe("D");

    // B and C must come before D but after A
    const bIndex = result.indexOf("B");
    const cIndex = result.indexOf("C");
    const dIndex = result.indexOf("D");
    expect(bIndex).toBeLessThan(dIndex);
    expect(cIndex).toBeLessThan(dIndex);
  });

  test("sorts multiple independent nodes", () => {
    const dependencies = {
      A: [],
      B: [],
      C: [],
    };
    const result = topologicalSort(dependencies);
    expect(result).toHaveLength(3);
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("C");
  });

  test("sorts complex graph with multiple levels", () => {
    const dependencies = {
      A: [],
      B: [],
      C: ["A"],
      D: ["A", "B"],
      E: ["C", "D"],
    };
    const result = topologicalSort(dependencies);

    // A and B must come before C, D, E
    const aIndex = result.indexOf("A");
    const bIndex = result.indexOf("B");
    const cIndex = result.indexOf("C");
    const dIndex = result.indexOf("D");
    const eIndex = result.indexOf("E");

    expect(aIndex).toBeLessThan(cIndex);
    expect(aIndex).toBeLessThan(dIndex);
    expect(aIndex).toBeLessThan(eIndex);
    expect(bIndex).toBeLessThan(dIndex);
    expect(bIndex).toBeLessThan(eIndex);
    expect(cIndex).toBeLessThan(eIndex);
    expect(dIndex).toBeLessThan(eIndex);
  });

  test("handles node with multiple dependencies", () => {
    const dependencies = {
      A: [],
      B: [],
      C: [],
      D: ["A", "B", "C"],
    };
    const result = topologicalSort(dependencies);

    // A, B, C must all come before D
    const dIndex = result.indexOf("D");
    expect(result.indexOf("A")).toBeLessThan(dIndex);
    expect(result.indexOf("B")).toBeLessThan(dIndex);
    expect(result.indexOf("C")).toBeLessThan(dIndex);
  });

  test("throws BuildError for self-loop", () => {
    const dependencies = {
      A: ["A"],
    };

    expect(() => topologicalSort(dependencies)).toThrow(BuildError);
    expect(() => topologicalSort(dependencies)).toThrow(/Circular dependency detected/);
  });

  test("throws BuildError for two-node cycle", () => {
    const dependencies = {
      A: ["B"],
      B: ["A"],
    };

    expect(() => topologicalSort(dependencies)).toThrow(BuildError);
    expect(() => topologicalSort(dependencies)).toThrow(/Circular dependency detected/);
  });

  test("throws BuildError for three-node cycle", () => {
    const dependencies = {
      A: ["B"],
      B: ["C"],
      C: ["A"],
    };

    expect(() => topologicalSort(dependencies)).toThrow(BuildError);
    expect(() => topologicalSort(dependencies)).toThrow(/Circular dependency detected/);
  });

  test("throws BuildError for cycle in complex graph", () => {
    const dependencies = {
      A: [],
      B: ["A"],
      C: ["B"],
      D: ["C"],
      E: ["D", "B"],
      F: ["E"],
      G: ["F", "C"],
      // Create cycle: G -> C -> B, but also E -> B
      H: ["G"],
      I: ["H", "A"],
      J: ["I"],
      // Add the cycle
      K: ["J"],
      L: ["K"],
      M: ["L", "K"],
    };

    // Add actual cycle
    dependencies.B = ["M"];

    expect(() => topologicalSort(dependencies)).toThrow(BuildError);
  });

  test("BuildError contains entity name from cycle", () => {
    const dependencies = {
      A: ["B"],
      B: ["C"],
      C: ["A"],
    };

    try {
      topologicalSort(dependencies);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(BuildError);
      if (error instanceof BuildError) {
        // Entity name should be one of the nodes in the cycle
        expect(["A", "B", "C"]).toContain(error.entityName);
      }
    }
  });

  test("BuildError message includes cycle path", () => {
    const dependencies = {
      A: ["B"],
      B: ["C"],
      C: ["A"],
    };

    try {
      topologicalSort(dependencies);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(BuildError);
      if (error instanceof BuildError) {
        expect(error.message).toContain("Circular dependency detected");
        expect(error.message).toContain("->");
      }
    }
  });

  test("sorts disconnected components", () => {
    const dependencies = {
      A: [],
      B: ["A"],
      C: [],
      D: ["C"],
    };
    const result = topologicalSort(dependencies);

    // Check ordering within each component
    const aIndex = result.indexOf("A");
    const bIndex = result.indexOf("B");
    const cIndex = result.indexOf("C");
    const dIndex = result.indexOf("D");

    expect(aIndex).toBeLessThan(bIndex);
    expect(cIndex).toBeLessThan(dIndex);
    expect(result).toHaveLength(4);
  });

  test("handles nodes with empty dependency arrays", () => {
    const dependencies = {
      A: [],
      B: [],
      C: ["A", "B"],
    };
    const result = topologicalSort(dependencies);

    const cIndex = result.indexOf("C");
    expect(result.indexOf("A")).toBeLessThan(cIndex);
    expect(result.indexOf("B")).toBeLessThan(cIndex);
  });

  test("preserves all nodes in result", () => {
    const dependencies = {
      A: [],
      B: ["A"],
      C: ["A"],
      D: ["B", "C"],
      E: [],
      F: ["E"],
    };
    const result = topologicalSort(dependencies);

    expect(result).toHaveLength(6);
    expect(new Set(result).size).toBe(6); // No duplicates
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("C");
    expect(result).toContain("D");
    expect(result).toContain("E");
    expect(result).toContain("F");
  });

  test("handles dependencies on non-existent nodes", () => {
    const dependencies = {
      A: ["B"], // B doesn't exist as a key
      C: [],
    };

    // Should handle gracefully - B is referenced but not defined
    const result = topologicalSort(dependencies);
    expect(result).toContain("A");
    expect(result).toContain("C");
  });

  test("handles realistic CloudFormation-style resource dependencies", () => {
    const dependencies = {
      MyVPC: [],
      MySubnet: ["MyVPC"],
      MySecurityGroup: ["MyVPC"],
      MyInstance: ["MySubnet", "MySecurityGroup"],
      MyEIP: ["MyInstance"],
    };
    const result = topologicalSort(dependencies);

    // VPC must be first
    expect(result[0]).toBe("MyVPC");

    // EIP must be last
    expect(result[result.length - 1]).toBe("MyEIP");

    // Subnet and SecurityGroup must come before Instance
    const subnetIndex = result.indexOf("MySubnet");
    const sgIndex = result.indexOf("MySecurityGroup");
    const instanceIndex = result.indexOf("MyInstance");

    expect(subnetIndex).toBeLessThan(instanceIndex);
    expect(sgIndex).toBeLessThan(instanceIndex);
  });
});

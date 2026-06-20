import { describe, it, expect } from "vitest";
import {
  toLayoutInput,
  DagreLayout,
  GraphvizLayout,
  getLayoutEngine,
  parseDotJson,
  DEFAULT_NODE_SIZE,
  type LayoutInput,
} from "./graph-layout";
import type { GraphIR } from "./graph-ir";

const ir: GraphIR = {
  nodes: [
    { id: "vpc", kind: "Vpc", lexicon: "aws", attrs: {} },
    { id: "subnet", kind: "Subnet", lexicon: "aws", attrs: {} },
  ],
  edges: [{ from: "subnet", to: "vpc", kind: "ref", viaAttr: "VpcId" }],
  groups: { byLexicon: { aws: ["vpc", "subnet"] } },
};

describe("toLayoutInput", () => {
  it("maps IR nodes/edges and carries groups", () => {
    const input = toLayoutInput(ir, { vpc: { w: 180, h: 60 }, subnet: { w: 180, h: 76 } });
    expect(input.nodes).toEqual([
      { id: "vpc", w: 180, h: 60 },
      { id: "subnet", w: 180, h: 76 },
    ]);
    expect(input.edges).toEqual([{ from: "subnet", to: "vpc" }]);
    expect(input.groups).toEqual({ aws: ["vpc", "subnet"] });
  });

  it("falls back to the default box for unmeasured nodes", () => {
    const input = toLayoutInput(ir);
    expect(input.nodes.every((n) => n.w === DEFAULT_NODE_SIZE.w && n.h === DEFAULT_NODE_SIZE.h)).toBe(true);
  });
});

describe("getLayoutEngine", () => {
  it("defaults to dagre (no native dependency)", () => {
    expect(getLayoutEngine().name).toBe("dagre");
    expect(getLayoutEngine("dagre").name).toBe("dagre");
  });
  it("returns graphviz on request", () => {
    expect(getLayoutEngine("graphviz").name).toBe("graphviz");
  });
  it("throws on an unknown engine", () => {
    expect(() => getLayoutEngine("elk")).toThrow(/unknown layout engine/i);
  });
});

describe("DagreLayout", () => {
  const input: LayoutInput = {
    nodes: [
      { id: "vpc", w: 180, h: 60 },
      { id: "subnetA", w: 180, h: 76 },
      { id: "subnetB", w: 180, h: 76 },
    ],
    edges: [
      { from: "subnetA", to: "vpc" },
      { from: "subnetB", to: "vpc" },
    ],
  };

  it("lays out with no native dependency and echoes sizes", async () => {
    const layout = await new DagreLayout().layout(input);
    expect(layout.nodes.map((n) => n.id)).toEqual(["subnetA", "subnetB", "vpc"]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.nodes.find((n) => n.id === "vpc")).toMatchObject({ w: 180, h: 60 });
  });

  it("spaces sized cards so none overlap", async () => {
    const layout = await new DagreLayout().layout(input);
    const r = layout.nodes.map((n) => ({
      id: n.id,
      x0: n.x - (n.w ?? 0) / 2,
      x1: n.x + (n.w ?? 0) / 2,
      y0: n.y - (n.h ?? 0) / 2,
      y1: n.y + (n.h ?? 0) / 2,
    }));
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const xOverlap = Math.min(r[i].x1, r[j].x1) - Math.max(r[i].x0, r[j].x0);
        const yOverlap = Math.min(r[i].y1, r[j].y1) - Math.max(r[i].y0, r[j].y0);
        expect(xOverlap > 0 && yOverlap > 0).toBe(false);
      }
    }
  });

  it("emits y-up coordinates matching graphviz (edge from drawn above to)", async () => {
    // Edges are subnet → vpc (consumer → producer). rankdir=TB draws the tail
    // above the head, so subnets sit above vpc — same as `dot`. In y-up space
    // that means subnets have the larger y. (Verified against GraphvizLayout.)
    const layout = await new DagreLayout().layout(input);
    const vpc = layout.nodes.find((n) => n.id === "vpc")!;
    const subnetA = layout.nodes.find((n) => n.id === "subnetA")!;
    expect(subnetA.y).toBeGreaterThan(vpc.y);
  });

  it("is deterministic", async () => {
    const a = await new DagreLayout().layout(input);
    const b = await new DagreLayout().layout(input);
    expect(a).toEqual(b);
  });
});

describe("parseDotJson", () => {
  it("reads bounds, positions, and echoes node size in points", () => {
    const json = JSON.stringify({
      bb: "0,0,200,100",
      objects: [
        { name: "b", pos: "50,80", width: "2.5", height: "0.5" },
        { name: "a", pos: "50,20" },
      ],
    });
    const layout = parseDotJson(json);
    expect(layout).toMatchObject({ width: 200, height: 100 });
    expect(layout.nodes.map((n) => n.id)).toEqual(["a", "b"]); // sorted
    expect(layout.nodes.find((n) => n.id === "b")).toMatchObject({ x: 50, y: 80, w: 180, h: 36 });
  });

  it("rejects zero bounds", () => {
    expect(() => parseDotJson(JSON.stringify({ bb: "0,0,0,0", objects: [] }))).toThrow(/zero graph bounds/);
  });
});

describe("GraphvizLayout", () => {
  it("exposes the graphviz engine name", () => {
    expect(new GraphvizLayout().name).toBe("graphviz");
  });
});

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeclaredPerStack, groupStackNodes } from "./graph-declared";
import { buildLiveGraphIr, sourceOverlayGraphs } from "./graph-ir";

/**
 * Side-by-side stacks (#1433) — several stacks declared in config, each with its
 * own `src`, composed into one graph.
 *
 * This is chant's ordinary multi-stack shape, as distinct from directory
 * partitioning (subdirectories of one `src/`), and it is the one where stack
 * membership is *declared* rather than inferred: the caller passes the names, and
 * `buildDeclaredPerStack` already renames every node `${stack}::${id}`. The
 * grouping was being discarded, so `groups.byStack` — the axis a boundary-box
 * renderer reads — came back empty for exactly the projects that have real
 * stacks to box.
 */
let dir: string;

// The shape discovery actually recognises — a plain object carrying the
// declarable marker, as `env.test.ts`'s fixtures do.
const stackSrc = (resource: string) =>
  `export const ${resource} = { entityType: "Thing", lexicon: "aws", kind: "resource", [Symbol.for("chant.declarable")]: true };\n`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-side-by-side-"));
  for (const [stack, resource] of [
    ["network", "vpc"],
    ["app", "service"],
  ] as const) {
    mkdirSync(join(dir, stack, "src"), { recursive: true });
    writeFileSync(join(dir, stack, "src", "main.ts"), stackSrc(resource));
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildDeclaredPerStack groups by declared stack (#1433)", () => {
  test("every node lands in the stack that declared it", async () => {
    const ir = await buildDeclaredPerStack(
      [
        { name: "network", src: "network/src" },
        { name: "app", src: "app/src" },
      ],
      dir,
    );
    const byStack = ir.groups.byStack ?? {};
    expect(Object.keys(byStack).sort()).toEqual(["app", "network"]);
    // Membership uses the SAME qualified ids the nodes carry — a consumer joins
    // the two without re-deriving anything.
    const ids = new Set(ir.nodes.map((n) => n.id));
    for (const members of Object.values(byStack)) {
      for (const id of members) expect(ids.has(id)).toBe(true);
    }
    // Every node is in exactly one stack: a boundary-box renderer that drew from
    // this would otherwise leave resources outside every box.
    expect(Object.values(byStack).flat().sort()).toEqual([...ids].sort());
  });

  test("a stack with no src contributes no group, as it contributes no nodes", async () => {
    const ir = await buildDeclaredPerStack(
      [{ name: "network", src: "network/src" }, { name: "unbuilt" }],
      dir,
    );
    expect(Object.keys(ir.groups.byStack ?? {})).toEqual(["network"]);
  });

  test("no stacks with src means no grouping at all, not an empty box", async () => {
    const ir = await buildDeclaredPerStack([{ name: "unbuilt" }], dir);
    expect(ir.groups.byStack).toBeUndefined();
    expect(ir.nodes).toEqual([]);
  });

  test("members are sorted, so the IR stays byte-stable across runs", async () => {
    const stacks = [
      { name: "network", src: "network/src" },
      { name: "app", src: "app/src" },
    ];
    const a = await buildDeclaredPerStack(stacks, dir);
    const b = await buildDeclaredPerStack(stacks, dir);
    expect(a.groups.byStack).toEqual(b.groups.byStack);
    for (const members of Object.values(a.groups.byStack ?? {})) {
      expect(members).toEqual([...members].sort());
    }
  });
});

describe("buildDeclaredPerStack takes edges from the lexicon hooks (#4232)", () => {
  test("withEdges sees each stack's entities by bare key, and its edges are qualified with the stack", async () => {
    const seen: string[][] = [];
    const ir = await buildDeclaredPerStack(
      [{ name: "network", src: "network/src" }, { name: "app", src: "app/src" }],
      dir,
      (g, entities) => {
        seen.push([...entities.keys()].sort());
        const [only] = g.nodes;
        return only ? { ...g, edges: [...g.edges, { from: only.id, to: only.id, kind: "ref", viaAttr: "self" }] } : g;
      },
    );
    expect(seen).toEqual([["vpc"], ["service"]]);
    expect(ir.edges).toContainEqual({ from: "network::vpc", to: "network::vpc", kind: "ref", viaAttr: "self" });
    expect(ir.edges).toContainEqual({ from: "app::service", to: "app::service", kind: "ref", viaAttr: "self" });
  });
});

describe("groupStackNodes puts a stack's live-only nodes in its box (#5490)", () => {
  test("a runtime task the read qualified joins its stack beside the declared service", async () => {
    const declared = await buildDeclaredPerStack([{ name: "app", src: "app/src" }, { name: "network", src: "network/src" }], dir);
    const live = buildLiveGraphIr([
      {
        lexicon: "aws",
        resources: {
          "app::service": { type: "Thing", status: "ACTIVE" },
          "app::Task/c/1": { type: "AWS::ECS::Task", status: "RUNNING", ownerChain: { root: "declared", entity: "app::service" } },
          "vpc-123": { type: "AWS::EC2::VPC", status: "available", referencedBy: ["app::service"] },
        },
      },
    ]);
    const ir = groupStackNodes(sourceOverlayGraphs(declared, live), ["app", "network"]);
    expect(ir.groups.byStack?.app).toEqual(["app::Task/c/1", "app::service"]);
    expect(ir.groups.byStack?.network).toEqual(["network::vpc"]);
    // A dependency keyed across stacks carries no stack prefix and stays unboxed.
    expect(Object.values(ir.groups.byStack ?? {}).flat()).not.toContain("vpc-123");
    const task = ir.nodes.find((n) => n.id === "app::Task/c/1");
    expect(task?.attrs._status).toBe("runtime");
  });

  test("nothing to add leaves the graph as it was", async () => {
    const declared = await buildDeclaredPerStack([{ name: "app", src: "app/src" }], dir);
    expect(groupStackNodes(declared, ["app"])).toBe(declared);
  });
});

/**
 * `moved`, `import`, `removed` and `check` blocks as entities (chant #4458).
 *
 * The fixture is `src/__fixtures__/config-blocks/app/`: one root holding two
 * `moved` blocks, an `import`, a `removed` and a `check` with a scoped `data`
 * block, rendered through `renderTerraformRoots` and core's `buildGraphIr`,
 * the pair `chant graph --format ir` runs.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildGraphIr, type GraphIR, type IREdge } from "@intentius/chant/graph-ir";
import type { Declarable } from "@intentius/chant/declarable";
import { renderTerraformRoots } from "./roots";
import {
  CHECK_TYPE,
  IMPORT_TYPE,
  MOVED_TYPE,
  REMOVED_TYPE,
  blocksToEntities,
  type TerraformEntity,
} from "./parse";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "config-blocks");

let entities: Map<string, Declarable>;
let warnings: string[];
let ir: GraphIR;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({ projectRoot: TREE, roots: { app: { dir: "./app" } } });
  entities = rendered.entities;
  warnings = rendered.warnings;
  ir = buildGraphIr(entities);
});

function entity(key: string): TerraformEntity {
  const e = entities.get(key);
  expect(e, key).toBeDefined();
  return e as TerraformEntity;
}

function edgesFrom(from: string): Array<[string, string]> {
  return ir.edges
    .filter((e: IREdge) => e.from === from)
    .map((e: IREdge) => [e.to, e.viaAttr ?? ""] as [string, string])
    .sort();
}

describe("moved blocks", () => {
  it("become Terraform::Moved entities", () => {
    expect(entity("app/moved").entityType).toBe(MOVED_TYPE);
    expect(entity("app/moved").props.address).toBe("moved");
  });

  it("get distinct keys when a root holds two", () => {
    expect(entity("app/moved~2").entityType).toBe(MOVED_TYPE);
    expect([...entities.keys()].filter((k) => entities.get(k)!.entityType === MOVED_TYPE).sort()).toEqual([
      "app/moved",
      "app/moved~2",
    ]);
    expect(entity("app/moved").props.line).not.toBe(entity("app/moved~2").props.line);
  });

  it("have an edge to `to`, and to `from` when `from` is still declared", () => {
    // `aws_instance.old` and `module.legacy` are not declared, so only `to` draws.
    expect(edgesFrom("app/moved")).toEqual([["app/aws_instance.web", "to"]]);
    expect(edgesFrom("app/moved~2")).toEqual([["app/module.network", "to"]]);
  });

  it("draws the `from` edge when the address it names is declared", async () => {
    const parsed = await blocksToEntities(
      [
        {
          name: "main.tf",
          source: [
            'resource "aws_instance" "a" {}',
            'resource "aws_instance" "b" {}',
            "moved {",
            "  from = aws_instance.a",
            "  to   = aws_instance.b",
            "}",
          ].join("\n"),
        },
      ],
      "app",
    );
    const { resolveEntityReferences } = await import("./edges");
    await resolveEntityReferences(parsed);
    const moved = parsed.get("app/moved") as TerraformEntity;
    expect(moved.references).toEqual([
      { to: "app/aws_instance.a", viaAttr: "from" },
      { to: "app/aws_instance.b", viaAttr: "to" },
    ]);
  });
});

describe("import blocks", () => {
  it("become a Terraform::Import entity with an edge to `to`", () => {
    expect(entity("app/import").entityType).toBe(IMPORT_TYPE);
    expect(edgesFrom("app/import")).toEqual([["app/aws_lb.front", "to"]]);
  });
});

describe("removed blocks", () => {
  it("become a Terraform::Removed entity", () => {
    expect(entity("app/removed").entityType).toBe(REMOVED_TYPE);
    expect(entity("app/removed").props.body["from"]).toBe("${aws_instance.gone}");
  });

  it("draw a `from` edge only when the address is still declared", async () => {
    expect(edgesFrom("app/removed")).toEqual([]);
    const parsed = await blocksToEntities(
      [{ name: "main.tf", source: 'resource "aws_instance" "a" {}\nremoved {\n  from = aws_instance.a\n}\n' }],
      "app",
    );
    const { resolveEntityReferences } = await import("./edges");
    await resolveEntityReferences(parsed);
    expect((parsed.get("app/removed") as TerraformEntity).references).toEqual([
      { to: "app/aws_instance.a", viaAttr: "from" },
    ]);
  });
});

describe("check blocks", () => {
  it("become a Terraform::Check entity keyed by its name", () => {
    expect(entity("app/check.health").entityType).toBe(CHECK_TYPE);
    expect(entity("app/check.health").props.address).toBe("check.health");
  });

  it("have an edge per reference, including the scoped data block's", () => {
    expect(edgesFrom("app/check.health")).toEqual([
      ["app/aws_lb.front", "data"],
      ["app/var.region", "assert"],
    ]);
  });

  it("read the scoped data block, never the root-level one of the same address", () => {
    expect(ir.edges.some((e) => e.from === "app/check.health" && e.to === "app/data.http.site")).toBe(false);
  });
});

describe("a `from` naming an undeclared address", () => {
  it("does not fail the build", () => {
    expect(warnings).toEqual([]);
  });

  it("raises no dangling reference", () => {
    expect(ir.dangling ?? []).toEqual([]);
    for (const e of ir.edges) expect(entities.has(e.to)).toBe(true);
  });
});

describe("the same blocks in Terraform's JSON syntax (chant#4457)", () => {
  /** Each config block's entity as the acceptance compares it: type, address and body, by key. */
  const configBlocks = (all: Map<string, Declarable>): Record<string, { type: string; address: string; body: unknown }> =>
    Object.fromEntries(
      [...all]
        .filter(([, e]) => [MOVED_TYPE, IMPORT_TYPE, REMOVED_TYPE, CHECK_TYPE].includes(e.entityType))
        .map(([key, e]) => {
          const p = (e as TerraformEntity).props;
          return [key, { type: e.entityType, address: p.address, body: p.body }];
        }),
    );

  it("main.tf.json's moved, import, removed and check blocks are the entities main.tf's are", async () => {
    const json = (await renderTerraformRoots({ projectRoot: TREE, roots: { app: { dir: "./app-json" } } })).entities;
    const fromJson = configBlocks(json);
    expect(Object.keys(fromJson).sort()).toEqual(["app/check.health", "app/import", "app/moved", "app/moved~2", "app/removed"]);
    expect(fromJson).toEqual(configBlocks(entities));
    for (const key of Object.keys(fromJson)) expect((json.get(key) as TerraformEntity).props.file).toBe("main.tf.json");
  });
});

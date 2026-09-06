/**
 * Module descent (chant #2112), against the real fixture tree in
 * `src/__fixtures__/module-tree/`. Every assertion here goes through
 * `renderTerraformRoots`, the same call `buildRoots()` makes, so the keys and
 * warnings under test are the ones a build produces.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { renderTerraformRoots } from "./roots";
import { resolveCallModuleType } from "./descend";
import { TERRAFORM_TYPE, type TerraformEntity } from "./parse";

const TREE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "module-tree");

function callersOf(entities: Map<string, Declarable>, key: string): readonly string[] | undefined {
  const entity = entities.get(key);
  return entity ? ((entity as TerraformEntity).props.callers ?? []) : undefined;
}

describe("descending into local modules", () => {
  it("keys a child module's blocks <root>/module.<name>/<address> and records the callers", async () => {
    const { entities } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
    });

    expect(entities.has("app/aws_s3_bucket.root_bucket")).toBe(true);
    expect(entities.has("app/module.cdn/aws_cloudfront_distribution.cdn")).toBe(true);
    expect(callersOf(entities, "app/module.cdn/aws_cloudfront_distribution.cdn")).toEqual(["module.cdn"]);

    // A root block carries no chain at all.
    expect(callersOf(entities, "app/aws_s3_bucket.root_bucket")).toEqual([]);
  });

  it("follows a child module's own local calls, one key segment per level", async () => {
    const { entities } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
    });

    const nested = "app/module.cdn/module.bucket/aws_s3_bucket.assets";
    expect(entities.has(nested)).toBe(true);
    expect(callersOf(entities, nested)).toEqual(["module.cdn", "module.bucket"]);
  });

  it("keeps the root name on a descended entity, so one root stays one root", async () => {
    const { entities } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
    });
    const child = entities.get("app/module.cdn/aws_cloudfront_distribution.cdn") as TerraformEntity;
    expect(child.props.root).toBe("app");
    expect(child.props.file).toBe("main.tf");
  });

  it("does not follow a registry or git source, and says which call site it skipped", async () => {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
    });

    expect([...entities.keys()].some((k) => k.startsWith("app/module.vpc/"))).toBe(false);
    const skipped = warnings.find((w) => w.includes("not descending into"));
    expect(skipped).toContain("module.vpc");
    expect(skipped).toContain("terraform-aws-modules/vpc/aws");
    expect(skipped).toContain("reported against the module block at the call site");
  });

  it('reads nothing but the root itself under "none"', async () => {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
      callModuleType: "none",
    });

    expect([...entities.keys()].some((k) => k.includes("/module.cdn/"))).toBe(false);
    expect(entities.has("app/module.cdn")).toBe(true); // the call block itself still parses
    expect(warnings).toEqual([]);
  });

  it('refuses "all" with a message, and descends into nothing', async () => {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
      callModuleType: "all",
    });

    expect(warnings[0]).toContain('terraform.callModuleType: "all" is not supported');
    expect(warnings[0]).toContain("chant fetches nothing");
    expect([...entities.keys()].some((k) => k.includes("/module.cdn/"))).toBe(false);
  });

  it("refuses a source that resolves outside the project root", async () => {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: join(TREE, "outside"),
      roots: { app: { dir: "./root" } },
    });

    expect([...entities.keys()].some((k) => k.includes("/module.shared/"))).toBe(false);
    const refused = warnings.find((w) => w.includes("outside the project"));
    expect(refused).toContain("module.shared");
    expect(refused).toContain("../../shared");
  });

  it("stops on a cycle rather than recursing forever", async () => {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./cycle" } },
    });

    expect(entities.has("app/module.a/null_resource.a")).toBe(true);
    expect(entities.has("app/module.a/module.b/null_resource.b")).toBe(true);
    expect(entities.has("app/module.a/module.b/module.a/null_resource.a")).toBe(false);
    expect(warnings.some((w) => w.includes("That is a cycle"))).toBe(true);
  });

  it("warns, and keeps the rest of the root, when a local source names no directory", async () => {
    const { entities, warnings } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./missing" } },
    });

    expect(entities.has("app/null_resource.here")).toBe(true);
    expect(warnings.some((w) => w.includes("module.gone") && w.includes("no directory exists"))).toBe(true);
  });
});

describe("resolveCallModuleType", () => {
  it("defaults to local", () => {
    expect(resolveCallModuleType(undefined)).toEqual({ effective: "local" });
    expect(resolveCallModuleType("local")).toEqual({ effective: "local" });
  });

  it("passes none through with no message", () => {
    expect(resolveCallModuleType("none")).toEqual({ effective: "none" });
  });

  it("refuses all, and falls back to reading nothing rather than to local", () => {
    const resolved = resolveCallModuleType("all");
    expect(resolved.effective).toBe("none");
    expect(resolved.warning).toContain("requires fetching them");
  });
});

describe("the descended entities the rules read", () => {
  it("marks a child module's terraform block as child-scoped, not as the root's", async () => {
    const { entities } = await renderTerraformRoots({
      projectRoot: TREE,
      roots: { app: { dir: "./root" } },
    });

    const child = entities.get("app/module.cdn/module.bucket/terraform") as TerraformEntity;
    expect(child.entityType).toBe(TERRAFORM_TYPE);
    expect(child.props.callers).toEqual(["module.cdn", "module.bucket"]);

    const root = entities.get("app/terraform") as TerraformEntity;
    expect(root.props.callers).toBeUndefined();
  });
});

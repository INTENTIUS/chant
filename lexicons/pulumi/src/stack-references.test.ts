/**
 * `StackReference` reads between `pulumi-up` steps (#4547). The exports are
 * built in the shape `pulumi stack export` writes a `StackReference`
 * (`inputs.name`, `outputs.outputs`, `outputs.secretOutputNames`), not
 * recorded; a floci recording of two corpus stacks replaces them at
 * epic-ready. No engine runs, and the index store is skipped (`null`).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { layerWaves } from "@intentius/chant/gated-waves";
import { pulumiDeclaredReads } from "./pulumi-up";
import { parsePulumiStackName, pulumiStackReferences, stackReferenceOwner } from "./stack-references";

const ref = (stack: string, name: string, outputs: Record<string, unknown>, secret: string[] = []) => ({
  urn: `urn:pulumi:${stack}::app::pulumi:pulumi:StackReference::${name}`,
  custom: true,
  type: "pulumi:pulumi:StackReference",
  inputs: { name },
  outputs: { name, outputs, secretOutputNames: secret },
});

const exportOf = (resources: unknown[]) => ({ version: 3, deployment: { resources } });

function project(name: string, exported?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), `stackref-${name}-`));
  writeFileSync(join(dir, "Pulumi.yaml"), `name: ${name}\nruntime: nodejs\n`);
  if (exported !== undefined) writeFileSync(join(dir, "stack-export.json"), JSON.stringify(exported));
  return dir;
}

describe("reading StackReference from an export", () => {
  test("names split three ways; a malformed one is left out", () => {
    expect(parsePulumiStackName("acme/network/prod")).toEqual({ org: "acme", project: "network", stack: "prod" });
    expect(parsePulumiStackName("network/prod")).toEqual({ project: "network", stack: "prod" });
    expect(parsePulumiStackName("prod")).toEqual({ stack: "prod" });
    expect(parsePulumiStackName("a//b")).toBeUndefined();
  });

  test("each reference with its recorded outputs, secret ones apart", () => {
    const refs = pulumiStackReferences(exportOf([ref("prod", "acme/network/prod", { vpcId: "vpc-1", dbPassword: "[secret]" }, ["dbPassword"])]));
    expect(refs).toEqual([
      expect.objectContaining({ name: "acme/network/prod", project: "network", stack: "prod", outputs: ["vpcId"], secretOutputs: ["dbPassword"] }),
    ]);
    expect(pulumiStackReferences(undefined)).toEqual([]);
  });

  test("the owner is the one other step with that project and stack; a bare name is the reader's own project", () => {
    const owners = [
      { component: "network", project: "network", stack: "prod" },
      { component: "app", project: "app", stack: "prod" },
      { component: "app-staging", project: "app", stack: "staging" },
    ];
    const [r] = pulumiStackReferences(exportOf([ref("prod", "network/prod", { vpcId: "v" })]));
    expect(stackReferenceOwner(r!, { component: "app", project: "app" }, owners)).toEqual({ owner: owners[0] });
    const [bare] = pulumiStackReferences(exportOf([ref("prod", "staging", { x: 1 })]));
    expect(stackReferenceOwner(bare!, { component: "app", project: "app" }, owners)).toEqual({ owner: owners[2] });
    const [far] = pulumiStackReferences(exportOf([ref("prod", "other/prod", { x: 1 })]));
    expect(stackReferenceOwner(far!, { component: "app", project: "app" }, owners)).toMatchObject({ outside: expect.stringMatching(/other\/prod is not a stack/) });
  });
});

describe("pulumi-up's declaredReads", () => {
  test("two stacks, one reading the other, plan in two waves in that order with no dependsOn written", async () => {
    const network = project("network", exportOf([]));
    const app = project("app", exportOf([ref("prod", "acme/network/prod", { vpcId: "vpc-1", subnetIds: ["s"], token: "[secret]" }, ["token"])]));
    const reads = await pulumiDeclaredReads(
      { root: "/" },
      [
        { component: "app", index: 0, step: { dir: app, stack: "prod" } },
        { component: "network", index: 0, step: { dir: network, stack: "prod" } },
      ],
      { exportStore: null },
    );
    expect(reads).toEqual([
      { reader: "app", index: 0, upstream: "network", output: "subnetIds", at: "/stackReferences/acme~1network~1prod/subnetIds" },
      { reader: "app", index: 0, upstream: "network", output: "vpcId", at: "/stackReferences/acme~1network~1prod/vpcId" },
    ]);
    const { applyDeclaredReads } = await import("@intentius/chant/components/declared-reads");
    const placed = applyDeclaredReads(
      [
        { name: "app", deploy: [{ phase: "deploy", steps: [{ kind: "pulumi-up", dir: app, stack: "prod" }] }] },
        { name: "network", deploy: [{ phase: "deploy", steps: [{ kind: "pulumi-up", dir: network, stack: "prod" }] }] },
      ] as never,
      reads.map((r) => ({ ...r, index: r.index ?? 0, kind: "pulumi-up" })),
    ) as unknown as { name: string; dependsOn?: string[] }[];
    expect(placed.find((c) => c.name === "app")!.dependsOn).toEqual(["network"]);
    expect(layerWaves(placed.map((c) => ({ name: c.name, dependsOn: c.dependsOn ?? [] })))).toEqual([["network"], ["app"]]);
  });

  test("a reference to a stack outside the project adds no read", async () => {
    const app = project("app", exportOf([ref("prod", "acme/billing/prod", { invoiceQueue: "q" })]));
    expect(await pulumiDeclaredReads({ root: "/" }, [{ component: "app", index: 0, step: { dir: app, stack: "prod" } }], { exportStore: null })).toEqual([]);
  });
});

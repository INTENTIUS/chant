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
import { createPulumiUpCapability, pulumiDeclaredReads, pulumiGraphReads, pulumiSecretOutputNames } from "./pulumi-up";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import { replanAfterApply, upstreamReadsOf, type OutputRecord, type OutputRecordPort } from "@intentius/chant/components/upstream-replan";
import { PULUMI_STACK_REFERENCE_GRAPH_FLOOR } from "./chant-floors";
import { pulumiWorkspaceStackReads } from "./workspace-stack-reads";
import { placeStackReads } from "../../../packages/core/src/workspace/stack-read-edges";
import type { WorkspaceGraph } from "../../../packages/core/src/workspace/compose-graph";
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

  test("with each stack only in the step's environments, core reads the run's environment's stack, and a pull request's through its template (#5360)", async () => {
    const network = project("network", exportOf([]));
    const app = project("app", exportOf([ref("prod", "acme/network/prod", { vpcId: "vpc-1" })]));
    const { CapabilityRegistry } = await import("@intentius/chant/components/capability");
    const { declaredReadsOf } = await import("@intentius/chant/components/declared-reads");
    const { createPulumiUpCapability } = await import("./pulumi-up");
    const registry = new CapabilityRegistry().register(createPulumiUpCapability({ snapshots: null }) as never);
    const perEnv = (dir: string) => ({ kind: "pulumi-up", dir, environments: { staging: { stack: "staging" }, prod: { stack: "prod" } } });
    const components = [
      { name: "app", deploy: [{ phase: "deploy", steps: [perEnv(app)] }] },
      { name: "network", deploy: [{ phase: "deploy", steps: [perEnv(network)] }] },
    ];
    const expected = [{ reader: "app", index: 0, upstream: "network", output: "vpcId", at: "/stackReferences/acme~1network~1prod/vpcId", kind: "pulumi-up" }];
    expect(await declaredReadsOf(components, registry, "/", { env: "prod" })).toEqual(expected);
    expect(await declaredReadsOf(components, registry, "/", { env: "pr-7", template: "prod" })).toEqual(expected);
    // Read as declared, the steps name no stack, and no owner is found.
    expect(await declaredReadsOf(components, registry, "/")).toEqual([]);
  });

  test("a reference to a stack outside the project adds no read", async () => {
    const app = project("app", exportOf([ref("prod", "acme/billing/prod", { invoiceQueue: "q" })]));
    expect(await pulumiDeclaredReads({ root: "/" }, [{ component: "app", index: 0, step: { dir: app, stack: "prod" } }], { exportStore: null })).toEqual([]);
  });
});

describe("pulumi-up's graphReads (#5331)", () => {
  test("the floor is a version or the next release", () => {
    expect(PULUMI_STACK_REFERENCE_GRAPH_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("a two-stack fixture: one edge per output, secret ones by name, the same reader as the wave order", async () => {
    const network = project("network", exportOf([]));
    const app = project("app", exportOf([ref("prod", "acme/network/prod", { vpcId: "vpc-1", token: "[secret]" }, ["token"])]));
    const members = [
      { component: "app", index: 0, step: { dir: app, stack: "prod" } },
      { component: "network", index: 0, step: { dir: network, stack: "prod" } },
    ];
    const graph = await pulumiGraphReads({ root: "/" }, members, { exportStore: null });
    expect(graph).toEqual([
      { reader: "app", index: 0, upstream: "network", output: "token" },
      { reader: "app", index: 0, upstream: "network", output: "vpcId" },
    ]);
    const ordered = await pulumiDeclaredReads({ root: "/" }, members, { exportStore: null });
    expect(ordered.map((r) => `${r.reader}>${r.upstream}:${r.output}`)).toEqual(["app>network:vpcId"]);
  });

  test("a stack no step applies is external, named org/project/stack, with a bare name in the reader's project", async () => {
    const app = project("app", exportOf([ref("prod", "acme/billing/prod", { invoiceQueue: "q" }), ref("prod", "shared", {})]));
    const graph = await pulumiGraphReads({ root: "/" }, [{ component: "app", index: 0, step: { dir: app, stack: "prod" } }], { exportStore: null });
    expect(graph).toEqual([
      { reader: "app", index: 0, external: "acme/billing/prod", output: "invoiceQueue" },
      { reader: "app", index: 0, external: "app/shared" },
    ]);
  });
});

describe("workspace graph stack reads (#5331)", () => {
  const exportFor = (stack: string, resources: unknown[] = []) =>
    exportOf([{ urn: `urn:pulumi:${stack}::x::pulumi:pulumi:Stack::x-${stack}`, type: "pulumi:pulumi:Stack" }, ...resources]);
  const empty = (): WorkspaceGraph =>
    ({ version: 1, workspace: { name: "w", root: "." }, members: [], nodes: [], edges: [], groups: { byMember: {} }, exports: [], imports: [], links: [], collectors: [], records: [] }) as unknown as WorkspaceGraph;

  test("two members: an edge from the reader's stack node to the upstream's, naming each output", async () => {
    const net = project("network", exportFor("prod"));
    const app = project("app", exportFor("prod", [ref("prod", "acme/network/prod", { vpcId: "v", token: "[secret]" }, ["token"])]));
    const answer = await pulumiWorkspaceStackReads({ root: "/", members: [{ name: "app", dir: app, kind: "pulumi" }, { name: "net", dir: net, kind: "pulumi" }, { name: "other", dir: "/x", kind: "chant" }] }, { exportStore: null });
    const g = empty();
    placeStackReads(g, answer!);
    expect(g.nodes.map((n) => n.id)).toEqual(["app/pulumi:pulumi:Stack", "net/pulumi:pulumi:Stack"]);
    expect(g.edges).toEqual([
      { from: "app/pulumi:pulumi:Stack", to: "net/pulumi:pulumi:Stack", kind: "ref", viaAttr: "token", origin: "declared", member: "app" },
      { from: "app/pulumi:pulumi:Stack", to: "net/pulumi:pulumi:Stack", kind: "ref", viaAttr: "vpcId", origin: "declared", member: "app" },
    ]);
    expect(g.edges.every((e) => e.grain === undefined)).toBe(true);
    expect(g.groups.byMember.app).toEqual(["app/pulumi:pulumi:Stack"]);
  });

  test("a stack no member applies is an external node in the reader's member", async () => {
    const app = project("app", exportFor("prod", [ref("prod", "acme/billing/prod", { queue: "q" })]));
    const answer = await pulumiWorkspaceStackReads({ root: "/", members: [{ name: "app", dir: app, kind: "pulumi" }] }, { exportStore: null });
    const g = empty();
    placeStackReads(g, answer!);
    const external = g.nodes.find((n) => n.attrs.external === true)!;
    expect(external).toMatchObject({ id: "external:acme/billing/prod", member: "app", attrs: { external: true, stack: "acme/billing/prod" } });
    expect(g.edges).toEqual([{ from: "app/pulumi:pulumi:Stack", to: "external:acme/billing/prod", kind: "ref", viaAttr: "queue", origin: "declared", member: "app" }]);
  });

  test("--env picks the member's Pulumi.<env>.yaml stack over the exported one", async () => {
    const net = project("network", exportFor("dev"));
    writeFileSync(join(net, "Pulumi.prod.yaml"), "config: {}\n");
    const app = project("app", exportFor("dev", [ref("dev", "network/prod", { vpcId: "v" })]));
    const members = [{ name: "app", dir: app, kind: "pulumi" }, { name: "net", dir: net, kind: "pulumi" }];
    const asDeclared = await pulumiWorkspaceStackReads({ root: "/", members }, { exportStore: null });
    expect(asDeclared!.reads).toEqual([{ reader: "app", external: "network/prod", output: "vpcId" }]);
    writeFileSync(join(app, "Pulumi.prod.yaml"), "config: {}\n");
    const forProd = await pulumiWorkspaceStackReads({ root: "/", env: "prod", members }, { exportStore: null });
    expect(forProd!.reads).toEqual([{ reader: "app", upstream: "net", output: "vpcId" }]);
  });
});

describe("re-planning a stack's dependents when an output it reads changes (#5345)", () => {
  const memory = (): OutputRecordPort & { lines: OutputRecord[] } => {
    const lines: OutputRecord[] = [];
    return { lines, read: async () => [...lines], append: async (_env, records) => void lines.push(...records) };
  };

  test("a StackReference is a read of the stack's output, and a change to it plans the reader at its gate, never its apply", async () => {
    const network = project("network", exportOf([]));
    const app = project("app", exportOf([ref("prod", "acme/network/prod", { vpcId: "vpc-1" })]));
    const cap = createPulumiUpCapability({ snapshots: null });
    const registry = new CapabilityRegistry().register({
      ...cap,
      run: async () => {
        throw new Error("a re-plan never applies");
      },
    } as never);
    const components = [
      { name: "network", deploy: [{ phase: "Apply", steps: [{ kind: "pulumi-up", dir: network, stack: "prod" }] }] },
      { name: "app", deploy: [{ phase: "Apply", steps: [{ kind: "pulumi-up", dir: app, stack: "prod" }] }] },
    ];
    const reads = await upstreamReadsOf(components, registry, "/", (component) => ({ env: "prod", component }), "prod");
    expect(reads).toEqual([{ reader: "app", upstream: "network", output: "vpcId", via: "declared" }]);

    const records = memory();
    const planned: string[][] = [];
    const decided: string[] = [];
    const go = (vpcId: string) =>
      replanAfterApply({
        components,
        registry,
        root: "/",
        env: "prod",
        applied: { network: { vpcId } },
        replanDependents: ["network"],
        records,
        gate: "pr-apply",
        gitSha: "0123456789abcdef",
        planner: async ({ plan }) => {
          planned.push(plan.order);
          return { doc: { digest: "jcs1-sha256:app" }, members: [], failed: false } as never;
        },
        decide: async ({ gate, description }) => {
          decided.push(`${gate}: ${description}`);
          return { status: "pending" };
        },
      });
    expect((await go("vpc-1")).changes).toEqual([{ member: "network", changed: [], first: true, dependents: [], replan: true }]);
    const moved = await go("vpc-2");
    expect(moved.changes[0]!.dependents).toEqual([{ member: "app", outputs: ["vpcId"] }]);
    expect(planned).toEqual([["app"]]);
    expect(decided).toEqual(["pr-apply-replan: planned again after an upstream output changed: network applied at 0123456789ab with vpcId changed, read by app"]);
    expect(moved.planned).toMatchObject({ gate: "pr-apply-replan", digest: "jcs1-sha256:app", components: ["app"], approval: { status: "pending" } });
  });
});

describe("a stack's secret outputs (chant#5345)", () => {
  test("the outputs stack output printed as [secret] are the marked ones", () => {
    expect(pulumiSecretOutputNames({ vpcId: "v", dbPassword: "[secret]", token: "[secret]" })).toEqual(["dbPassword", "token"]);
  });
});

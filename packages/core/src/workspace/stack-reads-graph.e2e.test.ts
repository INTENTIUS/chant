/**
 * `chant workspace graph` over two Pulumi members and a reference to a stack
 * no member applies (#5331), through the pulumi lexicon installed in this
 * checkout. The exports are shaped as `pulumi stack export` writes a
 * `StackReference`; no engine runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, scratchDir } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";

const TIMEOUT = 240_000;

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-stackref-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  cleanScratch();
});

const stackResource = (stack: string) => ({ urn: `urn:pulumi:${stack}::x::pulumi:pulumi:Stack::x-${stack}`, type: "pulumi:pulumi:Stack" });
const reference = (name: string, outputs: Record<string, unknown>) => ({
  urn: `urn:pulumi:prod::app::pulumi:pulumi:StackReference::${name}`,
  type: "pulumi:pulumi:StackReference",
  inputs: { name },
  outputs: { name, outputs, secretOutputNames: [] },
});

function member(root: string, dir: string, project: string, resources: unknown[]): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "Pulumi.yaml"), `name: ${project}\nruntime: nodejs\n`);
  writeFileSync(join(root, dir, "stack-export.json"), JSON.stringify({ version: 3, deployment: { resources: [stackResource("prod"), ...resources] } }));
}

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("workspace graph: StackReference edges between Pulumi members (#5331)", () => {
  test(
    "an edge to the member that applies the stack, naming the output, and an external node for the stack no member applies",
    async () => {
      const root = scratchDir("chant-stackref-fx-");
      member(root, "network", "network", []);
      member(root, "app", "app", [reference("network/prod", { vpcId: "vpc-1" }), reference("acme/billing/prod", { queue: "q" })]);
      const { doc, failed } = await workspaceGraph({ cwd: root, discover: true, noCache: true });
      const g = result(doc);
      expect(failed).toBe(false);

      const stacks = g.nodes.filter((n) => n.kind === "pulumi:pulumi:Stack");
      expect(stacks.map((n) => n.id)).toEqual(["app/pulumi:pulumi:Stack", "external:acme/billing/prod", "network/pulumi:pulumi:Stack"]);
      expect(stacks.find((n) => n.id === "external:acme/billing/prod")).toMatchObject({ member: "app", attrs: { external: true, stack: "acme/billing/prod" } });
      expect(stacks.find((n) => n.id === "network/pulumi:pulumi:Stack")!.attrs.external).toBeUndefined();

      const reads = g.edges.filter((e) => e.from === "app/pulumi:pulumi:Stack");
      expect(reads).toEqual([
        { from: "app/pulumi:pulumi:Stack", to: "external:acme/billing/prod", kind: "ref", viaAttr: "queue", origin: "declared", member: "app" },
        { from: "app/pulumi:pulumi:Stack", to: "network/pulumi:pulumi:Stack", kind: "ref", viaAttr: "vpcId", origin: "declared", member: "app" },
      ]);
      expect(reads.every((e) => e.grain === undefined)).toBe(true);
    },
    TIMEOUT,
  );
});

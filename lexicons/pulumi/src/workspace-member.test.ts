/**
 * The pulumi member kind's graph block (#3179): the reader project the kind's
 * graph config describes, run through chant graph over a checked-in
 * `pulumi stack export`. The kind moved here from the terraform lexicon
 * (#4453); the node ids are the ones it gave there. Nothing here runs Pulumi.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { GraphIR } from "@intentius/chant/graph-ir";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { readPackageKinds, substituteGraphConfig } from "../../../packages/core/src/workspace/kinds";
import { pulumiPlugin } from "./plugin";
import { readPulumiMember } from "./workspace-member";

const packageDir = join(import.meta.dirname, "..");
const member = join(import.meta.dirname, "testdata", "pulumi-member");

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function graphOf(dir: string): Promise<{ ir: GraphIR; err: string[]; exit: number }> {
  const graph = readPackageKinds(packageDir).kinds.find((k) => k.name === "pulumi")!.graph!;
  expect(graph.lexicon).toBe("pulumi");
  const config = substituteGraphConfig(graph.config, { member: "infra", dir, workspace: dirname(dir) });
  const project = await mkdtemp(join(tmpdir(), "chant-pulumi-member-"));
  scratch.push(project);
  await writeFile(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["pulumi"], pulumi: config, graph: { lint: "report" } }));
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const exit = await runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [pulumiPlugin], serializers: [] });
    return { ir: exit === 0 ? (JSON.parse(out.join("\n")) as GraphIR) : { nodes: [], edges: [], groups: {} }, err, exit };
  } finally {
    process.chdir(cwd);
  }
}

describe("pulumi member graph block (#3179)", () => {
  test("the export's resources are nodes; provider resources and the root stack are left out", async () => {
    const { ir, err, exit } = await graphOf(member);
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes.map((n) => [n.id, n.kind]).sort()).toEqual([
      ["infra/aws:iam/role:Role::web", "aws:iam/role:Role"],
      ["infra/aws:iam/rolePolicy:RolePolicy::webReadsAssets", "aws:iam/rolePolicy:RolePolicy"],
      ["infra/aws:s3/bucket:Bucket::assets", "aws:s3/bucket:Bucket"],
      ["infra/my:mod:Web$aws:lambda/function:Function::handler", "aws:lambda/function:Function"],
      ["infra/my:mod:Web::web-app", "my:mod:Web"],
    ]);
    expect(ir.meta?.pulumiMember).toEqual({ export: "stack-export.json", objects: 5, exported: true });
  });

  const recordedEdges = [
    "aws:iam/rolePolicy:RolePolicy::webReadsAssets -> aws:iam/role:Role::web via dependencies",
    "aws:iam/rolePolicy:RolePolicy::webReadsAssets -> aws:s3/bucket:Bucket::assets via dependencies",
    "my:mod:Web$aws:lambda/function:Function::handler -> aws:iam/role:Role::web via dependencies",
    "my:mod:Web$aws:lambda/function:Function::handler -> my:mod:Web::web-app via parent",
  ];
  const edgesOf = (ir: GraphIR) => ir.edges.map((e) => `${e.from.slice(6)} -> ${e.to.slice(6)} via ${e.viaAttr}`).sort();

  test("dependencies and parent are edges; the root stack is not", async () => {
    const { ir } = await graphOf(member);
    expect(edgesOf(ir)).toEqual(recordedEdges);
  });

  test("a dependency outside the export is not an edge", async () => {
    // A real export never names a dependency it does not hold, so the case is
    // built from a copy of the recorded one (#4507).
    const doc = JSON.parse(await readFile(join(member, "stack-export.json"), "utf-8")) as {
      deployment: { resources: { urn: string; dependencies?: string[] }[] };
    };
    const policy = doc.deployment.resources.find((r) => r.urn.endsWith("::webReadsAssets"))!;
    policy.dependencies = [...(policy.dependencies ?? []), "urn:pulumi:dev::app::aws:s3/bucket:Bucket::elsewhere"];
    const dir = await mkdtemp(join(tmpdir(), "chant-pulumi-dangling-"));
    scratch.push(dir);
    await writeFile(join(dir, "stack-export.json"), JSON.stringify(doc));
    const { ir, err, exit } = await graphOf(dir);
    expect(exit, err.join("\n")).toBe(0);
    expect(edgesOf(ir)).toEqual(recordedEdges);
  });

  test("inputs are not copied into the graph", async () => {
    const { ir } = await graphOf(member);
    expect(JSON.stringify(ir)).not.toContain("ciphertext");
  });

  test("a program with no export has no nodes, and the member says why", async () => {
    const { ir, err, exit } = await graphOf(join(import.meta.dirname, "testdata", "pulumi-unexported"));
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes).toEqual([]);
    const report = ir.meta?.pulumiMember as { exported: boolean; reason: string };
    expect(report.exported).toBe(false);
    expect(report.reason).toMatch(/pulumi stack export/);
    expect(err.join("\n")).toMatch(/was not read/);
  });

  test("an export with pending operations says how many, and one without leaves the count out (#4468)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chant-pulumi-pending-"));
    scratch.push(dir);
    await writeFile(
      join(dir, "stack-export.json"),
      JSON.stringify({
        version: 3,
        deployment: {
          resources: [{ urn: "urn:pulumi:dev::app::aws:s3/bucket:Bucket::assets", type: "aws:s3/bucket:Bucket" }],
          pending_operations: [{ type: "creating", resource: { urn: "urn:pulumi:dev::app::aws:s3/bucket:Bucket::logs" } }],
        },
      }),
    );
    expect(readPulumiMember({ member: { dir, label: "infra" } }).report).toEqual({
      export: "stack-export.json",
      objects: 1,
      exported: true,
      pendingOperations: 1,
    });
    expect(readPulumiMember({ member: { dir: member, label: "infra" } }).report.pendingOperations).toBeUndefined();
  });
});

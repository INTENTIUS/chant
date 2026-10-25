/**
 * The pulumi member kind's graph block (#3179): the reader project the kind's
 * graph config describes, run through chant graph over a checked-in
 * `pulumi stack export`. Nothing here runs Pulumi.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { GraphIR } from "@intentius/chant/graph-ir";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { readPackageKinds, substituteGraphConfig } from "../../../packages/core/src/workspace/kinds";
import { terraformPlugin } from "./plugin";

const packageDir = join(import.meta.dirname, "..");
const member = join(import.meta.dirname, "testdata", "pulumi-member");

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function graphOf(dir: string): Promise<{ ir: GraphIR; err: string[]; exit: number }> {
  const graph = readPackageKinds(packageDir).kinds.find((k) => k.name === "pulumi")!.graph!;
  expect(graph.lexicon).toBe("terraform");
  const config = substituteGraphConfig(graph.config, { member: "infra", dir, workspace: dirname(dir) });
  const project = await mkdtemp(join(tmpdir(), "chant-pulumi-member-"));
  scratch.push(project);
  await writeFile(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: config, graph: { lint: "report" } }));
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const exit = await runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [terraformPlugin], serializers: [] });
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

  test("dependencies and parent are edges; a dependency outside the export, or the root stack, is not", async () => {
    const { ir } = await graphOf(member);
    const edges = ir.edges.map((e) => `${e.from.slice(6)} -> ${e.to.slice(6)} via ${e.viaAttr}`).sort();
    expect(edges).toEqual([
      "aws:iam/rolePolicy:RolePolicy::webReadsAssets -> aws:iam/role:Role::web via dependencies",
      "aws:iam/rolePolicy:RolePolicy::webReadsAssets -> aws:s3/bucket:Bucket::assets via dependencies",
      "my:mod:Web$aws:lambda/function:Function::handler -> aws:iam/role:Role::web via dependencies",
      "my:mod:Web$aws:lambda/function:Function::handler -> my:mod:Web::web-app via parent",
    ]);
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
});

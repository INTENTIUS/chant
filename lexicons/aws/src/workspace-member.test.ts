/**
 * The cloudformation member kind's graph block (#3179): the reader project the
 * kind's graph config describes, run through chant graph over a fixture
 * template. Nothing here calls AWS.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { GraphIR } from "@intentius/chant/graph-ir";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { readPackageKinds, substituteGraphConfig } from "../../../packages/core/src/workspace/kinds";
import { awsPlugin } from "./plugin";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const member = join(here, "testdata", "cfn-member");

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function graphOf(dir: string, kind = "cloudformation"): Promise<{ ir: GraphIR; err: string[]; exit: number }> {
  const graph = readPackageKinds(packageDir).kinds.find((k) => k.name === kind)!.graph!;
  expect(graph.lexicon).toBe("aws");
  const config = substituteGraphConfig(graph.config, { member: "net", dir, workspace: dirname(dir) });
  const project = await mkdtemp(join(tmpdir(), "chant-cfn-member-"));
  scratch.push(project);
  await writeFile(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["aws"], aws: config, graph: { lint: "report" } }));
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const exit = await runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [awsPlugin], serializers: [] });
    return { ir: exit === 0 ? (JSON.parse(out.join("\n")) as GraphIR) : { nodes: [], edges: [], groups: {} }, err, exit };
  } finally {
    process.chdir(cwd);
  }
}

describe("cloudformation member graph block (#3179)", () => {
  test("a template's resources are nodes", async () => {
    const { ir, err, exit } = await graphOf(member);
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes.map((n) => [n.id, n.kind]).sort()).toEqual([
      ["net/Assets", "AWS::S3::Bucket"],
      ["net/Db", "AWS::RDS::DBInstance"],
      ["net/WebPolicy", "AWS::IAM::Policy"],
      ["net/WebRole", "AWS::IAM::Role"],
    ]);
    expect(ir.meta?.awsMember).toEqual({ templates: ["stack.yaml"], objects: 4 });
  });

  test("Ref, GetAtt, Sub and DependsOn are edges; parameters and pseudo parameters are not", async () => {
    const { ir } = await graphOf(member);
    const edges = ir.edges.map((e) => `${e.from} -> ${e.to} via ${e.viaAttr}${e.toAttr ? ` (${e.toAttr})` : ""}`).sort();
    expect(edges).toEqual([
      "net/Db -> net/Assets via Tags (DomainName)",
      "net/Db -> net/WebRole via DependsOn",
      "net/WebPolicy -> net/Assets via PolicyDocument (Arn)",
      "net/WebPolicy -> net/WebRole via Roles",
    ]);
  });
});

describe("cdk member graph block (#3179)", () => {
  test("the synthesized assembly's templates are read; the app is not run", async () => {
    const { ir, err, exit } = await graphOf(join(here, "testdata", "cdk-member"), "cdk");
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["net/HandlerGHI789", "net/HandlerRoleDEF456", "net/QueueABC123"]);
    expect(ir.edges.map((e) => `${e.from} -> ${e.to} via ${e.viaAttr}`).sort()).toEqual([
      "net/HandlerGHI789 -> net/HandlerRoleDEF456 via DependsOn",
      "net/HandlerGHI789 -> net/HandlerRoleDEF456 via Role",
      "net/HandlerGHI789 -> net/QueueABC123 via Environment",
    ]);
    expect(ir.meta?.awsMember).toEqual({ templates: ["AppStack.template.json"], objects: 3, synthesized: true });
  });

  test("an app with no assembly says synthesized: false and what to run", async () => {
    const { ir, err, exit } = await graphOf(join(here, "testdata", "cdk-unsynthesized"), "cdk");
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes).toEqual([]);
    const report = ir.meta?.awsMember as { synthesized: boolean; reason: string };
    expect(report.synthesized).toBe(false);
    expect(report.reason).toMatch(/cdk synth/);
    expect(err.join("\n")).toMatch(/was not read/);
  });
});

/**
 * The helm-chart member kind's graph block (#3179). The test builds the reader
 * project the way chant workspace graph does (the kind's graph config,
 * placeholders substituted, written to a chant.config.json) and runs chant
 * graph over it. The render is a canned runner, so no test needs helm; the last
 * test uses the real binary when one is installed.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { GraphIR } from "@intentius/chant/graph-ir";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { readPackageKinds, substituteGraphConfig } from "../../../packages/core/src/workspace/kinds";
import { helmPlugin } from "./plugin";
import { helmTemplateArgs, readHelmMember, setLastMemberReport, type HelmMemberConfig, type HelmRunner } from "./workspace-member";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const chart = join(here, "testdata", "web-chart");

const RENDERED = `---
# Source: web/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-chart
spec:
  replicas: 2
---
# Source: web/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web-chart
spec:
  ports:
    - port: 80
`;

const noBinary: HelmRunner = async () => {
  throw Object.assign(new Error("spawn helm ENOENT"), { code: "ENOENT" });
};

function pluginWith(run?: HelmRunner): LexiconPlugin {
  if (!run) return helmPlugin;
  return {
    ...helmPlugin,
    buildRoots: async (ctx) => {
      const member = (ctx.config as { helm?: { member?: HelmMemberConfig } }).helm?.member;
      setLastMemberReport(undefined);
      if (!member) return { entities: new Map() };
      const read = await readHelmMember({ member, run });
      setLastMemberReport(read.report);
      return { entities: read.entities, warnings: read.warnings };
    },
  };
}

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function graphOf(plugin: LexiconPlugin): Promise<{ ir: GraphIR; err: string[]; exit: number }> {
  const graph = readPackageKinds(packageDir).kinds.find((k) => k.name === "helm-chart")!.graph!;
  expect(graph.lexicon).toBe("helm");
  const config = substituteGraphConfig(graph.config, { member: "web", dir: chart, workspace: dirname(chart) });
  const project = await mkdtemp(join(tmpdir(), "chant-helm-member-"));
  scratch.push(project);
  await writeFile(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["helm"], helm: config, graph: { lint: "report" } }));
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    const exit = await runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [plugin], serializers: [] });
    return { ir: exit === 0 ? (JSON.parse(out.join("\n")) as GraphIR) : { nodes: [], edges: [], groups: {} }, err, exit };
  } finally {
    process.chdir(cwd);
  }
}

describe("helm-chart member graph block (#3179)", () => {
  test("renders the chart and draws its objects", async () => {
    let argv: string[] = [];
    const { ir, err, exit } = await graphOf(
      pluginWith(async (args) => {
        argv = args;
        return { stdout: RENDERED };
      }),
    );
    expect(exit, err.join("\n")).toBe(0);
    expect(argv).toEqual(helmTemplateArgs(chart));
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["web/deploymentWebChart", "web/serviceWebChart"]);
    expect(ir.meta?.helmMember).toEqual({ rendered: true, objects: 2 });
  });

  test("with no helm binary the member says rendered: false and why", async () => {
    const { ir, err, exit } = await graphOf(pluginWith(noBinary));
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes).toEqual([]);
    const report = ir.meta?.helmMember as { rendered: boolean; reason: string };
    expect(report.rendered).toBe(false);
    expect(report.reason).toMatch(/`helm` binary was not found/);
    expect(err.join("\n")).toMatch(/was not rendered/);
  });

  test("a render helm refused still fails", async () => {
    const { exit, err } = await graphOf(
      pluginWith(async () => {
        throw new Error("Error: parse error in templates/deployment.yaml");
      }),
    );
    expect(exit).not.toBe(0);
    expect(err.join("\n")).toMatch(/parse error/);
  });

  const haveHelm = (() => {
    try {
      execFileSync("helm", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test.skipIf(!haveHelm)("the real helm binary renders the chart", async () => {
    const { ir, err, exit } = await graphOf(pluginWith());
    expect(exit, err.join("\n")).toBe(0);
    expect((ir.meta?.helmMember as { rendered: boolean }).rendered).toBe(true);
    expect(ir.nodes.map((n) => n.id)).toEqual(["web/deploymentWebChart"]);
  });
});

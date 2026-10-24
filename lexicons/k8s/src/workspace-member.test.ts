/**
 * The graph blocks of the kustomize, argo-app and flux-kustomization member
 * kinds (#3179). Each test builds the reader project the way chant workspace
 * graph does (the kind's graph config, placeholders substituted, written to a
 * chant.config.json) and runs chant graph over it.
 *
 * The kustomize render is a canned runner, so no test needs kustomize or
 * kubectl; the last test uses the real binary when one is installed.
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
import type { KustomizeRunner } from "./kustomize/render";
import { k8sPlugin } from "./plugin";
import { readK8sMember, setLastMemberReport, type K8sMemberConfig } from "./workspace-member";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const members = join(here, "testdata", "workspace-members");
const overlay = join(here, "testdata", "kustomize-root", "overlays", "prod");

const RENDERED = `apiVersion: v1
kind: Service
metadata:
  name: prod-web
spec:
  ports:
    - port: 80
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prod-web
spec:
  replicas: 3
`;

const noBinary: KustomizeRunner = async () => {
  throw new Error("spawn kustomize ENOENT: command not found");
};

/** The k8s plugin with the member's kustomize render swapped for `run`. */
function pluginWith(run?: KustomizeRunner): LexiconPlugin {
  if (!run) return k8sPlugin;
  return {
    ...k8sPlugin,
    buildRoots: async (ctx) => {
      const member = (ctx.config as { k8s?: { member?: K8sMemberConfig } }).k8s?.member;
      setLastMemberReport(undefined);
      if (!member) return { entities: new Map() };
      const read = await readK8sMember({ member, run });
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

/** chant graph over the reader project the kind's graph block describes for a member at `dir`. */
async function graphOf(kind: string, dir: string, plugin: LexiconPlugin): Promise<{ ir: GraphIR; err: string[]; exit: number }> {
  const graph = readPackageKinds(packageDir).kinds.find((k) => k.name === kind)!.graph!;
  expect(graph.lexicon).toBe("k8s");
  const config = substituteGraphConfig(graph.config, { member: "m", dir, workspace: dirname(dir) });
  const project = await mkdtemp(join(tmpdir(), "chant-k8s-member-"));
  scratch.push(project);
  await writeFile(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["k8s"], k8s: config, graph: { lint: "report" } }));
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

const ids = (ir: GraphIR) => ir.nodes.map((n) => n.id).sort();

describe("member kinds with a graph block (#3179)", () => {
  test("kustomize: the rendered objects are the member's nodes", async () => {
    const { ir, err, exit } = await graphOf("kustomize", overlay, pluginWith(async () => ({ stdout: RENDERED })));
    expect(exit, err.join("\n")).toBe(0);
    expect(ids(ir)).toEqual(["m/deploymentProdWeb", "m/serviceProdWeb"]);
    expect(ir.meta?.k8sMember).toEqual({ kind: "kustomize", rendered: true, objects: 2 });
  });

  test("kustomize: with no binary the member says rendered: false and why", async () => {
    const { ir, err, exit } = await graphOf("kustomize", overlay, pluginWith(noBinary));
    expect(exit, err.join("\n")).toBe(0);
    expect(ir.nodes).toEqual([]);
    const report = ir.meta?.k8sMember as { rendered: boolean; reason: string; objects: number };
    expect(report.rendered).toBe(false);
    expect(report.objects).toBe(0);
    expect(report.reason).toMatch(/neither the `kustomize` binary nor `kubectl`/);
    expect(err.join("\n")).toMatch(/was not rendered/);
  });

  test("kustomize: a render the binary refused still fails", async () => {
    const refused: KustomizeRunner = async () => {
      throw new Error("Error: accumulating resources: missing base");
    };
    const { exit, err } = await graphOf("kustomize", overlay, pluginWith(refused));
    expect(exit).not.toBe(0);
    expect(err.join("\n")).toMatch(/missing base/);
  });

  test("argo-app: the Applications are nodes and other manifests beside them are left out", async () => {
    const { ir, err, exit } = await graphOf("argo-app", join(members, "argo"), pluginWith());
    expect(exit, err.join("\n")).toBe(0);
    expect(ids(ir)).toEqual(["m/applicationGuestbook", "m/applicationPayments"]);
    expect(ir.meta?.k8sMember).toEqual({ kind: "argo-app", objects: 2 });
  });

  test("flux-kustomization: the Flux Kustomization is a node, the kustomize one beside it is not", async () => {
    const { ir, err, exit } = await graphOf("flux-kustomization", join(members, "flux"), pluginWith());
    expect(exit, err.join("\n")).toBe(0);
    expect(ids(ir)).toEqual(["m/kustomizationApps"]);
  });

  const haveBinary = (() => {
    for (const bin of ["kustomize", "kubectl"]) {
      try {
        execFileSync(bin, ["version", "--client"], { stdio: "ignore" });
        return true;
      } catch {
        /* not installed */
      }
    }
    return false;
  })();

  test.skipIf(!haveBinary)("kustomize: the real binary renders the overlay", async () => {
    const { ir, err, exit } = await graphOf("kustomize", overlay, pluginWith());
    expect(exit, err.join("\n")).toBe(0);
    expect((ir.meta?.k8sMember as { rendered: boolean }).rendered).toBe(true);
    expect(ir.nodes.length).toBeGreaterThan(0);
  });
});

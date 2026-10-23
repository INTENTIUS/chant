/**
 * `chant search` over a `k8s.kustomize.roots` project (chant #4365): the
 * rendered objects are build-root entities, so search must merge them the way
 * `chant graph` does, and give them the ids `chant graph --format ir` prints.
 *
 * The render goes through the real hook's helper with a canned runner, the
 * same output `root.test.ts` pins, so the test needs neither kustomize nor
 * kubectl.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { GraphIR } from "@intentius/chant/graph-ir";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { runSearch, type SearchJson } from "@intentius/chant/cli/handlers/search";
import { renderKustomizeRoots } from "./root";
import { k8sPlugin } from "../plugin";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "testdata", "kustomize-root");

const RENDERED = `apiVersion: v1
kind: Service
metadata:
  name: prod-web
spec:
  ports:
    - port: 80
  selector:
    app: web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prod-web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
`;

/** The k8s plugin, with its kustomize render swapped for the canned output. */
const plugin: LexiconPlugin = {
  ...k8sPlugin,
  buildRoots: async (ctx) => {
    const roots = (ctx.config as { k8s?: { kustomize?: { roots?: string[] } } }).k8s?.kustomize?.roots ?? [];
    return renderKustomizeRoots({ projectRoot: ctx.projectRoot, roots, run: async () => ({ stdout: RENDERED }) });
  },
};

let project: string;

async function inProject(run: () => Promise<number>): Promise<{ exit: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(project);
  try {
    return { exit: await run(), out, err };
  } finally {
    process.chdir(cwd);
    vi.restoreAllMocks();
  }
}

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "chant-kustomize-search-"));
  await cp(fixtureRoot, project, { recursive: true });
  await writeFile(
    join(project, "chant.config.json"),
    JSON.stringify({ lexicons: ["k8s"], k8s: { kustomize: { roots: ["overlays/prod"] } } }),
  );
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("search over a k8s.kustomize.roots project (#4365)", () => {
  test("a kind query returns the rendered objects under graph --format ir's ids", async () => {
    const graphRun = await inProject(() =>
      runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [plugin], serializers: [] }),
    );
    expect(graphRun.exit, graphRun.err.join("\n")).toBe(0);
    const graph = JSON.parse(graphRun.out.join("\n")) as GraphIR;
    const drawn = graph.nodes.filter((n) => n.kind?.startsWith("K8s::")).map((n) => n.id).sort();
    expect(drawn).toEqual(["overlays/prod/deploymentProdWeb", "overlays/prod/serviceProdWeb"]);

    const searchRun = await inProject(() =>
      runSearch({ args: { path: "kind:K8s::", json: true } as never, plugins: [plugin], serializers: [] }),
    );
    expect(searchRun.exit, searchRun.err.join("\n")).toBe(0);
    const json = JSON.parse(searchRun.out.join("\n")) as SearchJson;
    expect(json.matches.map((m) => m.id).sort()).toEqual(drawn);
  });
});

/**
 * The cluster join end to end (#5101): `chant workspace graph --discover`
 * over a directory with Argo CD manifests and Terraform, read through the
 * terraform and k8s lexicons installed in this checkout. Each fixture is a
 * plain directory in a scratch location, so nothing writes into this
 * repository's git directory.
 */

import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, REPO, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";

const TIMEOUT = 240_000;
const { expectValid } = contract(schema);

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-cluster-join-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  cleanScratch();
});

const CLUSTERS = `apiVersion: v1
kind: Secret
metadata:
  name: cluster-prod
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
stringData:
  name: prod
  server: https://10.0.0.1
`;
const APP = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: web
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://example.com/repo.git
    path: web
  destination:
    name: prod
    namespace: web
`;
const cluster = (name: string) => `resource "google_container_cluster" "main" {\n  name     = "${name}"\n  location = "us-central1"\n}\n`;

const SECRET = "argo/argo/secretClusterProd";
const APPLICATION = "argo/argo/applicationWeb";
const REGISTERS = "k8s:K8s::Core::Secret:argoCluster.name";
const DESTINATION = "k8s:K8s::Argo::Application:spec.destination.name";

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

async function read(files: Record<string, string>, runsOn?: Record<string, string>) {
  const root = scratchDir("chant-cluster-join-fx-");
  writeFiles(root, files);
  const g = result((await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true, ...(runsOn ? { runsOn } : {}) })).doc);
  expectValid(g);
  const registers = (x: { rule?: string }) => x.rule === REGISTERS;
  return {
    edges: g.edges.map((e) => `${e.from} > ${e.to} ${e.origin}${e.rule ? ` ${e.rule}` : ""}`),
    registerDangling: (g.dangling ?? []).filter(registers).map((d) => d.value),
    registerAmbiguous: (g.ambiguous ?? []).filter(registers),
  };
}

describe("the cluster join (#5101)", () => {
  test(
    "an Application joins its Secret, and the Secret joins a cluster of its name",
    async () => {
      const { edges, registerDangling } = await read({ "argo/clusters.yaml": CLUSTERS, "argo/app.yaml": APP, "tf/main.tf": cluster("prod") });
      expect(edges).toEqual([`${APPLICATION} > ${SECRET} derived ${DESTINATION}`, `${SECRET} > tf/tf/google_container_cluster.main derived ${REGISTERS}`]);
      expect(registerDangling).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a renamed cluster draws no edge, and the Secret's name is dangling",
    async () => {
      const { edges, registerDangling } = await read({ "argo/clusters.yaml": CLUSTERS, "argo/app.yaml": APP, "tf/main.tf": cluster("prod-gke") });
      expect(edges).toEqual([`${APPLICATION} > ${SECRET} derived ${DESTINATION}`]);
      expect(registerDangling).toEqual(["prod"]);
    },
    TIMEOUT,
  );

  test(
    "--runs-on draws a declared edge from the Secret to the cluster, and the Secret is no longer dangling",
    async () => {
      const { edges, registerDangling } = await read({ "argo/clusters.yaml": CLUSTERS, "argo/app.yaml": APP, "tf/main.tf": cluster("prod-gke") }, { argo: "tf/google_container_cluster.main" });
      expect(edges).toEqual([`${APPLICATION} > ${SECRET} derived ${DESTINATION}`, `${SECRET} > tf/tf/google_container_cluster.main declared`]);
      expect(registerDangling).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "two clusters of one name in two roots draw no edge, and are recorded as ambiguous",
    async () => {
      const { edges, registerAmbiguous, registerDangling } = await read({ "argo/clusters.yaml": CLUSTERS, "argo/app.yaml": APP, "a/main.tf": cluster("prod"), "b/main.tf": cluster("prod") });
      expect(edges).toEqual([`${APPLICATION} > ${SECRET} derived ${DESTINATION}`]);
      expect(registerAmbiguous).toEqual([expect.objectContaining({ from: SECRET, value: "prod", candidates: ["a/a/google_container_cluster.main", "b/b/google_container_cluster.main"] })]);
      expect(registerDangling).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a declaration's runsOn does the same, and the document carries no credential",
    async () => {
      const root = scratchDir("chant-cluster-join-decl-");
      // A declared member kind comes from a pinned package; the checkout's own lexicons and chant serve here.
      const pin = (lexicon: string) => ({ package: `@intentius/chant-lexicon-${lexicon}`, version: JSON.parse(readFileSync(join(REPO, "lexicons", lexicon, "package.json"), "utf-8")).version as string });
      writeFiles(root, {
        "chant.workspace.json": JSON.stringify({
          name: "fx",
          schema: 1,
          pins: [pin("k8s"), pin("terraform")],
          members: [
            { name: "argo", dir: "argo", kind: "argo-app", runsOn: "tf/google_container_cluster.main" },
            { name: "tf", dir: "tf", kind: "terraform" },
          ],
        }),
        "argo/clusters.yaml": `${CLUSTERS}  config: '{"bearerToken": "not-a-real-token"}'\n`,
        "argo/app.yaml": APP,
        "tf/main.tf": cluster("prod-gke"),
      });
      symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
      const g = result((await workspaceGraph({ cwd: root, noCache: false, catalog: true, args: { detail: 3 } as never })).doc);
      expect(g.edges.filter((e) => e.origin === "declared").map((e) => `${e.from} > ${e.to}`)).toEqual([`${SECRET} > tf/tf/google_container_cluster.main`]);
      expect(JSON.stringify(g)).not.toContain("not-a-real-token");
    },
    TIMEOUT,
  );
});

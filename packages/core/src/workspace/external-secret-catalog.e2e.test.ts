/**
 * An ExternalSecret to its store and to the cloud secret, through
 * `chant workspace graph --discover` end to end (#5098): a manifests member
 * `k8s` and a terraform member `tf`, read through the k8s and terraform
 * lexicons installed in this checkout.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { CACHE_DIR_ENV } from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";

const TIMEOUT = 240_000;

let cacheBefore: string | undefined;
beforeAll(() => {
  cacheBefore = process.env[CACHE_DIR_ENV];
  process.env[CACHE_DIR_ENV] = scratchDir("chant-es-cache-");
});
afterAll(() => {
  if (cacheBefore === undefined) delete process.env[CACHE_DIR_ENV];
  else process.env[CACHE_DIR_ENV] = cacheBefore;
  cleanScratch();
});

const store = (kind: string, namespace?: string) =>
  `apiVersion: external-secrets.io/v1\nkind: ${kind}\nmetadata:\n  name: gcp\n${namespace ? `  namespace: ${namespace}\n` : ""}spec:\n  provider:\n    gcpsm:\n      projectID: demo-proj\n`;

const externalSecret = (name: string, key: string) =>
  `apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nmetadata:\n  name: ${name}\n  namespace: app\nspec:\n  secretStoreRef:\n    kind: ClusterSecretStore\n    name: gcp\n  target:\n    name: ${name}\n  data:\n    - secretKey: token\n      remoteRef:\n        key: ${key}\n`;

const FX = {
  "k8s/stores.yaml": `${store("ClusterSecretStore")}---\n${store("SecretStore", "elsewhere")}`,
  "k8s/app-creds.yaml": externalSecret("app-creds", "app-token"),
  "k8s/app-extra.yaml": externalSecret("app-extra", "other-token"),
  "tf/main.tf": [
    'resource "google_secret_manager_secret" "token" {',
    '  secret_id = "app-token"',
    '  project   = "demo-proj"',
    "  replication {\n    auto {}\n  }",
    "}",
    "",
    'variable "name" {}',
    "",
    'resource "google_secret_manager_secret" "named" {',
    "  secret_id = var.name",
    '  project   = "demo-proj"',
    "  replication {\n    auto {}\n  }",
    "}",
    "",
  ].join("\n"),
};

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("workspace graph: ExternalSecret rules (#5098)", () => {
  test(
    "draws the edges to the store and the cloud secret, and reports a key no secret has and an argument it could not read",
    async () => {
      const root = scratchDir("chant-es-fx-");
      writeFiles(root, FX);
      const { doc, failed } = await workspaceGraph({ cwd: root, discover: true, noCache: false, catalog: true });
      const g = result(doc);
      expect(failed).toBe(false);

      const es = g.nodes.filter((n) => n.kind === "K8s::ExternalSecrets::ExternalSecret").map((n) => n.id);
      expect(es).toHaveLength(2);
      const creds = es.find((id) => id.endsWith("AppCreds"))!;
      const extra = es.find((id) => id.endsWith("AppExtra"))!;
      const clusterStore = g.nodes.find((n) => n.kind === "K8s::ExternalSecrets::ClusterSecretStore")!.id;
      const secret = g.nodes.find((n) => n.id.endsWith("/google_secret_manager_secret.token"))!.id;
      const named = g.nodes.find((n) => n.id.endsWith("/google_secret_manager_secret.named"))!.id;

      const derived = g.edges.filter((e) => e.origin === "derived" && e.rule?.includes("ExternalSecret"));
      // Reads from the store, then the secret: app-creds, and app-extra's store only.
      expect(derived.map((e) => `${e.from} -> ${e.to} [${e.viaAttr}]`).sort()).toEqual(
        [
          `${creds} -> ${clusterStore} [secretStoreRef]`,
          `${creds} -> ${secret} [remoteRef.key via gcp]`,
          `${extra} -> ${clusterStore} [secretStoreRef]`,
        ].sort(),
      );
      // The SecretStore of that name in another namespace is joined to nothing.
      const namespaced = g.nodes.find((n) => n.kind === "K8s::ExternalSecrets::SecretStore")!.id;
      expect(g.edges.filter((e) => e.to === namespaced && e.relation === "reference")).toEqual([]);

      const dangling = (g.dangling ?? []).filter((d) => d.rule?.includes("remoteRef.key"));
      expect(dangling).toEqual([
        expect.objectContaining({ from: extra, value: "other-token", through: clusterStore, targetKind: "google_secret_manager_secret" }),
      ]);
      expect(g.catalog?.nonLiteral?.[named]).toBe(1);
    },
    TIMEOUT,
  );
});

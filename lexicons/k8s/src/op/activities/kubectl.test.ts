/**
 * `kubectlApply` over the typed API client (chant #1074, #1075).
 *
 * The activity contract is what Temporal workers register, so the shape of the
 * arguments and the `Promise<void>` return are asserted alongside the new
 * behavior. Nothing here spawns a process or reads an ambient kubeconfig,
 * which is the acceptance criterion: a worker image needs no `kubectl` binary.
 *
 * chant #1075 adds two things to assert: that the field manager is derived
 * from the project's `ownership.stack` rather than hardcoded, and that the
 * ownership-scoped prune the shelled `kubectl apply --prune` used to do is
 * still exactly as narrow now that it runs here.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, kubectlApply, readManifestDocuments, resolveFieldManager } from "./kubectl";
import { fakeCluster, objectKey, ownedObject } from "../../api/fake-cluster";
import { statusBody } from "@intentius/chant-k8s-client/testing";
import type { RecordedRequest } from "@intentius/chant-k8s-client/testing";

let dir: string;

const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: prod
spec:
  replicas: 3
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: prod
spec:
  ports:
    - port: 80
`;

/** Echo an applied object back, the way an API server does. */
const echoApplies = (req: RecordedRequest): { body: unknown } | undefined =>
  req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined;

/** A project directory whose config sets an ownership stack. */
function projectWithStack(stack: string, extra: Record<string, unknown> = {}): string {
  const project = join(dir, `project-${stack}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "chant.config.json"),
    JSON.stringify({ lexicons: ["k8s"], ownership: { stack, ...extra } }),
  );
  return project;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-k8s-apply-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readManifestDocuments", () => {
  test("splits a multi-document file, dropping empty documents", () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, `${deploymentYaml}---\n---\n`);
    const docs = readManifestDocuments(file);
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service"]);
  });

  test("a directory is read in sorted file order, as `kubectl apply -f <dir>` does", () => {
    writeFileSync(join(dir, "20-service.yaml"), "apiVersion: v1\nkind: Service\nmetadata:\n  name: b\n");
    writeFileSync(join(dir, "10-deployment.yaml"), "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a\n");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const docs = readManifestDocuments(dir);
    expect(docs.map((d) => d.kind)).toEqual(["Deployment", "Service"]);
  });

  test("JSON manifests are read too", () => {
    const file = join(dir, "k8s.json");
    writeFileSync(file, JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c" } }));
    expect(readManifestDocuments(file).map((d) => d.kind)).toEqual(["ConfigMap"]);
  });
});

describe("the field manager chant applies as (chant #1075)", () => {
  test("no ownership stack in the project → the unqualified chant", async () => {
    const project = join(dir, "no-config");
    mkdirSync(project);
    expect(await resolveFieldManager({ manifest: "x", cwd: project })).toBe("chant");
  });

  test("an ownership stack qualifies it, from the same config the label marker reads", async () => {
    expect(await resolveFieldManager({ manifest: "x", cwd: projectWithStack("web") })).toBe("chant:web");
  });

  test("ownership disabled falls back to the unqualified chant, as the label marker does", async () => {
    const project = projectWithStack("web", { enabled: false });
    expect(await resolveFieldManager({ manifest: "x", cwd: project })).toBe("chant");
  });

  test("an explicit field manager wins over the config", async () => {
    const project = projectWithStack("web");
    expect(await resolveFieldManager({ manifest: "x", cwd: project, fieldManager: "chant-op" })).toBe("chant-op");
  });

  test("an explicit stack wins over the config and skips reading it", async () => {
    const project = projectWithStack("web");
    expect(await resolveFieldManager({ manifest: "x", cwd: project, stack: "other" })).toBe("chant:other");
  });
});

describe("kubectlApply", () => {
  test("server-side applies every document, in file order, as the chant field manager", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });

    await kubectlApply({ manifest: file, cwd: projectWithStack("web") }, undefined, cluster.connector);

    const patches = cluster.layer.requests.filter((r) => r.method === "PATCH");
    expect(patches.map((p) => p.path)).toEqual([
      "/apis/apps/v1/namespaces/prod/deployments/web",
      "/api/v1/namespaces/prod/services/web-svc",
    ]);
    for (const patch of patches) {
      expect(patch.headers["Content-Type"]).toBe("application/apply-patch+yaml");
      expect(patch.query).toMatchObject({ fieldManager: "chant:web", force: "false" });
    }
  });

  test("the apply stamps its resolved stack onto every document's labels — the identity the prune and the status sweep query", async () => {
    // The serializer bakes the PROJECT stack (`ownership.stack`) into what it
    // emits, but a component's kubectl-apply step applies under its own unit
    // stack — and that is what both label readers select on. A manifest with
    // the project label (or none at all: upstream CRDs) must leave the apply
    // carrying the unit's identity, or the unit reads absent forever.
    const file = join(dir, "k8s.yaml");
    const labeled = deploymentYaml.replace(
      "  name: web\n  namespace: prod\n",
      "  name: web\n  namespace: prod\n  labels:\n    app.kubernetes.io/managed-by: chant\n    chant.intentius.io/stack: whole-project\n    chant.intentius.io/env: dev\n",
    );
    writeFileSync(file, labeled);
    const cluster = fakeCluster({ respond: echoApplies });

    await applyManifest({ manifest: file, stack: "kmv-workload" }, undefined, cluster.connector);

    const bodies = cluster.layer.requests
      .filter((r) => r.method === "PATCH")
      .map((r) => JSON.parse(String(r.body)) as { metadata?: { labels?: Record<string, string> } });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.metadata?.labels).toMatchObject({
        "app.kubernetes.io/managed-by": "chant",
        "chant.intentius.io/stack": "kmv-workload",
      });
    }
    // The env label is the serializer's channel — restamped never, kept as-is.
    expect(bodies[0].metadata?.labels?.["chant.intentius.io/env"]).toBe("dev");
    // The previously-unlabeled Service now carries the marker too.
    expect(bodies[1].metadata?.labels?.["chant.intentius.io/env"]).toBeUndefined();
  });

  test("a conflict owned entirely by chant's own managers is retaken with force — the stack-label migration path", async () => {
    // An estate applied before its components named per-unit stacks has every
    // object's labels owned by `chant:<ownership.stack>`. The re-stamp under
    // the unit's manager conflicts — with chant itself. Refusing that forever
    // would strand the estate with no non-force path (the capability exposes
    // no force flag), so chant retakes its OWN fields, once, per document.
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    let patches = 0;
    const cluster = fakeCluster({
      respond: (req) => {
        if (req.method !== "PATCH") return undefined;
        patches++;
        const forced = req.query.force === "true";
        if (forced) return { body: JSON.parse(String(req.body)) };
        return {
          status: 409,
          body: {
            ...statusBody(409, "Conflict", 'Apply failed with 1 conflict: conflict with "chant:kubemicrovm-ops"'),
            details: {
              causes: [
                {
                  type: "FieldManagerConflict",
                  message: 'conflict with "chant:kubemicrovm-ops"',
                  field: ".metadata.labels.chant.intentius.io/stack",
                },
              ],
            },
          },
        };
      },
    });

    const result = await applyManifest({ manifest: file, stack: "kmv-workload" }, undefined, cluster.connector);
    expect(result.applied).toHaveLength(2);
    // Each of the two documents: one refused apply + one forced retake.
    expect(patches).toBe(4);
    const requests = cluster.layer.requests.filter((r) => r.method === "PATCH");
    expect(requests.map((r) => r.query.force)).toEqual(["false", "true", "false", "true"]);
  });

  test("a conflict involving any FOREIGN manager still refuses — self-retake never widens", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) =>
        req.method === "PATCH"
          ? {
              status: 409,
              body: {
                ...statusBody(409, "Conflict", "Apply failed with 2 conflicts"),
                details: {
                  causes: [
                    { type: "FieldManagerConflict", message: 'conflict with "chant:old"', field: ".metadata.labels.chant.intentius.io/stack" },
                    { type: "FieldManagerConflict", message: 'conflict with "helm"', field: ".spec.replicas" },
                  ],
                },
              },
            }
          : undefined,
    });

    const err = (await applyManifest({ manifest: file, stack: "kmv-workload" }, undefined, cluster.connector).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.name).toBe("FieldManagerConflictError");
    // No forced retry was attempted.
    expect(cluster.layer.requests.filter((r) => r.method === "PATCH" && r.query.force === "true")).toHaveLength(0);
  });

  test("no resolvable stack applies the documents verbatim — no marker invented", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });

    // No stack arg, no project config: identity resolution yields none.
    await applyManifest({ manifest: file, cwd: dir }, undefined, cluster.connector);

    const body = JSON.parse(
      String(cluster.layer.requests.find((r) => r.method === "PATCH")!.body),
    ) as { metadata?: { labels?: Record<string, string> } };
    expect(body.metadata?.labels).toBeUndefined();
  });

  test("an explicit context is honored and skips the environment lookup entirely", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });

    await kubectlApply({ manifest: file, context: "test-context" }, undefined, cluster.connector);

    expect(cluster.connects[0]).toMatchObject({ context: "test-context" });
    expect(cluster.connects[0].environment).toBeUndefined();
  });

  test("an environment is passed through so the cluster binding applies to the write path too", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });

    await kubectlApply({ manifest: file, environment: "prod" }, undefined, cluster.connector);
    expect(cluster.connects[0]).toMatchObject({ environment: "prod" });
  });

  test("force is forwarded, for the caller that means to take ownership", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });

    await kubectlApply({ manifest: file, force: true, fieldManager: "chant-op" }, undefined, cluster.connector);
    const patch = cluster.layer.requests.find((r) => r.method === "PATCH")!;
    expect(patch.query).toMatchObject({ force: "true", fieldManager: "chant-op" });
  });

  test("force is off unless asked for — chant never resolves a conflict by itself", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });

    await kubectlApply({ manifest: file }, undefined, cluster.connector);
    for (const patch of cluster.layer.requests.filter((r) => r.method === "PATCH")) {
      expect(patch.query.force).toBe("false");
    }
  });

  test("a field-ownership conflict surfaces as a presented error, not a raw 409", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({
      respond: (req) =>
        req.method === "PATCH"
          ? {
              status: 409,
              body: {
                ...statusBody(409, "Conflict", 'Apply failed with 1 conflict: conflict with "kubectl" using apps/v1'),
                details: {
                  causes: [
                    {
                      type: "FieldManagerConflict",
                      message: 'conflict with "kubectl" using apps/v1',
                      field: ".spec.replicas",
                    },
                  ],
                },
              },
            }
          : undefined,
    });

    const err = (await kubectlApply({ manifest: file, stack: "web" }, undefined, cluster.connector).catch(
      (e: unknown) => e,
    )) as Error & { statusCode?: number; byManager?: Record<string, string[]>; fieldManager?: string };

    expect(err.name).toBe("FieldManagerConflictError");
    expect(err.statusCode).toBe(409);
    expect(err.byManager).toEqual({ kubectl: [".spec.replicas"] });
    expect(err.fieldManager).toBe("chant:web");
    expect(err.message).toContain("apps/v1 Deployment prod/web");
    expect(err.message).toContain(".spec.replicas");
    expect(err.message).toContain("chant does not force this for you");
  });

  test("resolves to undefined, keeping the activity's Promise<void> contract", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c\n  namespace: prod\n");
    const cluster = fakeCluster({ respond: echoApplies });
    await expect(kubectlApply({ manifest: file }, undefined, cluster.connector)).resolves.toBeUndefined();
  });

  test("applyManifest reports what it did, which is what nativeApply relays", async () => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(file, deploymentYaml);
    const cluster = fakeCluster({ respond: echoApplies });
    const result = await applyManifest({ manifest: file, stack: "web" }, undefined, cluster.connector);
    expect(result.fieldManager).toBe("chant:web");
    expect(result.applied).toEqual([
      { apiVersion: "apps/v1", kind: "Deployment", name: "web", namespace: "prod" },
      { apiVersion: "v1", kind: "Service", name: "web-svc", namespace: "prod" },
    ]);
    expect(result.pruned).toEqual([]);
  });
});

describe("the ownership-scoped prune (chant #1075)", () => {
  const manifest = (): string => {
    const file = join(dir, "k8s.yaml");
    writeFileSync(
      file,
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: prod\n",
    );
    return file;
  };

  /** A cluster holding one chant-owned orphan, one foreign object, and the declared one. */
  const clusterWithOrphans = () =>
    fakeCluster({
      respond: echoApplies,
      objects: {
        [objectKey("apps/v1", "Deployment", "old", "prod")]: ownedObject("apps/v1", "Deployment", "old", "prod"),
        [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod"),
        [objectKey("apps/v1", "Deployment", "handmade", "prod")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "handmade", namespace: "prod", labels: { app: "handmade" } },
        },
        [objectKey("apps/v1", "Deployment", "elsewhere", "staging")]: ownedObject(
          "apps/v1",
          "Deployment",
          "elsewhere",
          "staging",
        ),
      },
    });

  test("deleteMode never deletes nothing, and issues no DELETE at all", async () => {
    const cluster = clusterWithOrphans();
    const result = await applyManifest({ manifest: manifest() }, undefined, cluster.connector);
    expect(result.pruned).toEqual([]);
    expect(cluster.layer.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  test("owned-only deletes the chant-owned object the manifest no longer declares", async () => {
    const cluster = clusterWithOrphans();
    const result = await applyManifest(
      { manifest: manifest(), deleteMode: "owned-only" },
      undefined,
      cluster.connector,
    );
    expect(result.pruned).toEqual([
      { apiVersion: "apps/v1", kind: "Deployment", name: "old", namespace: "prod" },
    ]);
    expect(cluster.layer.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
      "/apis/apps/v1/namespaces/prod/deployments/old",
    ]);
  });

  test("gated prunes exactly as owned-only does — the gate is the composite's business", async () => {
    const cluster = clusterWithOrphans();
    const result = await applyManifest({ manifest: manifest(), deleteMode: "gated" }, undefined, cluster.connector);
    expect(result.pruned.map((p) => p.name)).toEqual(["old"]);
  });

  test("an object without chant's marker is never a candidate", async () => {
    const cluster = clusterWithOrphans();
    await applyManifest({ manifest: manifest(), deleteMode: "owned-only" }, undefined, cluster.connector);
    const deleted = cluster.layer.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deleted.some((p) => p.includes("handmade"))).toBe(false);
  });

  test("the object the manifest still declares is not pruned after being applied", async () => {
    const cluster = clusterWithOrphans();
    await applyManifest({ manifest: manifest(), deleteMode: "owned-only" }, undefined, cluster.connector);
    const deleted = cluster.layer.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deleted.some((p) => p.endsWith("/deployments/web"))).toBe(false);
  });

  test("a namespace the manifest never mentions is not swept", async () => {
    const cluster = clusterWithOrphans();
    await applyManifest({ manifest: manifest(), deleteMode: "owned-only" }, undefined, cluster.connector);
    const listed = cluster.layer.requests.filter((r) => r.method === "GET").map((r) => r.path);
    expect(listed.some((p) => p.includes("/namespaces/staging/"))).toBe(false);
  });

  test("the sweep is sent to the server as a marker selector, stack-scoped when one is configured", async () => {
    const cluster = clusterWithOrphans();
    await applyManifest(
      { manifest: manifest(), deleteMode: "owned-only", stack: "web" },
      undefined,
      cluster.connector,
    );
    const sweeps = cluster.layer.requests.filter((r) => r.query.labelSelector !== undefined);
    expect(sweeps.length).toBeGreaterThan(0);
    for (const sweep of sweeps) {
      expect(sweep.query.labelSelector).toBe(
        "app.kubernetes.io/managed-by=chant,chant.intentius.io/stack=web",
      );
    }
  });

  test("with no stack configured the selector is the marker alone, as the shelled prune's was", async () => {
    const cluster = clusterWithOrphans();
    const project = join(dir, "no-ownership");
    mkdirSync(project);
    await applyManifest(
      { manifest: manifest(), deleteMode: "owned-only", cwd: project },
      undefined,
      cluster.connector,
    );
    const sweep = cluster.layer.requests.find((r) => r.query.labelSelector !== undefined)!;
    expect(sweep.query.labelSelector).toBe("app.kubernetes.io/managed-by=chant");
  });

  test("a kind removed from source entirely is still swept, via the default sweep set", async () => {
    // Nothing in the manifest is a Service, yet a chant-owned Service must not
    // survive being deleted from source. This is why the sweep is the union of
    // the applied kinds and the default set rather than the applied kinds alone.
    const cluster = fakeCluster({
      respond: echoApplies,
      objects: {
        [objectKey("v1", "Service", "gone", "prod")]: ownedObject("v1", "Service", "gone", "prod"),
      },
    });
    const result = await applyManifest(
      { manifest: manifest(), deleteMode: "owned-only" },
      undefined,
      cluster.connector,
    );
    expect(result.pruned).toEqual([{ apiVersion: "v1", kind: "Service", name: "gone", namespace: "prod" }]);
  });

  test("a kind the cluster does not serve is skipped, not fatal", async () => {
    const cluster = fakeCluster({
      respond: echoApplies,
      // Only these two kinds exist here; every other sweep 404s on discovery.
      serves: ["K8s::Apps::Deployment", "K8s::Core::Service"],
      objects: {
        [objectKey("apps/v1", "Deployment", "old", "prod")]: ownedObject("apps/v1", "Deployment", "old", "prod"),
      },
    });
    const result = await applyManifest(
      { manifest: manifest(), deleteMode: "owned-only" },
      undefined,
      cluster.connector,
    );
    expect(result.pruned.map((p) => p.name)).toEqual(["old"]);
  });

  test("a manifest that names no namespace does not become a cluster-wide sweep", async () => {
    // Whether a kind is namespaced comes from the cluster's discovery, not from
    // whether the document happened to name a namespace. Getting that wrong is
    // the one way this could reach outside the namespace being applied to.
    const file = join(dir, "no-namespace.yaml");
    writeFileSync(file, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n");
    const cluster = fakeCluster({
      respond: echoApplies,
      objects: {
        [objectKey("apps/v1", "Deployment", "elsewhere", "staging")]: ownedObject(
          "apps/v1",
          "Deployment",
          "elsewhere",
          "staging",
        ),
      },
    });

    const result = await applyManifest({ manifest: file, deleteMode: "owned-only" }, undefined, cluster.connector);

    expect(result.pruned).toEqual([]);
    const sweeps = cluster.layer.requests.filter((r) => r.query.labelSelector !== undefined).map((r) => r.path);
    // Namespaced kinds are swept in the context's default namespace, never
    // across the cluster.
    expect(sweeps).toContain("/apis/apps/v1/namespaces/default/deployments");
    expect(sweeps).not.toContain("/apis/apps/v1/deployments");
  });

  test("an object already terminating is left alone", async () => {
    const terminating = ownedObject("apps/v1", "Deployment", "old", "prod");
    terminating.metadata!.deletionTimestamp = "2026-07-20T10:00:00Z";
    const cluster = fakeCluster({
      respond: echoApplies,
      objects: { [objectKey("apps/v1", "Deployment", "old", "prod")]: terminating },
    });
    const result = await applyManifest(
      { manifest: manifest(), deleteMode: "owned-only" },
      undefined,
      cluster.connector,
    );
    expect(result.pruned).toEqual([]);
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCluster, objectKey } from "@intentius/chant-lexicon-k8s/api/fake-cluster";

import type { HelmCapabilityProfile } from "./config";
import {
  diffRenderLive,
  diffRenders,
  documentKey,
  renderDiffIsEmpty,
  resolveDocumentNamespace,
} from "./render-diff";
import { persistHelmRender } from "./render-store";
import type { RenderManifest } from "./render-store";

/**
 * Render diffing (#1249 offline, #1250 live — epic #1228 Phase 6).
 *
 * The offline half resolves two content digests already in a fresh store —
 * no cluster, no helm binary, purely the stored-vs-stored path. The live
 * half drives the real `diffRenderLive` against a render persisted through
 * the real `persistHelmRender` (so the document index, byte offsets and
 * digests are exactly what the store would hold) and a fake k8s cluster at
 * the API edge — the same seam `deep-observe.test.ts` (#1247) uses for the
 * release-scoped read.
 */

const PROFILE: HelmCapabilityProfile = {
  name: "prod",
  kubeVersion: "1.33.6",
  apiVersions: ["batch/v1"],
};

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "chant-helm-render-diff-"));
}

function persist(root: string, rendered: string, overrides?: Partial<Parameters<typeof persistHelmRender>[0]>) {
  return persistHelmRender({
    rendered,
    releaseName: "rel",
    chart: "tiny",
    chartVersion: "0.1.0",
    namespace: "web",
    capabilityProfile: PROFILE,
    root,
    ...overrides,
  });
}

const BASE = [
  "---",
  "# Source: tiny/templates/configmap.yaml",
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: tiny-config",
  "  namespace: web",
  "data:",
  "  zeta: last",
  "  alpha: first",
  "---",
  "# Source: tiny/templates/serviceaccount.yaml",
  "apiVersion: v1",
  "kind: ServiceAccount",
  "metadata:",
  "  name: tiny-sa",
  "  namespace: web",
  "",
].join("\n");

describe("diffRenders", () => {
  test("throws naming the missing digest when either side was never persisted", () => {
    const root = freshRoot();
    const { manifest } = persist(root, BASE);
    expect(() => diffRenders(manifest.contentDigest, `sha256:${"0".repeat(64)}`, { root })).toThrow(
      /no stored render for sha256:0{64}/,
    );
    expect(() => diffRenders(`sha256:${"0".repeat(64)}`, manifest.contentDigest, { root })).toThrow(
      /no stored render for sha256:0{64}/,
    );
  });

  test("two identical renders diff to nothing", () => {
    const root = freshRoot();
    const { manifest: a } = persist(root, BASE);
    const { manifest: b } = persist(root, BASE, { namespace: "web", releaseName: "rel" });
    expect(a.contentDigest).toBe(b.contentDigest);

    const diff = diffRenders(a.contentDigest, b.contentDigest, { root });
    expect(renderDiffIsEmpty(diff)).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
    expect(diff.unindexed).toEqual({ from: 0, to: 0 });
  });

  test("reports a field-level change inside a document whose bytes differ", () => {
    const root = freshRoot();
    const { manifest: from } = persist(root, BASE);
    const bumped = BASE.replace("  zeta: last", "  zeta: LAST-BUMPED").replace(
      "  alpha: first",
      "  alpha: first\n  gamma: new",
    );
    const { manifest: to } = persist(root, bumped);
    expect(from.contentDigest).not.toBe(to.contentDigest);

    const diff = diffRenders(from.contentDigest, to.contentDigest, { root });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    const [cm] = diff.changed;
    expect(cm.kind).toBe("ConfigMap");
    expect(cm.name).toBe("tiny-config");
    expect(cm.namespace).toBe("web");
    expect(cm.beforeDigest).not.toBe(cm.afterDigest);

    const byPath = Object.fromEntries(cm.changes.map((c) => [c.path, c]));
    expect(byPath["data.zeta"]).toEqual({ path: "data.zeta", kind: "changed", before: "last", after: "LAST-BUMPED" });
    expect(byPath["data.gamma"]).toEqual({ path: "data.gamma", kind: "added", after: "new" });

    // The untouched ServiceAccount document is unchanged, not re-diffed.
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unchanged[0].kind).toBe("ServiceAccount");
  });

  test("reports a document present on only one side as added or removed", () => {
    const root = freshRoot();
    const { manifest: from } = persist(root, BASE);
    const withExtra =
      BASE +
      ["---", "# Source: tiny/templates/secret.yaml", "apiVersion: v1", "kind: Secret", "metadata:", "  name: tiny-secret", "  namespace: web", ""].join(
        "\n",
      );
    const { manifest: to } = persist(root, withExtra);

    const diff = diffRenders(from.contentDigest, to.contentDigest, { root });
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]).toMatchObject({ kind: "Secret", name: "tiny-secret", namespace: "web" });

    // Reversed direction: the same document reports as removed.
    const reverse = diffRenders(to.contentDigest, from.contentDigest, { root });
    expect(reverse.added).toEqual([]);
    expect(reverse.removed).toHaveLength(1);
    expect(reverse.removed[0]).toMatchObject({ kind: "Secret", name: "tiny-secret", namespace: "web" });
  });

  test("matches duplicate documents positionally within their identity group", () => {
    const root = freshRoot();
    const crd = [
      "---",
      "# Source: tiny/crds/widgets.yaml",
      "apiVersion: apiextensions.k8s.io/v1",
      "kind: CustomResourceDefinition",
      "metadata:",
      "  name: widgets.example.com",
      "spec:",
      "  group: example.com",
    ].join("\n");
    const oneCopy = crd + "\n";
    const twoCopies = crd + "\n" + crd + "\n";

    const { manifest: from } = persist(root, oneCopy, { chart: "tiny-one" });
    const { manifest: to } = persist(root, twoCopies, { chart: "tiny-two" });

    const diff = diffRenders(from.contentDigest, to.contentDigest, { root });
    // One matched pair (identical bytes -> unchanged), one surplus -> added.
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].kind).toBe("CustomResourceDefinition");
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("counts unindexed documents on each side without dropping them silently", () => {
    const root = freshRoot();
    const withJunk = BASE + "---\nnot: an object with kind or name\n";
    const { manifest: from } = persist(root, BASE);
    const { manifest: to } = persist(root, withJunk, { releaseName: "rel2" });

    const diff = diffRenders(from.contentDigest, to.contentDigest, { root });
    expect(diff.unindexed).toEqual({ from: 0, to: 1 });
  });

  test("carries chart/releaseName identity for both sides in the result header", () => {
    const root = freshRoot();
    const { manifest: from } = persist(root, BASE, { chart: "tiny", releaseName: "rel-a" });
    const { manifest: to } = persist(root, BASE.replace("last", "LAST"), { chart: "tiny", releaseName: "rel-b" });

    const diff = diffRenders(from.contentDigest, to.contentDigest, { root });
    expect(diff.from).toEqual({ contentDigest: from.contentDigest, chart: "tiny", releaseName: "rel-a" });
    expect(diff.to).toEqual({ contentDigest: to.contentDigest, chart: "tiny", releaseName: "rel-b" });
  });
});

const RENDERED = `---
# Source: tiny/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
---
# Source: tiny/templates/config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  key: value
---
# Source: tiny/templates/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: web-migrate
  annotations:
    helm.sh/hook: pre-install
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: migrate:1.0
---
# Source: tiny/templates/clusterrole.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: web-reader
rules: []
`;

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-helm-render-diff-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function persistFixture(root: string): RenderManifest {
  const { manifest } = persistHelmRender({
    rendered: RENDERED,
    releaseName: "web",
    chart: "tiny",
    namespace: "shop",
    capabilityProfile: { name: "test-profile", kubeVersion: "1.33.0", apiVersions: [] },
    root,
  });
  return manifest;
}

describe("resolveDocumentNamespace / documentKey (pure helpers)", () => {
  test("a namespace-silent namespaced kind defaults to the render's target namespace", () => {
    expect(resolveDocumentNamespace("ConfigMap", null, "shop")).toBe("shop");
    expect(documentKey("ConfigMap", "shop", "web-config")).toBe("ConfigMap/shop/web-config");
  });

  test("a namespace-silent cluster-scoped kind is never defaulted", () => {
    expect(resolveDocumentNamespace("ClusterRole", null, "shop")).toBeUndefined();
    expect(documentKey("ClusterRole", undefined, "web-reader")).toBe("cluster:ClusterRole/web-reader");
  });

  test("an explicit document namespace always wins over the render's target namespace", () => {
    expect(resolveDocumentNamespace("Deployment", "other-ns", "shop")).toBe("other-ns");
  });
});

describe("diffRenderLive (#1250)", () => {
  test("no such digest in the store — refused, never a false clean diff", async () => {
    const root = tmpRoot();
    const outcome = await diffRenderLive({ contentDigest: `sha256:${"0".repeat(64)}`, environment: "prod", root });
    expect(outcome.found).toBe(false);
  });

  test("every document in the render becomes a live-diff row, hook resources included — a hook is just another rendered document", async () => {
    const root = tmpRoot();
    const manifest = persistFixture(root);

    const cluster = fakeCluster({
      objects: {
        [objectKey("apps/v1", "Deployment", "web", "shop")]: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "web", namespace: "shop" },
          // Live has drifted from the pinned render — 3 replicas, not 2.
          spec: { replicas: 3 },
        },
        [objectKey("v1", "ConfigMap", "web-config", "shop")]: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "web-config", namespace: "shop" },
          data: { key: "value" },
        },
        [objectKey("batch/v1", "Job", "web-migrate", "shop")]: {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name: "web-migrate", namespace: "shop", annotations: { "helm.sh/hook": "pre-install" } },
          // The hook resource's image drifted too — reachable only because
          // the render's document index carries hook docs like any other.
          spec: { template: { spec: { containers: [{ name: "migrate", image: "migrate:2.0" }] } } },
        },
        [objectKey("rbac.authorization.k8s.io/v1", "ClusterRole", "web-reader")]: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "ClusterRole",
          metadata: { name: "web-reader" },
          rules: [],
        },
      },
    });

    const outcome = await diffRenderLive(
      { contentDigest: manifest.contentDigest, environment: "prod", root },
      { connect: cluster.connector },
    );
    expect(outcome.found).toBe(true);
    if (!outcome.found) return;

    const byName = Object.fromEntries(outcome.diff.drifted.map((e) => [e.name, e]));
    expect(byName["Deployment/shop/web"]).toBeDefined();
    expect(byName["Deployment/shop/web"].changes.some((c) => c.path === "spec.replicas")).toBe(true);

    // Hook resource: reported exactly like a non-hook document.
    expect(byName["Job/shop/web-migrate"]).toBeDefined();

    // Namespace-silent document defaulted to the render's namespace and matched clean.
    expect(outcome.diff.unchanged).toContain("ConfigMap/shop/web-config");
    // Cluster-scoped document never gets a namespace and matched clean.
    expect(outcome.diff.unchanged).toContain("cluster:ClusterRole/web-reader");

    // The read is identity-scoped (exactly the render's own documents, by
    // kind/namespace/name) rather than a cluster sweep — same as the
    // release-scoped deep read (#1247) — so there is never anything for
    // `undeclaredEntities` to report here.
    expect(outcome.diff.undeclaredEntities).toEqual([]);
  });

  test("a document the live cluster never got is neither drift nor a hole — the thin read owns existence, not this one", async () => {
    const root = tmpRoot();
    const manifest = persistFixture(root);
    // Cluster has nothing at all — every render document is simply absent live.
    const cluster = fakeCluster();

    const outcome = await diffRenderLive(
      { contentDigest: manifest.contentDigest, environment: "prod", root },
      { connect: cluster.connector },
    );
    expect(outcome.found).toBe(true);
    if (!outcome.found) return;
    expect(outcome.diff.drifted).toEqual([]);
    expect(outcome.diff.unchanged).toEqual([]);
    expect(outcome.diff.unobserved).toEqual([]);
  });
});

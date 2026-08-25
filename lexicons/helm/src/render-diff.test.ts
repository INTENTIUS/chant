import { describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistHelmRender } from "./render-store";
import type { HelmCapabilityProfile } from "./config";
import { diffRenders, renderDiffIsEmpty } from "./render-diff";

/**
 * Render-to-render offline diff (#1249, epic #1228 Phase 6). Every test
 * resolves two content digests already in a fresh store — no cluster, no
 * helm binary, purely the stored-vs-stored path.
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

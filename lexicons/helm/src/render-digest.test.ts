import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalizeRender,
  helmContentDigest,
  helmInputDigest,
  renderStability,
} from "./render-digest";
import { helmInstallInputDigest } from "./op/activities/helm";
import type { HelmRenderRecord } from "./render";

const RENDERED = `---
# Source: tiny-chart/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: rel-tiny
spec:
  selector:
    app: rel
  ports:
  - port: 80
---
# Source: tiny-chart/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rel-tiny
spec:
  replicas: 1
`;

describe("canonicalizeRender", () => {
  test("mapping key order is normalized; two key orders canonicalize identically", () => {
    const a = "---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  x: \"1\"\n";
    const b = "---\nkind: ConfigMap\ndata:\n  x: \"1\"\nmetadata:\n  name: cm\napiVersion: v1\n";
    expect(canonicalizeRender(a)).toBe(canonicalizeRender(b));
  });

  test("sequence order is preserved — list order is meaningful to Kubernetes", () => {
    const a = "---\nkind: ConfigMap\napiVersion: v1\nitems:\n- one\n- two\n";
    const b = "---\nkind: ConfigMap\napiVersion: v1\nitems:\n- two\n- one\n";
    expect(canonicalizeRender(a)).not.toBe(canonicalizeRender(b));
  });

  test("document order is preserved, not sorted", () => {
    const svc = "# Source: c/templates/s.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: s\n";
    const dep = "# Source: c/templates/d.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\n";
    const ab = canonicalizeRender(`---\n${svc}---\n${dep}`);
    const ba = canonicalizeRender(`---\n${dep}---\n${svc}`);
    expect(ab).not.toBe(ba);
    // Same documents either way — only the order differs.
    expect(ab.split("---\n").sort()).toEqual(ba.split("---\n").sort());
  });

  test("duplicate documents are preserved, and the form is stable across calls", () => {
    const crd =
      "# Source: c/charts/kid/crds/kid.yaml\napiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\nmetadata:\n  name: kidthings.example.com\n";
    const doubled = `---\n${crd}---\n${crd}`;
    const canonical = canonicalizeRender(doubled);
    expect(canonical.match(/kidthings\.example\.com/g)?.length).toBe(2);
    expect(canonicalizeRender(doubled)).toBe(canonical);
  });

  test("render noise is normalized: CRLF, trailing whitespace, non-Source comments, empty documents", () => {
    const noisy =
      "---\r\n# Source: c/templates/cm.yaml\r\nkind: ConfigMap   \r\napiVersion: v1\r\n# helm inserted this remark\r\nmetadata:\r\n  name: cm  \r\n---\r\n# Source: c/templates/empty.yaml\r\n---\r\n";
    const clean =
      "---\n# Source: c/templates/cm.yaml\nkind: ConfigMap\napiVersion: v1\nmetadata:\n  name: cm\n";
    expect(canonicalizeRender(noisy)).toBe(canonicalizeRender(clean));
  });

  test("the # Source: header survives as the document's leading line", () => {
    const canonical = canonicalizeRender(RENDERED);
    expect(canonical).toContain("---\n# Source: tiny-chart/templates/service.yaml\napiVersion: v1\n");
    expect(canonical).toContain("---\n# Source: tiny-chart/templates/deployment.yaml\napiVersion: apps/v1\n");
  });
});

describe("helmContentDigest", () => {
  test("pinned against a hand-written canonical form — the cross-machine anchor", () => {
    const rendered = "---\n# Source: c/templates/cm.yaml\nkind: ConfigMap\ndata:\n  b: '2'\n  a: '1'\napiVersion: v1\nmetadata:\n  name: cm\n";
    // Independently derived: sorted keys, 2-space indent, one trailing
    // newline. Knowing the exact bytes without calling canonicalizeRender
    // makes this a non-circular reproducibility anchor: any machine, any
    // platform, must produce this digest for this input.
    const canonical =
      "---\n# Source: c/templates/cm.yaml\napiVersion: v1\ndata:\n  a: '1'\n  b: '2'\nkind: ConfigMap\nmetadata:\n  name: cm\n";
    expect(canonicalizeRender(rendered)).toBe(canonical);
    const expected = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    expect(helmContentDigest(rendered)).toBe(expected);
  });

  test("changes when the rendered content changes", () => {
    const one = RENDERED;
    const three = RENDERED.replace("replicas: 1", "replicas: 3");
    expect(helmContentDigest(one)).not.toBe(helmContentDigest(three));
  });

  test("full sha256: prefix, 64 hex characters", () => {
    expect(helmContentDigest(RENDERED)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("helmInputDigest", () => {
  test("agrees with helmInstallInputDigest (#1243) for the same inputs", () => {
    const values = { replicaCount: 3, image: { tag: "v1" } };
    const dir = mkdtempSync(join(tmpdir(), "chant-helm-digest-"));
    const valuesFile = join(dir, "values.yaml");
    writeFileSync(valuesFile, "replicaCount: 3\nimage:\n  tag: v1\n");

    const fromRenderSide = helmInputDigest({
      chart: "./chart",
      chartVersion: "1.2.3",
      values,
      capabilityProfile: { kubeVersion: "1.33.6", apiVersions: ["batch/v1", "apps/v1"] },
    });
    const fromDeploySide = helmInstallInputDigest({
      name: "web",
      chart: "./chart",
      chartVersion: "1.2.3",
      values: valuesFile,
      capabilityProfile: { kubeVersion: "1.33.6", apiVersions: ["apps/v1", "batch/v1"] },
    });
    expect(fromRenderSide).toBe(fromDeploySide);
  });

  test("the profile's facts join the digest; its name would not (the shape has no name field)", () => {
    const base = { chart: "./chart", chartVersion: "1.0.0", values: {} };
    const bare = helmInputDigest(base);
    const pinned = helmInputDigest({
      ...base,
      capabilityProfile: { kubeVersion: "1.33.6" },
    });
    expect(pinned).not.toBe(bare);
    expect(pinned).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

function record(overrides: Partial<HelmRenderRecord> & { name: string }): HelmRenderRecord {
  return { chart: "c", version: "1.0.0", ...overrides };
}

describe("renderStability", () => {
  test("same inputDigest, different contentDigest — flagged as unstable", () => {
    const report = renderStability([
      record({ name: "eso", inputDigest: "sha256:aa", contentDigest: "sha256:11" }),
      record({ name: "eso", inputDigest: "sha256:aa", contentDigest: "sha256:22" }),
    ]);
    expect(report.unstable).toEqual([
      { inputDigest: "sha256:aa", names: ["eso", "eso"], contentDigests: ["sha256:11", "sha256:22"] },
    ]);
    expect(report.stable).toEqual([]);
  });

  test("same inputDigest, same contentDigest — stable", () => {
    const report = renderStability([
      record({ name: "eso", inputDigest: "sha256:aa", contentDigest: "sha256:11" }),
      record({ name: "eso", inputDigest: "sha256:aa", contentDigest: "sha256:11" }),
    ]);
    expect(report.stable.length).toBe(1);
    expect(report.unstable).toEqual([]);
  });

  test("different names never group together — the release name is a real render input", () => {
    const report = renderStability([
      record({ name: "a", inputDigest: "sha256:aa", contentDigest: "sha256:11" }),
      record({ name: "b", inputDigest: "sha256:aa", contentDigest: "sha256:22" }),
    ]);
    expect(report.unstable).toEqual([]);
    expect(report.stable.length).toBe(2);
  });

  test("unpinned records (no digests) are unassessed, never stable by omission", () => {
    const report = renderStability([
      record({ name: "unpinned" }),
      record({ name: "eso", inputDigest: "sha256:aa", contentDigest: "sha256:11" }),
    ]);
    expect(report.unassessed).toEqual(["unpinned"]);
    expect(report.stable.length).toBe(1);
  });
});

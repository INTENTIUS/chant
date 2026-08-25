import { describe, test, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HelmCapabilityProfile } from "../../config";
import type { HelmRenderRecord } from "../../render";
import { persistHelmRender } from "../../render-store";
import { checkRenderRecordsForSecrets, whm503 } from "./whm503";

const PROFILE: HelmCapabilityProfile = {
  name: "prod",
  kubeVersion: "1.33.6",
  apiVersions: ["batch/v1"],
};

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "chant-whm503-"));
}

/** A `helm template`-shaped stream with one Secret document, `data` swapped by caller. */
function renderedWith(secretBody: string): string {
  return [
    "---",
    "# Source: tiny/templates/serviceaccount.yaml",
    "kind: ServiceAccount",
    "apiVersion: v1",
    "metadata:",
    "  name: tiny-sa",
    "---",
    "# Source: tiny/templates/secret.yaml",
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    "  name: tiny-secret",
    "  namespace: web",
    secretBody,
    "",
  ].join("\n");
}

function persist(root: string, rendered: string, name = "rel") {
  return persistHelmRender({
    rendered,
    releaseName: name,
    chart: "tiny",
    namespace: "web",
    capabilityProfile: PROFILE,
    root,
  });
}

describe("WHM503: pinned render carries Secret data", () => {
  test("flags a Secret with populated data", () => {
    const root = freshRoot();
    const { manifest } = persist(root, renderedWith("data:\n  password: c2VjcmV0"));
    const records: HelmRenderRecord[] = [{ name: "rel", chart: "tiny", contentDigest: manifest.contentDigest }];

    const diags = checkRenderRecordsForSecrets(records, { root });
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM503");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("web/tiny-secret");
    expect(diags[0].message).toContain("runtimeSlot()");
    expect(diags[0].message).toContain("HelmExternalSecret");
    expect(diags[0].entity).toBe("web/tiny-secret");
  });

  test("flags a Secret with populated stringData", () => {
    const root = freshRoot();
    const { manifest } = persist(root, renderedWith("stringData:\n  token: hunter2"));
    const records: HelmRenderRecord[] = [{ name: "rel", chart: "tiny", contentDigest: manifest.contentDigest }];

    const diags = checkRenderRecordsForSecrets(records, { root });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("web/tiny-secret");
  });

  test("passes when the Secret's data is empty", () => {
    const root = freshRoot();
    const { manifest } = persist(root, renderedWith("data: {}"));
    const records: HelmRenderRecord[] = [{ name: "rel", chart: "tiny", contentDigest: manifest.contentDigest }];

    expect(checkRenderRecordsForSecrets(records, { root })).toHaveLength(0);
  });

  test("passes when the render carries no Secret documents", () => {
    const root = freshRoot();
    const rendered = [
      "---",
      "# Source: tiny/templates/serviceaccount.yaml",
      "kind: ServiceAccount",
      "apiVersion: v1",
      "metadata:",
      "  name: tiny-sa",
      "",
    ].join("\n");
    const { manifest } = persist(root, rendered);
    const records: HelmRenderRecord[] = [{ name: "rel", chart: "tiny", contentDigest: manifest.contentDigest }];

    expect(checkRenderRecordsForSecrets(records, { root })).toHaveLength(0);
  });

  test("skips unpinned records (no contentDigest)", () => {
    const root = freshRoot();
    const records: HelmRenderRecord[] = [{ name: "rel", chart: "tiny" }];
    expect(checkRenderRecordsForSecrets(records, { root })).toHaveLength(0);
  });

  test("skips a record whose digest is not in the store", () => {
    const root = freshRoot();
    const records: HelmRenderRecord[] = [
      { name: "rel", chart: "tiny", contentDigest: "sha256:" + "0".repeat(64) },
    ];
    expect(checkRenderRecordsForSecrets(records, { root })).toHaveLength(0);
  });

  test("flags every offending Secret across multiple pinned renders", () => {
    const root = freshRoot();
    const first = persist(root, renderedWith("data:\n  password: c2VjcmV0"), "rel-a");
    const second = persist(root, renderedWith("data:\n  password: b3RoZXI="), "rel-b");
    const records: HelmRenderRecord[] = [
      { name: "rel-a", chart: "tiny", contentDigest: first.manifest.contentDigest },
      { name: "rel-b", chart: "tiny", contentDigest: second.manifest.contentDigest },
    ];

    expect(checkRenderRecordsForSecrets(records, { root })).toHaveLength(2);
  });

  test("the PostSynthCheck wrapper carries the WHM503 id and description", () => {
    expect(whm503.id).toBe("WHM503");
    expect(whm503.description).toContain("Secret");
  });
});

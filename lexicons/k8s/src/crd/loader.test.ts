import { describe, test, expect, afterAll } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadCRDs } from "./loader";

// A two-CRD bundle standing in for a multi-doc install.yaml.
const BUNDLE = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gitrepositories.source.toolkit.fluxcd.io
spec:
  group: source.toolkit.fluxcd.io
  names: { kind: GitRepository, plural: gitrepositories }
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object } }
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: externalartifacts.source.toolkit.fluxcd.io
spec:
  group: source.toolkit.fluxcd.io
  names: { kind: ExternalArtifact, plural: externalartifacts }
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema: { openAPIV3Schema: { type: object } }
`;

const dir = mkdtempSync(join(tmpdir(), "chant-crd-loader-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadCRDs kinds allowlist", () => {
  test("keeps only allowlisted kinds from a multi-doc bundle", async () => {
    const path = join(dir, "bundle.yaml");
    writeFileSync(path, BUNDLE);

    const kept = await loadCRDs({ type: "file", path, kinds: ["GitRepository"] });
    expect(kept.map((r) => r.gvk.kind)).toEqual(["GitRepository"]);
  });

  test("without a kinds filter, every CRD in the bundle is parsed", async () => {
    const path = join(dir, "bundle.yaml");
    writeFileSync(path, BUNDLE);

    const all = await loadCRDs({ type: "file", path });
    expect(all.map((r) => r.gvk.kind).sort()).toEqual(["ExternalArtifact", "GitRepository"]);
  });
});

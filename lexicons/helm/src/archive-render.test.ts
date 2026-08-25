/**
 * Tests `addArchiveHelmRender` (#1240, epic #1228 Phase 3) — folding a
 * pinned render into a build archive's manifest, and the media-type story
 * that lets an OCI referrer lookup classify signatures/provenance/SBOMs
 * attached to a render's digest exactly as it would for an image.
 */

import { describe, expect, it } from "vitest";

import {
  addArchiveEntry,
  createBuildArchiveManifest,
  findArchiveEntry,
  templateEntries,
} from "@intentius/chant/components/verbs/build-archive";
import { createOrasReferrerLookup } from "@intentius/chant/lifecycle/oras-referrer-lookup";
import type { ProcessRunner } from "@intentius/chant/components/verbs/process-runner";

import { addArchiveHelmRender, HELM_RENDER_MEDIA_TYPE } from "./archive-render";
import type { RenderManifest } from "./render-store";

const RENDER_CONTENT_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fixtureRenderManifest(overrides: Partial<RenderManifest> = {}): RenderManifest {
  return {
    version: 1,
    chart: "external-secrets",
    chartVersion: "0.10.4",
    repo: "https://charts.external-secrets.io",
    releaseName: "external-secrets",
    namespace: "external-secrets",
    valuesDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    inputDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    capabilityProfile: { cluster: "prod", kubeVersion: "1.29.0", apiVersions: [] },
    contentDigest: RENDER_CONTENT_DIGEST,
    docCount: 3,
    documents: [],
    renderedAt: "2026-01-01T00:00:00.000Z",
    helmVersion: "3.14.0",
    chantVersion: "0.46.0",
    sourceRef: null,
    ...overrides,
  };
}

describe("addArchiveHelmRender (#1240)", () => {
  it("folds the render into BuildArchiveManifest.contents as a template-kind entry with the render media type", () => {
    const render = fixtureRenderManifest();
    const { manifest, digest } = addArchiveHelmRender({
      path: "external-secrets.render.yaml",
      render,
    });

    expect(digest).toBe(RENDER_CONTENT_DIGEST);
    const entry = findArchiveEntry(manifest, "external-secrets.render.yaml");
    expect(entry).toMatchObject({
      kind: "template",
      path: "external-secrets.render.yaml",
      digest: RENDER_CONTENT_DIGEST,
      mediaType: HELM_RENDER_MEDIA_TYPE,
    });
    expect(templateEntries(manifest)).toHaveLength(1);
  });

  it("reuses the render's own contentDigest rather than recomputing one from bytes", () => {
    const render = fixtureRenderManifest({
      contentDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
    const { manifest } = addArchiveHelmRender({ path: "chart.render.yaml", render });
    expect(findArchiveEntry(manifest, "chart.render.yaml")?.digest).toBe(render.contentDigest);
  });

  it("the render rolls into manifestDigest — adding it changes the aggregate digest", () => {
    const empty = createBuildArchiveManifest("my-component");
    const { manifest } = addArchiveHelmRender({
      path: "chart.render.yaml",
      render: fixtureRenderManifest(),
      manifest: empty,
    });
    expect(manifest.manifestDigest).not.toBe(empty.manifestDigest);
  });

  it("accumulates onto a caller-supplied manifest alongside other archive entries", () => {
    const staged = addArchiveEntry(createBuildArchiveManifest("my-component"), {
      kind: "image",
      path: "app.tar",
      digest: "sha256:img1",
    });

    const { manifest } = addArchiveHelmRender({
      path: "chart.render.yaml",
      render: fixtureRenderManifest(),
      manifest: staged,
    });

    expect(manifest.contents.map((e) => e.kind).sort()).toEqual(["image", "template"]);
  });

  it("records provenance from an explicit sourceRef", () => {
    const { manifest } = addArchiveHelmRender({
      path: "chart.render.yaml",
      render: fixtureRenderManifest(),
      sourceRef: "abc123",
    });
    const entry = findArchiveEntry(manifest, "chart.render.yaml");
    expect(entry?.provenance).toEqual({ sourceRef: "abc123", artifactDigest: RENDER_CONTENT_DIGEST });
  });

  it("falls back to the render's own sourceRef when the caller omits one", () => {
    const { manifest } = addArchiveHelmRender({
      path: "chart.render.yaml",
      render: fixtureRenderManifest({ sourceRef: "deadbeef" }),
    });
    expect(findArchiveEntry(manifest, "chart.render.yaml")?.provenance).toEqual({
      sourceRef: "deadbeef",
      artifactDigest: RENDER_CONTENT_DIGEST,
    });
  });

  it("records no provenance when neither the caller nor the render supplies a sourceRef", () => {
    const { manifest } = addArchiveHelmRender({ path: "chart.render.yaml", render: fixtureRenderManifest() });
    expect(findArchiveEntry(manifest, "chart.render.yaml")?.provenance).toBeUndefined();
  });

  it("assigns the template-kind default reproducibility basis (deterministic-synthesis)", () => {
    const { manifest } = addArchiveHelmRender({ path: "chart.render.yaml", render: fixtureRenderManifest() });
    expect(findArchiveEntry(manifest, "chart.render.yaml")?.reproducibility).toEqual({
      basis: "deterministic-synthesis",
      verifyBy: "re-synth",
    });
  });
});

describe("a render's digest is classified by the referrer lookup exactly like an image's (#1240)", () => {
  const REPO = "123.dkr.ecr.us-east-1.amazonaws.com/external-secrets";

  function stubRunner(stdout: string): ProcessRunner {
    return {
      async run() {
        return { stdout, stderr: "" };
      },
      async available() {
        return true;
      },
    };
  }

  it("discovers and classifies an SBOM referrer attached to the render's own contentDigest", async () => {
    const render = fixtureRenderManifest();
    // The archive entry this referrer would attach to — its `kind: "template"` /
    // `HELM_RENDER_MEDIA_TYPE` never enter the lookup below, which discovers by digest alone.
    addArchiveHelmRender({ path: "chart.render.yaml", render });

    const runner = stubRunner(
      JSON.stringify({
        manifests: [
          {
            digest: "sha256:sbom1",
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            artifactType: "application/spdx+json",
          },
        ],
      }),
    );
    const lookup = createOrasReferrerLookup({ repo: REPO, runner });

    const referrers = await lookup.discover(render.contentDigest);

    expect(referrers).toEqual([
      { kind: "sbom", mediaType: "application/spdx+json", digest: "sha256:sbom1", location: `${REPO}@sha256:sbom1` },
    ]);
  });

  it("discovers a provenance and a signature referrer the same way, unaffected by the subject entry's own template kind/media type", async () => {
    const render = fixtureRenderManifest();
    const runner = stubRunner(
      JSON.stringify({
        manifests: [
          {
            digest: "sha256:prov1",
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            artifactType: "application/vnd.in-toto+json",
          },
          {
            digest: "sha256:sig1",
            mediaType: "application/vnd.dev.cosign.simplesigning.v1+json",
            artifactType: "application/vnd.dev.cosign.signature",
          },
        ],
      }),
    );
    const lookup = createOrasReferrerLookup({ repo: REPO, runner });

    const referrers = await lookup.discover(render.contentDigest);

    expect(referrers.map((r) => r.kind)).toEqual(["provenance", "signature"]);
  });
});

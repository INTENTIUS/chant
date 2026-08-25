/**
 * `addArchiveHelmRender` — fold a pinned render into a `BuildArchiveManifest`
 * (#1240, epic #1228 Phase 3).
 *
 * #1238 gave a pinned render durable, content-addressed storage
 * (./render-store.ts's `RenderManifest`, modeled on core's
 * `BuildArchiveManifest`). This module is the seam between the two: it folds
 * one render into a *build archive*'s manifest, the same self-contained
 * bundle `docker-build`/`addArchiveTemplate` write into
 * (packages/core/src/components/verbs/build-archive.ts), so a component that
 * composes a `HelmRender` alongside an image/template gets one archive that
 * carries all of it.
 *
 * A rendered chart is a template: it reuses `kind: "template"` rather than
 * adding a new `BuildArchiveEntryKind`. What distinguishes a render from a
 * synthesized CloudFormation/other IaC template is only its media type,
 * `HELM_RENDER_MEDIA_TYPE` — and that is enough. Core's
 * `lifecycle/oras-referrer-lookup.ts` classifies *referrers* (SBOM/
 * provenance/signature) by the referrer's own media type, keyed only by the
 * subject *digest* it discovers against — never by the subject entry's own
 * `kind`/`mediaType`. A render's digest is therefore attachable exactly like
 * an image's: `oras discover <repo>@<renderDigest>` finds the same
 * referrers a signing/attestation pipeline would attach to any other
 * artifact, with no change to that lookup needed (see
 * ./archive-render.test.ts for the referrer-classification proof).
 *
 * Mirrors `addArchiveTemplate` (packages/core/src/components/verbs/build.ts)
 * in every way that matters: a plain, pure function (not a registered
 * capability — rendering happens at chant's existing build/synth time, not
 * as a new deploy-time verb), accumulates onto a caller-supplied manifest so
 * a component's whole build phase shares one archive, and threads an
 * optional `sourceRef` into a `provenance` link (#614). It differs in one
 * respect: rather than recomputing a digest from raw content bytes (core's
 * `contentDigest`), it reuses the render's own `contentDigest` — the real
 * `sha256:` over the canonical rendered stream that `helmContentDigest`
 * already computed and `persistHelmRender` already wrote to the render
 * store — so the archive entry's identity and the render store's identity
 * are the same digest, not two independent hashes of the same bytes.
 */

import {
  addArchiveEntry,
  createBuildArchiveManifest,
  type BuildArchiveManifest,
} from "@intentius/chant/components/verbs/build-archive";
import type { ProvenanceLink } from "@intentius/chant/components/verbs/reproducibility";

import type { RenderManifest } from "./render-store";

/**
 * Media type for a pinned helm render folded into a build archive as a
 * `template`-kind entry. `v1` names the canonical-stream shape
 * `canonicalizeRender` (./render-digest.ts) produces — a versioned suffix so
 * a future incompatible canonicalization can be told apart from this one
 * without guessing from content alone.
 */
export const HELM_RENDER_MEDIA_TYPE = "application/vnd.chant.helm-render.v1+yaml";

export interface AddArchiveHelmRenderInput {
  /** Where the render is written inside the build archive (e.g. `"external-secrets.render.yaml"`). */
  path: string;
  /**
   * The persisted render this entry describes — see ./render-store.ts's
   * `persistHelmRender`/`loadRenderManifest`. Supplies the entry's digest
   * (`RenderManifest.contentDigest`, the same identity the render store
   * keys its content-addressed entry under).
   */
  render: RenderManifest;
  /**
   * Manifest to extend, so a component's whole build phase (image/template +
   * render) accumulates one manifest — the same accumulation convention
   * `addArchiveTemplate`/`generate-sbom`'s `manifest` input uses. Omit to
   * start a new manifest holding just this render.
   */
  manifest?: BuildArchiveManifest;
  /**
   * Source ref/commit this render was produced from (#614), recorded as the
   * entry's `provenance.sourceRef`. Defaults to `render.sourceRef` when the
   * caller omits it — the render already carries this when known; no
   * `provenance` is recorded when neither supplies one.
   */
  sourceRef?: string;
}

export interface AddArchiveHelmRenderOutput {
  /** The render's content digest — `render.contentDigest`, unchanged; returned for symmetry with `addArchiveTemplate`'s output. */
  digest: string;
  /** The build archive's manifest, now including this render's entry. */
  manifest: BuildArchiveManifest;
}

/**
 * Fold one pinned render into a build archive's manifest as a
 * `template`-kind entry with `mediaType: HELM_RENDER_MEDIA_TYPE` — the
 * render peer of `addArchiveTemplate`. The entry's digest is the render's
 * own `contentDigest` (real `sha256:` over the canonical rendered stream,
 * ./render-digest.ts's `helmContentDigest`), so the same digest that keys
 * the render store's `sha256-<hex>/` entry (./render-store.ts) also keys
 * this archive entry — one identity, not a second hash of the same bytes.
 * Adding the entry recomputes `manifest.manifestDigest`
 * (`computeManifestDigest`), so the render rolls into the archive's own
 * aggregate identity exactly as an image or template does.
 */
export function addArchiveHelmRender(input: AddArchiveHelmRenderInput): AddArchiveHelmRenderOutput {
  const digest = input.render.contentDigest;
  const base = input.manifest ?? createBuildArchiveManifest("unknown");
  const sourceRef = input.sourceRef ?? input.render.sourceRef ?? undefined;
  const provenance: ProvenanceLink | undefined = sourceRef
    ? { sourceRef, artifactDigest: digest }
    : undefined;
  const manifest = addArchiveEntry(base, {
    kind: "template",
    path: input.path,
    digest,
    mediaType: HELM_RENDER_MEDIA_TYPE,
    ...(provenance ? { provenance } : {}),
  });
  return { digest, manifest };
}

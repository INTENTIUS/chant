/**
 * Render canonicalization and the contentDigest/inputDigest split
 * (#1237, epic #1228 Phase 2).
 *
 * A pinned render's output is normalized to a canonical byte form before
 * digesting, and two digests are recorded with different jobs:
 *
 * - `inputDigest` answers "same inputs?" cheaply — a `sha256:` over the
 *   canonical JSON of { chart reference, chart version, resolved values,
 *   capability profile }. It is the same digest `helmInstall` records in the
 *   release ledger (#1243), computed by the same helper, so a render and a
 *   deploy of the same inputs share an identity.
 * - `contentDigest` answers "same bytes on the cluster?" — a `sha256:` over
 *   the canonical rendered bytes. It is the artifact identity.
 *
 * The two diverge exactly when rendering is unpinned or the chart is
 * unstable: two renders with the same inputDigest but different
 * contentDigests mean the render function is not a function of its declared
 * inputs. That divergence is itself a signal — `renderStability` names it.
 *
 * Canonicalization scope (what the epic measured, not more):
 * - Mapping key order is normalized (sorted) — YAML mappings are unordered
 *   in Kubernetes semantics, so key order is render noise. Sequence order is
 *   never touched; list order is meaningful to Kubernetes.
 * - Document order is preserved, not sorted. The epic verified document
 *   ordering is already stable across renders (three renders, again with
 *   subcharts), so reordering would only destroy information.
 * - Duplicate documents are preserved. An aliased dependency emits the same
 *   CRD twice (epic finding 11); helm dedupes on install, the artifact keeps
 *   both, and the digest stays stable because canonicalization is
 *   per-document and order-preserving.
 * - The helm-inserted `# Source:` header is kept (it is the origin-routing
 *   key the archive wrapper builds on) and normalized to a single leading
 *   line. All other comments, trailing whitespace, CRLF line endings, and
 *   document-separator styling are render noise and are dropped or
 *   normalized.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "@intentius/chant/effect-receipt";
import yaml from "js-yaml";

import { splitDocuments } from "./pinnability/render-stream";
import type { HelmRenderRecord } from "./render";

/**
 * The declared inputs of a helm render or deploy, in the exact shape #1243
 * digests for the release ledger. `helmInstallInputDigest`
 * (op/activities/helm.ts) and `HelmRender`'s recorded `inputDigest` both
 * delegate here, so the two cannot drift: the same chart reference, version,
 * resolved values, and capability facts produce the same digest whether they
 * reach helm through a render or a deploy.
 */
export interface HelmInputDigestSource {
  /** Chart reference — a local path, or `<repo-url>/<chart>` for repo-fetched charts. */
  chart: string;
  /** Pinned chart version. Digested as `null` when absent. */
  chartVersion?: string;
  /** Resolved values (file merged with overrides). Digested as `{}` when absent. */
  values?: Record<string, unknown>;
  /**
   * Capability facts the render is pinned against. Only the facts join the
   * digest — the profile's *name* is a label, not an input, so two profiles
   * declaring the same cluster digest identically. `apiVersions` is sorted:
   * it declares a set, not an order.
   */
  capabilityProfile?: { kubeVersion?: string; apiVersions?: string[] };
}

/**
 * The input-side identity of a helm render or deploy: `sha256:` over the
 * canonical JSON (core's `canonicalJson`, RFC 8785 shape) of the declared
 * inputs. Shared with #1243's release-ledger digest — see
 * `HelmInputDigestSource`. Deliberately excludes the release name and
 * namespace: those are baked into the rendered bytes but the ledger uses
 * this digest as a cross-environment join key, and two environments
 * deploying the same chart, version, and values must share it.
 */
export function helmInputDigest(source: HelmInputDigestSource): string {
  const input: Record<string, unknown> = {
    chart: source.chart,
    chartVersion: source.chartVersion ?? null,
    values: source.values ?? {},
  };
  if (source.capabilityProfile) {
    input.capabilityProfile = {
      kubeVersion: source.capabilityProfile.kubeVersion ?? null,
      apiVersions: [...(source.capabilityProfile.apiVersions ?? [])].sort(),
    };
  }
  return `sha256:${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
}

/** The helm-inserted origin header, e.g. `# Source: chart/templates/deploy.yaml`. */
const SOURCE_HEADER = /^# Source: \S+$/m;

/**
 * Normalize a `helm template` stream to its canonical byte form.
 *
 * Per document: the `# Source:` header (if any) becomes the single leading
 * comment line, the YAML body is re-serialized with sorted mapping keys
 * (sequences untouched), no line-width folding, and a trailing newline.
 * Documents are emitted in render order, each introduced by a `---` line.
 * CRLF endings, trailing whitespace, non-Source comments, and empty or
 * comment-only documents are render noise and do not survive.
 *
 * A document that fails to parse as YAML is kept verbatim (trimmed) rather
 * than dropped — the canonical form must never silently lose content, and a
 * verbatim document still digests deterministically.
 */
export function canonicalizeRender(rendered: string): string {
  const out: string[] = [];
  for (const doc of splitDocuments(rendered.replace(/\r\n/g, "\n"))) {
    const header = doc.match(SOURCE_HEADER)?.[0];
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = yaml.load(doc);
    } catch {
      parseFailed = true;
    }
    if (parseFailed) {
      out.push(`---\n${doc}\n`);
      continue;
    }
    if (parsed === null || parsed === undefined) continue; // comment-only or empty document
    const body = yaml.dump(parsed, { sortKeys: true, lineWidth: -1, noRefs: true });
    out.push(`---\n${header ? header + "\n" : ""}${body}`);
  }
  return out.join("");
}

/**
 * The content-side identity of a render: `sha256:` over the canonical bytes
 * of the rendered stream (see `canonicalizeRender`). Unlike `inputDigest`,
 * this changes whenever the bytes that would reach the cluster change — a
 * chart upgrade with identical values, a helm version that renders
 * differently, an unstable template.
 */
export function helmContentDigest(rendered: string): string {
  return `sha256:${createHash("sha256").update(canonicalizeRender(rendered), "utf8").digest("hex")}`;
}

/** One inputDigest's renders and the distinct content identities they produced. */
export interface RenderStabilityGroup {
  inputDigest: string;
  /** Render names in this group, in record order. */
  names: string[];
  /** Distinct content digests observed, in first-seen order. */
  contentDigests: string[];
}

export interface RenderStabilityReport {
  /** Groups whose every render produced the same bytes. */
  stable: RenderStabilityGroup[];
  /**
   * Groups where the same inputs produced different bytes: the render is
   * not pinned down by its declared inputs — an unstable chart, or an input
   * that escaped declaration. Every group here is a defect signal.
   */
  unstable: RenderStabilityGroup[];
  /** Names of records carrying no digests (unpinned renders) — unassessable. */
  unassessed: string[];
}

/**
 * Group recorded renders by input identity and report whether the same
 * inputs always produced the same bytes.
 *
 * Two renders with equal `inputDigest` and different `contentDigest` mean
 * the render is not a function of its declared inputs — the chart is
 * unstable (generated values, timestamps) or an input escaped declaration.
 * That divergence is the signal this helper exists to name; a single render
 * per input proves nothing and lands in `stable` by default.
 *
 * Grouping keys on `(inputDigest, name)` because the release name is a real
 * render input baked into the bytes but deliberately absent from
 * `inputDigest` (see `helmInputDigest`) — two differently named renders of
 * the same chart legitimately differ in content and must not be read as
 * instability.
 */
export function renderStability(records: readonly HelmRenderRecord[]): RenderStabilityReport {
  const groups = new Map<string, RenderStabilityGroup>();
  const unassessed: string[] = [];
  for (const record of records) {
    if (!record.inputDigest || !record.contentDigest) {
      unassessed.push(record.name);
      continue;
    }
    const key = `${record.inputDigest} ${record.name}`;
    let group = groups.get(key);
    if (!group) {
      group = { inputDigest: record.inputDigest, names: [], contentDigests: [] };
      groups.set(key, group);
    }
    group.names.push(record.name);
    if (!group.contentDigests.includes(record.contentDigest)) {
      group.contentDigests.push(record.contentDigest);
    }
  }
  const report: RenderStabilityReport = { stable: [], unstable: [], unassessed };
  for (const group of groups.values()) {
    (group.contentDigests.length > 1 ? report.unstable : report.stable).push(group);
  }
  return report;
}

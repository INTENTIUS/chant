/**
 * WHM503: Pinned render artifact carries Secret data.
 *
 * WHM407 covers the pre-render concern — a chart TEMPLATE with an inline,
 * literal `data`/`stringData` value baked into `templates/`. This rule
 * covers a different concern (#1241, epic #1228 Phase 3): the STORED,
 * POST-RENDER artifact (`render-store.ts`, #1238). A pinned render is
 * durable, promoted, and pushed to a registry — unlike a normal `helm
 * upgrade`, whose rendered bytes are computed at deploy time and discarded.
 * By the time a render lands in the store, every `.Values` reference and
 * `{{ }}` expression is resolved, so a `kind: Secret` document with
 * populated `data`/`stringData` there is a live credential baked into
 * something that outlives the deploy that produced it.
 *
 * Scans every pinned render recorded so far in this process
 * (`getHelmRenderRecords()` from `../../render`) that carries a
 * `contentDigest`, loads its manifest + canonical content from the render
 * store, and flags any `Secret` document whose `data` or `stringData` is
 * non-empty.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import yaml from "js-yaml";

import type { HelmRenderRecord } from "../../render";
import { getHelmRenderRecords } from "../../render";
import { loadRenderManifest, readRenderDocument } from "../../render-store";

interface ParsedSecretDoc {
  data?: unknown;
  stringData?: unknown;
}

/** True when a `data`/`stringData` map carries at least one key. */
function isPopulated(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/**
 * Scan a set of `HelmRenderRecord`s for pinned renders whose stored artifact
 * carries a `Secret` document with populated `data`/`stringData`. Exported
 * separately from `whm503` so tests can drive it directly with hand-built
 * records — no real `helm` binary required, unlike a `HelmRender()` call.
 * `opts.root` overrides the render store root (test isolation).
 */
export function checkRenderRecordsForSecrets(
  records: readonly HelmRenderRecord[],
  opts?: { root?: string },
): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const record of records) {
    if (!record.contentDigest) continue; // unpinned — no stored artifact to scan

    const manifest = loadRenderManifest(record.contentDigest, opts);
    if (!manifest) continue; // recorded but not (or no longer) in the store

    for (const doc of manifest.documents) {
      if (doc.kind !== "Secret") continue;

      const found = readRenderDocument(record.contentDigest, { kind: doc.kind, name: doc.name, namespace: doc.namespace }, opts);
      if (!found) continue;

      let parsed: ParsedSecretDoc;
      try {
        parsed = (yaml.load(found.text) ?? {}) as ParsedSecretDoc;
      } catch {
        continue; // unparseable — not this check's problem to diagnose
      }

      if (!isPopulated(parsed.data) && !isPopulated(parsed.stringData)) continue;

      const locator = doc.namespace ? `${doc.namespace}/${doc.name}` : doc.name;
      diagnostics.push({
        checkId: "WHM503",
        severity: "error",
        message:
          `pinned render "${record.name}" (${record.chart}, ${record.contentDigest}): Secret "${locator}" ` +
          `carries populated data/stringData — a pinned render is stored, promoted, and pushed to a registry, ` +
          `so this bakes a live credential into a durable artifact. Declare the value with runtimeSlot() so ` +
          `it is supplied per environment, or replace this Secret with HelmExternalSecret.`,
        entity: locator,
        lexicon: "helm",
      });
    }
  }

  return diagnostics;
}

export const whm503: PostSynthCheck = {
  id: "WHM503",
  description: "Pinned render artifact must not carry populated Secret data/stringData",

  // This check's data source is the render store (#1238), not `ctx.outputs`
  // (the un-rendered chart template files WHM005-WHM502 read) — see the file
  // doc comment. `ctx` is accepted to satisfy `PostSynthCheck` and is unused.
  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkRenderRecordsForSecrets(getHelmRenderRecords());
  },
};

/**
 * WK8407: Unpinned model version
 *
 * KServe's InferenceService predictor pins a model by `storageUri`. The
 * `Model` composite (#986) always appends `version` as the trailing path
 * segment (`scheme://id/version`), so a resolved `Model` reference is
 * always pinned — but `InferenceService.model` also accepts a raw
 * `storageUri` string (#985), which can bypass that guarantee (e.g.
 * `"gs://bucket/model"` with no version segment, or a floating tag like
 * `"latest"`/`"main"`). An unpinned reference means a redeploy of the same
 * InferenceService can silently pick up different weights.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests } from "./k8s-helpers";

/** Trailing path segments that mean "no explicit version" even though present. */
const FLOATING_TAGS = new Set(["latest", "main", "master", "head"]);

/**
 * True when `storageUri` has an explicit, non-floating version segment:
 * `scheme://path/version` with at least two path segments after the
 * scheme, and the last segment isn't a known floating tag.
 */
export function isPinnedStorageUri(storageUri: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(.+)$/i.exec(storageUri.trim());
  if (!m) return false;

  const segments = m[1].split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return false;

  const last = segments[segments.length - 1].toLowerCase();
  return !FLOATING_TAGS.has(last);
}

export const wk8407: PostSynthCheck = {
  id: "WK8407",
  description: "InferenceService model storageUri has no explicit version segment",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const manifest of docsToManifests(ctx)) {
      if (manifest.kind !== "InferenceService") continue;

      const spec = manifest.spec as Record<string, unknown> | undefined;
      const predictor = spec?.predictor as Record<string, unknown> | undefined;
      const model = predictor?.model as Record<string, unknown> | undefined;
      const storageUri = model?.storageUri as string | undefined;
      if (!storageUri) continue;

      if (!isPinnedStorageUri(storageUri)) {
        const resourceName = manifest.metadata?.name ?? "InferenceService";
        diagnostics.push({
          checkId: "WK8407",
          severity: "warning",
          message: `InferenceService "${resourceName}": model storageUri "${storageUri}" has no explicit version segment — pin it (e.g. via the Model composite's required \`version\`) so a redeploy can't silently pick up different weights`,
          entity: resourceName,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};

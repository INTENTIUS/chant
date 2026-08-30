/**
 * WK8501: Custom resource spec has a field its CRD schema does not declare
 *
 * A generated CRD class takes `spec: Record<string, unknown>`, so a misspelled
 * field (`classname` for `className`) type-checks and serializes. The API
 * server accepts the object and prunes the unknown field, the controller
 * never sees it, and the resource runs with a default nobody chose. The
 * lexicon ships each CRD's `spec` schema (chant #1372); this check flags any
 * field that schema does not list, unless the enclosing object declares
 * `x-kubernetes-preserve-unknown-fields` or `additionalProperties`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { customResources, resourceLabel, validateSpec } from "./crd-schema-helpers";

export const wk8501: PostSynthCheck = {
  id: "WK8501",
  description: "Custom resource spec contains a field its CRD schema does not declare",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { manifest, schema } of customResources(ctx)) {
      if (manifest.spec === undefined) continue;
      const name = resourceLabel(manifest);
      for (const finding of validateSpec(manifest.spec, schema)) {
        if (finding.kind !== "unknown-field") continue;
        diagnostics.push({
          checkId: "WK8501",
          severity: "error",
          message: `${manifest.kind} "${name}": ${finding.message}. The API server prunes it and the controller never sees it.`,
          entity: name,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};

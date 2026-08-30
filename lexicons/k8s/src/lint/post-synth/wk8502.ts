/**
 * WK8502: Custom resource spec field has the wrong type or an invalid enum value
 *
 * With `spec: Record<string, unknown>` on every generated CRD class, nothing
 * at compile time stops `replicas: "2"` or `desiredState: "Runing"`. The API
 * server rejects the first at apply and the controller ignores the second.
 * The lexicon ships each CRD's `spec` schema (chant #1372); this check
 * compares every scalar against its declared type and enum before apply.
 * `x-kubernetes-int-or-string` and untyped nodes accept anything.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { customResources, resourceLabel, validateSpec } from "./crd-schema-helpers";

export const wk8502: PostSynthCheck = {
  id: "WK8502",
  description: "Custom resource spec field has the wrong type or a value outside its enum",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { manifest, schema } of customResources(ctx)) {
      if (manifest.spec === undefined) continue;
      const name = resourceLabel(manifest);
      for (const finding of validateSpec(manifest.spec, schema)) {
        if (finding.kind !== "type-mismatch") continue;
        diagnostics.push({
          checkId: "WK8502",
          severity: "error",
          message: `${manifest.kind} "${name}": ${finding.message}`,
          entity: name,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};

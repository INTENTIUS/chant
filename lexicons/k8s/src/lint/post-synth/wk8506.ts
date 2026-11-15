/**
 * WK8506: Object has a top-level key its kind does not declare
 *
 * A `labels:` written beside `metadata` instead of under it builds without
 * complaint: the serializer writes it, and WK8102 reports the missing
 * `metadata.labels` before and after the mistake. `kubectl apply` rejects the
 * object (`strict decoding error: unknown field "labels"`), and with
 * `--validate=ignore` the API server drops the key, so the label a selector
 * depends on never lands. The lexicon ships each kind's declared top-level
 * keys; this check flags any other. A kind with no schema in the lexicon is
 * left alone.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests, nameOf } from "./k8s-helpers";
import { declaredTopLevelFields } from "./top-level-fields-helpers";
import { metadataHasKey, unknownKeyReason, unknownTopLevelKeys } from "../../top-level-fields";

export const wk8506: PostSynthCheck = {
  id: "WK8506",
  description: "Object has a top-level key its kind does not declare",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const manifest of docsToManifests(ctx)) {
      const declared = declaredTopLevelFields(manifest);
      if (!declared || !manifest.kind) continue;
      const name = nameOf(manifest, manifest.kind);
      for (const key of unknownTopLevelKeys(manifest, declared)) {
        diagnostics.push({
          checkId: "WK8506",
          severity: "warning",
          message: `${manifest.kind} "${name}": ${unknownKeyReason(manifest.kind, key, metadataHasKey(manifest, key))}`,
          entity: name,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};

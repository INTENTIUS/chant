/**
 * The gcp lexicon's *static* deep-observation noise rules (#1087, epic #1073).
 *
 * Split out from `./deep-observe.ts` for the same reason chant #1076 split
 * the k8s lexicon's rules into `lexicons/k8s/src/deep-observe-hooks.ts`: this
 * file must be safe to import from `plugin.ts` at module load time, because
 * `LexiconPlugin.deepNormalizationHooks` is plain data core reads to
 * normalize the *declared* tree — the half of the contract that runs whether
 * or not a cluster is ever touched (`lifecycle diff` without `--live`,
 * `chant build`, tests that only exercise normalization). `./deep-observe.ts`
 * imports `./describe-resources.ts` for the live kubectl transport, which
 * pulls in `node:child_process`; nothing this file exports may pull that in,
 * directly or transitively, so `chant build` never resolves a process-
 * spawning module just to normalize a declared tree.
 *
 * What lives here is entirely reused from `@intentius/chant/managed-fields`
 * (chant #1087's module doc explains why that lives in core rather than the
 * k8s lexicon) plus GCP/Config-Connector-specific annotation noise. Nothing
 * here needs a live object in hand — the per-resource managed-fields prune
 * (which does) is computed in `./deep-observe.ts` and layered on top.
 */

import type { DeepNode, DeepNormalizationHooks } from "@intentius/chant/lexicon";
import { K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS, k8sListMapOrderKey } from "@intentius/chant/managed-fields";

/**
 * Config Connector's own observed-state annotations — written by
 * `cnrm-controller-manager` after reconciling, mirroring GCP-side state the
 * CRD schema has no field for (e.g. secret version pins). Never authored by
 * a chant manifest, so pruning them unconditionally cannot hide declared
 * config the way blindly pruning every `cnrm.cloud.google.com/*` annotation
 * would — several of that family (`state-into-spec`, `deletion-policy`,
 * `management-conflict-prevention-policy`) are themselves user-authored
 * configuration, not observed state, and pruning those would hide genuine
 * drift on them.
 *
 * Sparse and evidence-based (Config Connector's own docs), the same posture
 * every other lexicon's noise table takes. Widening it is additive and needs
 * no contract change.
 *
 * Most CNRM-controller noise doesn't need this list at all — it's already
 * pruned by the reused managed-fields ownership rule in `./deep-observe.ts`,
 * since `cnrm-controller-manager` is a foreign, undeclared owner of whatever
 * it touches. This list only covers the narrow, evidence-based case worth
 * pruning even were managedFields attribution ever missing for it.
 */
const CNRM_OBSERVED_STATE_ANNOTATION_KEYS: ReadonlySet<string> = new Set([
  "cnrm.cloud.google.com/observed-secret-versions",
]);

const ANNOTATIONS_PREFIX = "metadata.annotations.";

function isCnrmObservedStateAnnotation(node: DeepNode): boolean {
  if (!node.pattern.startsWith(ANNOTATIONS_PREFIX)) return false;
  return CNRM_OBSERVED_STATE_ANNOTATION_KEYS.has(node.pattern.slice(ANNOTATIONS_PREFIX.length));
}

/**
 * GCP's static deep-observation noise rules — the entity-agnostic half,
 * applied to the *declared* tree by core (`gcpPlugin.deepNormalizationHooks`)
 * exactly like the other three rows, and layered under the per-resource
 * managed-fields prune in `./deep-observe.ts` for the live tree.
 *
 * A Config Connector custom resource *is* a Kubernetes object (see
 * `./deep-observe.ts`'s module doc), so the generic envelope
 * (`K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS`) and Kubernetes' own list-map-key
 * ordering conventions (`k8sListMapOrderKey` — needed because some CNRM kinds
 * embed genuinely k8s-shaped substructures, e.g. Cloud Run's `RunService`)
 * are reused verbatim from `@intentius/chant/managed-fields` rather than
 * restated. The one GCP-specific rule is CNRM's own observed-state
 * annotation noise.
 */
export const gcpDeepNormalizationHooks: DeepNormalizationHooks = {
  prune(node: DeepNode): boolean {
    if (K8S_OBJECT_ENVELOPE_PRUNE_PATTERNS.has(node.pattern)) return true;
    return isCnrmObservedStateAnnotation(node);
  },
  orderKey: k8sListMapOrderKey,
};

/**
 * Shared helpers for the Argo post-synth checks (ARGO002, ARGO003, ARGO005).
 *
 * Excluded from check auto-discovery by the "helper" filename filter.
 */
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, type K8sManifest } from "./k8s-helpers";

/** The always-present, in-cluster Argo destination. */
export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";
export const IN_CLUSTER_NAME = "in-cluster";

/** Label that marks a Secret as an Argo CD external cluster registration. */
export const CLUSTER_SECRET_TYPE_LABEL = "argocd.argoproj.io/secret-type";

/** All manifests across every lexicon output. */
export function allManifests(ctx: PostSynthContext): K8sManifest[] {
  const manifests: K8sManifest[] = [];
  for (const [, output] of ctx.outputs) {
    manifests.push(...parseK8sManifests(getPrimaryOutput(output)));
  }
  return manifests;
}

/** Manifests of a given Argo kind. */
export function manifestsOfKind(manifests: K8sManifest[], kind: string): K8sManifest[] {
  return manifests.filter((m) => m.kind === kind);
}

/**
 * Read a string field from a Secret's stringData or data block.
 * (Argo cluster Secrets conventionally use stringData.)
 */
export function secretField(manifest: K8sManifest, key: string): string | undefined {
  const stringData = manifest.stringData as Record<string, unknown> | undefined;
  const data = manifest.data as Record<string, unknown> | undefined;
  const fromStringData = stringData?.[key];
  if (typeof fromStringData === "string") return fromStringData;
  const fromData = data?.[key];
  if (typeof fromData === "string") return fromData;
  return undefined;
}

/** True if the Secret is labelled as an Argo cluster registration. */
export function isClusterSecret(manifest: K8sManifest): boolean {
  if (manifest.kind !== "Secret") return false;
  const labels = manifest.metadata?.labels;
  return labels?.[CLUSTER_SECRET_TYPE_LABEL] === "cluster";
}

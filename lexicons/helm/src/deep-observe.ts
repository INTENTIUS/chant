/**
 * Helm deep observation (#1247, epic #1228 phase 5) — property-level live
 * trees for the resources a release manages, read through the k8s lexicon's
 * machinery rather than a second implementation.
 *
 * The objects a release deploys are Kubernetes objects, so the deep read
 * composes rather than reimplements:
 *
 *   1. The helm half (shared with `describeResources`, `./release-observe.ts`)
 *      resolves each declared `Helm::Chart` to its release and parses what
 *      the release holds — `helm get manifest` plus `helm get hooks`, both
 *      channels. Each rendered document becomes a synthetic declared entity:
 *      the release's stored manifest IS the declared side of a helm deep
 *      diff — what the cluster is supposed to hold is what the release
 *      applied.
 *   2. The k8s half (`observeResourcesDeepK8s`) reads the live property tree
 *      for each of those entities over the typed API client, resolves
 *      per-field ownership from `metadata.managedFields` (#1189), and
 *      normalizes with `k8sDeepNormalizationHooks` — so Secret-value masking
 *      and the managed-fields rules apply to helm rows exactly as they do to
 *      k8s rows, from the same hook object (see `./deep-observe-hooks.ts`).
 *
 * Verdicts compose per the deep contract (#1014/#1089): a helm-side failure
 * (missing binary, unreachable cluster, unreadable release) lands the chart
 * entity in `unobserved` with a total reason; a k8s-side failure lands the
 * specific resource row there. Chart-authoring entities (`Helm::Chart`,
 * `Helm::Values`, …) have no property tree of their own — their deep form is
 * the per-resource rows this read returns — so on a successful read they are
 * deliberately in neither map, which core's deep diff treats as
 * nothing-to-compare rather than drift.
 */
import type { DeepObservationResult, UnobservedEntity } from "@intentius/chant/lexicon";
import { deepObservation } from "@intentius/chant/deep-observation";
import { unobservedAll } from "@intentius/chant/observation";
import { observeResourcesDeepK8s } from "@intentius/chant-lexicon-k8s/deep-observe";
import type { K8sConnector } from "@intentius/chant-lexicon-k8s/api/connect";
import {
  defaultHelmRunner,
  observeReleases,
  type HelmRunner,
} from "./release-observe";

export interface HelmDeepObserveOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  region?: string;
  owned?: boolean;
}

/** Injectable seams, so tests run without a helm binary or a kubeconfig. */
export interface HelmDeepObserveDeps {
  run?: HelmRunner;
  /** Forwarded to the k8s reader — a test passes a fake cluster's connector. */
  connect?: K8sConnector;
}

/** The document minus the envelope the row's `type` already carries. */
function declaredTreeOf(doc: Record<string, unknown>, namespace: string | undefined): Record<string, unknown> {
  const { apiVersion: _apiVersion, kind: _kind, ...rest } = doc;
  const metadata = (rest.metadata ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    // The k8s reader addresses the object by `props.metadata.{name,namespace}`;
    // helm applies the release namespace to namespace-silent documents, so the
    // synthetic entity must carry the resolved one.
    metadata: { ...metadata, ...(namespace && metadata.namespace === undefined ? { namespace } : {}) },
  };
}

export async function observeResourcesDeepHelm(
  options: HelmDeepObserveOptions,
  deps: HelmDeepObserveDeps = {},
): Promise<DeepObservationResult> {
  const run = deps.run ?? defaultHelmRunner;

  let observed;
  try {
    observed = await observeReleases(
      { environment: options.environment, entities: options.entities, stack: options.stack },
      run,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return deepObservation({}, unobservedAll(options.entityNames, "read-failed", message, options.entities));
  }

  const unobserved: Record<string, UnobservedEntity> = { ...observed.unobserved };

  // One synthetic declared entity per rendered document, keyed like the thin
  // read's rows so the two reads spell the same identity for the same object.
  const synthetic = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const release of observed.releases) {
    for (const row of release.resources) {
      synthetic.set(row.key, {
        entityType: row.entityType,
        props: declaredTreeOf(row.doc, row.namespace),
      });
    }
  }

  if (synthetic.size === 0) return deepObservation({}, unobserved);

  const k8sOptions = {
    environment: options.environment,
    buildOutput: options.buildOutput,
    entityNames: [...synthetic.keys()],
    entities: synthetic,
    ...(options.owned !== undefined ? { owned: options.owned } : {}),
  };
  const k8sResult = deps.connect
    ? await observeResourcesDeepK8s(k8sOptions, deps.connect)
    : await observeResourcesDeepK8s(k8sOptions);

  return deepObservation(k8sResult.resources ?? {}, {
    ...(k8sResult.unobserved ?? {}),
    ...unobserved,
  });
}

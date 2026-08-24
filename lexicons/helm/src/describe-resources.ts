/**
 * Live introspection of Helm releases per resource — the helm lexicon's
 * `describeResources` (#1246, epic #1228 phase 5).
 *
 * `listArtifacts` reports release *metadata* (name, revision, status) and no
 * resource state, which is why `lifecycle diff --live` had nothing to compare
 * for a Helm-managed estate. This read goes one level down: for each release
 * a declared `Helm::Chart` deploys, it fetches what the release holds —
 * `helm get manifest` AND `helm get hooks`, both channels, because hooks are
 * excluded from the manifest channel and reading one would report every hook
 * resource as drift — and reports one row per rendered resource.
 *
 * ## Verdicts (#1089)
 *
 * - The chart entity itself is OBSERVED-PRESENT as the release
 *   (`Helm::Release`), OBSERVED-ABSENT when `helm list` was asked and did
 *   not report it (only that becomes a `create`), and NOT-OBSERVED with a
 *   total reason when helm or the cluster could not be reached — a missing
 *   binary or kubeconfig is `no-credentials`, never a clean empty snapshot.
 * - Every rendered resource is reported `ownership: "owned"` — helm-managed
 *   via release identity: the read is scoped to the release, so everything
 *   it returns is by construction managed by a release this project
 *   declares. Rows additionally surface chant's own stack/env marker
 *   (#1222) verbatim when the rendered labels carry it.
 * - Every rendered resource carries `ownerChain: { root: "declared" }`
 *   pointing at its chart entity, so the diff engine classifies it
 *   `runtime` rather than `orphan` (#1077) — an unpinned release is not
 *   drift. Controller-created children (Pods under a chart's Deployment)
 *   are the k8s lexicon's rows; its own owner-chain walk classifies them.
 *
 * ## Chart-authoring satellites
 *
 * `Helm::Values`, `Helm::Notes`, `Helm::Test` and the other authoring
 * entities have no runtime identity of their own — their deployed form IS
 * the release (helm stores the applied values and rendered NOTES.txt in the
 * release record). In a single-chart project they ride the chart's verdict:
 * present when the release is, absent when it is not, unobserved with the
 * same reason otherwise. A multi-chart project cannot attribute them to one
 * release, so they are NOT-OBSERVED (`unsupported-kind`) with a detail
 * saying so.
 */
import type { ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import type { ObservationResult } from "@intentius/chant/observation";
import { observation } from "@intentius/chant/observation";
import { LABEL_OWNERSHIP_KEYS, readOwnership } from "@intentius/chant/ownership";
import {
  HELM_CHART_ENTITY_TYPE,
  HELM_RELEASE_TYPE,
  defaultHelmRunner,
  observeReleases,
  type HelmRunner,
  type ObservedRelease,
} from "./release-observe";

export interface HelmDescribeOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  region?: string;
  owned?: boolean;
  namespace?: string;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function releaseRow(release: ObservedRelease): ResourceMetadata {
  return {
    type: HELM_RELEASE_TYPE,
    physicalId: `${release.namespace}/${release.release}`,
    status: release.status ?? "unknown",
    ...(release.updated ? { lastUpdated: release.updated } : {}),
    ownership: "owned",
    attributes: pruneUndefined({
      chart: release.chart,
      revision: release.revision,
      appVersion: release.appVersion,
      namespace: release.namespace,
      resources: release.resources.length,
    }),
  };
}

export async function describeResources(
  options: HelmDescribeOptions,
  run: HelmRunner = defaultHelmRunner,
): Promise<ObservationResult> {
  const satellites: Array<{ entityName: string; entityType: string }> = [];
  for (const [entityName, entity] of options.entities) {
    if (entity.entityType !== HELM_CHART_ENTITY_TYPE) {
      satellites.push({ entityName, entityType: entity.entityType });
    }
  }

  const observed = await observeReleases(
    { environment: options.environment, entities: options.entities, stack: options.stack },
    run,
  );

  const chartCount = options.entities.size - satellites.length;
  const resources: Record<string, ResourceMetadata> = {};
  const unobserved: Record<string, UnobservedEntity> = { ...observed.unobserved };
  const notes: string[] = [];

  if (chartCount === 0 && satellites.length > 0) {
    for (const { entityName, entityType } of satellites) {
      unobserved[entityName] = {
        type: entityType,
        reason: "unsupported-kind",
        detail: "chart-authoring entity with no declared Helm::Chart to attribute a release to",
      };
    }
    return observation(resources, unobserved, observed.queried, notes);
  }

  for (const release of observed.releases) {
    resources[release.entityName] = releaseRow(release);

    for (const row of release.resources) {
      const labels = (row.doc.metadata as { labels?: Record<string, unknown> } | undefined)?.labels;
      const marker = readOwnership(labels, LABEL_OWNERSHIP_KEYS);
      resources[row.key] = {
        type: row.entityType,
        physicalId: row.namespace ? `${row.namespace}/${row.name}` : row.name,
        status: release.status ?? "unknown",
        // Owned via release identity (#1246): the read is scoped to a release
        // this project declares, so every document it returns is helm-managed
        // by construction — the release IS the marker channel here.
        ownership: "owned",
        ...(marker ? { marker } : {}),
        // The release's resources are what the declared chart deploys —
        // expected runtime, never orphan/delete candidates (#1077).
        ownerChain: { root: "declared", entity: release.entityName },
        attributes: pruneUndefined({
          release: release.release,
          releaseNamespace: release.namespace,
          namespace: row.namespace,
          channel: row.channel,
          hook: row.hook?.hook,
          hookWeight: row.hook?.weight,
          hookDeletePolicy: row.hook?.deletePolicy,
        }),
      };
    }
  }

  // Chart-authoring satellites ride the single chart's verdict; see the
  // module doc. Their deployed form is the release itself, so the release
  // read is the honest answer for them — present, absent, or unobserved
  // exactly as the chart is.
  if (satellites.length > 0) {
    if (chartCount === 1) {
      const [chartEntity] = [...options.entities].find(
        ([, e]) => e.entityType === HELM_CHART_ENTITY_TYPE,
      )!;
      const release = observed.releases.find((r) => r.entityName === chartEntity);
      const hole = unobserved[chartEntity];
      for (const { entityName, entityType } of satellites) {
        if (release) {
          resources[entityName] = {
            type: entityType,
            physicalId: `${release.namespace}/${release.release}`,
            status: release.status ?? "unknown",
            ownership: "owned",
            attributes: { release: release.release, namespace: release.namespace, via: "release-identity" },
          };
        } else if (hole) {
          unobserved[entityName] = { type: entityType, reason: hole.reason, ...(hole.detail ? { detail: hole.detail } : {}) };
        }
        // Release confirmed absent → the satellite is absent too: in neither
        // map, and deploying the chart is what creates it.
      }
    } else {
      for (const { entityName, entityType } of satellites) {
        unobserved[entityName] = {
          type: entityType,
          reason: "unsupported-kind",
          detail: "chart-authoring entity in a multi-chart project — cannot attribute it to a single release",
        };
      }
    }
  }

  if (options.owned) {
    notes.push(
      "helm scopes reads to declared releases, so every row is helm-managed (owned) by construction — --owned withholds nothing",
    );
  }

  return observation(resources, unobserved, observed.queried, notes);
}

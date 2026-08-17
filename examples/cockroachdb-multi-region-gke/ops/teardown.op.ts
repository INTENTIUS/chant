/**
 * Take the estate back down, innermost first. `chant run crdb-teardown`.
 *
 * Order is the whole content of this Op, and getting it wrong is expensive:
 * delete the GKE clusters before their workloads and the regional load
 * balancers are orphaned in GCP with nothing left to reconcile them; delete
 * the VPC before the clusters and the delete blocks on dependencies until it
 * times out.
 *
 * Every step tolerates an already-absent resource, so this is safe to re-run
 * against a partial teardown — which, after a failed deploy, is the usual case.
 */

import { Op, phase, shell } from "@intentius/chant-lexicon-temporal";

const MGMT = "mgmt";
const REGIONS = ["east", "central", "west"] as const;

export default Op({
  name: "crdb-teardown",
  overview: "Destroy the CockroachDB estate — workloads, then clusters, then the VPC",
  taskQueue: "crdb",
  searchAttributes: { Estate: "crdb-multi-region" },

  phases: [
    // The manifests have to exist to be deleted, and after a failed deploy
    // they may not have been built yet.
    phase("Build", [shell("npm run build")]),

    phase(
      "Workloads",
      REGIONS.map((r) =>
        shell(
          `kubectl --context ${r} delete -f dist/${r}-k8s.yaml --ignore-not-found || true; ` +
            `kubectl --context ${r} delete -f dist/eso.yaml --ignore-not-found || true`,
          { profile: "longInfra" },
        ),
      ),
      { parallel: true },
    ),

    // StatefulSet PVCs outlive their StatefulSet by design; nothing else will
    // reclaim these disks.
    phase(
      "Volumes",
      REGIONS.map((r) =>
        shell(`kubectl --context ${r} -n crdb-${r} delete pvc --all --ignore-not-found || true`),
      ),
      { parallel: true },
    ),

    // Config Connector owns the GCP side: deleting the manifest deletes the
    // real resources. Regions first — the VPC they sit in comes after.
    phase(
      "Clusters",
      REGIONS.map((r) =>
        shell(`kubectl --context ${MGMT} delete -f dist/${r}-infra.yaml --ignore-not-found || true`, {
          profile: "longInfra",
        }),
      ),
      { parallel: true },
    ),
    phase("Clusters gone", [
      shell(
        REGIONS.map(
          (r) => `kubectl --context ${MGMT} wait --for=delete containercluster/gke-crdb-${r} --timeout=900s || true`,
        ).join("; "),
        { profile: "longInfra" },
      ),
    ]),

    phase("Network", [
      shell(`kubectl --context ${MGMT} delete -f dist/shared-infra.yaml --ignore-not-found || true`, {
        profile: "longInfra",
      }),
      shell(
        `kubectl --context ${MGMT} wait --for=delete computenetwork/crdb-multi-region --timeout=600s || true`,
        { profile: "longInfra" },
      ),
    ]),

    // Not Config Connector's: the bucket has objects, the secrets have
    // versions, and the management cluster was created by scripts/bootstrap.sh
    // rather than declared.
    phase("Residue", [shell("bash scripts/teardown-residue.sh", { profile: "longInfra" })]),
  ],
});

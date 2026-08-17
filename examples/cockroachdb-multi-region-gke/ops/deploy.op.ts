/**
 * Bring the whole estate up: one VPC, three GKE clusters, nine CockroachDB
 * nodes. `chant run crdb-deploy`.
 *
 * This replaces a 205-line shell script of thirteen numbered steps. What the
 * script could not do, and this can: every phase reports where it is, a failed
 * step retries under a profile chosen for how long it should take, a partial
 * failure runs the Diagnose phase instead of leaving you to guess, and a re-run
 * resumes rather than starting over.
 *
 * Runs on the local executor — no Temporal server needed. There is no gate
 * here on purpose: a gate anywhere in an Op makes the whole Op refuse to run
 * locally, and the one thing that genuinely waits on a human (delegating the
 * DNS subdomains at your registrar) blocks only the public UI, not the
 * database. That lives in `crdb-publish-ui`.
 *
 * Prerequisite: `npm run bootstrap` once, for the management cluster and
 * Config Connector. Config Connector is what turns dist/*-infra.yaml into real
 * GCP resources, so every infra apply below targets the `mgmt` context.
 */

import {
  Op,
  phase,
  build,
  kubectlApply,
  shell,
  waitForReady,
  waitForStack,
} from "@intentius/chant-lexicon-temporal";

/** Config Connector runs here; applying an infra manifest anywhere else does nothing. */
const MGMT = "mgmt";

/** Config Connector's kinds, as the cluster's own API discovery names them. */
const CC_CLUSTER = "containercluster.container.cnrm.cloud.google.com";
const CC_NODE_POOL = "containernodepool.container.cnrm.cloud.google.com";

const REGIONS = ["east", "central", "west"] as const;

export default Op({
  name: "crdb-deploy",
  overview: "CockroachDB across three GCP regions — VPC, 3 GKE clusters, 9 nodes",
  taskQueue: "crdb",
  searchAttributes: { Estate: "crdb-multi-region" },

  phases: [
    // Fail on a missing tool or an unbootstrapped management cluster now,
    // rather than ten minutes into a cluster create.
    phase("Preflight", [
      shell(
        "for c in gcloud kubectl docker helm; do command -v $c >/dev/null || " +
          '{ echo "missing: $c"; exit 1; }; done',
      ),
      shell(
        "kubectl --context mgmt get crd containerclusters.container.cnrm.cloud.google.com >/dev/null || " +
          '{ echo "Config Connector not found on the mgmt context — run npm run bootstrap"; exit 1; }',
      ),
    ]),

    // Synthesis. Renders the ESO chart too, which is why helm is a preflight
    // check — see platform/eso.ts.
    phase("Build", [build(".", { script: "build" })]),

    phase("Network", [
      kubectlApply("dist/shared-infra.yaml", { context: MGMT, profile: "longInfra" }),
    ]),

    // Three independent cluster creates. Nothing orders them.
    phase(
      "Clusters",
      REGIONS.map((r) => kubectlApply(`dist/${r}-infra.yaml`, { context: MGMT, profile: "longInfra" })),
      { parallel: true },
    ),

    // ~10-15 minutes. The old script polled `gcloud node-pools describe` sixty
    // times in a bash loop; these are Config Connector resources, so their own
    // Ready condition is the signal.
    phase(
      "Clusters ready",
      [
        ...REGIONS.map((r) => waitForReady(CC_CLUSTER, `gke-crdb-${r}`, { context: MGMT, profile: "longInfra" })),
        ...REGIONS.map((r) => waitForReady(CC_NODE_POOL, `gke-crdb-${r}-nodes`, { context: MGMT, profile: "longInfra" })),
      ],
      { parallel: true },
    ),

    // GKE creates a default-pool next to the declared one; nine CockroachDB
    // nodes need the CPU quota back.
    phase("Reclaim quota", [shell("bash scripts/delete-default-pools.sh", { profile: "longInfra" })]),

    phase("Credentials", [shell("bash scripts/kube-contexts.sh")]),

    // One CA, one node cert with SANs for all nine nodes, one client cert.
    // Generated in Docker, then stored as Secret Manager versions — the
    // secrets are declared, their payload is not.
    phase("Certificates", [
      shell("bash scripts/generate-certs.sh", { profile: "longInfra" }),
      shell("bash scripts/push-certs.sh"),
    ]),

    // The operator that syncs those secrets into each cluster. Rendered into
    // dist/eso.yaml at build time and pinned there, so this is an apply like
    // any other rather than a `helm upgrade --install` of whatever is current.
    phase(
      "Operators",
      REGIONS.map((r) => kubectlApply("dist/eso.yaml", { context: r, force: true, profile: "longInfra" })),
      { parallel: true },
    ),
    phase(
      "Operators ready",
      REGIONS.map((r) => waitForStack("external-secrets", { namespace: "kube-system", context: r })),
      { parallel: true },
    ),

    phase(
      "Workloads",
      REGIONS.map((r) => kubectlApply(`dist/${r}-k8s.yaml`, { context: r, profile: "longInfra" })),
      { parallel: true },
    ),

    // Nodes gossip over the names ExternalDNS registers in crdb.internal. A
    // StatefulSet that starts before they resolve burns its join attempts on
    // NXDOMAIN and then backs off for a long time — this wait is what keeps
    // the cluster from forming slowly for no visible reason.
    phase(
      "Discovery",
      REGIONS.map((r) => waitForStack("external-dns", { namespace: "kube-system", context: r })),
      { parallel: true },
    ),
    phase("Discovery records", [shell("bash scripts/wait-dns.sh", { profile: "k8sWait" })]),

    phase(
      "Nodes",
      REGIONS.map((r) => waitForStack("cockroachdb", { namespace: `crdb-${r}`, context: r })),
      { parallel: true },
    ),

    // Init is declared, not scripted — CockroachDbRegionStack emits an init Job
    // for east only, and that Job is the only thing that mounts the client
    // cert `cockroach init` needs. This waits for it, then adds the backup
    // schedule.
    phase("Initialize", [shell("bash scripts/init-cluster.sh", { profile: "longInfra" })]),

    // Primary region, the two secondaries, SURVIVE REGION FAILURE, and a demo
    // REGIONAL BY ROW table.
    phase("Topology", [shell("bash scripts/configure-regions.sh", { profile: "longInfra" })]),
  ],

  // Not a rollback. Tearing a half-built database estate down automatically is
  // the wrong default — what a failed deploy needs is the evidence, in the run
  // history, next to the phase that failed. `chant run crdb-teardown` when you
  // have read it.
  onFailure: [
    phase("Diagnose", [
      shell(
        "kubectl --context mgmt get containercluster,containernodepool " +
          "-o custom-columns=KIND:.kind,NAME:.metadata.name,READY:.status.conditions[0].status || true",
      ),
      ...REGIONS.map((r) =>
        shell(
          `kubectl --context ${r} -n crdb-${r} get pods,pvc || true; ` +
            `kubectl --context ${r} -n crdb-${r} logs -l app.kubernetes.io/name=cockroachdb --tail=50 || true`,
        ),
      ),
    ]),
  ],
});

/**
 * The local proof. `chant run crdb-k3d-smoke`.
 *
 * "Local verification (no cloud accounts required)" used to mean `npm run
 * build && npm run lint` — that the TypeScript compiles and the YAML is
 * well-formed. Nothing ran the manifests, so nothing caught the class of bug
 * this example actually hit in production: nodes that come up healthy, never
 * find each other, and sit there.
 *
 * This brings up a k3d cluster, generates a shared CA, applies three regional
 * CockroachDB slices into three namespaces, initialises from east, and then
 * asserts the thing that matters — three live nodes in one logical cluster,
 * three regions known to SQL, and a REGIONAL BY ROW table that takes a write.
 *
 * About a minute once the CockroachDB image is in the local Docker cache; the
 * first run pulls it. No GCP account, no credentials. Needs k3d, kubectl and
 * docker.
 *
 * What it does not cover, and could not without three clusters: cross-CLUSTER
 * gossip, ExternalDNS against Cloud DNS, Workload Identity, External Secrets
 * against Secret Manager, GCE Ingress, Cloud Armor, and NetworkPolicy
 * enforcement (k3s runs flannel, which ignores it). k3d/src/regions.ts says
 * the same next to the declarations; k3d/src/config.ts explains why one cluster.
 *
 * Teardown runs whether or not the run succeeded — a failed smoke test that
 * leaves a cluster behind gets run once and then avoided.
 */

import {
  Op,
  phase,
  build,
  k3dUp,
  k3dDown,
  kubectlApply,
  shell,
  waitForReady,
  waitForStack,
} from "@intentius/chant-lexicon-temporal";

/** Matches metadata.name in k3d/src/k3d-cluster.ts and CLUSTER in k3d/src/config.ts. */
const CLUSTER = "crdb-smoke";

/**
 * The context k3d creates for this cluster. Every step names it explicitly
 * rather than relying on whatever the current context happens to be — on a
 * machine that also has credentials for three real GKE clusters, "whatever is
 * current" is not a thing to apply manifests against.
 */
const CTX = `k3d-${CLUSTER}`;

const REGIONS = ["east", "central", "west"] as const;

export default Op({
  name: "crdb-k3d-smoke",
  overview: "Three CockroachDB regions on one local k3d cluster — no GCP, no credentials",
  taskQueue: "crdb",
  searchAttributes: { Estate: "crdb-multi-region", Environment: "local" },

  phases: [
    phase("Preflight", [
      shell(
        "for c in k3d kubectl docker; do command -v $c >/dev/null || " +
          '{ echo "missing: $c"; exit 1; }; done',
      ),
    ]),

    // The cluster shape is k3d/src/k3d-cluster.ts, built to the config k3d
    // consumes — so the declaration and what actually gets created cannot
    // drift the way a pile of CLI flags does.
    phase("Cluster", [
      build(".", { script: "build:k3d-cluster" }),
      // Idempotent — a cluster of this name already up is reused.
      // updateDefaultKubeconfig puts the context where the later steps can
      // name it; switchCurrentContext stays off, so the current context is
      // never moved out from under whoever is running this.
      k3dUp(CLUSTER, {
        configFile: "k3d/cluster.yaml",
        updateDefaultKubeconfig: true,
        switchCurrentContext: false,
      }),
    ]),

    // One CA for all three regions. Three cert-gen Jobs would mint three CAs.
    phase("Certificates", [
      shell("bash k3d/certs.sh", { env: { K3D_CONTEXT: CTX }, profile: "longInfra" }),
    ]),

    phase("Build", [build(".", { script: "build:k3d" })]),

    phase("Apply", [kubectlApply("dist/k3d.yaml", { context: CTX, profile: "longInfra" })]),

    // Init is declared, not scripted: CockroachDbCluster emits an init Job for
    // the primary region, and that Job is the only thing here that mounts the
    // client cert `cockroach init` needs. Running init by hand from inside a
    // database pod hits the node certs directory instead and fails with
    // "password authentication failed for user root".
    //
    // Before the rollout wait, for the same reason as the real deploy: a pod's
    // readiness probe stays 503 until the cluster is initialised, so the
    // rollout is waiting on what this produces. Ready on Complete, terminal on
    // Failed, so a Job that will never finish says so instead of leaving the
    // next phase to time out.
    phase("Initialize", [
      waitForReady("job", "cockroachdb-init", {
        namespace: "crdb-east",
        context: CTX,
        spec: {
          ready: [{ conditionType: "Complete", status: "True" }],
          terminal: [{ conditionType: "Failed", status: "True" }],
          observedGeneration: false,
        },
        profile: "k8sWait",
      }),
    ]),

    phase(
      "Nodes",
      REGIONS.map((r) => waitForStack("cockroachdb", { namespace: `crdb-${r}`, context: CTX })),
      { parallel: true },
    ),

    phase("Verify", [
      shell("bash k3d/verify.sh", { env: { K3D_CONTEXT: CTX }, profile: "k8sWait" }),
    ]),

    phase("Teardown", [k3dDown(CLUSTER)]),
  ],

  // A cluster left running after a failure is a cluster nobody deletes.
  onFailure: [
    phase("Diagnose", [
      ...REGIONS.map((r) =>
        shell(
          `kubectl --context ${CTX} -n crdb-${r} get pods || true; ` +
            `kubectl --context ${CTX} -n crdb-${r} logs -l app.kubernetes.io/name=cockroachdb --tail=40 || true`,
        ),
      ),
    ]),
    phase("Teardown", [k3dDown(CLUSTER)]),
  ],
});

# cc-azure-canonical — the CC lane's canonical Azure example

The estate the config-controller azure lane (epic #1200) runs its acceptance
against: **VNet / subnets / NSG / route table** — the same VnetDefault
networking the drift acceptance (#1213) rides — plus an **AKS managedCluster
and the k8s Service on it**, synthesized by the azure and k8s lexicons,
applied per-resource by `azApply` against floci-az, for $0.

Mixed-substrate on purpose: the CC round-trip has to show both halves observed
in one read, and behold has to render them as one graph (behold#126).
floci-az k3s-backs AKS, so the cluster is real and the Service really lands
on it.

- `src/cc-network/network.ts` — VnetDefault: VNet, two subnets, NSG, route
  table. The NSG declares one rule so a clean apply proves ARM's echo of a
  declared rule normalizes away; the subnets carry real `[resourceId(...)]`
  cross-references the applier evaluates.
- `src/cc-cluster/cluster.ts` — a raw generated `AksCluster` declaring exactly
  the surface floci-az's modeled provider round-trips (test/floci-gaps.md
  entry 9 explains why not the AksCluster composite).
- `src/cc-workload/service.ts` — the k8s half, observed through the cluster's
  own kubeconfig. behold anchors it under the cluster.
- `src/cc-workload/deployment.ts` — the Deployment behind the Service, same
  shape as cc-aws-canonical's: it is what makes the K8S runtime tier
  demonstrable on this estate.
- `src/cc-workload/workload.component.ts` — the component releasing the k8s
  half (#1495): a `kubectl-apply` step whose `stack` names the same owner the
  build stamps into the manifests. The azure half has no component
  counterpart — floci-az has no deployments provider, so the ARM estate is
  applied by the `cc-azure-deploy` Op (`ops/deploy.op.ts`).

## Run it

```bash
# The docker socket mount is what lets floci-az start the k3s container
# backing the AKS cluster.
docker run -d --rm -p 4577:4577 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name floci-az floci/floci-az:0.10.0
export AZURE_ENDPOINT_URL=http://localhost:4577

npm install
npm run build      # azure lexicon -> template.json, k8s lexicon -> k8s.yaml
npm run deploy     # the cc-azure-deploy Op azApply-PUTs the estate per-resource

# Point kubectl at the cluster. floci-az 0.10.0's listClusterAdminCredential
# carries a mock token (floci-gaps entry 8), so extract the k3s admin
# kubeconfig the way the emulator's own finalize would:
docker exec $(docker ps --format '{{.Names}}' | grep floci-az-aks) \
  cat /etc/rancher/k3s/k3s.yaml \
  | sed 's#server: https://.*#server: https://127.0.0.1:6443#' > kubeconfig
export KUBECONFIG=$PWD/kubeconfig

npm run deploy-workload   # cc-workload kubectl-applies k8s.yaml
npm run status            # the kubectl-apply unit, observed by its own labels
npm run diff              # declared vs live, both substrates, one read
```

## Why the config looks like this

- **No `stacks` entry** — the azure path observes per-resource inside the
  resource group the environment names (`local`); there is no deployment
  grouping to name.
- **`ownership`** — what makes live reads answer "is this mine?" from the
  resource's own `chant-*` tags rather than a state file. `cc-workload`'s
  `stack` names the same owner, so the k8s lexicon's `describeStackStatus`
  observes the unit by the labels the build stamped.
- **`k8s.profiles.local.context: "default"`** — the k8s half binds to the
  cluster's own kubeconfig context (behold#106); `default` is the context the
  k3s admin kubeconfig names.

## The round-trip

`just azure-cc-e2e` in the chant repo runs the whole config-controller loop on
this example — apply, observe, mutate out of band, detect the drift, reconcile
source from live over the applier's own ARM transport, and compute the
rollback delta. See `test/azure-cc-e2e.md`.

## Known limits, verified rather than assumed

- floci-az 0.10.0 never transitions the cluster to `Succeeded` in Docker and
  its admin credential is a mock (floci-gaps entry 8) — readiness is the
  apiserver's own `/readyz`, reached through the extracted kubeconfig.
- The modeled managedClusters provider drops `identity`/`networkProfile`/
  `addonProfiles` and part of the pool declaration (entry 9), so the cluster
  declares only what round-trips.
- The resource-group listing omits modeled providers (entry 10), so a live
  import regenerates the networking estate while the cluster rides its
  authored source.

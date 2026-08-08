# Azure config-controller round-trip E2E

Proves chant closes the **controller loop** on Azure, not just the write half.

`azure-drift-e2e` proves the observation half on a networking estate. This
starts where that stops — that chant can apply the full canonical estate, read
it back, notice somebody changed it out of band, regenerate source from what
is live, and compute the delta that would undo it:

```
apply -> observe -> mutate-and-detect-drift -> reconcile -> rollback
```

Both substrates in one run, against floci-az, for $0. The cloud half is VNet /
subnets / NSG / route table plus an **AKS managedCluster**, applied
per-resource by `azApply` (floci-az has no deployments provider); the k8s half
is a Service (plus the Deployment behind it) on that cluster — a real one,
since floci-az k3s-backs AKS.

The example under test is `examples/cc-azure-canonical`, the azure CC lane's
canonical mixed-substrate estate (chant#1200).

## Run

```bash
just azure-cc-e2e        # or: bash test/azure-cc-e2e.sh
```

On-demand only. It needs Docker and `kubectl`, so it is **not** part of the
gating CI; it cleanly skips (exit 0) when either is missing. Override the
emulator port with `FLOCI_AZ_PORT` (default 4591).

## What each step asserts

| Step | Claim |
|---|---|
| 2 Synthesize | both lexicons emit — VNet/subnets/NSG/route table/managedCluster with the ownership marker, and the Service |
| 3 Apply | `azApply` PUTs the estate per-resource; the AKS k3s container comes up |
| 3b Kubeconfig | `listClusterAdminCredential` answers and names the cluster's endpoint; the working admin kubeconfig is extracted (see below) |
| 3c Apply (k8s) | the `cc-workload` component `kubectl-apply`s the manifest through the cluster's own kubeconfig |
| 4 Observe | one `lifecycle diff --live` covers **both** substrates; a clean apply is quiet on the property axis; `components status --live` reports the kubectl-apply unit through the stamped ownership labels |
| 5 Drift | an out-of-band NSG rule (SSH from anywhere) surfaces as property drift, attributed to the nsg, named rule by rule |
| 6 Reconcile | `import --from local --output src` regenerates TypeScript over the applier's own ARM transport, drift included, without losing a declared resource |
| 7 Rollback | `lifecycle rollback --dry-run` produces a delta that removes the drifted rule, pushes nothing, and leaves no branch |

## Three things worth knowing before changing it

**The docker socket is mounted into floci-az.** The emulator starts a k3s
container to back the AKS cluster through `/var/run/docker.sock`. Without the
mount the cluster reports `Failed`, which reads like an AKS gap and is not
one. A stale `floci-az-aks-*` container from a dead emulator holding host
port 6443 produces the same `Failed` (test/floci-gaps.md entry 8).

**The cluster's readiness is gated on the apiserver, not the emulator.**
floci-az 0.10.0 never transitions a cluster to `Succeeded` when it runs in
Docker, and its `listClusterAdminCredential` carries a mock token
(floci-gaps entry 8) — so the harness performs the emulator's own finalize
itself: `docker exec` the k3s container for `/etc/rancher/k3s/k3s.yaml`,
rewrite the server to the host-published port, and wait on `/readyz`.

**The round-trip runs in a throwaway git repo**, a copy of the example, not in
this checkout. Reconcile *rewrites* source and rollback resolves the source
dir against the repository root — running it in place would both dirty the
tree and resolve `src` to chant's own. The copy also gives rollback a real
prior commit to target.

## Scope

The reconcile step regenerates the networking estate; the AKS cluster rides
its authored source, because floci-az's resource-group listing omits modeled
providers (floci-gaps entry 10) — the harness asserts exactly that split. The
estate declares only the AKS surface the modeled provider round-trips
(floci-gaps entry 9).

This owns the chant half. behold's half of #1200's bar — the mixed-substrate
estate rendering as one graph against floci-az — is behold#126's acceptance
lane, which runs against the same example. Neither repo needs the other
checked out.

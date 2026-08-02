# AWS config-controller round-trip E2E

Proves chant closes the **controller loop** on AWS, not just the write half.

`components-aws-e2e` already proves synthesis and apply: a template becomes a
real stack. This starts where that stops — that chant can read the estate back,
notice somebody changed it out of band, regenerate source from what is live, and
compute the delta that would undo it:

```
apply -> observe -> mutate-and-detect-drift -> reconcile -> rollback
```

Both substrates in one run, against [Floci](https://floci.io) for $0. The cloud
half is VPC / subnet / EC2 / SG plus an EKS cluster; the k8s half is a Service on
that cluster — a real one, since Floci k3s-backs EKS. The apiserver is reached
through the cluster's **own kubeconfig**, on a port the emulator allocates at
creation, so nothing here may hardcode one.

The example under test is `examples/cc-aws-canonical`, the CC lane's canonical
mixed-substrate estate (chant#1198).

## Run

```bash
just aws-cc-e2e        # or: bash test/aws-cc-e2e.sh
```

On-demand only. It needs Docker, the `aws` CLI and `kubectl`, so it is **not**
part of the gating CI; it cleanly skips (exit 0) when any of those is missing.
Override the emulator port with `FLOCI_PORT` (default 4598).

## What each step asserts

| Step | Claim |
|---|---|
| 2 Synthesize | both lexicons emit — VPC/subnet/SG/instance/cluster, and the Service |
| 3 Apply | the component `cfn-deploy`s to `CREATE_COMPLETE`; EKS reaches `ACTIVE`; `kubectl` lands the Service through the cluster's kubeconfig |
| 4 Observe | one `lifecycle diff --live` covers **both** substrates, and a clean apply is quiet on the property axis |
| 5 Drift | an out-of-band `authorize-security-group-ingress` surfaces as property drift, attributed to `appSecurityGroup`, with the added CIDR named |
| 6 Reconcile | `import --from local` puts live reality back into TypeScript, drift included, without losing any declared resource |
| 7 Rollback | `lifecycle rollback --dry-run` produces a delta that removes the drifted rule, pushes nothing, and leaves no branch |

Each step failed for a different reason at some point in #1198, so the
assertions are written to name which claim broke rather than just going red.

## Three things worth knowing before changing it

**The docker socket is mounted into Floci.** Floci starts a k3s container to back
the EKS cluster and reaches the daemon through `/var/run/docker.sock`. Without
the mount the cluster reports `FAILED` with a socket error, which reads like an
EKS gap and is not one.

**The AWS lexicon bundle is built first.** `dist/meta.json` is the packaged
registry the live-import generator reads. It is a build artifact, absent from a
fresh checkout, and without it the reconcile step dies on a module-not-found
that says nothing about reconcile.

**The round-trip runs in a throwaway git repo**, a copy of the example, not in
this checkout. Reconcile *rewrites* source, and rollback resolves `sourceDir`
against the repository root — so running it in place would both dirty the tree
and resolve `src` to chant's own. The copy also gives rollback a real prior
commit to target.

## Scope

This owns the chant half. behold's half of #1198's bar — a mixed-substrate
estate rendering as one graph, component status painted from the resource
rollup — is asserted by behold's own `just e2e-aws-logical` (behold#100/#103),
which runs against the same example. Neither repo needs the other checked out.

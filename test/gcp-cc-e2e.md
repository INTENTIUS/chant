# GCP config-controller E2E

Proves chant closes the **controller loop** on GCP, the cluster-free lane —
with chant holding every REST call itself, since GCP has no deployment service
to shell out to and no Config Connector cluster in this path:

```
apply -> observe -> mutate-and-detect-drift -> remediate -> destroy
```

Against [floci-gcp](https://github.com/floci-io/floci-gcp) for $0. The estate
under test is `examples/cc-gcp-canonical`: every kind the direct-REST applier
can write (`gcp-apply.ts` MAPPERS) — GCS bucket, Pub/Sub topic + subscription,
Secret Manager secret, IAM service account, Cloud Run service.

## Run

```bash
just gcp-cc-e2e        # or: bash test/gcp-cc-e2e.sh
```

On-demand only. It needs Docker, so it is **not** part of the gating CI; it
cleanly skips (exit 0) when Docker is missing. The emulator is booted through
`chant emulator up --lexicon gcp` (#920), so the container name and port
(`chant-floci-gcp`, `:4588`) are the capability's own — an already-running
floci-gcp under that name is recycled for a clean slate.

## What each step asserts

| Step | Claim |
|---|---|
| 3 Synthesize | all six appliable kinds emit, with the project annotation merged into each manifest |
| 4 Apply | `chant run deploy` lands each resource; every kind answers its own REST resource URL |
| 5 Observe | one `lifecycle diff --live` reads all six back — through the `local` environment's declared endpoint, nothing exported — and a clean apply is quiet on both axes |
| 6 Drift | an out-of-band `storageClass` change and a label nobody declared (the #1191 class) both surface, attributed and named |
| 7 Remediate | re-applying PATCHes the drifted resource back to declared; the diff comes back clean |
| 8 Destroy | `chant run destroy` empties the estate (the bucket 404s); `chant emulator down` stops the container |

## Scope — what this run does NOT prove, and why

- **No GKE / mixed-substrate half.** #1211's issue body asks for a real GKE
  cluster with a k8s workload on it. The applier has no `ContainerCluster`
  mapper (`gcp-apply.ts` covers six kinds), so chant cannot write a cluster to
  floci-gcp; that clause waits on the mapper rather than being faked here.
- **No VPC/network resources.** floci-gcp emulates no networking
  (floci-io/floci-gcp#100 upstream); the network-reachability demonstration
  stays AWS/Azure, exactly as epic #1199's coverage note says.
- **Remediation is cloud-side, not source-side.** `chant import --from` for
  GCP still rides the kubectl/Config Connector transport
  (`lexicons/gcp/src/export-resources.ts`), which floci-gcp does not have — so
  the reconcile-to-source and rollback legs of the AWS run have no GCP
  equivalent yet. The remediation this run proves is the applier's: a
  re-apply PATCHes live back to declared.
- **The bucket declares no `uniformBucketLevelAccess`.** floci-gcp drops
  `iamConfiguration` on insert (`test/floci-gaps.md` entry 6); declaring it
  would report one honest `absent` drift on every clean apply.

## Scope — the behold half

behold's side of the lane (the GCP logical overlay, project → location →
resource) is asserted by behold's own acceptance (behold#101/#126), which
reads the same estate. Neither repo needs the other checked out.

# cc-gcp-canonical — the CC lane's canonical GCP estate

The estate the config-controller GCP lane (epic #1199) runs its acceptance
against: **every kind the direct-REST applier can write** — a GCS bucket, a
Pub/Sub topic and subscription, a Secret Manager secret, an IAM service
account and a Cloud Run service — synthesized by the gcp lexicon and applied
to [floci-gcp](https://github.com/floci-io/floci-gcp), for $0.

GCP is the cluster-free lane. There is no CloudFormation and no Config
Connector cluster in the path: `gcpApply` maps each kind to its REST API
itself, and the #1209/#1210 readers observe the estate back over the same
transport. What this estate deliberately does not carry:

- **No GKE half.** The applier has no `ContainerCluster` mapper yet, so the
  mixed-substrate clause of #1211 waits on that rather than being faked here.
- **No VPC/network.** floci-gcp emulates no networking
  (floci-io/floci-gcp#100); the reachability demonstration stays AWS/Azure.
- **No `uniformBucketLevelAccess`.** floci-gcp drops `iamConfiguration` on
  insert (`test/floci-gaps.md` entry 6), and declaring it would put one honest
  `absent` drift on every clean apply.

Files:

- `src/config.ts` — one `defaultAnnotations` binding the estate to the
  emulator's project; the applier and both readers resolve the project from it.
- `src/storage.ts` — the bucket, and the drift target: `storageClass` is the
  field the e2e edits out of band.
- `src/messaging.ts` — topic + subscription; the `topicRef` is the estate's
  reference edge, ordering the applies.
- `src/iam.ts` — service account + secret.
- `src/service.ts` — the Cloud Run workload (create/update are long-running
  operations the applier polls).
- `ops/deploy.op.ts` / `ops/destroy.op.ts` — build + `gcpApply`, and the
  `gcpDelete` inverse.

## Run it

```bash
npm install
chant emulator up --lexicon gcp    # floci-gcp on :4588

npm run deploy      # build -> dist/gcp.yaml, gcpApply -> emulator
npm run diff        # declared vs live (the local env's endpoint points reads at :4588)

npm run teardown    # gcpDelete the estate
chant emulator down --lexicon gcp
```

The whole loop — apply, observe, out-of-band mutation, drift detection,
remediation by re-apply, destroy — is scripted as `just gcp-cc-e2e`
(`test/gcp-cc-e2e.sh`), the #1211 acceptance run.

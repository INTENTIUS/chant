# local-cloud-trio

The same infrastructure — an object store — deployed to **AWS, Azure, and GCP**,
each running entirely on a **local cloud emulator** with no account, no
credentials, and no cost. One consistent demo of chant's cross-cloud applier.

Each cloud keeps its native format and native local target:

| Cloud | Resource | Synthesizes to | Applied by | Emulator |
|-------|----------|----------------|------------|----------|
| AWS   | S3 bucket | CloudFormation | `awsApply` (direct CloudFormation API) | Floci (`:4566`) |
| Azure | Storage account | ARM template | `azApply` (direct ARM CRUD) | floci-az (`:4577`) |
| GCP   | GCS bucket | Config Connector | `gcpApply` (direct GCS REST) | floci-gcp (`:4588`) |

The shape is identical; only the cloud-native details differ. That's the point:
you describe each cloud's resources as data, and one op per cloud stands them up
locally.

## Three direct appliers, one shape

There's no shared "apply verb" off-cluster, so each cloud gets a direct-API
applier that speaks its own control plane over HTTP — no CLI shell-out:

- **AWS** — `awsApply` calls the CloudFormation API (create-or-update the stack,
  then poll it to a settled state) against Floci's emulated control plane. The
  stack is the deploy boundary.
- **Azure** — floci-az has **no** `Microsoft.Resources/deployments` provider, so
  `az deployment` can't run locally. `azApply` reads the ARM template and PUTs
  each resource directly to floci-az's ARM resource CRUD.
- **GCP** — GCP has no native deployment service (Deployment Manager is retired,
  Config Connector needs a cluster), so `gcpApply` maps each resource to a GCS
  REST call itself.

In every case the deployer code is exercised end-to-end against a real,
AWS/Azure/GCP-shaped API — a fast, free, offline integration test of "the code
that stands things up." (`nativeApply` remains for anyone who'd rather delegate
to `aws cloudformation deploy` / `kubectl` / `az deployment`.)

## Run it

Requires only Docker. Every op's emulator lifecycle, apply, and verify are typed
activities — no `aws`/`az`/`gcloud`/`curl` on PATH.

```bash
npm install

chant run aws     # S3 bucket → Floci
chant run azure   # storage account → floci-az
chant run gcp     # GCS bucket → floci-gcp
```

Each op boots the cloud's emulator, builds that cloud's stack, applies it,
verifies the resource exists, and tears the emulator down — every phase a
modeled activity (`flociAzUp`/`gcpApply`/`httpCheck`/…), not a shell script.

## Real cloud

The same stacks and appliers target real cloud by dropping the `endpoint`
override — the local emulator is just an endpoint swap. (Against real cloud the
appliers need the credential layer each API expects — SigV4 for AWS, tokens for
Azure/GCP; local Floci accepts unsigned calls.)

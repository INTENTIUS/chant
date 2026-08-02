# cc-aws-canonical — the CC lane's canonical AWS example

The estate the config-controller AWS lane (epic #1198) runs its acceptance
against: **VPC / subnet / EC2 / SG** — real network containment — plus an **EKS
cluster and the k8s Service on it**, synthesized by the AWS and k8s lexicons and
released by one component, on the Floci emulator, for $0.

Mixed-substrate on purpose: the CC round-trip has to show both halves observed
in one read, and behold has to render them as one graph. Floci k3s-backs EKS, so
the cluster is real and the Service really lands on it.

- `src/cc-network/network.ts` — VPC, public + private subnet, internet gateway,
  route table and associations. No NAT gateway or EIP: they cost time on a real
  account and nothing in this lane reads them.
- `src/cc-app/app.ts` — a security group and the instance inside it, in the
  private subnet. The security group is the one deep-readable type in this set
  (#1269), so it is the drift target #1207 proved.
- `src/cc-cluster/cluster.ts` — the managed cluster the workload runs on. Its
  apiserver port is allocated by the emulator at creation, so nothing may
  hardcode it (behold#106).
- `src/cc-workload/service.ts` — the k8s half, observed through the cluster's own
  kubeconfig. behold anchors it under the cluster (behold#103).
- `src/cc.component.ts` — one component owning every declared resource via
  `liveNames`, which is what makes `chant components status --live` report a
  real rollup rather than the rollup-of-one an identity join produces.

## Run it

```bash
docker run -d --rm -p 4566:4566 --name floci floci/floci:latest
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

npm install
npm run build      # AWS lexicon -> template.json, k8s lexicon -> k8s.yaml
npm run deploy     # the component cfn-deploys it
npm run status     # one row, with the resource rollup behold#100 paints from
npm run diff       # declared vs live
```

Expect `status` to report all ten resources present:

```json
{ "component": "cc-canonical", "live": true,
  "stack": { "name": "cc-canonical", "status": "CREATE_COMPLETE", "healthy": true },
  "resources": { "total": 10, "present": 10, "absent": 0, "unobserved": 0 } }
```

Tear down with `npm run teardown`, then `docker stop floci`.

## Why the config looks like this

`stacks` and `sourceDir` are both load-bearing rather than decorative:

- **`stacks`** — without it, observation falls back to the single-stack
  convention (the stack named after the environment) and looks for a stack
  called `local`. The component deploys `cc-canonical`, so every declared
  resource would come back absent.
- **`sourceDir: "src"`** — behold hands the resolved source directory to `chant
  graph`, and component discovery scans from there, so `cc.component.ts` lives
  under `src/` rather than at the project root.

## The round-trip

`just aws-cc-e2e` in the chant repo runs the whole config-controller loop on
this example — apply, observe, mutate out of band, detect the drift, reconcile
source from live, and compute the rollback delta. See `test/aws-cc-e2e.md`.

## What it is the vehicle for

- **behold#100** (B·aws) — its acceptance run is behold's
  `just e2e-aws-logical`, pointed here with `BEHOLD_E2E_PROJECT`. That asserts
  component status painted from the resource rollup, the live overlay, and the
  nested `region -> VPC -> subnet ⊃ component ⊃ resource` architecture diagram.
- **#1208** (E·aws) — the CC round-trip, both halves (`just aws-cc-e2e`).

## Known limits, verified rather than assumed

- Only the security group is deep-readable, so `lifecycle diff --live` reports
  the other eight resources as unobserved ("no reader for this resource kind").
  That is #1269/#1271, not a defect here.
- The rollup counts `describe-stack-resources`, which is CloudFormation's own
  inventory. Terminating the instance out of band leaves it listed
  `CREATE_COMPLETE` and the rollup still reports it present — so the rollup is
  finer-grained than the stack verdict, but not yet an independent existence
  check on AWS.

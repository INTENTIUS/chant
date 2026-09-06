# lifecycle-reconcile-aws

A self-contained walkthrough of chant's lifecycle loop on a real AWS account:

```
deploy → drift → import / diff → reconcile (cloud → code) / apply (code → cloud)
```

The stack is deliberately small — a default VPC (`src/`) — because the lifecycle
workflow is identical for any declared stack. Ownership marking is on
(`chant.config.ts`), so reconcile/apply can scope deletes to chant-owned
resources only.

> **This is a real-cloud E2E.** The steps below create and destroy AWS
> infrastructure and require credentials. CI only builds the example
> (`npm run build`); it never deploys. Run the live steps yourself per the
> repo's E2E policy.

## Prerequisites

- AWS credentials with CloudFormation + VPC permissions (`aws sts get-caller-identity` works)

## 1. Build & deploy

```bash
npm install
npm run build          # src/ → template.json (resources carry the chant ownership marker)
npm run deploy         # CloudFormation stack "prod"
```

## 2. Introduce drift

Change something out-of-band so the cloud no longer matches source — e.g. tag
the VPC by hand in the console, or:

```bash
aws ec2 create-tags --resources <vpc-id> --tags Key=DriftedBy,Value=console
```

## 3. See the drift

```bash
npm run diff           # chant lifecycle diff prod --live
```

`diff` reports a three-way comparison (declared / live-now / last-snapshot) and a
typed change set: `create` / `update` / `delete` / `adopt` / `noop`. An
undeclared live resource is `adopt`, never `delete`, unless it carries chant's
ownership marker.

## 4a. Reconcile (cloud → code)

Pull the live state back into source and open a PR for the drift:

```bash
npm run reconcile      # chant run prod-reconcile  (ReconcileOp, owned-only)
```

`ReconcileOp` runs one-shot on the local executor. Add a `schedule` (see
`src/reconcile.op.ts`) and `chant operator` — or a generated CI cron — ticks it
continuously.

## 4b. Apply (code → cloud)

Push declared source to the cloud via native CloudFormation deploy, with an
approval gate before any destructive change:

```bash
npm run apply          # chant run prod-apply  (ApplyOp)
```

`apply.op.ts` has an approval gate (`delete: "gated"`), and a gate is a fact
rather than a wait. The first run reads chant's gate ledger, finds no
resolution, records the gate as pending and ends with exit 3 — nothing is held
open. Record the answer and run it again:

```bash
chant approve prod-apply approve-prod-apply --approver you
npm run apply
```

The second run walks through the gate carrying the approver and applies.
Deletes ride the marker-scoped CloudFormation path, so they only ever touch
chant-owned orphans. Partial failures trigger a saga-style rollback.

## 5. Tear down

```bash
npm run teardown       # delete the CloudFormation stack
```

## Files

| Path | Role |
|---|---|
| `src/` | the declared stack (default VPC) |
| `chant.config.ts` | lexicons, environments, **ownership** marking |
| `src/reconcile.op.ts` | `ReconcileOp` — cloud → code, owned-only, PR on drift |
| `src/apply.op.ts` | `ApplyOp` — code → cloud, CloudFormation, gated destructive apply |

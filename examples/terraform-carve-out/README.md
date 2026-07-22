# Terraform carve-out

Practice carving a resource out of a Terraform estate into native chant,
incrementally and reversibly. The `terraform/` directory is a small estate to
carve from.

The **advise** and **bridge** steps run offline — no cloud, no Terraform state.
The **emit** and **apply** steps adopt a live resource and are shown as the
live steps.

## Prerequisites

The advisor parses HCL with `@cdktf/hcl2json`, installed on demand:

```bash
npm install -D @cdktf/hcl2json
```

## 1. See what is cheap to carve (offline)

```bash
chant carve advise --from ./terraform
```

You will see the estate ranked into three bands: clean leaves (carve now),
carvable with edits (has boundary work), and leave in Terraform (unmappable or
load-bearing). `aws_cloudwatch_log_group.api` is a clean leaf; `aws_vpc.main`
is carvable with edits (three subnets depend on it); `random_pet.suffix` has no
native mapping.

## 2. See the boundary of one resource (offline)

```bash
chant carve bridge --from ./terraform --select aws_s3_bucket.assets --output ./carveout
```

This writes, to `./carveout/`, the `data` source the surviving Lambda will read,
the rewritten `api.tf` (references rewired to the data source), and a reversible
runbook. Nothing in `./terraform` changes. Add `--apply-rewrites` to edit the
survivor `.tf` in place.

## 3. Adopt the live resource into chant (live)

```bash
chant carve emit --from ./terraform --select aws_s3_bucket.assets --env prod
```

Adopts the live bucket into typed chant source via the cloud→code import path,
and reports its boundary. The resource now sits at the observe position:
emitted, reversible, nothing applied.

## 4. Hand off Terraform, then graduate (live)

```bash
# Terraform stops managing the bucket — does NOT destroy it
terraform state rm aws_s3_bucket.assets

# apply the bridge patch so the survivors' plan stays valid
terraform plan && terraform apply

# graduate: resolve the ownership marker + finalized runbook
chant carve apply --from ./terraform --select aws_s3_bucket.assets --env prod --stack assets
```

Rollback at any point before graduation:

```bash
terraform import aws_s3_bucket.assets myapp-assets-prod
```

See the [carve CLI reference](https://intentius.io/chant/cli/carve-out/) for the
full flag list.

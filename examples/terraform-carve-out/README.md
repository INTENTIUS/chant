# Terraform carve-out

Practice carving a resource out of a Terraform estate into native chant,
incrementally and reversibly. The `terraform/` directory is a small estate to
carve from, with a `terraform.tfstate` so the whole flow runs **offline** — no
cloud, no Terraform binary.

## Run the whole demo

```bash
./demo.sh
```

That runs all four steps (advise → emit → bridge → apply) with commentary.
Agents can drive the same demo via the `chant-aws-carve-terraform` skill.

The steps individually are below.

## Prerequisites

The advisor parses HCL with `@cdktf/hcl2json`, installed on demand:

```bash
npm install -D @cdktf/hcl2json
```

## 1. See what is cheap to carve

```bash
chant carve advise --from ./terraform
```

The estate ranks into three bands: clean leaves (carve now), carvable with edits
(has boundary work), and leave in Terraform (unmappable or load-bearing).
`aws_cloudwatch_log_group.api` is a clean leaf; `aws_vpc.main` is carvable with
edits (three subnets depend on it); `random_pet.suffix` has no native mapping.

## 2. Adopt a resource into chant source (offline, from state)

```bash
chant carve emit --from ./terraform --select aws_s3_bucket.assets \
  --state ./terraform/terraform.tfstate --output ./carveout
```

Writes `./carveout/assets.ts` — a real `new Bucket({ BucketName, Tags })` with
CloudFormation-style properties mapped from the Terraform state attributes. A
Terraform-managed resource is not in any CloudFormation stack, so the state file
is the correct source of its live shape. (`--env <env>` adopts a
CloudFormation-managed resource live instead.)

## 3. Bridge the boundary

```bash
chant carve bridge --from ./terraform --select aws_s3_bucket.assets --output ./carveout
```

Writes the `data "aws_s3_bucket" "assets"` block the surviving Lambda will read,
the rewritten `main.tf` (references rewired to the data source), and a reversible
runbook. Nothing in `./terraform` changes. Add `--apply-rewrites` to edit the
survivor `.tf` in place.

## 4. Graduate

```bash
chant carve apply --from ./terraform --select aws_s3_bucket.assets --env prod --stack assets
```

Resolves the ownership marker + finalized runbook. No cloud call — the apply is
your lifecycle.

## Going live

The real handoff adds three Terraform commands between steps 3 and 4:

```bash
terraform state rm aws_s3_bucket.assets   # stop managing it — does NOT destroy
terraform plan && terraform apply          # apply the bridge patch to survivors
```

Rollback at any point before graduation:

```bash
terraform import aws_s3_bucket.assets myapp-assets-prod
```

See the [carve CLI reference](https://intentius.io/chant/cli/carve-out/) for the
full flag list.

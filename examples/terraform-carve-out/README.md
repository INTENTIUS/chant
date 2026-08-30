# Terraform carve-out

Practice carving a resource out of a Terraform estate into native chant,
incrementally and reversibly. The `terraform/` directory is a small estate to
carve from, with a `terraform.tfstate` so the whole flow runs **offline** — no
cloud, no Terraform binary.

## Run the whole demo

```bash
./demo.sh
```

That runs the full flow (advise → emit → audit → bridge → apply) with
commentary. Agents can drive the same demo via the `chant-aws-carve-terraform`
skill.

The steps individually are below. The
[carve tutorial](https://intentius.io/chant/tutorials/terraform-carve-out/)
walks them with full output.

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

Writes `./carveout/src/assets.ts` — a real `new Bucket({ ... })` with
CloudFormation-style properties mapped from the Terraform state attributes, the
`aws_s3_bucket_versioning` sub-resource folded into `VersioningConfiguration` —
and scaffolds `./carveout` into a buildable chant project (`chant.config.ts`,
`package.json`, `tsconfig.json`). It also persists a carve manifest
(`aws_s3_bucket-assets.carve.json`): the later steps read the target from it,
so `--select` is only needed once. A Terraform-managed resource is not in any
CloudFormation stack, so the state file is the correct source of its live
shape. (`--env <env>` adopts a CloudFormation-managed resource live instead.)

## 3. Audit what you adopted

```bash
chant build ./carveout/src --lexicon aws
```

The first build **fails, deliberately**: the adopted bucket faithfully carries
Terraform's missing security posture, and chant's post-synth audit refuses an
S3 bucket without a public-access block and a TLS-only policy. Add both to
`src/assets.ts` (the tutorial shows the exact code) and the build produces a
valid CloudFormation template. That audit is part of the value: chant tells
you what is wrong with what you adopted.

## 4. Bridge the boundary

```bash
chant carve bridge --from ./terraform --output ./carveout
```

Writes the `data "aws_s3_bucket" "assets"` block the surviving Lambda will read,
the rewritten `main.tf` (references rewired to the data source, the carved
`resource` block and its folded versioning sub-resource excised), a reversible
runbook, and one git-applyable `*-bridge.patch` carrying the whole edit.
Nothing in `./terraform` changes. Add `--apply-rewrites` to edit the survivor
`.tf` in place.

## 5. Graduate

```bash
chant carve apply --from ./terraform --output ./carveout --env prod --stack assets --write-source
```

Resolves the ownership marker + graduation runbook, and stamps the
`chant:managed-by` / `chant:stack` / `chant:env` tags into the emitted source.
No cloud call — the apply is your lifecycle.

## Carving Kubernetes instead

`kubernetes/` is a second estate, managing Kubernetes objects through the
Terraform kubernetes provider:

```bash
chant carve advise --from ./kubernetes
chant carve emit --from ./kubernetes --select kubernetes_manifest.web_cert \
  --state ./kubernetes/terraform.tfstate --output ./carveout-k8s
chant build ./carveout-k8s/src --lexicon k8s
```

A `kubernetes_manifest` has no fixed kind — the body is the object — so emit
reads `apiVersion`/`kind` out of the manifest in state and writes it back
through `k8sManifest`, the lexicon's verbatim escape hatch. The same rule
carves the cert-manager `Certificate` in that estate as carves a core
ConfigMap. The typed provider resources (`kubernetes_config_map` and friends)
are ranked but refused by emit, `--env` is refused (no type to filter a live
export by until the body is read), and `carve bridge` refuses the manifest
types until they have a data-source mapping (chant #2034).

## Going live

The real handoff adds three Terraform commands between steps 4 and 5:

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

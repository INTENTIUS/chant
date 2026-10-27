---
skill: chant-aws-carve-terraform
description: Demo moving one Terraform resource to native CloudFormation, fully offline (advise, emit, audit, bridge, apply); Terraform keeps the rest
user-invocable: true
---

# Move one Terraform resource to CloudFormation (demo)

Use this skill to demonstrate chant's carve flow, which moves one resource
from a Terraform estate to chant source for the AWS lexicon. The whole demo
runs **offline**, with no cloud account, Terraform binary or state backend. It
moves an S3 bucket from a small Terraform estate to chant source, patches the
resources that stay in Terraform, and plans the graduation.

## When to use

- Someone asks how chant can manage one resource from a Terraform root as
  native CloudFormation.
- Someone on Terraform or OpenTofu asks how to get chant's ownership markers
  on their resources. Point them at choudoufu instead
  (`terraform.binary: "choudoufu"`, see
  https://intentius.io/chant/lexicons/terraform/ops/#choudoufu). Their roots
  stay in OpenTofu.
- You want to show the advise → emit → audit → bridge → apply loop end to end.
- You are evaluating whether a Terraform estate is worth carving.

## Preconditions

- `chant --version` succeeds.
- `@cdktn/hcl2json` is installed (the HCL parser). If a command reports it is
  missing, run `npm install -D @cdktn/hcl2json` once.

## The fastest path: run the bundled demo

The `examples/terraform-carve-out` example ships a runnable estate + state and a
script that runs all five steps with commentary:

```bash
cd examples/terraform-carve-out
./demo.sh
```

Walk the person through the output. That is the whole demo.

## Driving it step by step (to explain each stage)

From `examples/terraform-carve-out`, with `TF=./terraform`:

1. **Advise: rank the resources.**
   ```bash
   chant carve advise --from ./terraform
   ```
   Point out the three bands: clean leaves (carve now), carvable with edits,
   and stays in Terraform (`leave in Terraform` in the JSON). `aws_s3_bucket.assets` is a clean leaf held back one
   notch by the Lambda that reads it; `random_pet` has no native mapping.

2. **Emit — adopt the bucket into chant source, offline, from state.**
   ```bash
   chant carve emit --from ./terraform --select aws_s3_bucket.assets \
     --state ./terraform/terraform.tfstate --output ./carveout
   ```
   Show `./carveout/src/assets.ts` — a real `new Bucket({ BucketName, Tags })` with
   CloudFormation-style properties mapped from the Terraform state attributes,
   and the `aws_s3_bucket_versioning` sub-resource folded into
   `VersioningConfiguration`. Emit also scaffolds `./carveout` into a buildable
   chant project (`chant.config.ts`, `package.json`) and persists a carve
   manifest (`*.carve.json`) — bridge and apply read the target from it, so
   `--select` is only needed once. Explain: a Terraform-managed resource is not
   in any CloudFormation stack, so the correct source of its live shape is the
   state file, not a cloud read.

3. **Audit the inherited resource.**
   ```bash
   chant build ./carveout/src --lexicon aws
   ```
   The first build fails, deliberately: the post-synth audit refuses the
   adopted bucket because it has no public-access block or TLS-only policy.
   This is a feature of carving: chant tells the person which settings the
   adopted resource is missing. Show the fix (add
   `PublicAccessBlockConfiguration` and a companion `S3BucketPolicy` with an
   `aws:SecureTransport = false` Deny — the tutorial page has the exact code),
   then re-run the build and show the valid CloudFormation template.

4. **Bridge — patch the surviving Terraform.**
   ```bash
   chant carve bridge --from ./terraform --output ./carveout
   ```
   Show the generated `data "aws_s3_bucket" "assets"` and the rewired survivor.
   Emphasize it is dry-run: nothing in `./terraform` changed. `--apply-rewrites`
   would edit it in place.

5. **Apply — graduation plan.**
   ```bash
   chant carve apply --from ./terraform --output ./carveout --env prod --stack assets
   ```
   Show the ownership marker (`chant:managed-by/stack/env`) and the finalized
   runbook. `--write-source` additionally stamps the marker tags into the
   emitted source. Stress this makes no cloud call — the apply is the person's
   own lifecycle; chant just plans it.

## Key points to land

- Nothing is destroyed or applied; every step before graduation is reversible
  with `terraform import`.
- You carve one resource at a time. Everything else stays in Terraform, where
  it already works.
- `advise` and `bridge` work against **any** Terraform tree — offer to point
  them at the person's own estate.

## Going live (only if asked)

The real handoff adds three Terraform commands between bridge and apply:
`terraform state rm <addr>` (stops managing it, does not destroy), then
`terraform plan && terraform apply` to land the survivor patch. See the
generated runbook in `./carveout/<addr>-runbook.md`.

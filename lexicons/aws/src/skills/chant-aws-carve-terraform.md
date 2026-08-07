---
skill: chant-aws-carve-terraform
description: Demo carving a resource out of Terraform into native chant — advise, emit, bridge, apply — fully offline
user-invocable: true
---

# Carve a resource out of Terraform (demo)

Use this skill to cleanly demonstrate chant's Terraform carve-out flow for
someone. The whole demo runs **offline** — no cloud account, no Terraform
binary, no state backend. It carves an AWS S3 bucket out of a small Terraform
estate into native chant source, patches the survivors, and plans the
graduation.

## When to use

- Someone asks "how does chant move things off Terraform?"
- You want to show the advise → emit → bridge → apply loop end to end.
- You are evaluating whether a Terraform estate is worth carving.

## Preconditions

- `chant --version` succeeds.
- `@cdktf/hcl2json` is installed (the HCL parser). If a command reports it is
  missing, run `npm install -D @cdktf/hcl2json` once.

## The fastest path: run the bundled demo

The `examples/terraform-carve-out` example ships a runnable estate + state and a
script that runs all four steps with commentary:

```bash
cd examples/terraform-carve-out
./demo.sh
```

Walk the person through the output. That is the whole demo.

## Driving it step by step (to explain each stage)

From `examples/terraform-carve-out`, with `TF=./terraform`:

1. **Advise — what is cheap to carve.**
   ```bash
   chant carve advise --from ./terraform
   ```
   Point out the three bands: clean leaves (carve now), carvable with edits,
   and leave-in-Terraform. `aws_s3_bucket.assets` is a clean leaf held back one
   notch by the Lambda that reads it; `random_pet` has no native mapping.

2. **Emit — adopt the bucket into chant source, offline, from state.**
   ```bash
   chant carve emit --from ./terraform --select aws_s3_bucket.assets \
     --state ./terraform/terraform.tfstate --output ./carveout
   ```
   Show `./carveout/src/assets.ts` — a real `new Bucket({ BucketName, Tags })` with
   CloudFormation-style properties mapped from the Terraform state attributes.
   Emit also scaffolds `./carveout` into a buildable chant project
   (`chant.config.ts`, `package.json`), so `npm install && npm run build` works
   there as-is. Explain: a Terraform-managed resource is not in any
   CloudFormation stack, so the correct source of its live shape is the state
   file, not a cloud read.

3. **Lint the inherited resource — optional, offer it.**
   ```bash
   chant lint ./carveout/src --lexicon aws
   ```
   After emit, offer to lint the carved source. chant audits the resource you
   inherited from Terraform against the AWS lexicon's rules. Findings have a
   severity: `error` (must fix before `chant build` will emit — e.g. an S3
   bucket with no public-access block) and `warning`/`info` (advisory — e.g.
   DynamoDB point-in-time recovery). This is a feature of carving: chant
   immediately tells the person what is wrong with what they adopted. Whether to
   fix an advisory finding is their call; errors block the build until resolved.

4. **Bridge — patch the surviving Terraform.**
   ```bash
   chant carve bridge --from ./terraform --select aws_s3_bucket.assets --output ./carveout
   ```
   Show the generated `data "aws_s3_bucket" "assets"` and the rewired survivor.
   Emphasize it is dry-run: nothing in `./terraform` changed. `--apply-rewrites`
   would edit it in place.

5. **Apply — graduation plan.**
   ```bash
   chant carve apply --from ./terraform --select aws_s3_bucket.assets --env prod --stack assets
   ```
   Show the ownership marker (`chant:managed-by/stack/env`) and the finalized
   runbook. Stress this makes no cloud call — the apply is the person's own
   lifecycle; chant just plans it.

## Key points to land

- Nothing is destroyed or applied; every step before graduation is reversible
  with `terraform import`.
- You carve one resource at a time. The gnarly long tail stays in Terraform.
- `advise` and `bridge` work against **any** Terraform tree — offer to point
  them at the person's own estate.

## Going live (only if asked)

The real handoff adds three Terraform commands between bridge and apply:
`terraform state rm <addr>` (stops managing it, does not destroy), then
`terraform plan && terraform apply` to land the survivor patch. See the
generated runbook in `./carveout/<addr>-runbook.md`.

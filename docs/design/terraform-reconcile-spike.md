# Terraform reconcile: `import {}` plus `-generate-config-out` (#2089)

Research spike against #2089, sub-issue 8 of epic #2081. Five questions with evidence, plus
the end-to-end example the issue asks for, run for real against the floci AWS emulator.
Terraform v1.15.8, `hashicorp/aws` v5.100.0, `floci/floci:latest` on port 4597.

## 1. Where the `import {}` blocks come from

Terraform will not say. The example below creates a bucket outside Terraform and
`terraform plan -detailed-exitcode` still exits 0 with "No changes": a stock plan compares
the configuration to the state file, and an object in neither is invisible to it. So the
address and the cloud id must arrive from elsewhere, and `-generate-config-out` is only the
second half of the mechanism. Four candidate sources, none producing both halves.

The lexicons' observation reads are scoped to the declared set by construction.
`describeResources` takes `entityNames` and `entities` and returns a map keyed by chant entity
name (`packages/core/src/lexicon.ts:1023`; its doc at `:1107` says it is scoped to what the
stack declares). AWS reads `DescribeStackResources` for one stack
(`lexicons/aws/src/plugin.ts:564`); gcp and azure do one GET per declared entity
(`lexicons/gcp/src/describe-resources.ts:176`, `lexicons/azure/src/describe-resources.ts:128`).
Each gives a physical id for something already declared, the case needing no import block. The
one exception, `enumerateOutOfBandChildren` (`lexicons/aws/src/deep-observe.ts:757`), returns
undeclared resources, but only children of declared parents and only for the two types in
`DEEP_CHILD_SOURCES` (`:168`).

The live export path is the only chant read whose input is a scope rather than a declared set:
`exportResources` (`packages/core/src/lexicon.ts:1483`) takes `environment`, `stack`, `region`,
`selector` and no entity list. Azure enumerates a whole resource group
(`lexicons/azure/src/export-resources.ts:98`); gcp sweeps every Config Connector kind in a
cluster (`lexicons/gcp/src/export-resources.ts:37`). AWS, the cloud the example needs, is the
weak one: `lexicons/aws/src/import/live-export.ts:15` parses one CloudFormation stack template,
so it enumerates stack members and nothing else. The primitive for an account-wide sweep exists
and nothing calls it unscoped: `listResources(typeName, options, resourceModel?)` at
`lexicons/aws/src/api/read-client.ts:517`, a paginated Cloud Control listing whose
`resourceModel` narrowing is optional.

Third-party enumerators solve the physical half and take over the logical half. Terraformer
and terracognita write `.tf` and a state file directly rather than emitting `import` blocks,
and both invent their own resource names, so adopting either means adopting its naming,
coverage and cadence inside a lexicon whose promise is that the estate's HCL stays the
practitioner's. An aws-nuke style lister gives ids and types with no address.

choudoufu's `live-ls -estate -json` yields both halves and is already read here (`readLiveLs`
at `lexicons/terraform/src/describe-resources.ts:659`, `observeAmbient` at `:781`), off the
Resource Groups Tagging API with no configuration read, because choudoufu writes `tofu-estate`
and `tofu-address` tags on create. That answers only for resources choudoufu created, which
also needs no import block.

The residue: nothing in the repo produces a logical address for an undeclared resource.
`outOfBandChildName` (`lexicons/aws/src/deep-observe.ts:193`, `"Type:identifier"`) is the only
naming convention for one, and it is not an HCL address.

## 2. Which cloud enumerates, and the epic boundary

Reusing the aws, gcp or azure live reads is acceptable against #2081's stated boundaries, and
still the wrong first move.

"One shared parser and nothing else" constrains the relationship to carve
(`packages/core/src/terraform/parse.ts`), not the relationship to other lexicons. "No
synthesis" constrains what the serializer emits, and holds literally:
`lexicons/terraform/src/serializer.ts:23` returns `""`, and under this design Terraform's own
binary writes the HCL. Neither rule forbids calling `exportResources`.

What forbids it in practice is that the dependency buys nothing for AWS today. The AWS
exporter reads one CloudFormation stack, so an estate running Terraform usually has no stack
to read, and the resources worth importing are exactly the ones no stack declares. Making it
useful means calling `listResources` unscoped per type: an account-wide sweep with a type
list, a pagination budget and a cost profile, which belongs in the aws lexicon under its own
issue. So the answer is that no enumeration source is ready today, on any of the three
clouds, that yields `(address, id)` pairs for a stock root. Azure and gcp produce the id half
at scope, aws does not, none produces the address half.

## 3. Where the generated file lands

Terraform decides more of this than the issue assumed, and decides it narrowly.

`-generate-config-out` writes one flat file of root-module `resource` blocks carrying every
attribute the provider returned, computed ones such as `tags_all` included, and refuses to
write over an existing file ("Do not supply a path to an existing file, or Terraform throws an
error",
[generating configuration](https://developer.hashicorp.com/terraform/language/import/generating-configuration)).
Reproduced below.

The harder constraint is that the target address must be in the root module. An `import`
block naming `module.buckets.aws_s3_bucket.in_module` fails generation with "Only resources
within the root module are eligible for config generation" (captured below). For an estate
whose resources live in modules, which is most estates worth wrapping, the generator produces
a starting point at the root and nothing where a reviewer wants it. Moving it is a human
edit: rename the block, move it into the module, delete the computed attributes, re-point the
`import` block. chant cannot decide that, and a PR is the right shape for handing it over.

## 4. Does the ownership answer hold

It holds, and the pre-import window is visible rather than wrong.

`classifyStateOwnership` (`lexicons/terraform/src/describe-resources.ts:241`) is
`index.rows.has(address) ? "owned" : "unknown"`, over an index built from `terraform show
-json` (`indexStateResources`, `:204`). So once the generated HCL is committed, `buildRoots()`
makes an entity for the new block, `show -json` has no row for its address, and
`describeResources` reports `unknown`; after `terraform apply` lands the import, the address
appears in state and the same call reports `owned`. Both halves are reproduced below.

`unknown` never escalates to a delete, which the module doc already states (`:30`). Worth
writing down: a reconcile PR deliberately adds `unknown` entities to the build, and a watch
running between the merge and the apply reports them as `unknown`, correctly.

## 5. Terraform lexicon, or a `chant import` backend

Neither, as framed. It is a third thing.

Every other lexicon's cloud-to-code path runs live read to `TemplateIR` to TypeScript:
`exportResources` returns `ExportedTemplate` (`packages/core/src/lexicon.ts:1596`),
`liveImportFromPlugins` (`packages/core/src/cli/commands/import.ts:462`) merges the IR and
renders it through the first exporter's `templateGenerator()`, and core writes the files.
`reconcilePr` drives that in one line, `chant import --from <env> --output <output> --force`
(`packages/core/src/op/activities/reconcile.ts:175`), then commits `<output>` and opens the
PR. The terraform lexicon implements none of `exportResources`, `templateParser` or
`templateGenerator`, by the "no synthesis" decision rather than by omission.

Making this a `chant import` backend means that lexicon growing a `templateGenerator` that
emits HCL, the thing the epic ruled out and the thing `-generate-config-out` exists to avoid.
The shape that fits is a terraform-lexicon activity, `terraformGenerateConfig`, taking
`(address, id)` pairs, writing the `import` blocks, running the generator, and handing the two
files to `reconcilePr` with `mode: "pull-request"` and a caller-supplied `body`, the way
`TerraformWatchOp` already hands it the `-no-color` plan
(`lexicons/terraform/src/composites/terraform-watch-op.ts:255`). That reuses the one place in
chant that shells to `gh pr create` without pretending HCL is regenerated TypeScript, and
needs one change to `reconcilePr`: a mode that commits files the caller already wrote.

## Worked example (run, floci on :4597)

Provider pointed at the emulator with `endpoints {}` (s3, sts, iam on `http://localhost:4597`)
plus the flags the e2e scripts use (`test/components-aws-e2e.sh:45`):
`skip_credentials_validation`, `skip_metadata_api_check`, `skip_requesting_account_id`,
`s3_use_path_style`, `test`/`test` credentials. One managed resource, `aws_s3_bucket.managed`.

```
$ terraform init && terraform apply -auto-approve
aws_s3_bucket.managed: Creation complete after 0s [id=spike-managed]

$ AWS="aws --endpoint-url http://localhost:4597"
$ $AWS s3api create-bucket --bucket spike-created-by-hand
$ $AWS s3api put-bucket-tagging --bucket spike-created-by-hand \
    --tagging 'TagSet=[{Key=Owner,Value=ops-oncall}]'
$ $AWS s3api list-buckets --query 'Buckets[].Name' --output text
spike-managed	spike-created-by-hand

$ terraform plan -detailed-exitcode
No changes. Your infrastructure matches the configuration.
exit=0
```

That exit 0 is question 1: the unmanaged bucket is not drift, it is nothing.

```
$ cat imports.tf
import {
  to = aws_s3_bucket.adopted
  id = "spike-created-by-hand"
}

$ terraform plan -generate-config-out=generated.tf
Plan: 1 to import, 0 to add, 0 to change, 0 to destroy.
Warning: Config generation is experimental
Terraform has generated configuration and written it to generated.tf.

$ cat generated.tf
# __generated__ by Terraform from "spike-created-by-hand"
resource "aws_s3_bucket" "adopted" {
  bucket              = "spike-created-by-hand"
  force_destroy       = null
  object_lock_enabled = false
  tags     = { Owner = "ops-oncall" }
  tags_all = { Owner = "ops-oncall" }
}

$ terraform apply -auto-approve
aws_s3_bucket.adopted: Import complete [id=spike-created-by-hand]
Apply complete! Resources: 1 imported, 0 added, 0 changed, 0 destroyed.

$ terraform plan -detailed-exitcode
No changes. Your infrastructure matches the configuration.
exit=0
```

The no-op the issue asked for. It takes an `apply`; generation alone leaves `Plan: 1 to
import`. Ownership (question 4), on a third bucket whose generated block is in place but whose
import has not landed:

```
$ terraform show -json | jq -c '[.values.root_module.resources[].address]'   # before
["aws_s3_bucket.adopted","aws_s3_bucket.managed"]            # aws_s3_bucket.third -> unknown
$ terraform apply -auto-approve      # Import complete [id=spike-third-by-hand]
$ terraform show -json | jq -c '[.values.root_module.resources[].address]'   # after
["aws_s3_bucket.adopted","aws_s3_bucket.managed","aws_s3_bucket.third"]      # -> owned
```

Two limits, question 3:

```
$ terraform plan -generate-config-out=generated.tf
Error: Target generated file already exists

$ terraform plan -generate-config-out=generated-mod.tf    # to = module.buckets.aws_s3_bucket.in_module
Error: Configuration for import target does not exist
Resource module.buckets.aws_s3_bucket.in_module not found. Only resources
within the root module are eligible for config generation.
```

One honest failure: the same flow on an SQS queue generated HCL Terraform then refused.

```
$ terraform plan -generate-config-out=generated-q.tf
Error: expected max_message_size to be in the range (1024 - 262144), got 1048576
  with aws_sqs_queue.adopted_q, on generated-q.tf line 6
```

The out-of-range value came from the emulator, so this reading is a floci artifact rather than
an AWS one. The class of failure is not: generation copies live attributes into HCL without
validating them, and HashiCorp documents the same shape for conflicting arguments. A generated
file is a draft that may not plan. Floci was torn down after the run.

## Composition with `TerraformAdoptOp`

Two mechanisms, one dial position, and they do not merge. On a live root (#2105, shipped in
#2142) ownership is a pair of tags, the configuration already describes the resource, and
reconcile is a tag write that claims it. On a stock root the configuration does not mention
the resource, so reconcile is authoring HCL in someone else's module layout, and the state
file calls it owned only after an `apply`. The inputs differ (an estate sweep already
carrying addresses, versus an enumeration with no address to carry), the write differs (two
tags, versus a commit, a merge and an apply), and the latency to `owned` differs.

They can share the reporting surface. `TerraformWatchOp` already branches on `live` for its
Plan step and publishes different outcome attributes off it (`terraform-watch-op.ts:234-243`).
A stock generator Op would be a third composite beside `TerraformApplyOp` and
`TerraformAdoptOp`, gating on the same `reconcilePr` call, with the `live` branch left where
it is. `resolveRootModeSync` (`op/resolve-root-mode.ts`) already keeps a live root from being
watched in stock mode and would keep one out of the generator.

## Recommendation

Do not implement the stock-root generator yet. The example proves the second half works end to
end (`import {}` plus `-generate-config-out` plus `apply` gives a clean no-op plan) and proves
the first half is missing: nothing in chant produces `(address, id)` pairs for an undeclared
AWS resource, and the AWS exporter reads a CloudFormation stack a Terraform estate does not
have. The root-module restriction makes the generated file useless for a modular estate
without a human edit, capping the value of automating it at "saves typing the attribute list".
Implementing now means either an account-wide Cloud Control sweep that belongs to the aws
lexicon, or vendoring terraformer's naming, both larger decisions than this issue. Two pieces
are worth landing regardless: write down that a stock plan reports unmanaged resources as no
drift at all, and give `reconcilePr` the ability to open a PR over files a caller already
wrote, which the generator would need and which `TerraformWatchOp`'s `pull-request` mode wants
today. Revisit when the aws lexicon has an account-scope enumerator, or when Terraform lifts
the root-module restriction.

Proposed sub-issues, in order:

1. `docs(terraform): a stock plan is silent about unmanaged resources`. Acceptance: the
   observation page states that `plan -detailed-exitcode` exits 0 for a live resource no state
   row covers, that `describeResources` cannot see it either, and names `import {}` as the only
   cloud-to-code route on a stock root.
2. `core(op): reconcilePr commits files the caller wrote instead of running chant import`.
   Acceptance: a mode that commits named paths and opens the PR, existing callers unchanged,
   with a test pinning that `chant import` is not invoked in it.
3. `aws: account-scope enumeration through Cloud Control listResources`. Acceptance:
   `listResources` reachable unscoped over a declared type list, paginated and rate-limited,
   returning type plus primary identifier, with no terraform dependency.
4. `terraform: terraformGenerateConfig activity` (blocked on 2 and 3). Acceptance: given
   `(address, id)` pairs it writes `imports.tf`, runs `plan -generate-config-out`, refuses a
   non-root-module address with Terraform's own message, and returns both paths, with an
   emulator test reproducing the no-op plan after apply.

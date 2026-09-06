---
skill: chant-terraform
description: Read an existing Terraform root module into chant's build and audit, and drive it with the init/plan/apply Ops
user-invocable: true
---

# Terraform as an Existing Estate

## What this lexicon covers

There is no generated resource surface here, and nothing is written back over the HCL. Terraform's own `.tf` files stay the only source of truth, and `terraform apply` keeps working exactly as before. What chant adds is: one entity per HCL block, read at build time, so the post-synth checks and `chant audit` have something to see; and Op activities that drive `init`/`plan`/`apply`/`show` against a saved plan.

## Naming your roots

Add the `terraform` namespace to `chant.config.ts`. Importing the package brings the key into `ChantConfig`.

```ts
import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "terraform", // or "tofu" — the two are wire-compatible for everything this lexicon does
    roots: {
      app: { dir: "./terraform/app", workspace: "prod", varFiles: ["prod.tfvars"] },
    },
  },
} satisfies ChantConfig;
```

`dir` is the only required field, resolved against the project root (where `chant.config.ts` lives), not against the cwd a step happens to run from. The root's name (`app` above) is the entity-key prefix and the string every Op step and builder takes as `root` — keep it stable once other declarations reference it.

## What a build produces

Every block of every configured root becomes one entity, keyed `<root>/<address>`: `terraform { }` -> `Terraform::Terraform`, `provider "x" {}` -> `Terraform::Provider`, `resource "x" "y" {}` -> `Terraform::Resource`, `data "x" "y" {}` -> `Terraform::Data`, `module "x" {}` -> `Terraform::Module`, `variable "x" {}` -> `Terraform::Variable`, `output "x" {}` -> `Terraform::Output`, `locals {}` -> `Terraform::Locals`. Each carries `props.address`, `props.body` (the block, verbatim), `props.file` and `props.root`. A root whose `dir` doesn't exist, or whose HCL the parser refuses, warns and contributes no entities — the rest of the build is unaffected.

## The one thing to check before anything else

`TF001` fires once per root whose `terraform` block declares neither a `backend "<type>"` nor a `cloud {}`. That root's state is a local `terraform.tfstate`: unshared, unlocked, holding every resource attribute in plaintext. Add a real backend before anything else touches this root:

```hcl
terraform {
  backend "s3" {
    bucket = "acme-tfstate"
    key    = "app/terraform.tfstate"
    region = "us-east-1"
  }
}
```

`TF101` is the second rule, and it's about the Ops below: a `terraformApply` step's `planFile` must reference the output of a preceding `terraformPlan` step (`plan.out.planFile`), never a literal path. Applying an unreviewed plan, or a plan somebody hand-edited on disk, is exactly what a saved-plan discipline exists to prevent.

## Driving a root with an Op

`TerraformApplyOp` is Init, Plan, an optional approval Gate, then Apply — Init and Plan on the `longInfra` profile, the Gate's `show` step on `fastIdempotent`:

```ts
import { TerraformApplyOp } from "@intentius/chant-lexicon-terraform";

export const { op } = TerraformApplyOp({
  name: "app-apply",
  root: "app",
  gate: "on-destroy", // default — "always" gates every apply, "never" drops the Gate phase entirely
});
```

`gate: "never"` drops the Gate phase, so `chant run` walks straight from Plan to Apply; any other mode emits a Gate phase, and a run that reaches an unapproved gate records a pending fact on the gate ledger, ends `gated` and exits 3 until someone runs `chant approve <op> <gate>`. The Gate phase always shows the saved plan first and reports its `destroys` count as a `Destroys` search attribute, because `GateStep` carries no condition to branch on at build time — the approver sees what's at stake before approving, rather than the Op deciding for them.

Terraform has no automatic rollback, so `compensate: true` with no command throws at build time, naming the Op, rather than warning once an apply has already half-run:

```ts
export const { op } = TerraformApplyOp({
  name: "app-apply-gated",
  root: "app",
  gate: "always",
  compensate: { command: "terraform destroy -auto-approve" },
});
```

Reach for the four builders directly (`terraformInit`, `terraformPlan`, `terraformApply`, `terraformShow`) when a phase shape other than Init/Plan/Gate/Apply is needed — `plan.out.planFile` is how a later step references an earlier Plan step's saved output, and it only resolves when the Plan step carries an `id`.

## Where a running estate's ownership answer lives

Terraform's own state file is the ownership answer for what it manages — this lexicon doesn't add a second one. See the lexicon's "Live Observation" doc page for how a scheduled watch reads that state.

## Rules

| Rule | Severity | What it catches |
|---|---|---|
| TF001 | error (post-synth) | root module declares no remote backend |
| TF101 | error | `terraformApply`'s `planFile` isn't a preceding `terraformPlan` step's output |

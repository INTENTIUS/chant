---
schema: 1
id: "ws-108"
title: "How each lexicon composes in a pull request's run"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#4443"
  row: "decide per lexicon how it composes, and record it"
  revision: null
question: "For each capability with plan (cfn-deploy, terraform-apply, arm-deploy, gcp-apply, kubectl-apply) and for CloudFormation's Fn::ImportValue, does a member that reads an output not known yet join a group (ws-107), get a preview with stand-ins and a PlanShape, or stay a hole that needs its own round approval?"
options:
  - id: "a"
    label: "per capability, what its plan and its API support"
    how: "Each capability gets the shape its own plan can give: a group where one apply can carry a value from one member to another, a preview where a stand-in can take the unknown value's place in a real plan, and a hole otherwise. The table in this record gives the choice per capability."
    tradeoff: "Lexicons differ in what a reviewer sees for a member waiting on an upstream. The docs have to say which shape each one has."
  - id: "b"
    label: "a group in every lexicon"
    how: "Every capability implements groupFallback, planGroup and runGroup."
    tradeoff: "Only Terraform has one apply that carries a value between members. For the others a group would plan and apply members one after another inside runGroup, which covered rounds already do, while hiding the per-member plan behind one call."
  - id: "c"
    label: "a preview in every lexicon"
    how: "Every capability plans a waiting member with stand-ins and returns a PlanShape, as cfn-deploy does (#4423)."
    tradeoff: "arm-deploy, gcp-apply and kubectl-apply take no values into their resources. An upstream output can only fill a field that names the target, so a stand-in plans against a target that does not exist."
choice:
  option: "a"
  reason: "It follows the code. terraform-apply groups (#4447), cfn-deploy previews (#4423, #4430), Fn::ImportValue previews in an epic of its own (#4466, ruling 7), and arm-deploy, gcp-apply and kubectl-apply stay holes until their inputs carry values into resources."
rejected:
  - option: "b"
    why: "A group earns its cost only where one apply passes values between members. Elsewhere it repeats covered rounds."
  - option: "c"
    why: "A stand-in for a resource group, a project, a manifest path or a kubectl context gives a plan of the wrong target."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#4443, decide per lexicon how it composes"
    url: "https://github.com/INTENTIUS/chant/issues/4443"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4419, composed runs: the maintainer rulings of 2026-10-25"
    url: "https://github.com/INTENTIUS/chant/issues/4419"
    as_of: "2026-10-25T00:00:00Z"
  - title: "ws-107, a capability plans and applies a group of components as one"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-107-a-capability-plans-and-applies-a-group.md"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4423, AWS previews a hole member and checks the real change set"
    url: "https://github.com/INTENTIUS/chant/issues/4423"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4447, terraform-apply plans and applies a group through core"
    url: "https://github.com/INTENTIUS/chant/issues/4447"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4466, CloudFormation: preview stacks that read each other through Fn::ImportValue"
    url: "https://github.com/INTENTIUS/chant/issues/4466"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4467, kubectl-apply plans against a missing input instead of a hole"
    url: "https://github.com/INTENTIUS/chant/issues/4467"
    as_of: "2026-10-25T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-25"
reviews: []
constrains:
  - "INTENTIUS/chant#4443"
  - "INTENTIUS/chant#4447"
  - "INTENTIUS/chant#4449"
  - "INTENTIUS/chant#4466"
  - "INTENTIUS/chant#4467"
  - "ws-107"
  - "path:lexicons/aws/src/components/apply.ts"
  - "path:lexicons/terraform/src/components/capability-plugin.ts"
  - "path:lexicons/azure/src/components/arm-deploy.ts"
  - "path:lexicons/gcp/src/components/gcp-apply.ts"
  - "path:lexicons/k8s/src/components/kubectl-apply.ts"
---

# How each lexicon composes in a pull request's run

Decided on 2026-10-25 for #4443. Code was read at origin/integration/4419-composed-runs b1ae26157. The CloudFormation `Fn::ImportValue` row follows ruling 7 of #4419. The maintainer ruled the same day that this record stays `decided` (#4481, ruling 8).

A member composes in one of three ways:

1. a group: the capability implements ws-107's `planGroup` and `runGroup`, and one plan and one apply cover several members;
2. a preview: a member waiting on an output not known yet is planned with stand-ins and returns a `PlanShape`, so a later round whose plan matches it is covered by the first approval (`coveredRound`);
3. a hole: the member is not planned until its upstream applied, and that round needs its own approval.

## The table

| Capability | Lexicon | Composes as | Issue | What the API offers | Why |
|---|---|---|---|---|---|
| `terraform-apply` | terraform | group | [#4447](https://github.com/INTENTIUS/chant/issues/4447) | `terraform plan` over a root of module calls, where a value one module creates is known after apply in the modules that read it | One apply carries a value from one root to another. Outside a group a waiting root is previewed with typed placeholders since [#4463](https://github.com/INTENTIUS/chant/issues/4463) (epic:engine-ship), and stays a hole (`waitingRoot`) when no preview is possible. |
| `cfn-deploy` | aws | preview | [#4423](https://github.com/INTENTIUS/chant/issues/4423), [#4430](https://github.com/INTENTIUS/chant/issues/4430) | a change set per stack, created and deleted without executing | Built. `previewCfnDeploy` creates the change set with `cfnPlaceholder` stand-ins for the unknown parameters and returns `cfnPlanShape`. CloudFormation has no change set over several stacks, so a group would run change sets in order, as covered rounds do. |
| `Fn::ImportValue` | aws | preview | [#4466](https://github.com/INTENTIUS/chant/issues/4466) | the same change set; an import resolves only when the change set is created, and fails when the export does not exist yet | The CDK shape. Core sees no read, since the import is inside the template, and `valueReads` treats it as opaque. The epic turns an import of an export another stack in the change declares into a read, and previews the importer with the import as a stand-in parameter. |
| `arm-deploy` | azure | hole | none | ARM what-if (`deployments/whatIf`), for ARM deployments only | chant applies through `azApply`, one PUT per resource, and plans by reading each resource with a GET (`readPlan`). It makes no ARM deployment, so what-if has nothing to preview. `ArmDeployInput` takes no template parameters: an upstream output can only fill `resourceGroup`, `location`, `endpoint`, `subscriptionId` or `template`, and a stand-in there reads a different target. |
| `gcp-apply` | gcp | hole | none | no preview on the REST APIs `gcpApply` writes to; Config Connector and Infrastructure Manager preview through their own controllers, which chant does not use | `planGcpResources` reads each resource and decides it with `decideResource`. `GcpApplyStepInput` takes no values into resources: an upstream output can only fill `manifest`, `project`, `endpoint` or `stack`, all of which name the target. |
| `kubectl-apply` | k8s | hole | [#4467](https://github.com/INTENTIUS/chant/issues/4467) | server-side dry run (`dryRun=All`), which `plan` already uses against the live cluster | `KubectlApplyInput` takes no values into objects: an upstream output can only fill `manifest`, `stack`, `context` or `delete`, and a dry run needs a real cluster. `plan` does not read `unresolvedInputs` yet, so it plans against the missing value; #4467 makes it return a hole as the other two do. |

## When a hole would change

A hole becomes a preview when the step takes values into its resources: template parameters for `arm-deploy`, or values substituted into a manifest for `gcp-apply` and `kubectl-apply`. Each plan already compares the declared body with the live one in chant's own code, and `arm-deploy`'s marks an unresolved value as unknown (`attributeOf`), so a stand-in could then sit in the declared body and the entries give the shape. That change is a new issue when a step gains such an input.

None of the three is a group. Their applies write resource by resource with no value passed between members inside one call, so a group would order the members as the waves already do.

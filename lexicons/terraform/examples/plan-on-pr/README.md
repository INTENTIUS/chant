# plan-on-pr

The Terraform CI shape, as two Ops over one root: plan on the pull request,
apply on the push that follows the merge. `src/app-plan.op.ts` builds a
`TerraformWatchOp` that inits, plans and reports; `src/app-apply.op.ts` builds a
`TerraformApplyOp` that inits, plans, gates and applies the plan it saved.

Run either one locally:

```bash
chant run app-plan
chant run app-apply
```

Neither Op carries a cron. What pairs them is the trigger each one is given
when the workflows are generated, which is chant #2084's `trigger` on the
`ScheduledOpSpec`. There is no CLI for this yet, so it is the
`generateOpsPipeline` call itself:

```ts
import { generateOpsPipeline } from "@intentius/chant/op";

const { files } = await generateOpsPipeline(
  [
    { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "issue" },
    { name: "app-apply", trigger: { kind: "push", branches: ["main"] } },
  ],
  "github",
  { beforeScript: ["curl ... && unzip ..."] },
);
```

Two specs, two workflow files, because a GitHub trigger is workflow-scoped
rather than job-scoped. `app-plan.yml` carries `on: pull_request` with a
`branches` filter and no `workflow_dispatch`, since a pull request needs no
manual escape hatch. `app-apply.yml` carries `on: push` filtered to the same
branch. Both carry a per-Op concurrency group, which is also the thing that
stops two applies racing for the same state lock.

Permissions are what each finding mode needs and nothing else.
`app-apply.yml` is `contents: read`: the apply talks to the provider and the
state backend, not to the forge. `app-plan.yml` is `contents: read`,
`issues: write` for the issue the plan is posted as, and `pull-requests:
write`, which the `pull_request` trigger grants for a comment on the
triggering PR. chant posts no such comment today: `reconcilePr`'s modes are
`report`, `issue` and `pull-request`, and the last regenerates chant
TypeScript through `chant import`, which is not what a terraform plan wants
to say. So the plan lands as an issue and that one grant goes unused, which
is chant #2221's own note on the trigger pair.

Only the human plan is ever posted, on either half. `terraform show -json`
over a plan file carries resource attribute values, provider secrets among
them, so the Op references the `-no-color` render and there is no option to
post the other.

The runner has no terraform on it, so the install is passed in as a
`beforeScript` line, pinned to a version rather than taken from a package
repo: the version the plan runs is then the version the file names, which
matters for a root with a `required_version` floor. `../examples.test.ts`
pins both emitted documents, install line included, and is the copyable form
of the call above.

The apply half stops at its gate. A push run reaches it, finds no resolution
on the gate ledger, records the pending fact and exits 3, so the workflow run
ends there instead of holding a runner open. `chant approve app-apply
approve-app-apply --approver you` records the answer, and re-running the
workflow applies the plan. Drop the stop with `gate: "never"` on a root whose
merges should apply unattended.

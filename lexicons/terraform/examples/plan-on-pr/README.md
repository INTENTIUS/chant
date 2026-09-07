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
    { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
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

`findingMode: "comment"` is what posts the plan (chant #2231). The
`reconcilePr` activity writes a hidden marker as the comment's first line,
looks the comment up by that marker on the next run, and edits it in place, so
a pull request pushed to five times carries one comment holding the current
plan rather than five stale ones. The mode reads the pull request out of the
run's own event payload (`GITHUB_EVENT_PATH`, falling back to `GITHUB_REF`),
which is why it is tied to the trigger: the github generator refuses it by
name on a cron or push trigger, and a run that reaches the Report step with no
pull request fails there instead of posting the plan elsewhere.

Permissions are what each finding mode needs and nothing else.
`app-apply.yml` is `contents: read`: the apply talks to the provider and the
state backend, not to the forge. `app-plan.yml` is `contents: read` and
`pull-requests: write`, which is the whole scope a comment on the triggering
pull request costs. No `issues: write`, because nothing opens an issue, and no
`contents: write`, because nothing pushes a branch. That set was unreachable
from any finding mode before this one existed, which is chant #2221's own note
on the trigger pair.

Off GitHub the mode is refused rather than approximated: `reconcilePr` shells
to `gh` against the GitHub API and reads the GitHub Actions event payload, and
chant carries no GitLab or Forgejo client that would post the equivalent note.
The gitlab and forgejo Op generators say so by name at build time.

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

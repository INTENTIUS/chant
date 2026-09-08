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

const assumeRole = (roleVariable: string) => [
  {
    uses: "aws-actions/configure-aws-credentials@v6",
    with: { "role-to-assume": `\${{ vars.${roleVariable} }}`, "aws-region": "eu-west-1" },
  },
];

const { files } = await generateOpsPipeline(
  [
    {
      name: "app-plan",
      trigger: { kind: "pull_request", branches: ["main"] },
      findingMode: "comment",
      setup: assumeRole("AWS_PLAN_ROLE_ARN"),
      permissions: { "id-token": "write" },
    },
    {
      name: "app-apply",
      trigger: { kind: "push", branches: ["main"] },
      setup: assumeRole("AWS_APPLY_ROLE_ARN"),
      permissions: { "id-token": "write" },
    },
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

Permissions are what each finding mode needs, plus the one scope the spec adds
by name. `app-apply.yml` is `contents: read`: the apply talks to the provider
and the state backend, not to the forge. `app-plan.yml` is `contents: read` and
`pull-requests: write`, which is the whole scope a comment on the triggering
pull request costs. No `issues: write`, because nothing opens an issue, and no
`contents: write`, because nothing pushes a branch. That set was unreachable
from any finding mode before this one existed, which is chant #2221's own note
on the trigger pair. Both files then add `id-token: write`, which is what the
AWS auth below needs and what no finding mode grants (chant #2242); the
addition is checked to be additive, so it can never replace or widen what
the mode computed.

## AWS credentials

Both halves authenticate to AWS through GitHub's OIDC provider, which is the
form to reach for first. `aws-actions/configure-aws-credentials` is a `uses:`
step, so it rides the spec's `setup` list, and it needs `id-token: write` on
the job, so it rides the spec's additive `permissions`:

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write

jobs:
  app-plan:
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: '${{ vars.AWS_PLAN_ROLE_ARN }}'
          aws-region: eu-west-1
```

The run mints a short-lived OIDC token, the action exchanges it for
credentials that expire with the job, and the repository stores no long-lived
key at all. `role-to-assume` reads a repository variable rather than a secret,
because a role ARN is not one: it is an account number and a role name, and
keeping it a variable means a fork of this example needs one variable set and
no secret. The two halves name two different variables on purpose, which is
why `setup` is a per-Op option rather than a generator-wide one. The
pull-request half only ever plans, so its role can be read-only; the push half
is the only thing that should hold a role that can write. Set the trust policy
on each role to the repository and, for the apply role, to the `refs/heads/main`
ref the push trigger fires on.

Static credentials still work, through the `variables` mapping on the
`generateOpsPipeline` options, which becomes the workflow's top-level `env:`:

```ts
{ variables: { AWS_ACCESS_KEY_ID: "${{ secrets.AWS_ACCESS_KEY_ID }}", AWS_SECRET_ACCESS_KEY: "${{ secrets.AWS_SECRET_ACCESS_KEY }}" } }
```

Use that when the runner cannot reach GitHub's OIDC provider, when the account
is on a provider with no OIDC federation to GitHub, or on a self-hosted forge
where the token has no audience to present. Everywhere else the OIDC form is
strictly better: nothing durable is stored, a leaked log line expires within
the hour, and the role's trust policy names the repository and ref that may
assume it, so an unrelated repository holding the same secret gets nothing.

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
repo (a `setup` entry could carry `hashicorp/setup-terraform` instead, but a
curl and an unzip need no action to express): the version the plan runs is then the version the file names, which
matters for a root with a `required_version` floor. `../examples.test.ts`
pins both emitted documents, install line included, and is the copyable form
of the call above.

The apply half stops at its gate. A push run reaches it, finds no resolution
on the gate ledger, records the pending fact and ends there instead of holding
a runner open. `chant approve app-apply approve-app-apply --approver you`
records the answer, and re-running the workflow applies the plan. Drop the stop
with `gate: "never"` on a root whose merges should apply unattended.

That stop used to mark main as broken on every merge, since a gated run exits 3
and GitHub Actions has no neutral conclusion for a `run:` step. The push job now
runs `chant run app-apply --gated-exit 0 --json`, which maps that one outcome
and nothing else: a run that fails for any other reason still exits 1 and the
job is still red. The gate, the `chant approve` command and the
`_gates/app-apply.jsonl` ledger path go to `GITHUB_STEP_SUMMARY`, which is what
the run page shows.

The pending state also leaves the log. `app-apply-gate-notice` `needs:` the
apply and runs when its `gated` output is set. A push event carries no pull
request, so the job asks `repos/{repo}/commits/{sha}/pulls` for the one the
pushed commit belongs to and posts there through the same marker recipe the
plan half uses, editing one comment rather than stacking one per merge. When
that lookup answers with nothing — a direct push to the branch — it opens an
issue instead, which is why it carries `issues: write` beside
`pull-requests: write`. Those permissions sit on that job, so the apply next to
it stays `contents: read`.

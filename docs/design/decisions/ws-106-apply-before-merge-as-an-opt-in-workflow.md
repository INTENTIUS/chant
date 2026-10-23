---
schema: 1
id: "ws-106"
title: "Apply before merge is an opt-in ci.workflow value"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#4301"
  row: "apply before merge from a pull request comment, as an opt-in mode"
  revision: null
question: "May a pull request's plan be applied from its head before it merges, as terragucci's apply.when: pull-request does, when chant's default is that a merge deploys nothing and a release is one green commit; and if it may, what turns it on and what must hold before it runs?"
options:
  - id: "a"
    label: "never: a change deploys only through a release or the apply on merge"
    how: "chant keeps the two workflows it has. A team that wants to see a change in an environment before it merges uses a pull-request environment (#4298) or merges and promotes."
    tradeoff: "One path to a shared environment, always through a green commit. terragucci's users lose the mode they run today, and the switch to chant's pull-request loop leaves them on terragucci's comment-apply."
  - id: "b"
    label: "a third ci.workflow value, apply-before-merge, off by default, behind the same gate and four requires checks"
    how: "ci.workflow takes apply-before-merge at the top level or on a member. Under it a merge records the plan and deploys nothing, as under trunk-curated. A person can also apply an open pull request's plan from its head: a comment on GitHub or Forgejo, a pipeline on the target branch on GitLab. chant components pr-apply --before-merge runs it. It refuses unless the declaration at base sets the workflow for the member, and unless the pull request is approved, mergeable, undiverged and its checks passed, each read through a PrForge method. Then it runs the pull request's gate as it stands (quorum, policy at base, target locks, the apply identity) and applies under that approval."
    tradeoff: "The change is deployed from a commit that is not green and may never merge. The environment runs code that trunk does not have until the merge, and a second pull request reaching the same targets has to wait for the first's locks."
  - id: "c"
    label: "an apply-before-merge flag on the generated pipeline alone"
    how: "chant build --pr-loop --apply-before-merge writes the job, and nothing in the declaration says the workspace allows it."
    tradeoff: "Whoever edits the pipeline file decides, and a pull request that adds the job would apply itself. The declaration at base is where chant reads every other gate setting from."
choice:
  option: "b"
  reason: "terragucci's users need the mode to switch to chant, and option b keeps every rule chant already has. It is off unless the declaration at base turns it on, so the default stays that a merge deploys nothing. The apply runs only under the pull request's own gate, so a non-empty plan still waits for a person (ws-104:195, ws-080). The four requires checks are terragucci's, so a switching team keeps what it relies on."
rejected:
  - option: "a"
    why: "It leaves terragucci's apply.when: pull-request with no chant equivalent, so its comment-apply code can never be deleted."
  - option: "c"
    why: "A pipeline file is part of the change, and a setting that lets a change deploy itself before review belongs in the declaration read at base."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#4301, apply before merge from a pull request comment, as an opt-in mode"
    url: "https://github.com/INTENTIUS/chant/issues/4301"
    as_of: "2026-10-22T00:00:00Z"
  - title: "INTENTIUS/chant#4287, lift terragucci's general CI features into chant core"
    url: "https://github.com/INTENTIUS/chant/issues/4287"
    as_of: "2026-10-22T00:00:00Z"
  - title: "INTENTIUS/chant#4168, merge deploys nothing by default"
    url: "https://github.com/INTENTIUS/chant/issues/4168"
    as_of: "2026-10-22T00:00:00Z"
  - title: "INTENTIUS/chant#4293, target locks"
    url: "https://github.com/INTENTIUS/chant/issues/4293"
    as_of: "2026-10-22T00:00:00Z"
  - title: "INTENTIUS/chant#4296, separate plan and apply cloud identities"
    url: "https://github.com/INTENTIUS/chant/issues/4296"
    as_of: "2026-10-22T00:00:00Z"
  - title: "ws-080, a person is a forge identity or a signer"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-080-person-identity-forge-or-signer.md"
    as_of: "2026-10-22T00:00:00Z"
  - title: "ws-104, the release model"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-104-the-release-model.md"
    as_of: "2026-10-22T00:00:00Z"
  - title: "terragucci comment-apply.ts at e6cb431: decideApplyComment and the requires checks"
    url: "https://github.com/INTENTIUS/terragucci/blob/e6cb431/packages/terragucci/src/comment-apply.ts"
    as_of: "2026-10-22T00:00:00Z"
  - title: "terragucci comment-apply-gitlab.ts at e6cb431: apply before merge on GitLab"
    url: "https://github.com/INTENTIUS/terragucci/blob/e6cb431/packages/terragucci/src/comment-apply-gitlab.ts"
    as_of: "2026-10-22T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-22"
reviews: []
constrains:
  - "INTENTIUS/chant#4301"
  - "INTENTIUS/chant#4287"
  - "ws-104"
  - "ws-080"
  - "path:packages/core/src/workspace/ci-workflow.ts"
  - "path:packages/core/src/pr-requires.ts"
  - "path:packages/core/src/workspace/declaration.schema.json"
  - "path:packages/core/src/workspace/pr-report.schema.json"
---

# Apply before merge is an opt-in ci.workflow value

Decided by lex00 on 2026-10-22, in the goal for epic #4287. Code was read at origin/main 01e5f7c92, which has the target locks (#4293) and the plan and apply identities (#4296).

## What it reverses, and how far

#4168 made a merge record its plan and deploy nothing (`components/pr-pipeline.ts:16-21`). ws-104 made a release one green commit, built once and promoted. An apply before merge deploys a pull request's head, which is not green and may never merge. This record allows it as a third workflow and nothing more:

- `ci.workflow` takes `apply-before-merge` (`workspace/declaration.schema.json`). It is off unless the declaration sets it. With no `ci.workflow`, or with `trunk-curated` or `trunk-curated+apply-on-merge`, nothing applies before merge.
- `pr-apply --before-merge` reads the workflow from the declaration at base, the target branch's commit. A pull request that sets the workflow in its own copy of the declaration gets nothing from it.
- Under the workflow a merge still records and deploys nothing. Releases are cut and promoted as under `trunk-curated`. The apply before merge writes deploy records with no `releaseDigest`, so `chant workspace status` shows the environment running something that is no release.

## The requires checks

Before it plans, `pr-apply --before-merge` asks the forge four things about the pull request. Each one is a `PrForge` method implemented for GitHub, GitLab and Forgejo. Every one of them must pass, and the report lists each with its reason:

| Require | Passes when |
|---|---|
| `approved` | someone other than the pull request's authors approved its current head, and no standing review asks for changes |
| `mergeable` | the forge says the pull request merges as it stands: no conflicts, and on GitHub no branch protection blocking it |
| `undiverged` | the head contains the target branch's current tip |
| `checks` | every status and check reported on the head passed, apart from the apply's own, and at least one did |

A check the forge has not settled reads as pending, and the apply refuses with the reason. The checks run before the head's code loads, so a head that fails them runs nothing. They also confirm that the forge's head is the commit the job checked out.

terragucci's `apply.requires` lets a repository drop some of the four (`config.ts:137` at e6cb431). chant requires all four. A setting to drop one can come later as its own decision.

## The same gate

Once the four pass, the apply is `pr-apply` as it runs on merge, at the pull request's head. Nothing about the gate changes:

- The approval is the pull request's own gate, `pr-<n>` or `pr-<n>-<member>`, bound to the digest this run plans. A non-empty plan applies only once a person approves it. Only a human approval counts toward the quorum (`lifecycle/gate-ledger.ts:207`, ws-080). ws-104:195 states the same rule for releases.
- `ci.policy` at base judges the change set, and a deny or hold stops it as on merge (#4294).
- Under `ci.locks`, another open pull request's lock on a target refuses the apply. The apply then takes `apply` locks on the targets it reaches for the pull request, which hold until it merges or closes (#4293).
- The generated job takes the apply identity (#4296). It runs the head's code with that identity, as the apply on merge runs the merged code with it. The `approved` require is what makes that head a reviewed one.

## Triggers

GitHub and Forgejo run the apply job on an `issue_comment` that starts with `/chant apply` on a pull request into the target branch. The job's workflow file is the target branch's, so a pull request cannot change the job that applies it. GitLab builds a merge request's pipeline from the merge request's own files, so the job there runs in a pipeline of the target branch. A person starts it with `CHANT_APPLY_PR` set to the merge request's iid. The variable only says which merge request to read; the requires checks read everything else from the forge.

## Floor table

| Field | On | Holds | Floor |
|---|---|---|---|
| `apply-before-merge` | `ci.workflow` | the opt-in | 0.124.42 |
| `beforeMerge` | pull-request report | the four requires checks, each with `passed` and `reason` | 0.124.42 |
| `requires-unmet`, `before-merge-off` | pull-request report `refusal` | why an apply before merge refused | 0.124.42 |

---
schema: 1
id: "ws-105"
title: "What triggers a release cut, and what a revoked commit does to its releases"
state: "proposed"
area: "D17"
source:
  issue: "INTENTIUS/chant#4033"
  row: "lifecycle: what triggers a release cut, and what a revoked commit does to releases cut from it"
  revision: null
question: "Is a release cut automatically when a commit goes green, by hand, or per environment, and when ci tick later revokes a commit, what happens to the releases cut from it, their pending gates and the environments that run them?"
options:
  - id: "a"
    label: "chant ci tick cuts a release of each member whenever it makes a green tag"
    how: "After the tick pushes ci/green/<sha>, it runs the cut for every member whose files the commit touched, unlabelled, and pushes chant/lifecycle. A tick from chant runs (#4044) does the same on any runner. Labels are given later by a second cut of the same digest."
    tradeoff: "Every green commit has a release with no one asking, which suits continuous delivery. The tick stops being a cheap job that reads check runs and writes tags: it needs each member's toolchain, builds artifacts and compiles every environment on a 15-minute cron, and a tick that walks its window cuts every newly green commit in it. A cut under identity.gates.release must be signed by a person in the releaser class, so either the tick's runner key joins that class, and whoever runs CI may cut, or every automatic cut is refused there. Most cuts would be of commits nobody promotes."
  - id: "b"
    label: "a release is cut by hand, with chant release cut, by a person or by a job that runs the command"
    how: "chant release cut stays the only way a release is made, as #4026 built it, with the green and revoked checks it already makes. The tick never cuts. A workstation cuts and signs (ws-104, #4027). A project that wants a release for every green commit adds a pipeline step after the tick that runs chant release cut on chant ci last-green; the cut is idempotent per digest, so running it twice on one commit is a no-op, and it works on any runner because it needs only git, the tags and the member's build."
    tradeoff: "One path makes every release, and the declaration's identity.gates.release decides who may take it, whether that is a person or a CI job. Cutting on green is a recipe a project writes rather than a chant feature, so a project that wants it writes two lines of pipeline, and chant documents them."
  - id: "c"
    label: "per environment: each environment in the promotion order declares whether a green commit reaches it on its own"
    how: "Each entry of a member's environments array gains a trigger, such as { name: \"dev\", trigger: \"green\" }, and a green commit is cut and promoted to the environments that say green, while the rest wait for a person."
    tradeoff: "It reads naturally for dev environments that should follow trunk. A release covers every environment at once (ws-104 question 1), so the cut can't be per environment: what this option sets per environment is whether a promote runs on its own, which is promotion, governed by #4030's order and the release gates (#4045), and not the cut."
choice: null
rejected: []
supersedes: []
evidence:
  - title: "INTENTIUS/chant#4033, what triggers a release cut, and what a revoked commit does to releases cut from it"
    url: "https://github.com/INTENTIUS/chant/issues/4033"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/behold#678, the second audit"
    url: "https://github.com/INTENTIUS/behold/issues/678"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#4027, a workstation cuts and signs, and CI publishes"
    url: "https://github.com/INTENTIUS/chant/issues/4027"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#4031, signed release cuts and signed ci tags"
    url: "https://github.com/INTENTIUS/chant/issues/4031"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#4044, chant run results as a status source for ci tick, and the revoked tag's run.opRun"
    url: "https://github.com/INTENTIUS/chant/issues/4044"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#4045, release gates bind the release digest, the environment and the change set"
    url: "https://github.com/INTENTIUS/chant/issues/4045"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#4035, rolling an environment back to a release"
    url: "https://github.com/INTENTIUS/chant/issues/4035"
    as_of: "2026-10-16T00:00:00Z"
  - title: "ws-103, CI green and revoked tags"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-103-ci-green-and-revoked-tags.md"
    as_of: "2026-10-16T00:00:00Z"
  - title: "ws-104, the release model"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-104-the-release-model.md"
    as_of: "2026-10-16T00:00:00Z"
  - title: "lifecycle/release-cut.ts at 509acfa56: the cut refuses a commit with no counted green tag, or a revoked one"
    url: "https://github.com/INTENTIUS/chant/blob/509acfa56/packages/core/src/lifecycle/release-cut.ts"
    as_of: "2026-10-16T00:00:00Z"
  - title: "workspace/ci-green.ts at 509acfa56: readCiTags, which judges each ci tag under signedSince"
    url: "https://github.com/INTENTIUS/chant/blob/509acfa56/packages/core/src/workspace/ci-green.ts"
    as_of: "2026-10-16T00:00:00Z"
decided_by: null
decided_on: null
reviews: []
constrains:
  - "INTENTIUS/chant#4033"
  - "INTENTIUS/chant#4027"
  - "INTENTIUS/chant#4034"
  - "INTENTIUS/chant#4035"
  - "INTENTIUS/behold#678"
  - "ws-103"
  - "ws-104"
  - "path:packages/core/src/lifecycle/release-revocation.ts"
  - "path:packages/core/src/workspace/releases.schema.json"
  - "path:packages/core/src/workspace/status.schema.json"
---

# What triggers a release cut, and what a revoked commit does to its releases

Proposed for lex00's review. Code was read at origin/main 509acfa56, which has #4026's cut, #4045's release gate, #4031's signed cuts and tags, and #4044's runs as a status source. The option letters in the front matter answer question 1. Question 2 is answered here, and #4033's implementation follows the recommendation for it, so the decision on it can be read against working code.

## 1. What triggers a cut

Recommendation: option (b). A release is cut by hand, with `chant release cut`, and `chant ci tick` never cuts.

The reasons, in the order they weigh:

1. Who may cut is already decided, and (b) keeps one answer to it. #4031 put it in `identity.gates.release`: with that entry a cut must be signed by a key `.chant/allowed_signers` lists for the actor, and when the entry names a class the actor must hold its role. A tick signs with a runner key from `.chant/trust.json`. Under (a), either runner keys join the releaser class, so anyone who can run CI can make a release, or every automatic cut is refused where the gate is declared. Under (b) the declaration decides: a project that lets CI cut grants a CI principal the role, and one that doesn't, doesn't.
2. ws-104 settled that a workstation cuts and signs and CI publishes (#4027). (a) would add a second producer of releases, with a different actor, before #4027 has shipped the first.
3. The tick is a small job. It reads check runs or signed runs, writes tags and pushes them, on `workflow_run` and a 15-minute cron, in one concurrency group that never cancels (ws-103). A cut runs the member's build per environment, builds the artifacts and compiles every target. Putting that in the tick puts each member's toolchain, and its failures, into the job that decides what is green.
4. A release is a commit someone intends to promote. Cutting every green commit makes releases nobody reads, and each one is a file on `chant/lifecycle` that is written once and never removed.
5. Nothing is lost for a project that does want every green commit released. The cut is a no-op for a digest already cut, and it needs only git, the tags and the member's build, so a pipeline step after the tick that runs `chant release cut` on `chant ci last-green` gives (a)'s result on any runner, GitHub or not. That includes a pipeline whose tick reads chant runs (#4044). The recipe goes on the release page.

Option (c) sets when a promote runs, not when a cut runs. A release is compiled for every environment at once (ws-104 question 1), so there is one cut and nothing per environment to trigger. Whether dev follows trunk without a person is a question for the promote, under #4030's order and #4045's gates, and an empty change set already passes its gate without an approval. If the automatic promote is wanted, it belongs in its own issue.

## 2. What a revoked commit does to its releases

Recommendation: derive revocation at read time from the commit's `ci/revoked/<sha>` tag, and write no new record.

A release traces to exactly one commit (ws-104, question 1, and its assumption for #4033), so "the releases cut from a revoked commit" is a join between a release's `commit` and the revoked tags, with nothing to remember. Each reader judges the tags the way `release cut` judges them, through `readCiTags` (#4031). With `ci.green.signedSince` declared, a revoked tag without a valid runner statement is ignored and revokes nothing, and a tag that counts revokes every release cut from its commit.

Reasons for deriving rather than recording:

- The tag is already the durable record, made once by the tick and kept by every clone (ws-103). A second record, such as a `revoked` line in `_releases/`, would hold the same fact in two places, and the two can disagree: a person who deletes a revoked tag by hand to restore a commit, as ws-103 allows, would leave a stale line behind.
- The signed-tag rules apply in one place. A recorded flag would need its own signer, or would let anyone with push access to `chant/lifecycle` revoke a release that no runner revoked.
- The tick does not have to know about releases. It runs in the root CI file and in non-GitHub pipelines (#4044) and has no member's ledger in hand. Under recording, it would need to find and write each member's `_releases/` on every revocation.
- Releases cut after the revocation are refused already (#4026's `release-commit-revoked`), so only releases cut before it are affected, and the join covers them with no ordering to get right.

The cost is that a reader must have the tags. Every reader below reads local tags only, as `release cut` and `ci last-green` do, so a clone that hasn't run `git fetch origin --tags` does not see a revocation. The promote's refusal names the fetch. The promote job `chant build --components --generate <lexicon> --promote-to <env>` writes does not fetch tags today, so it should fetch `ci/*` before it promotes; that is a follow-up.

What each reader does:

| Reader | When the release's commit is revoked |
|---|---|
| `chant approve` on a release gate | Refuses with `release-revoked`, whatever plan is named, and names `chant approve release <gate> --expire` and `chant ci last-green` in the fix line. It also refuses with `release-unreadable` when the release file can't be read, and with `declaration-invalid` when the tags can't be judged, since whether the release is revoked is then unknown. |
| `chant components promote --release` | Refuses before anything runs, with `release-revoked`, so an approval given before the revocation can't be used. |
| `chant release cut` | Unchanged: refuses a revoked `HEAD` with `release-commit-revoked`. |
| `chant workspace status --json` | A release gate for the release reads `superseded` (an expired one stays `expired`) and carries `revoked`. A component whose latest deploy record names the release carries `revoked`, with the release, its label and the rollback line `chant components rollback <env> --component <component>`. The text view prints that line under the member. |
| `chant release list` | Each entry carries `revoked`, the tag or `null`. The text line ends with `revoked`, and the failed phase and run go to stderr. |

The `revoked` object is the revoked tag as `chant ci list --json` shows it, `{ tag, tagged, phase, run, signer }`, plus `commit`. A tag made from chant runs names its run with `id: null` and the Op run in `run.opRun` (`{ id, env, signer }`), and every reader passes that through rather than reading `run.id`.

An approval recorded before the revocation stays on the ledger, since the ledger is append-only, and nothing counts it: the promote refuses the release before it reaches the gate. A pending fact is not expired by the revocation either. `status` reads it as superseded, and `chant approve --expire` clears it.

## Floor table

Every field is added within contract 1 and is optional or nullable, so a reader treats its absence as an older chant. Current main is 0.124.27.

| Field | On | Holds | Floor |
|---|---|---|---|
| `revoked` | `releases` entry | the revoked tag on the release's commit, or `null` | 0.124.29 |
| `revoked` | `status` release item | the same, with `releaseDigest`, `label` and `rollback`; absent when the release is not revoked | 0.124.29 |
| `revoked` | `status` gate item | the revoked tag, on a release gate whose release is revoked; absent otherwise | 0.124.29 |
| `superseded` for a revoked release | `status` gate item `state` | an existing value, given for one more cause | 0.124.29 |

## Assumptions for #4034 and #4035

- #4035 extends rollback to take a release label. The rollback line printed here is today's `chant components rollback <env> --component <component>`, which restores the component's release before the current one, and #4035 can name the release to go back to. It should also refuse to roll back to a revoked release.
- `components redeploy` and `components rollback` do not check revocation yet. Redeploying a revoked release, or rolling back to one, is #4035's to decide.
- A promote without `--release` whose source deploy names a revoked release is not refused here; only `--release` is. #4035 makes rollback a gated promote of an earlier release and can settle both.
- #4034 reads older records under the release model. A deploy record with no `releaseDigest` names no release, so status can't flag it even when its `gitSha` is revoked. If #4034 maps such records to releases, the flag follows with no change here.

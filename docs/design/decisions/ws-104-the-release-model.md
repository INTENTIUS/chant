---
schema: 1
id: "ws-104"
title: "The release model"
state: "proposed"
area: "D17"
source:
  issue: "INTENTIUS/chant#4028"
  row: "decision: the release model (what a release covers, what a gate binds, names and contract version, member vs workspace)"
  revision: null
question: "What does a release cover, so that a release cut from a green commit is what a gate approves and a promote moves, and how does a flag change, which is a commit, reach an environment?"
options:
  - id: "a"
    label: "a release is one green commit of one member, compiled for every environment; a flag change is a new release"
    how: "A release holds the commit, the artifact digests built once from it, and one compile target per environment: that environment's template digests and the build parameters they were compiled with, flag values included. Its releaseDigest covers all of it. A flag change is a commit, so once it is green it is cut as a release of its own. When no artifact source changed, that release carries the previous release's artifact digests, so it is a config-only release. Every environment gets the new release; where its target did not change, its change set is empty. A flag change ships with every commit merged before it."
    tradeoff: "One rule: every green commit can be a release, and every release traces to exactly one commit. Promote-by-digest holds because artifact bytes are shared by digest. Flipping a flag in one environment makes a release that also exists for the others, and a prod-only flip carries every unreleased trunk commit with it."
  - id: "b"
    label: "a release is the artifacts only; per-environment targets are separate revisions pinned to it"
    how: "The release digest covers the commit and the artifact digests. Each environment's compiled target is its own record pinned to a release, and a flag change makes a new target revision of the same release while the release digest stays the same."
    tradeoff: "A flag flip touches one environment's record only. It needs a second versioned object with its own gate binding and its own lane column, and a target revision has no green commit of its own, although the flag record that caused it was committed and went green."
  - id: "c"
    label: "as a, and a release may also be cut from the deployed release's commit with newer flag records applied on top"
    how: "Besides releases cut from a green commit, a flag-only release is cut from the commit an environment runs, with the flag records of a later green commit applied to it, so a flag can ship without the commits merged before it."
    tradeoff: "A flag can ship alone. The release no longer traces to one commit: its source is a commit plus records from another, a pair that never went green together, and the hash input, the cut checks and #4033's revocation all need a second form."
choice: null
rejected: []
supersedes: []
evidence:
  - title: "INTENTIUS/chant#4028, decision: the release model"
    url: "https://github.com/INTENTIUS/chant/issues/4028"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/behold#678, the second audit (A2, A3, A4, A9, A11)"
    url: "https://github.com/INTENTIUS/behold/issues/678#issuecomment-6226482185"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#4016, a forge without branches or pull requests, and its correcting comment"
    url: "https://github.com/INTENTIUS/chant/issues/4016"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#2554, release trains, deferred on 2026-09-30 pending #1939"
    url: "https://github.com/INTENTIUS/chant/issues/2554"
    as_of: "2026-10-16T00:00:00Z"
  - title: "INTENTIUS/chant#3856, publishing a release as one set (dist-tag staging, OIDC trusted publishing)"
    url: "https://github.com/INTENTIUS/chant/issues/3856"
    as_of: "2026-10-16T00:00:00Z"
  - title: "lifecycle/release-ledger.ts at 8b045980c: ReleaseRecord, its digest, inputDigest and flags"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/packages/core/src/lifecycle/release-ledger.ts#L73-L178"
    as_of: "2026-10-16T00:00:00Z"
  - title: "lifecycle/gate-ledger.ts at 8b045980c: planDigest and environment on resolutions and pending gates"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/packages/core/src/lifecycle/gate-ledger.ts#L95-L380"
    as_of: "2026-10-16T00:00:00Z"
  - title: "lifecycle/plan-ledger.ts at 8b045980c: ReleaseRecord.digest as a release-plan digest"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/packages/core/src/lifecycle/plan-ledger.ts#L7-L20"
    as_of: "2026-10-16T00:00:00Z"
  - title: "workspace/status.schema.json at 8b045980c: the release item"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/packages/core/src/workspace/status.schema.json#L910-L927"
    as_of: "2026-10-16T00:00:00Z"
  - title: "components/verbs/build-archive.ts at 8b045980c: the manifest has no environment"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/packages/core/src/components/verbs/build-archive.ts#L117-L139"
    as_of: "2026-10-16T00:00:00Z"
  - title: "lifecycle/build-ledger-store.ts at 8b045980c: a build archive is not env-scoped"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/packages/core/src/lifecycle/build-ledger-store.ts#L25-L40"
    as_of: "2026-10-16T00:00:00Z"
  - title: "The change-set document, its three digests"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/docs/src/content/docs/reference/change-set.mdx#L74-L90"
    as_of: "2026-10-16T00:00:00Z"
  - title: "The workspace read contract, versions and floors"
    url: "https://github.com/INTENTIUS/chant/blob/8b045980cf9cd1351dd4f60c9c46ee69d45ec0d7/docs/src/content/docs/reference/workspace-read-contract.mdx#L9-L17"
    as_of: "2026-10-16T00:00:00Z"
  - title: "ws-055, what a development model tracks goes in the workspace's ledgers"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-055-dev-model-ledgers.md"
    as_of: "2026-10-16T00:00:00Z"
  - title: "ws-095, release sites on the component"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-095-release-sites-on-the-component.md"
    as_of: "2026-10-16T00:00:00Z"
  - title: "ws-103, CI green and revoked tags"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-103-ci-green-and-revoked-tags.md"
    as_of: "2026-10-16T00:00:00Z"
decided_by: null
decided_on: null
reviews: []
constrains:
  - "INTENTIUS/chant#4028"
  - "INTENTIUS/chant#4026"
  - "INTENTIUS/chant#4045"
  - "INTENTIUS/chant#4046"
  - "INTENTIUS/chant#4043"
  - "INTENTIUS/chant#4024"
  - "INTENTIUS/chant#4022"
  - "INTENTIUS/chant#4030"
  - "INTENTIUS/chant#4033"
  - "INTENTIUS/chant#4035"
  - "INTENTIUS/chant#4027"
  - "INTENTIUS/behold#678"
  - "ws-055"
  - "ws-103"
  - "path:packages/core/src/lifecycle/release-ledger.ts"
  - "path:packages/core/src/lifecycle/gate-ledger.ts"
  - "path:packages/core/src/workspace/status.schema.json"
x-recommendation:
  option: "a"
  reason: "It keeps one rule, that a release is one green commit compiled, and needs no second versioned object. Promote-by-digest is a promise about artifact bytes, and a config-only release keeps it by carrying the same artifact digests. Option b invents a target revision that has no commit of its own, and option c gives a release a source that never went green as a whole. The cost is that a flag flip ships with trunk; that is answered in question 6."
---

# The release model

Proposed, not decided. Each answer below is a recommendation for lex00 to accept or change. Code was read at origin/main 8b045980c. Option letters in the front matter answer questions 1 and 6 together; questions 2 to 5 are answered here.

A word on names used below. The release is the new object, cut once from a green commit of one member. A deploy record is the existing per-component line, `ReleaseRecord` in `<env>/releases.jsonl` (`lifecycle/release-ledger.ts:73-178`).

## 1. What a release covers

Recommendation: option (a).

A release is one green commit of one member, compiled. It holds the commit, the artifact digests built once, and one target per environment. A flag change is a commit, so it becomes a release of its own, and when no artifact source changed it carries the previous release's artifact digests.

This keeps one rule. Every green commit can become a release and every release traces to one commit, which is what ws-103's green tags and #4033's revocation key on. Option (b) needs a target revision with its own gate binding and lane column, and that revision would come from a flag record that was itself committed and went green, so the commit already exists. The cost of (a) is that a one-environment flip makes a release for every environment. The other environments' targets are unchanged, so their change sets are empty (question 6 says what their gates do).

## 2. What a gate binds

Recommendation: a release gate binds three values, and an approval counts only when all three match.

- The release digest, in a new optional `releaseDigest` on both `PendingGateRecord` and `GateResolutionRecord`.
- The environment, in the existing `environment` (`gate-ledger.ts:153` and `:336`).
- The change-set document's `digest` (`change-set.mdx:88`), stored in the existing `planDigest` (`gate-ledger.ts:140` and `:319`).

The document digest is the one to bind because the set digest covers only each member's `planDigest`, and a member's `planDigest` is planner-specific (for a SQL member it is the product's own digest, `change-set.mdx:83`). The document digest also covers the entries, holes and side effects, so it pins what the reviewer saw across every planner. The pull-request gate already binds it in `planDigest` (`pr-loop.ts:15-24`), so this gives the field no new meaning. The document leaves provisional members out (`change-set.mdx:40`), so a release gate refuses a change set that holds one, as a gated wave does (`gated-waves.ts:125-136`).

The release gets a field of its own because behold's lane and #4043's join read `releaseDigest` directly, and folding it into one combined hash would make every reader recompute it.

Gates that are not release gates, such as a component gate in a plain `chant run --components`, keep binding the lifecycle-plan digest as today. #4022 stores a change set for release gates and pull-request gates, keyed by the document `digest`.

## 3. Names, storage and the contract version

Recommendation: add fields and leave `digest` alone.

`ReleaseRecord.digest` keeps the meaning each producer gives it today: an artifact digest, a release-plan digest for a runner that records plans (`plan-ledger.ts:7-20`, ws-055), or a product's own digest such as SQL Yodeler's `schemaSha`. The read-contract docs and the `status.schema.json` description of `digest` (line 915, which says only "artifact digest") are corrected to list those three. The data does not change.

The release is stored at `_releases/<releaseDigest>.json` on `chant/lifecycle`, with `:` written as `_` as `_plans/` and `_builds/` do. A workspace member's copy sits under `_members/<member>/_releases/` through the same `ledgerDir` prefix. The file is written once and never rewritten, like a plan (`plan-ledger.ts:43-51`). It holds:

| Field | Holds |
|---|---|
| `version` | `1`, the file's schema version, as every chant ledger line has |
| `releaseDigest` | `computePlanDigest("release", subject)` over the hash input below, so it carries the `jcs1-sha256:` prefix |
| `member` | the workspace member, or `null` for a project outside a workspace |
| `commit` | the full sha of the green commit |
| `artifactDigests` | each `image` and `asset` entry built once: `{ component, kind, path, digest }`, sorted by component, then path |
| `targets` | one per environment, sorted by `env`: `{ env, templates, params }`. `templates` lists `{ component, path, digest }` (component `null` for a project with no components), sorted. `params` lists `{ name, value, source }`, sorted by name, where `source` is the build-parameter source, a flag record included |

The hash input is `member`, `commit`, `artifactDigests`, and each target's `env`, `templates` and the `name` and `value` of each param. These stay outside it:

- a param's `source` and the chant version, which can change without changing what deploys;
- SBOM entries, which external tools write with timestamps;
- the actor, the time, the label and any signature, which belong to the cut. Two cuts of one commit then get the same digest, which #4046 relies on, and a release published from CI and one published from a workstation with no CI are the same release.

A cut is a line appended to `_releases/cuts.jsonl`: `{ version: 1, releaseDigest, label, actor, timestamp, runOrigin, signature }`, with `signature` written by #4031 and #4049. The human name is `label`, the value `chant release cut <version>` (#4027) and `components rollback` (#4035) take. The field is `label` because `version` is already the schema-version field on `ReleaseRecord` (`release-ledger.ts:80`), on gate lines and on the build manifest. A label names one release digest in a member, and a release digest takes at most one label. Cutting a digest again is a no-op that prints the existing label, and cutting it under a different label is refused.

`ReleaseRecord` stays the deploy record and gains an optional `releaseDigest` naming the release it deployed. `env` is already on the record, so release plus environment names the target. `run --components`, `promote`, `rollback` and `redeploy` write it when the deploy came from a release; `rollback` and `redeploy` copy it from the record they restore.

A promote moves the whole release by default: every component with an artifact in it, in dependency order, under one gate per environment that binds the release's change set for that environment. `--component` still promotes one component of a release. Its change set is that component's subset, so it has a different document digest and needs an approval of its own. The environment then runs components from two releases, which `workspace status` shows per component and #4035 handles.

The flag field avoids `flags`, which the deploy record already uses for `["legacy-digest"]` (`status.schema.json:921`). In a release, a flag value is a `params` entry whose `source` names the flag record. In `workspace status`, #4024's listing is `featureFlags`.

The change is additive to contract 1, since no existing field changes meaning. Every new field is optional or nullable, the release read is a new output schema at `v1` within contract 1, and its failures reuse the existing codes `ledger-unreadable` and `ledger-malformed`. If #4026 finds it needs a new reason code, that is a new contract version under the read contract's rule (`workspace-read-contract.mdx:17`), and it comes back here. The floors are in the [floor table](#floor-table).

## 4. One member or the whole workspace

Recommendation: a release belongs to one member. A project outside a workspace is its own single member, read through the flat ledger layout (`status.schema.json:884`).

Environments, build parameters and components are declared per member (`chant.config.ts`, ws-095), and #4030 puts the promotion order on the member's `environments`. A set of member releases shipped together is #2554's release train, which composes member releases by their digests and doesn't redefine them. #2554 is deferred pending #1939, so #4037 stays parked and nothing here waits on it.

## 5. Implicit releases, and whether templates are compiled per environment

Finding: today a template is synthesized for one environment per invocation, and no archive holds one template per environment.

- `--env` sets `CHANT_ENV` before the project is imported (`cli/main.ts:1392-1396`), and `chant run --components` resolves build parameters once per invocation before it discovers components (`cli/handlers/run.ts:971`, `:1028`).
- The build archive manifest has no environment field (`build-archive.ts:117-139`). It holds one entry per path, since `addArchiveEntry` replaces by path (`:189`), and it is stored under `_builds/` by manifest digest, explicitly not per environment (`build-ledger-store.ts:30-40`).
- Nothing in the component driver synthesizes a template. `cfn-deploy` reads the file at its `archive:` path from disk when the step runs (`lexicons/aws/src/components/apply.ts:64`, `:140`), so a deploy uses whatever the job's own `chant build` left there.
- A promote runs the remaining steps "as they are written in this checkout" (`cli/components.mdx:371`), and the generated promote job restores only what `docker-build`, `zip-package` and `jvm-build` wrote (`cli/build.mdx:143`). A promoted template therefore comes from the promote job's own checkout.
- Pinned helm renders already differ per environment, which is why a helm deploy record carries `inputDigest` for cross-environment joins (`release-ledger.ts:139-150`).

Recommendation: the cut compiles each environment the member declares in `chant.config.ts` `environments`, in #4030's order, with that environment's `CHANT_ENV` and resolved build parameters (flag values included), and records each target's template digests. Artifacts are built once. A promote under a release deploys the target's recorded templates and checks their digests, as it checks the publish digest today, instead of synthesizing from the checkout. A helm render is a template here, so it belongs to a target.

An artifact step whose inputs read `params`, such as `docker-build` `buildArgs` taken from `params.env`, would build different bytes per environment. The cut evaluates each component's build steps for every environment and refuses when their inputs differ, since "built once" can't hold for that component.

A project with no components fits (a) with no special case (#4046). `artifactDigests` is empty, and each target's `templates` are the content digests of the files `chant build --env <env>` writes, with `params` from `BuildResult.buildParams`. Templates are `deterministic-synthesis` (`components/build-archive.mdx:96`), so two cuts of one commit give one digest.

## 6. Can a flag change ship alone?

Recommendation: (i), flags ship with trunk.

A release is cut from a green commit, so a flag flip carries every commit merged since the release an environment runs. Option (c) would let a flag ship alone, but its release has two sources that never went green together, and the hash input, the cut checks and #4033's revocation would each need a second form. Trunk discipline keeps the cost down, because unfinished work on trunk is itself behind a flag that is off. When prod needs to change without trunk, rollback (#4035) is the way back.

Recommendation on empty change sets: an environment whose change set for the release is empty passes its gate without an approval, and the pass is recorded. Empty means every member planned, no member is failed or provisional, there are no holes, and no entry has an action other than `no-op` or `read`. The promote writes a resolution line with `releaseDigest`, `environment`, the empty document's digest in `planDigest`, `resolvedBy` set to the actor running the promote, and a new `empty: true`. A gate counts an `empty` resolution only after it recomputes that the stored document (#4022) is empty, and quorum and signing rules don't apply to it, because nothing changes. The promote also writes a deploy record per component naming the release, so #4030's order check sees that the environment passed. A prod-only flip then moves through staging with no click, and staging's ledger still says it runs the new release.

## Floor table

Every field below is new in contract 1 and optional or nullable, so a reader treats absence as an older chant. The floor is the first chant release that ships the issue; current main is 0.124.27, which has none of them. Each implementing pull request writes its release number into this table's copy in `reference/workspace-read-contract.mdx`, as the uncommitted-records table there does, and behold pins against that copy.

| Field | On | Holds | Floor |
|---|---|---|---|
| `_releases/<releaseDigest>.json` | `chant/lifecycle` | the release, shaped as in question 3 | the release with #4026 |
| `_releases/cuts.jsonl` | `chant/lifecycle` | one line per cut, with `label` | the release with #4026 |
| `signature` | each cut line | the signer's signature over the digest and label | the release with #4031 |
| the `releases` output schema, `v1` | the read contract | releases with their targets and the environments running each | the release with #4026 |
| `releaseDigest` | `ReleaseRecord` | the release a deploy came from | the release with #4043 |
| `releaseDigest`, `releaseLabel` | `status` release item | the same, and the release's label, `null` without one | the release with #4043 |
| `releaseDigest` | `PendingGateRecord`, `GateResolutionRecord` | the release a gate binds | the release with #4045 |
| `releaseDigest` | `status` gate item | the same | the release with #4045 |
| `empty` | `GateResolutionRecord` | `true` for a pass over an empty change set | the release with #4045 |
| stored change sets, keyed by document `digest` | `chant/lifecycle` | the document a release or pull-request gate bound | the release with #4022 |
| `featureFlags` | `status` member | each flag and its value per environment | the release with #4024 |

## Assumptions for #4033 and #4035

- A release is named by `releaseDigest` and traces to one commit, so revoking a commit's green tag revokes every release with that `commit` (#4033).
- A label is unique per member and names one digest, so `components rollback --to <label>` resolves to one release (#4035).
- An environment can run components from more than one release after a per-component promote. Status reports it per component.
- Who triggers a cut, by hand or on green, is #4033's. Nothing above depends on it.

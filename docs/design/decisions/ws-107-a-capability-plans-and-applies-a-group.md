---
schema: 1
id: "ws-107"
title: "A capability plans and applies a group of components as one"
state: "decided"
area: "D17"
source:
  issue: "INTENTIUS/chant#4435"
  row: "decide how a lexicon plans and applies several components as one"
  revision: null
question: "How does a lexicon plan and apply several components of a pull request as one, with one digest and one approval, without core taking any lexicon's shape: which components form a group, where the group sits among the waves, what the digest binds, what a reader inside the group sees, and what happens on a partial failure, a resume and a wave gate?"
options:
  - id: "a"
    label: "an optional group pair on Capability; core forms, places and binds the group"
    how: "Capability gains three optional methods: groupFallback(ctx, members), asked before anything plans; planGroup(ctx, members), returning one CapabilityPlan per member, a group digest and an opaque artifact; and runGroup(ctx, run, members), returning each member's outcome (applied, partial, failed, not-started, no-changes) and outputs. Core decides which components of the change form a group, places the group in one wave, folds the group digest into each member's planDigest, and maps outcomes onto member statuses. Members stay members of the change set."
    tradeoff: "Core gains a group pass in the pull-request run (#4440) and report fields (#4446). Each lexicon that composes implements three methods. A lexicon that implements none behaves exactly as today."
  - id: "b"
    label: "a lexicon hook over the whole change"
    how: "A lexicon plugin gets the change's components of its kinds and returns one plan and one apply for all of them. Core treats the result as one opaque unit."
    tradeoff: "Least core work. Core cannot place the unit among other kinds' components, cannot say which components it left out or why, and cannot check coverage or report per member, so each lexicon writes its own report."
  - id: "c"
    label: "a synthetic component per group"
    how: "Core rewrites the group into one component whose single step runs the composed run, as terragucci's compose target stands in for its roots in a wave (wavesWithRun)."
    tradeoff: "No change to Capability. The members disappear from the change set and the report, a component outside the group that reads a member reads a component that no longer exists, and the approval binds a name nobody declared."
  - id: "d"
    label: "no group; rounds and previews only"
    how: "Every lexicon previews a member with unknown inputs and supplies a PlanShape (#4422, #4423, #4428). A member that reads a value created in the same change applies in a later round covered by the first approval."
    tradeoff: "Nothing new to build in core. Terraform's composed run, one plan and one apply in which a created value reaches its readers inside the same apply, has no place, against the maintainer's direction on #4419 (2026-10-24)."
choice:
  option: "a"
  reason: "It is the only option that lets a lexicon run several components as one while core still decides which ones, orders them, binds the approval and reports each member. Nothing in the interface names a lexicon: the artifact is opaque, the digest is the capability's, and the outcome vocabulary is per member. Rounds and coverage stay as built for every component outside a group."
rejected:
  - option: "b"
    why: "Core loses the per-member change set, coverage and report the pull-request run is built on, and ruling 1 needs core to say which components grouped and why the others did not."
  - option: "c"
    why: "Members vanish from the change set and from the reads of components outside the group."
  - option: "d"
    why: "The maintainer ruled that Terraform's composed run is one plan and one apply, so rounds alone do not meet the epic."
supersedes: []
evidence:
  - title: "INTENTIUS/chant#4435, decide how a lexicon plans and applies several components as one"
    url: "https://github.com/INTENTIUS/chant/issues/4435"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4419, composed runs: design direction and the maintainer rulings of 2026-10-25"
    url: "https://github.com/INTENTIUS/chant/issues/4419"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4422, one approval covers a round whose only change is previewed unknowns"
    url: "https://github.com/INTENTIUS/chant/issues/4422"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4423, AWS previews a hole member and checks the real change set"
    url: "https://github.com/INTENTIUS/chant/issues/4423"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4430, a three-stack composed run needs one approval"
    url: "https://github.com/INTENTIUS/chant/issues/4430"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4440, core: plan a group as one, bind one digest, apply it as one unit"
    url: "https://github.com/INTENTIUS/chant/issues/4440"
    as_of: "2026-10-25T00:00:00Z"
  - title: "INTENTIUS/chant#4465, release promote plans and applies a group as one"
    url: "https://github.com/INTENTIUS/chant/issues/4465"
    as_of: "2026-10-25T00:00:00Z"
  - title: "terragucci compose.ts at c493e0e: compositionFor, composedDigest, MemberApply, wavesWithRun"
    url: "https://github.com/INTENTIUS/terragucci/blob/c493e0e/packages/terragucci/src/compose.ts"
    as_of: "2026-10-25T00:00:00Z"
  - title: "ws-104, the release model"
    url: "https://github.com/INTENTIUS/chant/blob/main/docs/design/decisions/ws-104-the-release-model.md"
    as_of: "2026-10-25T00:00:00Z"
decided_by: "lex00"
decided_on: "2026-10-25"
reviews: []
constrains:
  - "INTENTIUS/chant#4435"
  - "INTENTIUS/chant#4440"
  - "INTENTIUS/chant#4443"
  - "INTENTIUS/chant#4446"
  - "INTENTIUS/chant#4447"
  - "ws-104"
  - "path:packages/core/src/components/capability.ts"
  - "path:packages/core/src/components/pr-run.ts"
  - "path:packages/core/src/components/fan-out-run.ts"
  - "path:packages/core/src/change-set.ts"
  - "path:packages/core/src/pr-loop.ts"
---

# A capability plans and applies a group of components as one

Decided by lex00 on 2026-10-25: the design direction on #4419 (2026-10-24) and the rulings of 2026-10-25, with the interface written here for #4440 to build. Code was read at origin/integration/4419-composed-runs 8cd73461a, which has covered rounds (`components/covered-round.ts`, #4422), the AWS preview (#4423, #4430) and `PrMember.reads` (#4433).

The types are in `packages/core/src/components/capability.ts` and exported from `@intentius/chant/components`. Nothing calls them yet; #4440 does.

## The rulings

The maintainer's rulings on #4419's open questions, 2026-10-25, as they stand:

1. Partial composition. chant composes the eligible components. The rest plan wave by wave as today, under the one approval through covered rounds. The report names which components grouped and why the others fell back.
2. A component of another kind on a dependency path between two components splits them: two Terraform roots with a CloudFormation stack between them do not compose with each other.
3. Only a component whose deploy is a single step joins a group, for now.
4. The pull request's one approval covers the group. A change set that looks empty while the group has unknown reads is not passed without an approval.
5. Names: `terraform.compose`, `.chant-compose/` and `<key>.chant-unwritten`. A run also reads a leftover `.terragucci-unwritten` and never writes that name (#4437, #4441).
6. Previewing a Terraform hole outside a group is #4463, not built in this epic.
7. CloudFormation `Fn::ImportValue` between stacks, the CDK shape, is recorded by #4443, which files a separate epic. Not built here.
8. #4424 stays the Terraform tracking issue and closes with #4447.
9. #4425 is rescoped to record what #4428 built (core compares a lexicon's `PlanShape`), plus a conformance helper the AWS lexicon passes.
10. Whether terragucci's state migration switches to the lock code #4437 lifts is not ruled; it belongs to terragucci#1268.

Rulings 1 to 4 shape this record. 5 to 10 belong to other issues and are listed so the epic's decisions sit in one place.

## The interface

Three optional methods on `Capability`, beside `plan`, `run` and `outputs`:

| Method | Called by | When | Returns |
|---|---|---|---|
| `groupFallback(ctx, members)` | core's group pass | once per candidate group, before anything plans | a `GroupFallback` (`kind`, `reason`, and `drop` to leave out only some members), or `undefined` to take the group |
| `planGroup(ctx, members)` | `planPrSet` | at the group's wave, in place of `plan` for each member | `CapabilityGroupPlan`: one `CapabilityPlan` per member by component, the capability's `digest`, an opaque `artifact` |
| `runGroup(ctx, run, members)` | `applyPrSet`, through `runFanOut` | at the group's wave, in place of each member's `run` | `CapabilityGroupOutcome`: per member a `GroupMemberStatus` (`applied`, `partial`, `failed`, `not-started`, `no-changes`), its `outputs` and `error` |

A capability that declares `planGroup` without `runGroup`, or the reverse, never gets a group. `groupFallback` is optional; without it the capability takes every group core forms.

Each member arrives as a `GroupMember`: its component, its one step as declared, its input resolved against outputs from outside the group, its `DeployContext`, and its `reads` of other members. A `GroupRead` names the reader's input position (`at`, a JSON Pointer), the `ref` as `<component>.<output>`, and the member read. Core leaves that value `undefined` in the input and the capability wires it inside its own apply. `GroupContext` carries the environment, the variables and the components in apply order.

Core never reads `artifact`. It goes back to `runGroup` in a `GroupRun`, with the bound group digest and each member's plan as bound into the change set. Like `CapabilityPlan.artifact`, it lives in the process that planned; the apply stage plans again before it applies, as it does today.

Nothing in these types names state, modules, backends or any lexicon. Terraform's composed root, its state split and its write-back stay inside `terraform-apply` (#4447).

Who calls whom, as #4440 builds it:

- `pr.ts`'s prepare step derives the fan-out (`planFanOut`), then calls a new `findComponentGroups` in `components/groups.ts`. That function forms the candidate groups by the rule below and asks each capability's `groupFallback`. A new `groupFanOut` there places each group in one wave and returns the `FanOutPlan` with a `groups` field. Every later step reads groups from that plan, so the plan stage, the apply stage and each `--wave-gate` job get the same waves from the same commit.
- `planPrSet` plans a wave unit by unit. A component is planned by `planWaveComponent` as today. A group is planned by `planComponentGroup` in `groups.ts`, which builds the `GroupMember`s, calls `planGroup`, runs `bindTargets` (`wave-plan.ts`) on each member's plan, then folds in the group digest (`bindGroup`, below). Each member's part, planned outputs and shape go into the change set and `PrPlanSet` as any member's do. `PrPlanSet` gains `groups` and `fallbacks`.
- `applyPrSet` hands the grouped plan to `runFanOut`. In a wave, `runFanOut` runs a group through `runComponentGroup` in `groups.ts`, which calls `runGroup` once and turns each member outcome into a `DriverComponentResult` and its outputs.

## Which components form a group

A component is eligible when it is in the change (`plan.order`), its deploy has exactly one step with gates counted (ruling 3), and that step's capability declares `planGroup` and `runGroup`.

1. Candidate sets are the connected sets of eligible components of one kind, joined by reads: a wiring reference (`stackOutput()`, `@<component>.publish.*`) from one to the other, in either direction. An order that only `dependsOn` gives, with no read, joins nothing.
2. While a component outside a set lies on a `dependsOn` path between two of its members, the set splits: the members downstream of that component leave it, and both parts are joined by reads again. The outside component is taken in plan order, so the split is the same every time. This is ruling 2. It applies to any component outside the set, of another kind or of the same kind that could not join, because a group applies in one call and cannot wait for anything in between.
3. A set of one member is no group.
4. Each remaining set is offered to its capability's `groupFallback`. A fallback without `drop` dissolves it. A fallback with `drop` names the members to leave out, each with its own `kind` and `reason` or the fallback's (ruling 1). The rest are joined by reads and split by step 2 again, a member left on its own falls back with kind `alone` (or `split`, when step 2 split it off), and each set left with two or more members is offered again. A `drop` that names no member of the set dissolves it.
5. Groups are placed in plan order of their first member. A group whose placement would put two groups each before the other is dissolved with kind `cycle`.

A capability may refuse with any `kind` it names; terragucci's `compositionFor` kinds (`binary`, `backend`, `order-only` and the rest) become `terraform-apply`'s (#4438). Core's own kinds are `steps` (a component whose group-capable step is one of several, joined by a read to an eligible component), `split`, `alone` (the last member of a group whose capability dropped the others) and `cycle`. A fallback is decided before planning, so terragucci's `plan-failed` kind has no counterpart: a `planGroup` that throws makes every member of the group plan-failed, with its error, and nothing applies. A capability returns kind `off` when its own setting turns grouping off (`terraform.compose` unset): the plan set records it and the note does not print it.

The fallbacks list every component in the change whose capability declares the pair, that a read joins to another such component of its kind, and that ended in no group, each with its kind and reason (ruling 1). A component whose kind declares no pair is not listed: it had nothing to fall back from.

## All or nothing

Not all or nothing (ruling 1). The groups compose. Every other component of the change plans and applies wave by wave as today, and a member that reads a value not known yet is covered by the first approval through rounds (`coveredRound`). terragucci falls back for the whole change; chant does not.

## Where the group sits

A group is one unit in one wave. Its wave is the earliest in which every dependency of every member that is outside the group and in the change has applied in an earlier wave. When no member depends on anything outside the group in the change, that is the earliest wave any member is in, as terragucci's `wavesWithRun` places a composed run.

`groupFanOut` takes the members out of their waves and puts them, upstreams first, in the group's wave. Then, in plan order, each component outside the group moves to a later wave when a dependency now sits in its own wave or after it. Later waves keep their other members. A wave left empty stays, so wave numbers and their gates keep their meaning, and waves may be added at the end. The derivation's `digest` does not change, as `remainingFanOut` keeps it.

## What the digest binds

The approval binds the change-set document's digest (`changeSetDocumentDigest`), which binds every member's `planDigest`. Core folds the group into each one, so an approval of one composition never applies another:

- the group digest is `computePlanDigest("capability-group", { kind, members, composition })`, where `members` is each member's component, change-set member and own `planDigest`, sorted, and `composition` is the capability's `CapabilityGroupPlan.digest`;
- each member's `planDigest` becomes `computePlanDigest("capability-group-member", { plan, group })`, written into its change-set part too, the way `bindTargets` binds targets.

A group with one member more, or the same members composed differently, moves every member's digest and so the document's. The capability's `digest` is where it binds what the members' own plans do not show; terragucci's `composedDigest` joins its generated files there.

One approval covers the group (ruling 4). There is no gate per group. Policy at the gate (#4294) and hooks (#4288) see each member's part as they see any member's.

## What a reader inside the group sees

A member's read of another member of its group is neither a hole nor an `unknownInputs` entry. It is a value the group computes in its apply. So:

- the member is not held for a round on account of it. `heldReason` leaves out references to members of the reader's own group, as it leaves out a build's published identity;
- `PrMember.reads` lists it as today, under `unknown` when the upstream's plan had no value (#4433), so the report still draws the line;
- the change set marks it. `ChangeSetMember` gains `group?: { digest: string; reads: string[] }`: the group digest and the `<component>.<output>` values the member reads from its group that the plan does not know. It enters the document digest when present, so documents without it keep their digests.
- `isEmptyChangeSet` returns false when any member's `group.reads` is non-empty. A change set that looks empty while the group has unknown reads then waits for a person under `pr-env` and at a release gate, as ruling 4 says.

The note (#4446) says it in one line per group: "`a`, `b`, `c` plan and apply as one (`terraform-apply`); `b` reads `a.id` and `c` reads `b.arn`, known when the group applies." A component outside the group that reads a member reads that member's planned outputs, or is planned again in a round once the group applied, as for any upstream.

## A group that fails part way

`runGroup` says how each member's part ended. Core maps it:

| Outcome | Member status | In the run |
|---|---|---|
| `applied`, `no-changes` | `applied` | completed; its outputs are read by components after it |
| `partial`, `failed` | `failed` | failed; components outside the group that depend on it are `blocked` by it (#4291) |
| `not-started` | `not-started`, a new `PrMemberStatus` | not run; components outside the group that depend on it are `blocked` by it |

What applied stays applied, and the report says so per member. Core runs no rollback for a group member; compensation is the capability's own. A `runGroup` that throws makes every member `failed`, since core cannot tell what applied; one that throws a moved plan (`isPlanMovedError`) makes every member `not-started`, and `pr-apply` exits 3 as for any moved plan. Any `failed` member makes `pr-apply` exit non-zero.

A group is held as a unit. When any member reads an output from outside the group that moved or was unknown, the whole group, and what is downstream of it, waits for a round. The round plans the group again with `planGroup` and decides coverage per member by `coveredRound`, with one rule more: the round's group must have the same members as the approved one, or it is not covered.

## Resume

The attempt record keeps the approved change set and the components that applied, as today. Members with `applied` or `no-changes` count as applied; `partial`, `failed` and `not-started` members are what is left. `resumePrSet` narrows the plan with `remainingFanOut` and forms groups again over what is left, so the left members of a group plan as a smaller group, or one by one when the rule or the capability says so. Each is checked against the approved set as any resumed member is (`waveNotCovered`, `coveredRound`). A `partial` member's fresh plan has fewer changes than the approved one, which `planCoveredBy` accepts. The smaller group's digest differs from the approved group's, so coverage rests on entries and shapes, never on the digest. A member's own state between attempts goes through `DeployContext.carry`, as a choudoufu root's resume file does today. #4446 builds this.

## Wave gate

Under `--wave-gate`, the group is part of the wave `groupFanOut` placed it in. The waves `p.plan.waves` holds are the grouped ones, and the report's `selection.waves` shows them. The wave's digest covers the group's members like any other. A later wave whose group plans again is covered by the approved change set when `waveNotCovered` says so for each member; otherwise the wave waits at `<gate>-wave-<k>` with the whole group in it. A `--wave <k>` job forms the groups from the same commit and gets the same waves.

## Outside this record

The pull-request run is `pr-plan`, `pr-apply` and `pr-env`, which call `planPrSet` and `applyPrSet`. A release promote (`runPromotionInRounds`), `components fan-out` and `run --components` keep planning component by component. Under the default workflow a merge deploys nothing (#4168) and the deploy is the promote, so composing there is #4465.

The report fields (`groups`, `fallbacks`, `group`, `groupOutcome`) and their contract floor are #4446. How each other lexicon composes is #4443.

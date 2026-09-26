# Reference workspace

A small product built as a chant workspace: an app, the chant project that delivers it, a design client and the design data it edits. It is chant's integration fixture for the workspace work in [#2524](https://github.com/INTENTIUS/chant/issues/2524) (D21, [ws-046](../docs/design/decisions/ws-046-reference-repo.md)), tracked in [#2543](https://github.com/INTENTIUS/chant/issues/2543).

It lives in the chant repo rather than in a repo of its own, for two reasons. Each phase of the workspace work lands its change here in the same pull request as the feature. And chant's CI tests it against the commit under test, not against a released chant, so a change that breaks it fails before it merges.

It is a level 1 workspace. [`chant.workspace.json`](chant.workspace.json) declares its four members in the format of [#2534](https://github.com/INTENTIUS/chant/issues/2534), and `chant workspace ls` lists them:

```sh
cd reference-workspace
chant workspace ls
```

The chant repo's own [`chant.workspace.json`](../chant.workspace.json) lists this directory as a member of kind `workspace`, a nested workspace that the outer one does not look inside.

## Members

| Member | Directory | Kind | What it is |
|---|---|---|---|
| app | [`app/`](app) | `other` | a Node HTTP server with no dependencies, its own Dockerfile and one test. No app kind exists yet ([#2535](https://github.com/INTENTIUS/chant/issues/2535)) |
| delivery | [`delivery/`](delivery) | `chant` | a chant project on the docker lexicon. It declares the app with the `DockerWebService` composite, and `chant build` writes a Compose file that builds the app's image from `app/Dockerfile` and runs it. Its `app` component deploys that composite |
| design-client | [`design-client/`](design-client) | `other`, role `design-app` | a placeholder for a hud client with its own lineage. No hud client package is published to vendor yet |
| design | [`design/`](design) | `other` | the design data member: a screen spec and a wireframe for the app's home page |

The app does not embed the design client, so it declares no `depends-on` link to it (D18). Delivery builds the app's image from `../app`, and that build-context path is its only link to the app until member links land ([#2539](https://github.com/INTENTIUS/chant/issues/2539)). The design client has a lineage of its own: once there is a client to vendor, the lineage lock records its upstream as a scope of its own, and an upgrade of it writes only inside `design-client/`.

The root also holds [`chant.template.json`](chant.template.json), the template manifest for `chant init --from` ([#2627](https://github.com/INTENTIUS/chant/issues/2627)). It declares one parameter, `name`, with the default `Reference app`. In this directory the files it lists carry the placeholder `{{chant:name}}`, so the app run from here shows that text as its title. A copy made with `chant init --from` shows the value.

The declaration has an empty `pins` list. Nothing here loads a kind plugin yet, so there is nothing to pin until kinds come from plugins ([#2535](https://github.com/INTENTIUS/chant/issues/2535)).

The root holds the declaration, this README and [`decisions/`](decisions), the workspace's own decision records in the format of [`docs/design/decisions/`](../docs/design/decisions/README.md), with ids `ref-001` onwards. The kind file and schema beside them are copies of chant's, so a workspace made from this one can read them on its own:

```sh
cd reference-workspace
chant workspace records --kind decisions/decision.kind.mjs --current
```

[`work/`](work) holds the workspace's work items ([#2683](https://github.com/INTENTIUS/chant/issues/2683)), with the work kind and its schema beside them. `W-001` implements `ref-002` and is in progress, and `W-002` needs `W-001`, so `records` reads it as blocked. The declaration names the work kind beside the decision kind, so `graph --intent` reads both without `--kind`:

```sh
cd reference-workspace
chant workspace records --kind work/work.kind.mjs --json
chant workspace graph --intent design/screens/home.json
```

[`decisions/points.json`](decisions/points.json) declares the workspace's decision points ([ws-058](../docs/design/decisions/ws-058-decision-points.md)): `finding-triage` and `needs-a-decision` over what `graph --intent` reports, `slice-tier` for a work item's builder tier, and `ship-skip`, taken from chud. Their answers are records in [`answers/`](answers), and `chant workspace points --open` lists the ones waiting on a person:

```sh
cd reference-workspace
chant workspace points --open --json
```

A work item a model or an agent suggests opens `proposed`, with its proposer in `proposed_by`, until a person opens it or drops it.

[`lessons/`](lessons), [`constraints/`](constraints) and [`preferences/`](preferences) hold what a box learns and stands by without weighing options, so it stops living only in a decision's prose ([#2771](https://github.com/INTENTIUS/chant/issues/2771)). A lesson names a situation and what was learned, with `derived_from` naming where it came from. A constraint states a rule, and its `constrains` joins `graph --intent` the way a decision's does. A preference states a default a person or team chose, and a decision may override it without withdrawing it. The declaration names all three beside the decision, work and answer kinds:

```sh
cd reference-workspace
chant workspace records --kind lessons/lesson.kind.mjs --json
chant workspace records --kind constraints/constraint.kind.mjs --json
```

[`skills/record-decisions/`](skills/record-decisions) and
[`docs/record-decisions.md`](docs/record-decisions.md) are a harness-neutral
way to write decision records by hand from a session, before anything
harvests them automatically ([#2709](https://github.com/INTENTIUS/chant/issues/2709)).
The skill is plain Markdown with the frontmatter Claude Code, Codex, Gemini
CLI and opencode all read; the doc is the same ask as one prompt, for a
harness with no skill mechanism. Both walk the same loop: list what the
session decided, check it against `chant workspace records --current --json`
for duplicates and contests, show the list, and write only what's kept with
`chant workspace records new`. See [Recording Decisions by Hand](https://intentius.io/chant/guide/recording-decisions-by-hand/)
for the loop end to end.

## What switches on here, and when

| Issue | What it adds to this workspace |
|---|---|
| [#2534](https://github.com/INTENTIUS/chant/issues/2534) | landed: `chant.workspace.json` declares the members, and `chant workspace ls` lists them |
| [#2535](https://github.com/INTENTIUS/chant/issues/2535) | kinds are checked; `other` members need `because`, and an app kind can replace `other` for the app |
| [#2536](https://github.com/INTENTIUS/chant/issues/2536) | the read contract and its output schemas are tested against this workspace |
| [#2537](https://github.com/INTENTIUS/chant/issues/2537) | `chant workspace build`, `lint`, `audit` and `graph` run per member |
| [#2538](https://github.com/INTENTIUS/chant/issues/2538) | delivery gets a per-member ledger |
| [#2539](https://github.com/INTENTIUS/chant/issues/2539) | delivery states its link to the app instead of a build-context path |
| [#2540](https://github.com/INTENTIUS/chant/issues/2540) | landed: `chant init --from INTENTIUS/chant@<tag>#reference-workspace` copies this directory and writes `.chant/workspace.lock.json`. The design client gets a lineage scope of its own once there is a client to vendor |
| [#2542](https://github.com/INTENTIUS/chant/issues/2542) | per-member CI pipelines with path filters |
| [#2546](https://github.com/INTENTIUS/chant/issues/2546) | the decisions become sealed records, read by the spec query |
| [#2549](https://github.com/INTENTIUS/chant/issues/2549) | partly landed: `ref-002` pins `design/screens/home.json` by hash, and `chant workspace records` reports an edit to it as drift. The design member's kind and `check --live` come later |
| [#2550](https://github.com/INTENTIUS/chant/issues/2550) | `chant workspace upgrade` from an older tag of this workspace |
| [#2627](https://github.com/INTENTIUS/chant/issues/2627) | landed: [`chant.template.json`](chant.template.json) declares a `name` parameter, the app's display name. `chant init --from ... --param name="Untitled app"` puts it in the home page and the screen spec, and the lock records it |
| [#2683](https://github.com/INTENTIUS/chant/issues/2683) | landed: [`work/`](work) holds two work items read through `work/work.kind.mjs`. `W-001` implements `ref-002`, and `W-002` needs `W-001`. `chant workspace records` gives each one `ready` and `blockedBy`, and `graph --intent` shows them beside the decisions |
| [#2662](https://github.com/INTENTIUS/chant/issues/2662) | landed: delivery declares the app as a `DockerWebService` composite instance, and [`delivery/src/app.component.ts`](delivery/src/app.component.ts) is the component that deploys it, naming that kind in `composites`. `chant workspace graph --composites` lists the instance `delivery/app` with the component, matched in the same member. Compose names the service `appService` |
| [#2741](https://github.com/INTENTIUS/chant/issues/2741) | landed: [`decisions/points.json`](decisions/points.json) declares `finding-triage`, `needs-a-decision`, `slice-tier` and `ship-skip`, and the work kind gains a `proposed` first state with `proposed_by`. The studio smoke claim for the same flow belongs to arugula-salad/studio |
| [#2709](https://github.com/INTENTIUS/chant/issues/2709) | landed: [`skills/record-decisions/SKILL.md`](skills/record-decisions/SKILL.md) and [`docs/record-decisions.md`](docs/record-decisions.md), a harness-neutral way to propose decision records by hand from a session. Names `chant workspace records new` (or the `records-new` MCP tool from #2707, once it exists); the `source` provenance block from #2708 is filled in once that lands |
| [#2771](https://github.com/INTENTIUS/chant/issues/2771) | landed: [`lessons/`](lessons), [`constraints/`](constraints) and [`preferences/`](preferences), three more reference kinds beside the decision, work and answer kinds, one example record each |

## Tests

[`test/reference-workspace.test.ts`](../test/reference-workspace.test.ts) runs in chant's unit test shards. It validates the declaration against chant's declaration schema, checks that its members are on disk, runs `chant workspace ls --json` and `chant workspace check` from the commit under test, runs the app's test, builds and lints delivery with no findings, runs `chant workspace graph --composites` and checks the app's row, validates the decision files against chant's schema and reads them with `chant workspace records`, and validates and reads the work items the same way. It validates the decision points. [`test/reference-workspace-triage.e2e.test.ts`](../test/reference-workspace-triage.e2e.test.ts), in chant's `test-e2e` job, walks a finding on a copy from `graph --intent` through the `decide` activity and a stub backend to a proposed work item that a person keeps. The first file also runs `chant init --from` on this directory at `HEAD` and checks that the copy is a working workspace: it has a lock, reads its own decisions, lists the same four members with `chant workspace ls`, and passes `chant workspace check`, and that the copy carries the record-decisions skill and prompt, whose example record validates against the decision schema. The per-member workspace commands and their contract tests join the test as their issues land (#2537, #2536).

## Ownership and support

| | |
|---|---|
| Owner | the chant maintainers, [INTENTIUS/chant](https://github.com/INTENTIUS/chant). Changes go through chant's own pull requests |
| Tags | `reference-workspace-v<minor>` on the chant repo, one per chant minor release, on the same commit as `chant-v<minor>.0`. Tags are cut starting with the first chant release after the declaration landed; none exists yet |
| Chant floor | 0.85.0 |
| Upgrade range | a workspace made from any tag of the last three chant minors upgrades to the current one |

The floor is 0.85.0 because delivery declares the app with the docker lexicon's `DockerWebService` composite and `graph --composites` reads it ([#2662](https://github.com/INTENTIUS/chant/issues/2662)), neither of which is in 0.84.0. Before that it was 0.81.0, because the declaration needs `chant workspace ls` and the declaration reader ([#2593](https://github.com/INTENTIUS/chant/pull/2593)), merged after 0.80.0. The decision files need `chant workspace records`, which is in 0.80.0 ([#2572](https://github.com/INTENTIUS/chant/pull/2572), [#2573](https://github.com/INTENTIUS/chant/pull/2573)), and the delivery member alone builds on older releases, but the fixture is only ever tested as a whole. The floor moves up when a phase lands a feature here that an older chant does not have, and the tag for that minor says so below.

Until `chant workspace upgrade` exists (#2550), no command performs an upgrade. Within the range, the promise is that each change between two tags is listed below with any manual step it needs, so a workspace made from an older tag can be brought forward by hand from `git diff reference-workspace-v<old> reference-workspace-v<new> -- reference-workspace/`. Once #2550 lands, the same range is what its migrations cover.

## Changes by tag

| Tag | Chant floor | Changes | Manual steps |
|---|---|---|---|
| the first tag, `reference-workspace-v<minor>` for the first chant minor after the declaration landed | 0.81.0 | the four members declared in `chant.workspace.json` at level 1, two decision files | none |
| the tag after `reference-workspace-v0.85` | 0.85.0, and 0.86.0 for the work kind | adds [`work/`](work), the work kind with two work items ([#2683](https://github.com/INTENTIUS/chant/issues/2683)). A chant older than 0.86.0 refuses `work/work.kind.mjs` as `kind-invalid`, and everything else still reads | none |
| `reference-workspace-v0.85`, with chant 0.85.0 | 0.85.0 | delivery declares the app with the docker lexicon's `DockerWebService` composite and adds `delivery/src/app.component.ts`, the component that deploys it ([#2662](https://github.com/INTENTIUS/chant/issues/2662)) | Compose now names the service `appService` instead of `app`, so a command that names the service, such as `docker compose logs app`, needs the new name |
| the tag after `reference-workspace-v0.89` | 0.89.0 | adds [`skills/record-decisions/`](skills/record-decisions) and [`docs/record-decisions.md`](docs/record-decisions.md) ([#2709](https://github.com/INTENTIUS/chant/issues/2709)), plain files with no schema or command either depends on | none |
| the tag after `reference-workspace-v0.91` | 0.92.0 for the work kind | adds `finding-triage` and `needs-a-decision` to `decisions/points.json`, `release.work_changed` to `ship-skip`, and a `proposed` first state with `proposedBy` to the work kind ([#2741](https://github.com/INTENTIUS/chant/issues/2741)). `finding-triage` also sends `change-out-of-scope` from `check --changes` to a decision ([#2794](https://github.com/INTENTIUS/chant/issues/2794)). A chant older than 0.92.0 refuses the work kind's `proposedBy` as `kind-invalid` | a work item written through the MCP `records-new` tool now opens `proposed`, so a person moves it to `open` before it is ready |

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
| delivery | [`delivery/`](delivery) | `chant` | a chant project on the docker lexicon. `chant build` writes a Compose file that builds the app's image from `app/Dockerfile` and runs it |
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

## Tests

[`test/reference-workspace.test.ts`](../test/reference-workspace.test.ts) runs in chant's test job. It validates the declaration against chant's declaration schema, checks that its members are on disk, runs `chant workspace ls --json` and `chant workspace check` from the commit under test, runs the app's test, builds and lints delivery with no findings, validates the decision files against chant's schema and reads them with `chant workspace records`. It also runs `chant init --from` on this directory at `HEAD` and checks that the copy is a working workspace: it has a lock, reads its own decisions, lists the same four members with `chant workspace ls`, and passes `chant workspace check`. The per-member workspace commands and their contract tests join the test as their issues land (#2537, #2536).

## Ownership and support

| | |
|---|---|
| Owner | the chant maintainers, [INTENTIUS/chant](https://github.com/INTENTIUS/chant). Changes go through chant's own pull requests |
| Tags | `reference-workspace-v<minor>` on the chant repo, one per chant minor release, on the same commit as `chant-v<minor>.0`. Tags are cut starting with the first chant release after the declaration landed; none exists yet |
| Chant floor | 0.81.0 |
| Upgrade range | a workspace made from any tag of the last three chant minors upgrades to the current one |

The floor is 0.81.0 because the declaration needs `chant workspace ls` and the declaration reader ([#2593](https://github.com/INTENTIUS/chant/pull/2593)), merged after 0.80.0. The decision files need `chant workspace records`, which is in 0.80.0 ([#2572](https://github.com/INTENTIUS/chant/pull/2572), [#2573](https://github.com/INTENTIUS/chant/pull/2573)), and the delivery member alone builds on older releases, but the fixture is only ever tested as a whole. The floor moves up when a phase lands a feature here that an older chant does not have, and the tag for that minor says so below.

Until `chant workspace upgrade` exists (#2550), no command performs an upgrade. Within the range, the promise is that each change between two tags is listed below with any manual step it needs, so a workspace made from an older tag can be brought forward by hand from `git diff reference-workspace-v<old> reference-workspace-v<new> -- reference-workspace/`. Once #2550 lands, the same range is what its migrations cover.

## Changes by tag

| Tag | Chant floor | Changes | Manual steps |
|---|---|---|---|
| the first tag, `reference-workspace-v<minor>` for the first chant minor after the declaration landed | 0.81.0 | the four members declared in `chant.workspace.json` at level 1, two decision files | none |

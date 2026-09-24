# Reference workspace

A small product built as a chant workspace: an app, the chant project that delivers it, a design client and the design data it edits. It is chant's integration fixture for the workspace work in [#2524](https://github.com/INTENTIUS/chant/issues/2524) (D21, [ws-046](../docs/design/decisions/ws-046-reference-repo.md)), tracked in [#2543](https://github.com/INTENTIUS/chant/issues/2543).

It lives in the chant repo rather than in a repo of its own, for two reasons. Each phase of the workspace work lands its change here in the same pull request as the feature. And chant's CI tests it against the commit under test, not against a released chant, so a change that breaks it fails before it merges.

Today it is at level 0. There is no `chant.workspace.json`, only [`chant.workspace.draft.json`](chant.workspace.draft.json), which nothing reads. The declaration arrives with [#2534](https://github.com/INTENTIUS/chant/issues/2534).

## Members

| Member | Directory | Kind | What it is |
|---|---|---|---|
| app | [`app/`](app) | `other` | a Node HTTP server with no dependencies, its own Dockerfile and one test. No app kind exists yet ([#2535](https://github.com/INTENTIUS/chant/issues/2535)) |
| delivery | [`delivery/`](delivery) | `chant` | a chant project on the docker lexicon. `chant build` writes a Compose file that builds the app's image from `app/Dockerfile` and runs it |
| design-client | [`design-client/`](design-client) | `other`, role `design-app` | a placeholder for a hud client with its own lineage. No hud client package is published to vendor yet |
| design | [`design/`](design) | `other` | the design data member: a screen spec and a wireframe for the app's home page |

The app does not embed the design client, so it declares no `depends-on` link to it (D18).

The root also holds [`chant.template.json`](chant.template.json), the template manifest for `chant init --from` ([#2627](https://github.com/INTENTIUS/chant/issues/2627)). It declares one parameter, `name`, with the default `Reference app`. In this directory the files it lists carry the placeholder `{{chant:name}}`, so the app run from here shows that text as its title. A copy made with `chant init --from` shows the value.

The root holds this README and [`decisions/`](decisions), the workspace's own decision records in the format of [`docs/design/decisions/`](../docs/design/decisions/README.md), with ids `ref-001` onwards. The kind file and schema beside them are copies of chant's, so a workspace made from this one can read them on its own:

```sh
cd reference-workspace
chant workspace records --kind decisions/decision.kind.mjs --current
```

## What switches on here, and when

| Issue | What it adds to this workspace |
|---|---|
| [#2534](https://github.com/INTENTIUS/chant/issues/2534) | the draft becomes a real `chant.workspace.json`; `chant workspace ls` lists the members |
| [#2535](https://github.com/INTENTIUS/chant/issues/2535) | kinds are checked; `other` members need `because`, and an app kind can replace `other` for the app |
| [#2536](https://github.com/INTENTIUS/chant/issues/2536) | the read contract and its output schemas are tested against this workspace |
| [#2537](https://github.com/INTENTIUS/chant/issues/2537) | `chant workspace build`, `lint`, `audit` and `graph` run per member |
| [#2538](https://github.com/INTENTIUS/chant/issues/2538) | delivery gets a per-member ledger |
| [#2539](https://github.com/INTENTIUS/chant/issues/2539) | delivery states its link to the app instead of a build-context path |
| [#2540](https://github.com/INTENTIUS/chant/issues/2540) | landed: `chant init --from INTENTIUS/chant@<tag>#reference-workspace` copies this directory and writes `.chant/workspace.lock.json`. The design client gets a lineage scope of its own once there is a client to vendor |
| [#2542](https://github.com/INTENTIUS/chant/issues/2542) | per-member CI pipelines with path filters |
| [#2546](https://github.com/INTENTIUS/chant/issues/2546) | the decisions become sealed records, read by the spec query |
| [#2549](https://github.com/INTENTIUS/chant/issues/2549) | records link to `design/` by anchor and pin its files' hashes |
| [#2550](https://github.com/INTENTIUS/chant/issues/2550) | `chant workspace upgrade` from an older tag of this workspace |
| [#2627](https://github.com/INTENTIUS/chant/issues/2627) | landed: [`chant.template.json`](chant.template.json) declares a `name` parameter, the app's display name. `chant init --from ... --param name="Untitled app"` puts it in the home page and the screen spec, and the lock records it |

## Tests

[`test/reference-workspace.test.ts`](../test/reference-workspace.test.ts) runs in chant's test job. It checks that the draft's members are on disk and no live declaration is, runs the app's test, builds and lints delivery with no findings, validates the decision files against chant's schema and reads them with `chant workspace records`. It also runs `chant init --from` on this directory at `HEAD` and checks that the copy has a lock and reads its own decisions. A second run passes `--param name="Untitled app"` and checks that the value reaches every file the manifest lists and the lock, and that the copy's app test passes with it. The copy is not a working workspace until the declaration lands (#2534), and the workspace commands and their contract tests join the test as their issues land.

## Ownership and support

| | |
|---|---|
| Owner | the chant maintainers, [INTENTIUS/chant](https://github.com/INTENTIUS/chant). Changes go through chant's own pull requests |
| Tags | `reference-workspace-v<minor>` on the chant repo, one per chant minor release, on the same commit as `chant-v<minor>.0`. The first is `reference-workspace-v0.80` |
| Chant floor | 0.80.0 |
| Upgrade range | a workspace made from any tag of the last three chant minors upgrades to the current one |

The floor is 0.80.0 because that is the first release with `chant workspace records`, which the decision files here are read with ([#2572](https://github.com/INTENTIUS/chant/pull/2572), [#2573](https://github.com/INTENTIUS/chant/pull/2573), merged after 0.79.0). The delivery member alone builds on older releases, but the fixture is only ever tested as a whole. The floor moves up when a phase lands a feature here that an older chant does not have, and the tag for that minor says so below.

Until `chant workspace upgrade` exists (#2550), no command performs an upgrade. Within the range, the promise is that each change between two tags is listed below with any manual step it needs, so a workspace made from an older tag can be brought forward by hand from `git diff reference-workspace-v<old> reference-workspace-v<new> -- reference-workspace/`. Once #2550 lands, the same range is what its migrations cover.

## Changes by tag

| Tag | Chant floor | Changes | Manual steps |
|---|---|---|---|
| `reference-workspace-v0.80` | 0.80.0 | first tag: the four members at level 0, two decision files, a draft declaration | none |

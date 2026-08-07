# Wardens

Runtime governance CLIs built on chant's provider-agnostic reconcile seam
(`@intentius/chant/reconcile`, #501). Each warden fetches live state from a
provider's API, diffs it against a declared governance config, and reconciles —
stateless, selective-by-omission, ownership-gated deletes, dry-run by default.

| Package | Bin | Provider surface |
| --- | --- | --- |
| `@intentius/github-warden` (`wardens/github`) | `github-warden` | GitHub org + repos, App auth, audit + compliance reporting |
| `@intentius/gitlab-warden` (`wardens/gitlab`) | `gitlab-warden` | GitLab groups + projects, token auth |
| `@intentius/forgejo-warden` (`wardens/forgejo`) | `forgejo-warden` | Forgejo orgs + repos, token auth |
| `@intentius/warden-core` (`wardens/core`) | — | Shared CLI scaffolding (flags, config loading, outcome rendering, exit codes) |

## Why these are not lexicons (#447, #789)

A lexicon is build-time synthesis: tsc-gated, zero runtime I/O, emits files. A
warden is the opposite execution model: live-API I/O, auth, e2e suites against
real instances. Folding a warden into its `lexicon-*` package couples runtime
dependencies into a build-time plugin, so the two stay separate packages with
separate testing profiles. `@intentius/chant-lexicon-github-org` was the older
plan for the GitHub org CLI and was retired in favor of `wardens/github`
(#488, superseded by #789).

## How a warden relates to its lexicon (#789)

Uniform rule: a lexicon is never required to *run* a warden — the CLI consumes
plain YAML/JSON governance config. A warden may declare its provider's lexicon
as a peer only where warden features consume it at runtime:

- `github-warden` peers on `@intentius/chant-lexicon-github`: the `audit`
  subcommand runs the lexicon's post-synth checks over managed repos, and the
  pipeline emitter types its output as lexicon `Workflow` resources.
- `gitlab-warden` and `forgejo-warden` declare no lexicon dependency — nothing
  in them consumes one yet.

Authoring governance config from typed TS (the C1 `LandingZone` pattern of
#787) is a build-time concern and stays in lexicons/composites; the warden
only ever reads the emitted config.

## Packaging (#789)

Every warden publishes three surfaces:

- `bin/` + `dist/cli.js` — the committed launcher and the esbuild bundle it
  imports. The bundle is self-contained; installing a warden pulls no runtime
  dependencies beyond what its package.json says.
- `src/` — the library surface, resolved directly (chant's model: the
  `development`/`default` export conditions point at TypeScript source).
- `dist/*.d.ts` — declaration-only tsc output backing the `types` condition.

The e2e suites live per-warden (`e2e/`) and run from the monorepo's
`warden-*-e2e.yml` workflows — nightly and on demand, never gating PR CI.

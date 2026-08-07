# forgejo-warden

[![chant](https://github.com/intentius/chant/actions/workflows/chant.yml/badge.svg)](https://github.com/intentius/chant/actions/workflows/chant.yml)
[![e2e](https://github.com/intentius/chant/actions/workflows/warden-forgejo-e2e.yml/badge.svg)](https://github.com/intentius/chant/actions/workflows/warden-forgejo-e2e.yml)

Keep your Forgejo org and repos in a declared state — reconcile, guardrails, drift correction.

## Install

```bash
# Dry-run against your instance — reads only, prints a plan, changes nothing.
npx @intentius/forgejo-warden reconcile --config governance.yml --base-url https://forgejo.example.com --token-env FORGEJO_TOKEN --mode dry-run
```

Installs the `forgejo-warden` CLI. Point `--base-url` at your instance — works
against [Codeberg](https://codeberg.org) too. Config + flags below.

A sibling of [github-warden](https://github.com/INTENTIUS/github-warden), built on
the shared provider-agnostic reconcile primitive in
[`@intentius/chant/reconcile`](https://github.com/INTENTIUS/chant) (change-set
model, generic collection diff, guardrail framework, and the `runReconcile`
loop). forgejo-warden supplies the Forgejo-specific layer: a REST client for a
self-hosted instance, the config + live-state types, a Forgejo `diff()`, and the
reconcile cycles.

## What it reconciles

You declare desired state in YAML (selective-by-omission: an absent field is
never touched); warden diffs it against the live org and, in `apply` mode,
converges it — guarded by a removal cap so a typo can't mass-delete.

| Cycle | Reconciles |
|-------|------------|
| `org-settings` | org name/description/website/visibility, repo-admin team access |
| `membership` | org members (team-driven; ownership-gated removal) |
| `teams` | teams + their members and repo access |
| `repo-settings` | repo settings + topics |
| `branch-protection` | Forgejo `branch_protections` (not rulesets) |
| `repo-baseline` | provision repos (empty or from a template) |
| `secrets-variables` | Actions secrets (presence) + variables (value), org & repo |
| `webhooks` | org & repo webhooks |

## Tests

`npm test` runs the unit suite (mock-client, fully offline). The
[e2e suite](e2e/) is **fully hermetic** — it stands up a throwaway Forgejo via
Docker Compose, mints an admin token, provisions its own org, exercises every
cycle, and tears down (no external account or secrets):

```sh
eval "$(npm run --silent e2e:up)"   # compose up + mint token
npm run test:e2e:run                # FORGEJO_E2E_APPLY=1 to include the apply phase
npm run e2e:down                    # compose down -v
```

CI runs it on every push to main and nightly.

## How it differs from github-warden

- **Self-hosted:** the client takes a configurable instance base URL, not a fixed API host.
- **Auth:** a Forgejo API token — no GitHub Apps, no installation tokens.
- **Membership is team-driven**, branch protection (not rulesets), plus webhooks.
- Out of scope (no Forgejo equivalent): GHAS/security features, deployment environments, Dependabot, fine-grained PAT governance.

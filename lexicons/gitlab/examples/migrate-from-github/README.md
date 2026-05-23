# migrate-from-github example

A worked example showing `chant migrate` in action: a representative
GitHub Actions workflow translated to both `.gitlab-ci.yml` and typed
chant TypeScript.

## What's here

- `input/ci.yml` — a realistic 3-job GitHub Actions workflow (build → test → deploy) using six common marketplace actions: `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact` (implicit), plus matrix-driven test parallelism and a conditional deploy gated on `github.ref`.
- `expected.gitlab-ci.yml` — the literal YAML translation produced by `chant migrate input/ci.yml --output expected.gitlab-ci.yml`.
- `expected.ts` — the same translation in chant TypeScript form (`--emit ts`).

## Reproduce

```bash
# From this directory
npx chant migrate input/ci.yml --output out.gitlab-ci.yml
diff out.gitlab-ci.yml expected.gitlab-ci.yml

npx chant migrate input/ci.yml --emit ts --output out.ts
diff out.ts expected.ts
```

## What the example demonstrates

| GitHub feature | What chant migrate did |
|---|---|
| `name: Node CI` | → `workflow.name: Node CI` |
| `on: push` + `pull_request` | → `workflow.rules` with two `$CI_PIPELINE_SOURCE` conditions |
| `runs-on: ubuntu-latest` | → `image: node:22` (overridden by `actions/setup-node` mapping in Tier 1) |
| `actions/checkout@v4` | → skipped (GitLab clones automatically) |
| `actions/setup-node@v4` with `cache: npm` | → `image: node:<v>` + native `cache:` keyword on `.npm/` |
| `actions/upload-artifact@v4` | → native `artifacts:` keyword with `expire_in` |
| `actions/download-artifact@v4` | → no-op (auto-passed between stages) |
| `needs: [build, test]` | → passthrough |
| `timeout-minutes: 15` | → `timeout: "15 minutes"` |
| `strategy.matrix: { node: [...] }` | → `parallel.matrix: [{ NODE: [...] }]` |
| `if: github.ref == 'refs/heads/main'` | → `rules: [{ if: $CI_COMMIT_REF_NAME == 'refs/heads/main' && $CI_PIPELINE_SOURCE == 'push' }]` |
| Stage inference | Kahn topo-sort: build (depth 0) → test (depth 1) → deploy (depth 2) |

## Further reading

- [Migration docs page](https://intentius.io/chant/lexicons/gitlab/migration/) — full surface, all 33 mapped actions, NeedsReview catalog, `--use-composites`, `--validate`, SARIF reporting
- [`chant migrate` CLI reference](https://intentius.io/chant/cli/migrate/) — flags + exit codes
- [Inspired-by section](https://intentius.io/chant/lexicons/gitlab/migration/#inspired-by-github-actions-to-gitlab-ci) — credits to upstream `gitlab-org/ci-cd/github-actions-to-gitlab-ci` (MIT)

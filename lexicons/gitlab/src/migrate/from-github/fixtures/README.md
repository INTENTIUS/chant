# Migration fixtures

End-to-end test inputs for the `chant migrate` GitHub Actions →
GitLab CI/CD transformer.

Each fixture is a directory under `syntax-mapping/` or
`marketplace-actions/` with three files:

- `input.yml` — the GitHub Actions workflow under translation
- `expected.gitlab-ci.yml` — the GitLab CI/CD YAML the transformer
  should produce (canonicalised compare; parse → stringify on both sides)
- `expected-report.json` — the *shape* of the diagnostic + provenance
  report (totals, rule IDs, NeedsReview line/rule pairs). Asserts
  structure rather than raw SARIF text so cosmetic provenance message
  changes don't cause churn.

The driver test (`fixtures.test.ts`) globs the tree and runs every
fixture through `transform()`. To add a new fixture, drop a directory
with the three files; no manifest edits required.

## Attribution

The before/after content is derived from the upstream GitLab skill
`gitlab-org/ci-cd/github-actions-to-gitlab-ci` (MIT-licensed) —
specifically its `references/syntax-mapping.md` and
`references/marketplace-actions.md` files. See
`../../../ATTRIBUTIONS.md` for full credit.

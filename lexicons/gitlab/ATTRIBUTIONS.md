# Third-party attributions for @intentius/chant-lexicon-gitlab

## github-actions-to-gitlab-ci

The GitHub Actions → GitLab CI migration tool (`src/migrate/from-github/`)
is inspired by and partially derived from the upstream Agent Skill
`gitlab-org/ci-cd/github-actions-to-gitlab-ci`:

- Source: https://gitlab.com/gitlab-org/ci-cd/github-actions-to-gitlab-ci
- License: MIT

Specifically, the following materials are direct ports of MIT-licensed
content from that repository:

- The four-category provenance model (Translated / Approximated /
  NeedsReview / Lost) — implemented as `ProvenanceCategory` in
  `src/migrate/from-github/provenance.ts`. Used verbatim.
- The marketplace-action mapping table — encoded as `ActionMapping[]`
  in `src/migrate/from-github/actions/{tier-1,tier-2,tier-3}.ts`.
  Each chant mapping is a direct port of the upstream `references/
  marketplace-actions.md` before/after examples.
- The syntax-mapping reference — the `github.*` / `runner.*` →
  `$CI_*` substitution table in `src/migrate/from-github/
  expressions.ts` mirrors the upstream `references/syntax-mapping.md`
  "github.* context expressions" tables.
- The validator-as-final-stage pattern (`glci` / `glab ci lint`) —
  patterned after the upstream `scripts/validate.sh`.
- The migration test fixtures under `src/migrate/from-github/fixtures/`
  are derived from the upstream before/after blocks in
  `references/syntax-mapping.md` and `references/marketplace-actions.md`.

The chant version is the same translation rules wearing a compiler
instead of an LLM prompt: same mappings, but encoded as typed,
testable TypeScript modules with deterministic output.

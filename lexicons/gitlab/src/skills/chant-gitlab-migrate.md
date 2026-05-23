---
skill: chant-gitlab-migrate
description: Translate GitHub Actions workflows into GitLab CI/CD pipelines via chant migrate
user-invocable: true
---

# Chant GitHub Actions → GitLab CI/CD Migration

## When to invoke this skill

The user wants to translate a `.github/workflows/*.yml` workflow into a `.gitlab-ci.yml` pipeline. Trigger phrases include:

- "migrate this GitHub workflow to GitLab"
- "convert .github/workflows/ci.yml to GitLab CI"
- pasting a GitHub workflow and asking "how would this look in GitLab"
- evaluating GitLab CI/CD from a GitHub Actions background
- "what's the GitLab equivalent of <action>"

This skill is the operational glue around `chant migrate`. The translation logic lives in `@intentius/chant-lexicon-gitlab`; this skill knows how to invoke it, surface the report, and suggest GitLab-only upgrade moments.

## Distinction from the upstream GitLab skill

The upstream `gitlab-org/ci-cd/github-actions-to-gitlab-ci` Agent Skill (MIT) translates workflows by direct LLM prompting — stateless, freehand each run. `chant migrate` ports the same translation rules into a typed compiler so the output is reproducible, testable, and re-runnable. The skills are complementary:

- Use the upstream skill for one-shot read-and-respond ("here's my YAML, paste the answer").
- Use `chant migrate` when the translation has to survive evolution of the source workflow.

## Step 1: Detect

Confirm the input is a GitHub Actions workflow. Heuristic: top-level `jobs:` plus either `on:` or per-job `runs-on:`. If you're given a path, read the file. If pasted inline, work from the paste.

## Step 2: Dry-run migrate

Run with no `--strict`, no `--validate` first so the user sees the full translation including any NeedsReview items:

```bash
npx chant migrate path/to/workflow.yml --output /tmp/proposed.gitlab-ci.yml --report /tmp/migration.sarif
```

Or for inline content, pipe via a temp file:

```bash
TMPF=$(mktemp --suffix=.yml) && cat > "$TMPF" <<'EOF'
<paste workflow here>
EOF
npx chant migrate "$TMPF" --output /tmp/proposed.gitlab-ci.yml --report /tmp/migration.sarif
```

The Markdown summary always prints to stderr. The SARIF v2.1.0 report goes to `--report`.

## Step 3: Review NeedsReview items

The transformer surfaces categorised provenance. The categories are:

| Category | Severity (default) | Meaning |
|---|---|---|
| literal | (none, no diagnostic) | Direct key rename (env → variables) |
| rewrite | (none, no diagnostic) | Expression substitution (github.ref → $CI_COMMIT_REF_NAME) |
| synthesis | (none, no diagnostic) | Emitted construct with no GH original (inferred stage) |
| action-map tier 3 | warning | Marketplace action mapping that requires manual review |
| skipped | info | Intentionally dropped (actions/checkout) |
| needs-review | warning | No clean translation — user must decide |

Common needs-review rules and the right response:

- **MIG-PERMISSIONS-001**: GitHub `permissions:` has no per-job equivalent. Configure CI/CD token access at project level (Settings > CI/CD > Token Access).
- **MIG-ON-SCHEDULE**: GitLab cron schedules live in the UI under CI/CD > Schedules, not in YAML. The workflow rule (`$CI_PIPELINE_SOURCE == "schedule"`) is emitted; the schedule itself needs UI setup.
- **MIG-ON-DISPATCH**: `workflow_dispatch` inputs require `spec:inputs` (GitLab 17+) with defaults on every input (auto-triggered pipelines can't prompt).
- **MIG-NEEDS-OUTPUTS-001**: GitHub job outputs require the `artifacts:reports:dotenv` pattern in GitLab. Manual rewire needed.
- **MIG-ACTION-UNKNOWN**: A marketplace action has no registered mapping. Either replace with an inline script, or add an `--action-mapping <file>` extension (future flag).

## Step 4: Validate (optional)

If the user has `glci` or `glab` installed locally, run validation:

```bash
npx chant migrate path/to/workflow.yml --output .gitlab-ci.yml --validate
```

The CLI picks `glci` (offline, no auth) first; `glab ci lint` second. If neither is on PATH, `--validate` warns and skips. Pair with `--strict` to make validation failures hard.

## Step 5: Decide the emit mode

Two modes serve different intents:

- `--emit yaml` (default): produces `.gitlab-ci.yml` directly. Right when the user wants the YAML and is done with chant going forward.
- `--emit ts`: produces chant TypeScript source the user owns. Right when the user wants to maintain the pipeline in chant — they can edit the typed source and rebuild via `chant build` to refresh the YAML.

When in doubt, do `--emit yaml` first to validate the translation, then offer `--emit ts` as the long-term ownership option.

## Step 6: Suggest the upgrade moments

After surfacing the literal translation, opportunistically suggest GitLab-native features that improve on the GitHub original. Only suggest when they actually apply:

- `--use-composites` recognises Node-shaped pipelines and emits `NodePipeline({...})` or `NodeCI({...})` instead of raw `Job` constructors. The output is 5-10x shorter and easier to maintain.
- DAG `needs:` removes stage barriers — jobs run as soon as deps complete (already handled by the transformer for explicit `needs:`).
- `rules:changes:` enables monorepo path-based job filtering — no GitHub equivalent.
- `resource_group:` serialises deploys to the same environment (covered when GH `concurrency.group:` is translated).
- `include:` shares config across projects and workflows.
- GitLab CI templates (`Auto-DevOps`, `Security/SAST`, `Terraform/Base`) — no GitHub Actions equivalent.

## Self-check rubric

Before reporting "done" to the user, verify:

- [ ] Was `actions/checkout` removed (GitLab clones automatically)?
- [ ] Was `runs-on:` translated to `image:` (Linux runners) or `tags:` (self-hosted)?
- [ ] Did every `uses:` step either map cleanly or get flagged with NeedsReview?
- [ ] Did `if:` conditions translate to `rules:if:` (NOT a string substitution; semantics differ)?
- [ ] Were `permissions:` items documented as manual project-level setup?
- [ ] Was the migration report (Markdown + SARIF) surfaced to the user?
- [ ] Were `NeedsReview` items called out explicitly?
- [ ] Did I suggest `--use-composites` if Node patterns were detected?

## Inspired by

`gitlab-org/ci-cd/github-actions-to-gitlab-ci` — MIT. The trigger-phrase patterns, the four-category report shape, and the "suggest GitLab improvements" step are direct ports. The difference: this skill *calls* a compiler instead of *being* one.

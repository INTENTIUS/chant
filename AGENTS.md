# For agents

Working in the INTENTIUS workspace, `../agents/shared.md` applies too. This file adds what is particular to chant.

## Setup and gate

- A fresh worktree needs `npm ci --ignore-scripts`, then `just _ensure-gen`. vitest fails fast with a message if the generated artifacts are missing.
- The local gate is `just check` (build, repo-wide typecheck, lint, unit tests, lexicon contract). A change merges on it. Run the core typecheck in the foreground with a 600s timeout; it is slow.
- `npx tsx scripts/typecheck.ts` checks against `scripts/typecheck-baseline.json`. The baseline may only shrink.
- Docs changes also run `just docs-check`.
- Some tests write to the real git directory when run from a worktree. Use temp repos in tests, and check the main checkout's `git status` before and after.

## Merging

main takes changes through the merge queue (`ci.green.mergeQueue` in `chant.workspace.json`). Queue with `gh pr merge <n> --auto --squash` and stop.

Stacked pull requests: queue the base first. GitHub retargets the child to main when the base's branch is deleted after merge.

## Conflicts

Parallel branches collide in barrels, the audit catalog, generated docs pages and rules-count lines. Keep both sides, then regenerate: `npm run generate:fold-coverage`, and the audit rules page through the docs member's generator in `chant.workspace.json`.

## Generated workflows

`chant.yml`, `chant-ci-green.yml` and `chant-merge-queue.yml` are written by `chant ci workflow` from `ci.green`. Edit `chant.workspace.json` and regenerate with the command in the files' first line. Never hand-edit them.

## Releases

`just release` cuts the newest green main commit. Agents do not run it.

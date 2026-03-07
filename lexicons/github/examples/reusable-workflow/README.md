# Reusable Workflow

A GitHub Actions example demonstrating the caller + called (reusable) workflow pattern. The reusable workflow accepts inputs for Node.js version and lint toggle, and the caller workflow invokes it with `workflow_call`.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the reusable-workflow workflow.
> ```

## What this produces

- **GitHub Actions** (`reusable-workflow.yml`): 2 workflows (reusable + caller) with CI jobs across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/pipeline.ts` | Workflow (reusable), Job (CI), Workflow (caller), Job (call) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)

**Local verification** (build, lint) requires only Node.js.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/reusable-workflow.yml
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) -- Minimal CI workflow
- [node-ci](../node-ci/) -- Node.js CI with matrix testing
- [matrix-test](../matrix-test/) -- Dynamic matrix from JSON

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

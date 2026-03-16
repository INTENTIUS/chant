# Dynamic Matrix Test

A GitHub Actions workflow demonstrating dynamic matrix generation from JSON output, with fail-fast enabled. A `prepare` job computes the matrix, and a `test` job fans out across OS and Node.js version combinations.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the matrix-test workflow.
> ```

## What this produces

- **GitHub Actions** (`matrix-test.yml`): 1 workflow with prepare and test jobs across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/pipeline.ts` | Workflow, Job (prepare matrix), Job (test with dynamic matrix) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)

**Local verification** (build, lint) requires only Node.js.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/matrix-test.yml
npx chant lint src
```

## Related examples

- [node-ci](../node-ci/) -- Static matrix across Node 18/20/22
- [getting-started](../getting-started/) -- Minimal CI workflow
- [reusable-workflow](../reusable-workflow/) -- Caller + called workflow pattern

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

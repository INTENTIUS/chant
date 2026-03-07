# Node.js CI

A GitHub Actions workflow for Node.js projects with npm caching, matrix testing across Node 18/20/22, and lint + test + build steps.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the node-ci workflow.
> ```

## What this produces

- **GitHub Actions** (`node-ci.yml`): 1 workflow with a matrix CI job across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/pipeline.ts` | Workflow, Job (matrix: Node 18/20/22) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)

**Local verification** (build, lint) requires only Node.js -- no GitHub repository needed.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/node-ci.yml
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) -- Minimal CI workflow
- [matrix-test](../matrix-test/) -- Dynamic matrix from JSON with fail-fast
- [docker-build](../docker-build/) -- Build and push Docker images

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

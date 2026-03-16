# Docker Build and Push

A GitHub Actions workflow that builds a multi-platform Docker image and pushes it to GitHub Container Registry (GHCR) on push to main or version tags.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the docker-build workflow.
> ```

## What this produces

- **GitHub Actions** (`docker-build.yml`): 1 workflow with a multi-platform Docker build job across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/pipeline.ts` | Workflow, Job (QEMU, Buildx, login, metadata, build+push) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] A `Dockerfile` in the repository root
- [ ] `packages: write` permission on the GitHub token

**Local verification** (build, lint) requires only Node.js -- no Docker or registry needed.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/docker-build.yml
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) -- Minimal CI workflow
- [deploy-pages](../deploy-pages/) -- Deploy to GitHub Pages
- [release-please](../release-please/) -- Automated releases with changelog

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

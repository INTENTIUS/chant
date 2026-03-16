# Release Please

A GitHub Actions workflow that automates versioning, changelog generation, and npm publishing using Google's release-please-action.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the release-please workflow.
> ```

## What this produces

- **GitHub Actions** (`release-please.yml`): 1 workflow with release and publish jobs across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/pipeline.ts` | Workflow, Job (release-please), Job (publish to npm) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] An `NPM_TOKEN` repository secret for publishing

**Local verification** (build, lint) requires only Node.js -- no npm account needed.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/release-please.yml
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) -- Minimal CI workflow
- [docker-build](../docker-build/) -- Build and push Docker images
- [deploy-pages](../deploy-pages/) -- Deploy to GitHub Pages

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

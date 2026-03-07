# Deploy to GitHub Pages

A GitHub Actions workflow that builds a static site and deploys it to GitHub Pages on push to main, using the official Pages actions with OIDC token authentication.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the deploy-pages workflow.
> ```

## What this produces

- **GitHub Actions** (`deploy-pages.yml`): 1 workflow with build and deploy jobs across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/pipeline.ts` | Workflow, Job (build), Job (deploy with environment) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] GitHub Pages enabled in repository settings (source: GitHub Actions)

**Local verification** (build, lint) requires only Node.js -- no GitHub Pages needed.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/deploy-pages.yml
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) -- Minimal CI workflow
- [docker-build](../docker-build/) -- Build and push Docker images
- [release-please](../release-please/) -- Automated releases with changelog

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

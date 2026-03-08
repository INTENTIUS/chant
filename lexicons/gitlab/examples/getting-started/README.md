# Getting Started

A basic GitLab CI pipeline with build and test stages, shared image/cache configuration, and JUnit test reporting.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon gitlab`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI pipeline lifecycle: build, lint, validate, deploy |

> **Using Claude Code?** Just ask:
>
> ```
> Build the getting-started pipeline.
> ```

## What this produces

- **GitLab CI** (`.gitlab-ci.yml`): 2-stage pipeline (build + test) with npm caching and JUnit artifact reporting

## Source files

| File | Description |
|------|-------------|
| `src/config.ts` | Shared image (`node:20-alpine`), cache configuration (`$CI_COMMIT_REF_SLUG` key, `node_modules/`) |
| `src/pipeline.ts` | Build and test Job definitions with JUnit artifacts and 1-week expiry |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)

**Local verification** (build, lint) requires only Node.js -- no GitLab repository needed.

## Local verification

```bash
npx chant build src --lexicon gitlab -o .gitlab-ci.yml
npx chant lint src
```

## Related examples

- [node-pipeline](../node-pipeline/) -- Node.js pipeline with NodePipeline composite
- [docker-build](../docker-build/) -- Docker build and push pipeline
- [multi-stage-deploy](../multi-stage-deploy/) -- Multi-environment deployment pipeline

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

# Docs Snippets

Code examples used in the GitHub lexicon documentation — composites, expressions, context variables, and lint rules.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the docs-snippets workflow.
> ```

## What this produces

- **GitHub Actions** (`ci.yml`): Workflows demonstrating composites, expressions, variables, and lint patterns across 5 source files

## Source files

| File | Resources |
|------|-----------|
| `src/quickstart.ts` | Workflow, Job (CI with Checkout, SetupNode, install/build/test steps) |
| `src/composites-usage.ts` | Job (Checkout, SetupNode, SetupGo, CacheAction, UploadArtifact, DownloadArtifact, NodePipeline, BunPipeline, PythonCI, DockerBuild, DeployEnvironment, GoCI) |
| `src/expressions-usage.ts` | Expression helpers (github context, secrets, steps, runner, always/failure, contains, startsWith, branch, tag) |
| `src/variables-usage.ts` | Job (GitHub and Runner context variable interpolation) |
| `src/lint-gha003.ts` | Job (hardcoded token anti-pattern vs secrets() best practice) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)

**Local verification** (build, lint) requires only Node.js -- no GitHub repository needed.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/ci.yml
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) -- Minimal CI workflow
- [node-ci](../node-ci/) -- Node.js matrix CI workflow
- [docker-build](../docker-build/) -- Build and push Docker images

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

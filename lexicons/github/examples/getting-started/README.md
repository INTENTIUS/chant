# Getting Started

A minimal GitHub Actions CI workflow with checkout, Node.js setup, install, build, and test steps.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon github`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-github` | `@intentius/chant-lexicon-github` | GitHub Actions workflow lifecycle: build, lint, validate |

> **Using Claude Code?** Just ask:
>
> ```
> Build the getting-started workflow.
> ```

## What this produces

- **GitHub Actions** (`ci.yml`): 1 workflow with a CI job triggered on push/PR to main

## Source files

| File | Resources |
|------|-----------|
| `src/ci.ts` | Workflow (push + PR triggers, read-only permissions), Job (Checkout, SetupNode, install, build, test) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)

**Local verification** (build, lint) requires only Node.js -- no GitHub repository needed.

## Local verification

```bash
npx chant build src --lexicon github -o .github/workflows/ci.yml
npx chant lint src
```

## Related examples

- [node-ci](../node-ci/) -- Node.js matrix CI workflow
- [docs-snippets](../docs-snippets/) -- Composites, expressions, and lint examples
- [docker-build](../docker-build/) -- Build and push Docker images

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

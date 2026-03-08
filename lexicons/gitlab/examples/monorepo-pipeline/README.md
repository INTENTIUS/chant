# Monorepo Pipeline -- GitLab CI with chant

A GitLab CI pipeline for a monorepo that triggers child pipelines per workspace using rules-based inclusion -- only changed packages are built.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon gitlab`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI pipeline lifecycle: build, lint, validate, deploy |

> **Using Claude Code?** Just ask:
>
> ```
> Build the monorepo-pipeline pipeline.
> ```

## What this generates

A `.gitlab-ci.yml` with:

- **validate** stage -- runs linting across all workspaces
- **triggers** stage -- triggers child pipelines for `packages/api`, `packages/web`, and `packages/shared` based on file changes
- Each child pipeline only runs when its own files (or shared dependencies) change

## Try it on GitLab

### 1. Build the pipeline

```bash
chant build src --lexicon gitlab -o .gitlab-ci.yml
```

### 2. Push to GitLab

```bash
git init -b main
git add -A
git commit -m "Initial pipeline"
git remote add origin git@gitlab.com:YOUR_GROUP/YOUR_PROJECT.git
git push -u origin main
```

Each workspace needs its own `.gitlab-ci.yml` defining its build/test jobs. The parent pipeline triggers them based on which files changed.

### 3. Iterate

Edit `src/pipeline.ts`, rebuild, and push:

```bash
chant build src --lexicon gitlab -o .gitlab-ci.yml
git add .gitlab-ci.yml && git commit -m "Update pipeline" && git push
```

## Project structure

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | Parent pipeline with trigger jobs and rules-based inclusion |

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill automates building, linting, validating, and deploying pipelines. Ask it to:

- "Build my pipeline and validate it"
- "Add a new workspace trigger for packages/auth"

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

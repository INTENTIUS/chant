# Multi-Stage Deploy -- GitLab CI with chant

A GitLab CI pipeline with **build**, **test**, and **deploy** stages -- staging deploys automatically on the default branch, production requires manual approval.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon gitlab`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI pipeline lifecycle: build, lint, validate, deploy |

> **Using Claude Code?** Just ask:
>
> ```
> Build the multi-stage-deploy pipeline.
> ```

## What this generates

A `.gitlab-ci.yml` with four jobs across three stages:

- **build** -- installs dependencies and builds the project
- **test** -- runs the test suite
- **deploy-staging** -- deploys to staging automatically on the default branch
- **deploy-production** -- deploys to production with manual approval on the default branch

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

The pipeline runs automatically on push. Staging deploys automatically; production requires clicking "Play" in the GitLab UI.

### 3. Iterate

Edit `src/pipeline.ts`, rebuild, and push:

```bash
chant build src --lexicon gitlab -o .gitlab-ci.yml
git add .gitlab-ci.yml && git commit -m "Update pipeline" && git push
```

## Project structure

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | Build, test, and deploy job definitions with environment and rules |

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill automates building, linting, validating, and deploying pipelines. Ask it to:

- "Build my pipeline and validate it"
- "Add a manual approval gate to my production deploy"

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

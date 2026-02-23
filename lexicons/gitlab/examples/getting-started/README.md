# Getting Started — GitLab CI with chant

A basic GitLab CI pipeline with **build** and **test** stages using shared configuration.

## What this generates

```yaml
stages:
  - build
  - test

build:
  stage: build
  image:
    name: node:20-alpine
  cache:
    key: '$CI_COMMIT_REF_SLUG'
    paths:
      - node_modules/
    policy: pull-push
  script:
    - npm install
    - npm run build

test:
  stage: test
  image:
    name: node:20-alpine
  cache:
    key: '$CI_COMMIT_REF_SLUG'
    paths:
      - node_modules/
    policy: pull-push
  script:
    - npm install
    - npm test
  artifacts:
    reports:
      junit: coverage/junit.xml
    paths:
      - coverage/
    expire_in: '1 week'
```

## Try it on GitLab

### 1. Create your project

```bash
chant init --lexicon gitlab my-project
cd my-project
```

### 2. Build the pipeline

```bash
chant build src/ --output .gitlab-ci.yml
```

### 3. Push to GitLab

```bash
cd my-project
git init -b main
git add -A
git commit -m "Initial pipeline"
git remote add origin git@gitlab.com:YOUR_GROUP/YOUR_PROJECT.git
git push -u origin main
```

The pipeline runs automatically on push.

### 4. Iterate

Edit files in `src/`, rebuild, and push:

```bash
chant build src/ --output .gitlab-ci.yml
git add .gitlab-ci.yml && git commit -m "Update pipeline" && git push
```

## Project structure

| File | Purpose |
|------|---------|
| `src/config.ts` | Shared image, cache, and artifact configuration |
| `src/pipeline.ts` | Build and test job definitions |
| `index.js` | Scaffold application entry point |
| `test.js` | Scaffold test that verifies the app works |

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill automates building, linting, validating, and deploying pipelines. Ask it to:

- "Build my pipeline and validate it"
- "Deploy my pipeline changes to GitLab"
- "Create a test job with caching"

The skill knows how to run `chant build`, `chant lint`, validate via the GitLab CI Lint API, and push changes through the MR workflow.

## Next steps

- Add a deploy stage with environment and rules
- Switch to a composite like `NodePipeline` for convention-over-configuration
- Run `chant lint src/` to catch issues before pushing

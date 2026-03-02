# Node Pipeline — GitLab CI with chant

A complete Node.js CI pipeline using the `NodePipeline` composite. One function call generates build and test jobs with caching, artifacts, and Node best practices.

## What this generates

```yaml
stages:
  - build
  - test

default:
  image:
    name: node:22-alpine
  cache:
    - key:
        files:
          - package-lock.json
      paths:
        - .npm/
      policy: pull-push

app-build:
  stage: build
  script:
    - npm install
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: '1 hour'
  variables:
    npm_config_cache: '$CI_PROJECT_DIR/.npm/'

app-test:
  stage: test
  script:
    - npm install
    - npm run test
  artifacts:
    reports:
      junit: junit.xml
    when: always
  variables:
    npm_config_cache: '$CI_PROJECT_DIR/.npm/'
```

## Try it on GitLab

### 1. Create your project

```bash
chant init --lexicon gitlab --template node-pipeline my-node-app
cd my-node-app
```

### 2. Build the pipeline

```bash
chant build src/ --output .gitlab-ci.yml
```

### 3. Push to GitLab

```bash
git init -b main
git add -A
git commit -m "Initial pipeline"
git remote add origin git@gitlab.com:YOUR_GROUP/YOUR_PROJECT.git
git push -u origin main
```

The pipeline runs automatically on push.

## Project structure

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | `NodePipeline` composite — generates build + test jobs |
| `index.js` | Scaffold application entry point |
| `test.js` | Scaffold test that verifies the app works |
| `package.json` | App dependencies and scripts (`build`, `test`) |

## Customizing

Edit `src/pipeline.ts` to change Node version, package manager, or scripts:

```typescript
export const app = NodePipeline({
  nodeVersion: "20",           // default: "22"
  packageManager: "pnpm",      // "npm" | "pnpm" | "bun"
  buildScript: "build:prod",   // default: "build"
  testScript: "test:ci",       // default: "test"
});
```

Or use the preset variants:

```typescript
import { BunPipeline, PnpmPipeline } from "@intentius/chant-lexicon-gitlab";

export const app = BunPipeline({ buildScript: "build" });
```

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill can scaffold, build, validate, and deploy this pipeline for you. Try:

- "Create a Node.js CI pipeline and deploy it to GitLab"
- "Build my pipeline and validate it"
- "Deploy my pipeline changes"

The skill handles `chant init --template node-pipeline`, `chant build`, lint validation, and the full push-to-GitLab workflow.

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

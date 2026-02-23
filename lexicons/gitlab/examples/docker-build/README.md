# Docker Build — GitLab CI with chant

A Docker build pipeline using the `DockerBuild` composite. Builds and pushes images to the GitLab Container Registry with automatic `:latest` tagging on the default branch.

## What this generates

```yaml
stages:
  - build
  - test

docker-build:
  stage: build
  image:
    name: docker:27-cli
  services:
    - name: docker:27-dind
      alias: docker
  variables:
    DOCKER_TLS_CERTDIR: /certs
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_REF_SLUG -f Dockerfile .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_REF_SLUG
    - >-
      if [ "$CI_COMMIT_BRANCH" = "$CI_DEFAULT_BRANCH" ]; then docker tag
      $CI_REGISTRY_IMAGE:$CI_COMMIT_REF_SLUG $CI_REGISTRY_IMAGE:latest &&
      docker push $CI_REGISTRY_IMAGE:latest; fi

test:
  stage: test
  image:
    name: node:22-alpine
  script:
    - node test.js
```

## Try it on GitLab

### 1. Create your project

```bash
chant init --lexicon gitlab --template docker-build my-docker-app
cd my-docker-app
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

The pipeline runs automatically. The Container Registry is enabled by default on GitLab.com projects.

## Project structure

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | `DockerBuild` composite + test job |
| `Dockerfile` | Scaffold container image |
| `index.js` | Scaffold application entry point |
| `test.js` | Scaffold test that verifies the app works |

## Customizing

Edit `src/pipeline.ts` to change the Docker configuration:

```typescript
export const docker = DockerBuild({
  dockerfile: "Dockerfile.prod",   // default: "Dockerfile"
  context: "./app",                // default: "."
  tagLatest: false,                // default: true
  dockerVersion: "26",             // default: "27"
  buildArgs: {
    NODE_ENV: "production",
  },
});
```

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill can scaffold, build, validate, and deploy this pipeline for you. Try:

- "Create a Docker build pipeline and deploy it to GitLab"
- "Build my pipeline and validate it"

The skill handles `chant init --template docker-build`, `chant build`, lint validation, and the full push-to-GitLab workflow.

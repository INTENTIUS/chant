---
skill: chant-gitlab-patterns
description: GitLab CI/CD pipeline stages, caching, artifacts, includes, and advanced patterns
user-invocable: true
---

# GitLab CI/CD Pipeline Patterns

## Pipeline Stage Design

### Standard Stage Ordering

```typescript
import { Job, Image, Cache, Artifacts } from "@intentius/chant-lexicon-gitlab";

// Stages execute in order. Jobs within a stage run in parallel.
// Default stages: .pre, build, test, deploy, .post

export const lint = new Job({
  stage: "build",
  image: new Image({ name: "node:22-alpine" }),
  script: ["npm ci", "npm run lint"],
});

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:22-alpine" }),
  script: ["npm ci", "npm test"],
});

export const deploy = new Job({
  stage: "deploy",
  script: ["./deploy.sh"],
  rules: [{ if: '$CI_COMMIT_BRANCH == "main"' }],
});
```

### Parallel Jobs with needs

Use `needs` to create a DAG and skip waiting for the full stage:

```typescript
export const unitTests = new Job({
  stage: "test",
  script: ["npm run test:unit"],
  needs: ["build"],
});

export const integrationTests = new Job({
  stage: "test",
  script: ["npm run test:integration"],
  needs: ["build"],
});

export const deploy = new Job({
  stage: "deploy",
  script: ["./deploy.sh"],
  needs: ["unitTests", "integrationTests"],
});
```

## Caching Strategies

### Language-Specific Cache Keys

```typescript
import { Cache } from "@intentius/chant-lexicon-gitlab";

// Node.js: cache node_modules by lockfile hash
export const nodeCache = new Cache({
  key: { files: ["package-lock.json"] },
  paths: ["node_modules/"],
  policy: "pull-push",
});

// Python: cache pip downloads
export const pipCache = new Cache({
  key: { files: ["requirements.txt"] },
  paths: [".pip-cache/"],
  policy: "pull-push",
});
```

### Cache Policies

| Policy | Behavior | Use for |
|--------|----------|---------|
| `pull-push` | Download and upload cache | Build jobs that install dependencies |
| `pull` | Download only, never upload | Test/deploy jobs (read from build cache) |
| `push` | Upload only, never download | Initial cache population |

```typescript
export const build = new Job({
  stage: "build",
  cache: new Cache({
    key: "$CI_COMMIT_REF_SLUG",
    paths: ["node_modules/", "dist/"],
    policy: "pull-push",  // build populates cache
  }),
  script: ["npm ci", "npm run build"],
});

export const test = new Job({
  stage: "test",
  cache: new Cache({
    key: "$CI_COMMIT_REF_SLUG",
    paths: ["node_modules/"],
    policy: "pull",  // test only reads cache
  }),
  script: ["npm test"],
});
```

## Artifacts

### Pass Build Output Between Jobs

```typescript
import { Artifacts } from "@intentius/chant-lexicon-gitlab";

export const buildArtifacts = new Artifacts({
  paths: ["dist/"],
  expire_in: "1 day",
});

export const testReports = new Artifacts({
  reports: { junit: "coverage/junit.xml", coverage_report: { coverage_format: "cobertura", path: "coverage/cobertura.xml" } },
  paths: ["coverage/"],
  expire_in: "1 week",
});

export const build = new Job({
  stage: "build",
  script: ["npm ci", "npm run build"],
  artifacts: buildArtifacts,
});

export const test = new Job({
  stage: "test",
  script: ["npm ci", "npm test -- --coverage"],
  artifacts: testReports,
  needs: ["build"],
});
```

### Artifact Types

| Type | Purpose | GitLab feature |
|------|---------|----------------|
| `junit` | Test results | MR test report widget |
| `coverage_report` | Code coverage | MR coverage visualization |
| `dotenv` | Export variables | Pass variables to downstream jobs |
| `terraform` | Terraform plans | MR Terraform widget |

## Include Patterns

### Reusable Pipeline Components

```typescript
import { Include } from "@intentius/chant-lexicon-gitlab";

// Include from same project
export const localInclude = new Include({
  local: ".gitlab/ci/deploy.yml",
});

// Include from another project
export const projectInclude = new Include({
  project: "devops/pipeline-templates",
  ref: "main",
  file: "/templates/docker-build.yml",
});

// Include from remote URL
export const remoteInclude = new Include({
  remote: "https://example.com/ci-templates/security-scan.yml",
});

// Include a GitLab CI template
export const templateInclude = new Include({
  template: "Security/SAST.gitlab-ci.yml",
});
```

### Composites for Common Pipelines

Use composites instead of raw includes for type-safe pipeline generation:

```typescript
import { NodePipeline } from "@intentius/chant-lexicon-gitlab";

export const app = NodePipeline({
  nodeVersion: "22",
  installCommand: "npm ci",
  buildScript: "build",
  testScript: "test",
});
```

## Rules and Conditional Execution

### Branch-Based Rules

```typescript
export const deployStaging = new Job({
  stage: "deploy",
  script: ["./deploy.sh staging"],
  rules: [
    { if: '$CI_COMMIT_BRANCH == "develop"', when: "on_success" },
  ],
});

export const deployProd = new Job({
  stage: "deploy",
  script: ["./deploy.sh production"],
  rules: [
    { if: '$CI_COMMIT_BRANCH == "main"', when: "manual" },
  ],
});
```

### MR vs Branch Pipelines

```typescript
// Run on merge requests only
export const mrTest = new Job({
  stage: "test",
  script: ["npm test"],
  rules: [{ if: "$CI_MERGE_REQUEST_IID" }],
});

// Run on default branch only
export const release = new Job({
  stage: "deploy",
  script: ["npm publish"],
  rules: [{ if: '$CI_COMMIT_BRANCH == "main"' }],
});
```

## Review Apps

### Deploy Per-MR Environments

```typescript
import { ReviewApp } from "@intentius/chant-lexicon-gitlab";

export const review = ReviewApp({
  name: "review",
  deployScript: "kubectl apply -f manifests.yaml",
  stopScript: "kubectl delete -f manifests.yaml",
  autoStopIn: "1 week",
});
```

This generates a deploy job with `environment` and a stop job with `action: stop` that triggers when the MR is merged or closed.

## Docker Build Pattern

### Multi-Stage Build and Push

```typescript
import { DockerBuild } from "@intentius/chant-lexicon-gitlab";

export const docker = DockerBuild({
  dockerfile: "Dockerfile",
  context: ".",
  tagLatest: true,
  registry: "$CI_REGISTRY",
  imageName: "$CI_REGISTRY_IMAGE",
});
```

This generates a job using Docker-in-Docker (`dind`) service with proper `DOCKER_TLS_CERTDIR` configuration.

## Matrix Builds

### Test Across Multiple Versions

```typescript
export const test = new Job({
  stage: "test",
  parallel: {
    matrix: [
      { NODE_VERSION: ["18", "20", "22"] },
    ],
  },
  image: new Image({ name: "node:${NODE_VERSION}-alpine" }),
  script: ["npm ci", "npm test"],
});
```

## Pipeline Security

### Protected Variables

Use protected variables for production secrets. They are only available on protected branches/tags:

```typescript
export const deploy = new Job({
  stage: "deploy",
  script: ["./deploy.sh"],
  variables: { DEPLOY_ENV: "production" },
  rules: [
    { if: '$CI_COMMIT_BRANCH == "main"', when: "manual" },
  ],
});
```

Set `DEPLOY_TOKEN` as a protected, masked variable in project settings.

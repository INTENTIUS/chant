# Review App — GitLab CI with chant

A review app pipeline using the `ReviewApp` composite. Deploys per-branch environments on merge requests with automatic cleanup.

## What this generates

```yaml
stages:
  - deploy
  - test

review-deploy:
  stage: deploy
  environment:
    name: review/$CI_COMMIT_REF_SLUG
    url: https://$CI_ENVIRONMENT_SLUG.example.com
    auto_stop_in: '1 week'
    on_stop: review-stop
  rules:
    - if: '$CI_MERGE_REQUEST_IID'
  script:
    - echo deploy

review-stop:
  stage: deploy
  environment:
    name: review/$CI_COMMIT_REF_SLUG
    action: stop
  rules:
    - if: '$CI_MERGE_REQUEST_IID'
      when: manual
  script:
    - echo "Stopping review app..."

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
chant init --lexicon gitlab --template review-app my-review-app
cd my-review-app
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

### 4. Open a merge request

The review app deploys when you open a merge request. Push to a branch and create an MR:

```bash
git checkout -b feature/my-change
# make changes...
git add -A && git commit -m "My change"
git push -u origin feature/my-change
# Create MR in GitLab UI or via API
```

The environment auto-stops after 1 week, or when you click the manual "stop" button.

## Project structure

| File | Purpose |
|------|---------|
| `src/pipeline.ts` | `ReviewApp` composite + test job |
| `index.js` | Scaffold application entry point |
| `test.js` | Scaffold test that verifies the app works |

## Customizing

Edit `src/pipeline.ts` to change the review app configuration:

```typescript
export const review = ReviewApp({
  name: "review",
  deployScript: ["./deploy.sh", "echo deployed"],  // your deploy commands
  stopScript: "./teardown.sh",                      // cleanup commands
  urlPattern: "https://$CI_COMMIT_REF_SLUG.staging.example.com",
  autoStopIn: "3 days",                             // default: "1 week"
  stage: "review",                                  // default: "deploy"
});
```

**Note:** The `review-deploy` job only runs on merge request pipelines (`$CI_MERGE_REQUEST_IID`). The test job runs on every push. On the default branch (main), only the test job executes.

## Using the chant-gitlab skill

If you use Claude Code, the `chant-gitlab` skill can scaffold, build, validate, and deploy this pipeline for you. Try:

- "Create a review app pipeline and deploy it to GitLab"
- "Build my pipeline and validate it"

The skill handles `chant init --template review-app`, `chant build`, lint validation, and the full push-to-GitLab workflow.

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`

---
skill: chant-gitlab
description: Build, validate, and deploy GitLab CI pipelines from a chant project
user-invocable: true
---

# Deploying GitLab CI Pipelines from Chant

This project defines GitLab CI jobs as TypeScript in `src/`. Use these steps to build, validate, and deploy.

## Build the pipeline

```bash
chant build src/ --output .gitlab-ci.yml
```

## Validate before pushing

```bash
chant lint src/
```

For API-level validation against your GitLab instance:
```bash
curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.com/api/v4/ci/lint" \
  --data "{\"content\": \"$(cat .gitlab-ci.yml)\"}"
```

## Deploy

Commit and push the generated `.gitlab-ci.yml` — GitLab runs the pipeline automatically:

```bash
chant build src/ --output .gitlab-ci.yml
git add .gitlab-ci.yml
git commit -m "Update pipeline"
git push
```

## Check pipeline status

- GitLab UI: project → CI/CD → Pipelines
- API: `curl --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines?per_page=5"`

## Retry a failed job

- GitLab UI: click Retry on the failed job
- API: `curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/jobs/$JOB_ID/retry"`

## Cancel a running pipeline

- API: `curl --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/$PROJECT_ID/pipelines/$PIPELINE_ID/cancel"`

## Troubleshooting

- Check job logs in GitLab UI: project → CI/CD → Jobs → click the job
- `chant lint src/` catches: missing scripts (WGL002), deprecated only/except (WGL001), missing stages (WGL003), artifacts without expiry (WGL004)
- Post-synth checks (WGL010, WGL011) run during build

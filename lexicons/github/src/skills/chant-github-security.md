---
skill: chant-github-security
description: GitHub Actions security best practices — secret scanning, OIDC, permissions hardening, supply chain security
user-invocable: true
---

# GitHub Actions Security Playbook

## Permissions Hardening

Always set the minimum required permissions at the workflow level:

```typescript
new Workflow({
  name: "CI",
  on: { push: { branches: ["main"] } },
  permissions: { contents: "read" },
});
```

For deployments that need write access, scope it to the job:

```typescript
new Job({
  "runs-on": "ubuntu-latest",
  permissions: { contents: "read", "id-token": "write" },
  steps: [...],
});
```

## Pin Actions by SHA

Never use mutable tags like `@v4`. Pin to a full commit SHA:

```typescript
new Step({
  uses: "actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11", // v4.1.1
})
```

## OIDC for Cloud Providers

Use OpenID Connect instead of long-lived secrets:

```typescript
// AWS
new Step({
  uses: "aws-actions/configure-aws-credentials@v4",
  with: {
    "role-to-assume": "arn:aws:iam::123456789012:role/deploy",
    "aws-region": "us-east-1",
  },
})
```

## Secret Scanning

- Never echo secrets in `run:` steps
- Use `environment` protection rules for production secrets
- Rotate secrets regularly and audit access logs

## Supply Chain Security

- Use `permissions: {}` (empty) as a baseline, then grant only what each job needs
- Avoid `pull_request_target` with `actions/checkout` (code injection risk)
- Use Dependabot or Renovate to keep action versions current
- Add `concurrency` blocks to prevent parallel deploys

## Concurrency Control

```typescript
new Concurrency({
  group: "${{ github.workflow }}-${{ github.ref }}",
  "cancel-in-progress": true,
})
```

## Job Timeouts

Always set timeouts to prevent runaway jobs:

```typescript
new Job({
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 30,
  steps: [...],
});
```

---
skill: chant-github-patterns
description: GitHub Actions workflow patterns — triggers, jobs, matrix, caching, artifacts, permissions, reusable workflows
user-invocable: true
---

# GitHub Actions Patterns

## Workflow Structure

A GitHub Actions workflow is a YAML file in `.github/workflows/`. Key sections:

- `name:` — display name for the workflow
- `on:` — trigger events (push, pull_request, schedule, etc.)
- `permissions:` — GITHUB_TOKEN permissions (least-privilege)
- `jobs:` — named jobs that run on runners

## Trigger Patterns

```typescript
// Push to main
new PushTrigger({ branches: ["main"] })

// Pull requests
new PullRequestTrigger({ branches: ["main"], types: ["opened", "synchronize"] })

// Schedule (cron)
new ScheduleTrigger({ cron: "0 0 * * *" })

// Manual dispatch with inputs
new WorkflowDispatchTrigger({ inputs: { environment: { type: "choice", options: ["staging", "production"] } } })
```

## Matrix Strategy

```typescript
new Strategy({
  matrix: {
    os: ["ubuntu-latest", "windows-latest"],
    "node-version": ["18", "20", "22"],
  },
  "fail-fast": false,
})
```

## Caching

Use the `cache` option on setup actions, or explicit Cache action:
```typescript
SetupNode({ nodeVersion: "22", cache: "npm" })
```

## Permissions (Least Privilege)

Always set explicit permissions:
```typescript
new Permissions({
  contents: "read",
  "pull-requests": "write",
})
```

## Reusable Workflows

Call reusable workflows with `ReusableWorkflowCallJob`:
```typescript
new ReusableWorkflowCallJob({
  uses: "./.github/workflows/deploy.yml",
  with: { environment: "production" },
  secrets: "inherit",
})
```

## Artifacts

```typescript
UploadArtifact({ name: "build", path: "dist/", retentionDays: 7 })
DownloadArtifact({ name: "build", path: "dist/" })
```

## Environment Protection

```typescript
new Environment({ name: "production", url: "https://example.com" })
```

## Concurrency

```typescript
new Concurrency({
  group: "${{ github.workflow }}-${{ github.ref }}",
  "cancel-in-progress": true,
})
```

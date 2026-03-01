# Docs Snippets

Code snippets used in the GitLab lexicon documentation — covers jobs, pipelines, variables, rules, stages, environments, and lint examples.

## What this contains

This example is a collection of standalone snippet files used in the documentation site. Each file demonstrates a specific GitLab CI/CD concept:

| File | Concept |
|------|---------|
| `src/quickstart.ts` | Getting started |
| `src/job-basic.ts` | Basic job definition |
| `src/job-test.ts` | Test job patterns |
| `src/stages.ts` | Pipeline stages |
| `src/variables-usage.ts` | Variable usage |
| `src/variables-patterns.ts` | Variable patterns |
| `src/rules-conditions.ts` | Rules and conditions |
| `src/environment.ts` | Environment configuration |
| `src/trigger.ts` | Pipeline triggers |
| `src/workflow.ts` | Workflow rules |
| `src/config.ts` | Pipeline configuration |
| `src/defaults.ts` | Default settings |
| `src/images.ts` | Docker image configuration |
| `src/reference-basic.ts` | YAML references |
| `src/reference-shared.ts` | Shared references |
| `src/reference-vs-import.ts` | References vs imports |
| `src/pipeline-shared-config.ts` | Shared pipeline config |
| `src/lint-wgl*.ts` | Lint rule examples |

## Local verification

```bash
npx chant build src --lexicon gitlab
npx chant lint src
```

## Related examples

- [getting-started](../getting-started/) — Minimal GitLab CI pipeline
- [node-pipeline](../node-pipeline/) — Node.js CI/CD pipeline

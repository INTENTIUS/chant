# @intentius/chant-lexicon-gitlab

> Part of the [chant](../../README.md) monorepo. Published as [`@intentius/chant-lexicon-gitlab`](https://www.npmjs.com/package/@intentius/chant-lexicon-gitlab) on npm.

GitLab CI lexicon for chant — declare CI/CD pipelines as flat, typed TypeScript that serializes to `.gitlab-ci.yml`.

## Overview

This package provides:

- **GitLab CI serializer** — converts chant declarables to GitLab CI YAML
- **Resource types** — typed constructors for `Job`, `Default`, `Workflow`, and all GitLab CI keywords
- **Property types** — `Artifacts`, `Cache`, `Image`, `Rule`, `Retry`, `Environment`, `Trigger`, and more
- **Lint rules** — GitLab-specific validation (e.g. missing script, deprecated only/except)
- **Code generation** — generates TypeScript types from the GitLab CI JSON schema
- **LSP/MCP support** — completions and hover for GitLab CI keywords

## Usage

```typescript
import { Job, Artifacts, Image } from "@intentius/chant-lexicon-gitlab";

export const testJob = new Job({
  stage: "test",
  image: new Image({ name: "node:20" }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    paths: ["coverage/"],
    expireIn: "1 week",
  }),
});
```

## Lint Rules

| Rule | Description |
|------|-------------|
| `missing-script` | Job must have a `script` keyword |
| `missing-stage` | Job should declare a `stage` |
| `deprecated-only-except` | Flags use of deprecated `only`/`except` keywords |
| `artifact-no-expiry` | Artifacts should have `expire_in` set |

## Code Generation

The GitLab lexicon generates types from the [GitLab CI JSON schema](https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json):

- `codegen/generate.ts` — calls core `generatePipeline<GitLabParseResult>` with GitLab callbacks
- `codegen/naming.ts` — extends core `NamingStrategy` for GitLab CI keywords
- `codegen/package.ts` — calls core `packagePipeline` with GitLab manifest
- `codegen/parse.ts` — parses the GitLab CI JSON schema into typed entities

## Related Packages

- `@intentius/chant` — core functionality, type system, and CLI
- `@intentius/chant-lexicon-aws` — AWS CloudFormation lexicon

## License

See the main project LICENSE file.

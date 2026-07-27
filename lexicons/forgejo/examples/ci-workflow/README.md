# Forgejo ci-workflow example

A build-test-publish Node.js pipeline using the Forgejo lexicon — a build job
(install, build, test) followed by a publish job that runs only after build
succeeds.

## What this produces

Running `npm run build` generates `.forgejo/workflows/ci.yml`, applying the
Forgejo dialect on the way out:

- `ubuntu-latest` is mapped to the default Forgejo runner label (`docker`)
- `actions/checkout@v4` and `actions/setup-node@v4` are resolved against the
  configured actions root (`https://code.forgejo.org` by default)

## Files

- `src/pipeline.ts` — `Workflow`, `Job`, and `Step` entities, reused directly
  from the github lexicon via `@intentius/chant-lexicon-forgejo`

## Usage

```bash
npm install
npm run build
# .forgejo/workflows/ci.yml is now ready to commit
```

## Prerequisites

- [chant CLI](https://intentius.io/chant) installed
- A Forgejo, Codeberg, or Gitea repository with Actions enabled

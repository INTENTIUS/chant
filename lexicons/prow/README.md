# @intentius/chant-lexicon-prow

This is the Prow lexicon for [chant](https://github.com/intentius/chant). It declares presubmits, postsubmits and periodics. `chant build` writes the job config Prow loads, and `chant import` reads an existing one.

The types are generated from sigs.k8s.io/prow at the commit `tools/go.mod` pins. Job fields come from Prow's Go types. The pod spec and the other shared types come from its ProwJob CRD. `npm run vendor` writes both into `src/spec/`.

```bash
npm run generate   # src/generated/ from src/spec/job-config.schema.json
npm run bundle     # dist/ manifest, types, rules and skills
npm run docs       # this lexicon's pages in the docs site
```

`src/serializer.ts` writes the job config, and its `emitJobConfig` takes plain job data. The import is in `src/import/`, and the PROW rules with their fixtures are in `src/lint/`. The Go programs in `tools/` run on the pinned Prow module: one loads a job config with Prow's strict loader, and one reads Prow's job types.

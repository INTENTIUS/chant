# Prow jobs for one repository

Two presubmits check each pull request, one of them only when docs change. A postsubmit publishes after merge, and a periodic runs the end-to-end tests at night. The presubmits run on the `untrusted` build cluster with no service account token. The publish and the nightly run on `trusted` under service accounts the cloud can trust.

```bash
npx chant build src --lexicon prow -o prow/jobs.yaml
npx chant lint src
```

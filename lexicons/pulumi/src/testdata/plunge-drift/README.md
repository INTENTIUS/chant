# plunge-drift

Recorded on 2026-10-26 for INTENTIUS/chant#4475 against the plunge corpus at INTENTIUS/plunge 30806be26b (`tests/plunge-corpus/aws-ts`, corpus prefix `rec-ts`), stack `floci`, on the floci emulator (ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec) only, with file backends and fake credentials. Tools: stock pulumi v3.272.0 (darwin-arm64 release), plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0) built from the same plunge commit, provider pulumi-aws 7.51.1. The program ran under plunge on its own stack (corpus prefix `rec-pl`, backend `plunge+file://`). The `docs-assets` bucket's `corpus-owner` tag was then set to `hotfix` through floci's API, keeping plunge's marker tags. Each file is `plunge drift --resource <urn> --stream --stack floci --member site`:

- `assets-drifted.ndjson`: `corpus:index:Site$aws:s3/bucket:Bucket::docs-assets`, drifted.
- `role-in-sync.ndjson`: `aws:iam/role:Role::app-role`, in-sync.
- `component-unsupported.ndjson`: the component `corpus:index:Site::docs`, not-observed, `unsupported-kind`.
- `settled-empty.ndjson` is not a recording: plunge exits 1 with `the stack holds no record for <urn>` for a URN its stack lacks and prints no stream. It is `role-in-sync.ndjson`'s start line and its settle line with empty counts, for the decoder's not-reached path.

The drift-start line carries no `at`; attribute paths are Pulumi's (`tags["corpus-owner"]`).

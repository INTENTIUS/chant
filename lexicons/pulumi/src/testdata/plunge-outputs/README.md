# plunge-outputs

Recorded on 2026-10-26 for INTENTIUS/chant#4475 against the plunge corpus at INTENTIUS/plunge 30806be26b (`tests/plunge-corpus/aws-ts`, corpus prefix `rec-ts`), stack `floci`, on the floci emulator (ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec) only, with file backends and fake credentials. Tools: stock pulumi v3.272.0 (darwin-arm64 release), plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0) built from the same plunge commit, provider pulumi-aws 7.51.1. The program ran under plunge on its own stack (corpus prefix `rec-pl`, backend `plunge+file://`).

- `stack-export.json`: `plunge stack export` after its first `plunge up`.
- `stack-output.json`: `plunge stack output --json --show-secrets=false`, which prints the secret as `"[secret]"` like pulumi.
- `Pulumi.yaml`: the corpus program's, with a `plunge+file://` backend URL added so chant picks plunge. The path in it is a placeholder.

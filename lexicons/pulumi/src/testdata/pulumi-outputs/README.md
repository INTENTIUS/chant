# pulumi-outputs

Recorded on 2026-10-26 for INTENTIUS/chant#4475 against the plunge corpus at INTENTIUS/plunge 30806be26b (`tests/plunge-corpus/aws-ts`, corpus prefix `rec-ts`), stack `floci`, on the floci emulator (ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec) only, with file backends and fake credentials. Tools: stock pulumi v3.272.0 (darwin-arm64 release), plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0) built from the same plunge commit, provider pulumi-aws 7.51.1.

- `stack-export.json`, `stack-output.json`: `pulumi stack export` and `pulumi stack output --json --show-secrets=false` of the settled stack. The secret output `dbPasswordValue` prints as the string `"[secret]"`; the export holds it as a ciphertext signature object.
- `preview-settled.json`: `pulumi preview --json --show-sames` of the settled stack, every step `same`.
- `preview-replaced.json`: the change preview of `pulumi-preview/preview.json` (the VPC replaced).

Neither preview carries planned outputs on the stack's step.

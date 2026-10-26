# pulumi-urn-node

Recorded on 2026-10-26 for INTENTIUS/chant#4475 against the plunge corpus at INTENTIUS/plunge 30806be26b (`tests/plunge-corpus/aws-ts`, corpus prefix `rec-ts`), stack `floci`, on the floci emulator (ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec) only, with file backends and fake credentials. Tools: stock pulumi v3.272.0 (darwin-arm64 release), plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0) built from the same plunge commit, provider pulumi-aws 7.51.1.

- `stack-export.json`: `pulumi stack export` of the settled stack (a `preview --show-sames` of it printed 17 `same` steps).
- `preview.json`: `pulumi preview --json --show-sames` after four changes: `corpus:workerCount` 3 to 2 (deletes `worker-2`), `corpus:eventsRetentionSeconds` 7200 (an update), a new `corpus:dbPassword` secret, and the program's VPC `cidrBlock` moved from `10.42.0.0/16` to `10.43.0.0/16` (a replace, the security group reading its id replaced too, and `vpc-id`, registered inside `vpc.id.apply`, printed as a delete). The CIDR edit is to a copy of the corpus program; the corpus itself is unchanged.
The two files are the same recording as `pulumi-preview`'s `stack-export.json` and `preview.json`.

What the recording showed that the earlier hand-written fixtures assumed otherwise: without `--show-sames` no unchanged resource is listed but the stack; a replace is one `replace` step; the stack's step has no `outputs`; a secret is `"[secret]"`; the default provider is never printed.

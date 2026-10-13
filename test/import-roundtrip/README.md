# Import round trip inputs

Real CloudFormation templates and Kubernetes manifests used to measure how many
byte-for-byte survive `chant import` followed by `chant build`. Each file is
vendored unmodified. `provenance.json` records, per file, the upstream URL at a
pinned commit, the repository and its license.

- `aws/`: templates from awslabs/aws-cloudformation-templates (Apache-2.0).
  The upstream NOTICE.txt applies.
- `k8s/`: example manifests from the Kubernetes documentation,
  kubernetes/website (CC BY 4.0, (c) The Kubernetes Authors).

Run the measurement with `npx tsx scripts/import-roundtrip-bytes.ts`. It writes
`results.json` and `results.md` here.

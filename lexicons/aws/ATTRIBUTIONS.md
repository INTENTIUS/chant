# Third-party attributions for @intentius/chant-lexicon-aws

## cfn-lint

The AWS lexicon's generated types and two of its audit checks are built on
data published by [cfn-lint](https://github.com/aws-cloudformation/cfn-lint)
(MIT-0). Nothing from cfn-lint's own rule engine is copied; what chant consumes
is the schema data cfn-lint maintains on top of the CloudFormation registry:

- The registry-schema patches under cfn-lint's `src/cfnlint/data/schemas/patches/`.
  `src/codegen/patches.ts` fetches them from the pinned cfn-lint release
  tarball and `applyPatches` lays them over the raw CloudFormation schemas
  before type generation, so the generated `lexicon-aws.json` carries the same
  corrections cfn-lint applies (create-only properties, deprecated
  properties, allowed values the Registry omits). The deprecation half of that
  data is what `WAW016` (deprecated property) reports.
- The extension schemas under `src/cfnlint/data/schemas/extensions/`.
  `src/codegen/extensions.ts` fetches them from the same tarball and
  `loadExtensionSchemas` turns their `requiredOr`, `requiredXor`,
  `dependentRequired` and `dependentExcluded` keywords into the cross-property
  constraints `EXT001` checks at build and audit time.

The pinned cfn-lint version is recorded in `src/codegen/versions.ts`, and the
lexicon's rolling-upgrade Op moves it.

## Prior art for the audit rules

Rules whose condition another open-source tool checked first credit that tool
per rule in `src/lint/audit-lineage.ts`: cfn-lint, cfn_nag, Checkov, KICS and
the AWS Guard Rules Registry. Those are credits for shared ideas, not derived
code; the registry of tools and the relation vocabulary live in
`packages/core/src/audit/prior-art.ts`, and the rendered credits are on the
[audit rules reference](https://intentius.io/chant/lint-rules/audit-rules/#prior-art).

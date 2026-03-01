# Docs Snippets

Code snippets used in the AWS lexicon documentation — covers resources, intrinsics, parameters, conditions, composites, tagging, policies, and lint examples.

## What this contains

This example is a collection of standalone snippet files used in the documentation site. Each file demonstrates a specific AWS CloudFormation concept:

| File | Concept |
|------|---------|
| `src/intrinsics.ts` | CloudFormation intrinsic functions |
| `src/intrinsics-detail.ts` | Detailed intrinsic usage |
| `src/conditions.ts` | Conditional resources |
| `src/mappings.ts` | Mappings |
| `src/pseudo-params.ts` | Pseudo parameters |
| `src/parameter-declaration.ts` | Parameter declarations |
| `src/parameter-ref.ts` | Parameter references |
| `src/parameter-cross-file-ref.ts` | Cross-file parameter references |
| `src/output-explicit.ts` | Stack outputs |
| `src/depends-on.ts` | DependsOn attributes |
| `src/resource-attributes.ts` | Resource attributes |
| `src/policy-role.ts` | IAM role policies |
| `src/policy-scoped.ts` | Scoped policies |
| `src/policy-trust.ts` | Trust policies |
| `src/tagging.ts` | Resource tagging |
| `src/propagate.ts` | Tag propagation |
| `src/builtin-composites.ts` | Built-in composites |
| `src/computed-defaults.ts` | Computed defaults |
| `src/with-defaults.ts` | Default values |
| `src/action-constants.ts` | Action constants |
| `src/config.ts` | Chant configuration |
| `src/lint-waw*.ts` | Lint rule examples |

## Local verification

```bash
npx chant build src --lexicon aws
npx chant lint src
```

## Related examples

- [core-concepts](../core-concepts/) — Core AWS CloudFormation concepts
- [lambda-function](../lambda-function/) — Simple Lambda function

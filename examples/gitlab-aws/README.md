# GitLab + AWS Cross-Lexicon Example

A chant project that uses **two lexicons** together: AWS CloudFormation for infrastructure and GitLab CI/CD for the deployment pipeline.

The GitLab deploy job references the AWS S3 bucket ARN directly — chant auto-detects the cross-lexicon reference, generates the necessary outputs, and orders deployments correctly.

## Structure

```
src/
  _.ts          # barrel — re-exports both AWS and GitLab lexicons
  config.ts     # shared defaults (encryption, cache, images)
  infra.ts      # AWS resources (S3 bucket, IAM role)
  pipeline.ts   # GitLab CI jobs (build, test, deploy)
```

## Run

```bash
npx chant build src/
npx chant lint src/
```

## Learn More

- [Cross-Lexicon Projects](https://intentius.io/chant/guide/cross-lexicon/) — how multi-lexicon projects work
- [AWS Lexicon](https://intentius.io/chant/lexicons/aws/) — CloudFormation resources
- [GitLab Lexicon](https://intentius.io/chant/lexicons/gitlab/) — CI/CD pipeline resources

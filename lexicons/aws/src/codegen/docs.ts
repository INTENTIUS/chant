/**
 * AWS CloudFormation documentation generator.
 *
 * Calls the core docsPipeline with AWS-specific config:
 * service grouping, resource type URLs, and overview content.
 *
 * Produces a standalone Starlight docs site at lexicons/aws/docs/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname_, "..", "..");

/**
 * Extract the AWS service name from a CloudFormation resource type.
 * e.g. "AWS::S3::Bucket" → "S3", "AWS::Lambda::Function" → "Lambda"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Other";
}

const overview = `The **AWS CloudFormation** lexicon provides full support for defining AWS infrastructure using chant's declarative TypeScript syntax. Resources are serialized to CloudFormation JSON templates.

This lexicon is generated from the official [CloudFormation Resource Provider Schemas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-resource-specification.html) and includes coverage for all publicly available resource types.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-aws
\`\`\``;

const outputFormat = `The AWS lexicon serializes resources into **CloudFormation JSON templates**.

## Building

Run \`chant build\` to produce a CloudFormation template from your declarations:

\`\`\`bash
chant build
# Writes dist/template.json
\`\`\`

The generated template includes:

- \`AWSTemplateFormatVersion\` header
- \`Parameters\` section (if any parameters are declared)
- \`Resources\` section with typed resource definitions
- \`Outputs\` section for exported values
- Full support for intrinsic functions (\`Fn::Sub\`, \`Ref\`, \`Fn::GetAtt\`, etc.)

## Deploying

The output is standard CloudFormation JSON. Deploy with any CF-compatible tool:

\`\`\`bash
# AWS CLI
aws cloudformation deploy \\
  --template-file dist/template.json \\
  --stack-name my-stack \\
  --capabilities CAPABILITY_IAM

# Rain (faster, with diff preview)
rain deploy dist/template.json my-stack

# SAM CLI (if using serverless transforms)
sam deploy --template-file dist/template.json --stack-name my-stack
\`\`\`

## Compatibility

The output is compatible with:
- AWS CloudFormation service (direct deployment)
- AWS SAM CLI
- AWS CDK (as an escape hatch via \`CfnInclude\`)
- Rain and other CloudFormation tooling
- Any tool that accepts CloudFormation JSON templates`;

/**
 * Generate AWS lexicon documentation as a standalone Starlight site.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const log = options?.verbose
    ? (msg: string) => console.error(msg)
    : (_msg: string) => {};

  const distDir = join(pkgDir, "dist");
  const srcDir = join(pkgDir, "src");
  const outDir = join(pkgDir, "docs");

  const config: DocsConfig = {
    name: "aws",
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/aws/",
    displayName: "AWS CloudFormation",
    description: "AWS CloudFormation lexicon for chant — resource types, intrinsics, and lint rules",
    distDir,
    outDir,
    srcDir,
    overview,
    outputFormat,
    serviceFromType,
    // "intrinsics" is no longer suppressed (chant #1067) — the reference
    // table at that slug is now generated from the plugin's own
    // `intrinsics()` registration (docsPipeline's generateIntrinsics, same
    // mechanism azure/helm already use), so its "Folds?" column can never
    // drift from the registration the way #1062's foldability matrix
    // depends on. The hand-written usage guide with full worked examples
    // moves to a separate "intrinsics-guide" page in docs/pages/ — content
    // unchanged, just no longer sharing a slug with generated data.
    // `rules` is NOT suppressed: the hand-written `lint-rules` page in docs/pages/
    // explains 26 of the lexicon's 50 rules in depth, and the whole WAW032+
    // hardening pass had no entry there at all (#1312). The generated table is
    // the complete, always-current list, so both ship — the overview/reference
    // pairing temporal uses. Duplicating 24 descriptions into the prose page
    // would just create a third copy to drift.
    suppressPages: ["pseudo-parameters"],
    examplesDir: join(pkgDir, "examples"),
  };

  log("Generating AWS documentation...");
  const result = docsPipeline(config);

  log(`Writing standalone docs site to ${outDir}`);
  writeDocsSite(config, result);

  console.error(
    `Docs generated: ${result.stats.resources} resources, ${result.stats.services} services, ${result.stats.rules} rules`,
  );
}

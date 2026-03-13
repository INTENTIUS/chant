/**
 * Azure ARM documentation generator.
 *
 * Calls the core docsPipeline with Azure-specific config:
 * service grouping, resource type URLs, and overview content.
 *
 * Produces a standalone Starlight docs site at lexicons/azure/docs/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname_, "..", "..");

/**
 * Extract the Azure service name from an ARM resource type.
 * e.g. "Microsoft.Storage/storageAccounts" → "Storage"
 */
function serviceFromType(resourceType: string): string {
  const match = resourceType.match(/^Microsoft\.([^/]+)/);
  return match ? match[1] : "Other";
}

const overview = `The **Azure Resource Manager** lexicon provides support for defining Azure infrastructure using chant's declarative TypeScript syntax. Resources are serialized to ARM template JSON.

This lexicon is generated from the official [Azure Resource Manager Schemas](https://github.com/Azure/azure-resource-manager-schemas) and includes coverage for commonly used resource types.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-azure
\`\`\``;

const outputFormat = `The Azure lexicon serializes resources into **ARM template JSON**.

## Building

Run \`chant build\` to produce an ARM template from your declarations:

\`\`\`bash
chant build
# Writes dist/template.json
\`\`\`

The generated template includes:

- \`$schema\` pointing to the ARM deployment template schema
- \`contentVersion: "1.0.0.0"\`
- \`parameters\` section for input parameters
- \`resources\` array with typed Azure resources
- \`outputs\` section for stack outputs

## Deploying

Use the Azure CLI to deploy the generated template:

\`\`\`bash
az deployment group create \\
  --resource-group my-rg \\
  --template-file dist/template.json
\`\`\``;

const docsConfig: DocsConfig = {
  name: "azure",
  displayName: "Azure Resource Manager",
  description: "Typed constructors for Azure Resource Manager templates",
  distDir: join(pkgDir, "dist"),
  outDir: join(pkgDir, "docs"),
  basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/azure/",
  overview,
  outputFormat,
  serviceFromType,
};

/**
 * Generate the Azure docs site.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const result = docsPipeline(docsConfig);
  writeDocsSite(docsConfig, result);
  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} doc pages`);
  }
}

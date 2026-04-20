import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";

/**
 * Generate documentation site for the Temporal lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config = {
    name: "temporal",
    displayName: "Temporal",
    description: "Temporal lexicon documentation",
    distDir: "./dist",
    outDir: "./docs",
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/temporal/",
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    resourceTypeUrl: (type: string) => `#${type}`,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error("Documentation generated");
  }
}

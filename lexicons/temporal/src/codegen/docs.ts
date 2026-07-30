import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

/**
 * Generate documentation site for the Temporal lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  // Annotated as DocsConfig so an unrecognized key is a type error rather
  // than a silent no-op — `resourceTypeUrl` sat here doing nothing because
  // an unannotated object literal skips the excess-property check.
  const config: DocsConfig = {
    name: "temporal",
    displayName: "Temporal",
    description: "Temporal lexicon documentation",
    distDir: "./dist",
    outDir: "./docs",
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/temporal/",
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error("Documentation generated");
  }
}

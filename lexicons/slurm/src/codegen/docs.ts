import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";

/**
 * Generate documentation site for the slurm lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config = {
    name: "slurm",
    displayName: "Slurm",
    description: "slurm lexicon documentation",
    distDir: "./dist",
    outDir: "./docs",
    // TODO: Implement service grouping for your provider
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    // TODO: Implement resource documentation URLs
    resourceTypeUrl: (type: string) => `#${type}`,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error("Documentation generated");
  }
}

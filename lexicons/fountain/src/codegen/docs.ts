import { docsPipeline, writeDocsSite } from "@intentius/chant/codegen/docs";

/**
 * Generate documentation site for the fountain lexicon.
 */
export async function generateDocs(options?: { verbose?: boolean }): Promise<void> {
  const config = {
    name: "fountain",
    displayName: "Fountain",
    description: "Fountain workload primitives (Environment, Vault, Agent) as typed estate.",
    distDir: "./dist",
    outDir: "./docs",
    serviceFromType: (type: string) => type.split("::")[1] ?? type,
    resourceTypeUrl: (_type: string) =>
      "https://github.com/BinaryBourbon/fountain/blob/main/docs/primitives.md",
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (options?.verbose) {
    console.error("Documentation generated");
  }
}

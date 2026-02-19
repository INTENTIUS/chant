import { importCommand } from "../../commands/import";

/**
 * Import tool definition for MCP
 */
export const importTool = {
  name: "import",
  description: "Import external templates and convert them to chant TypeScript",
  inputSchema: {
    type: "object" as const,
    properties: {
      source: {
        type: "string",
        description: "Path to the template file to import",
      },
      output: {
        type: "string",
        description: "Output directory (default: ./infra/)",
      },
    },
    required: ["source"],
  },
};

/**
 * Handle import tool invocation
 */
export async function handleImport(params: Record<string, unknown>): Promise<unknown> {
  const source = params.source as string;
  const output = params.output as string | undefined;

  const result = await importCommand({
    templatePath: source,
    output,
    force: true,
  });

  if (!result.success) {
    throw new Error(result.error ?? "Import failed");
  }

  return {
    success: true,
    lexicon: result.lexicon,
    generatedFiles: result.generatedFiles,
    warnings: result.warnings,
  };
}

import { lintCommand } from "../../commands/lint";

/**
 * Lint tool definition for MCP
 */
export const lintTool = {
  name: "lint",
  description: "Lint chant infrastructure code and report issues",
  inputSchema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Path to the infrastructure directory or file to lint",
      },
      fix: {
        type: "boolean",
        description: "Automatically fix issues where possible",
      },
    },
    required: ["path"],
  },
};

/**
 * Handle lint tool invocation
 */
export async function handleLint(params: Record<string, unknown>): Promise<unknown> {
  const path = params.path as string;
  const fix = (params.fix as boolean) ?? false;

  const result = await lintCommand({
    path,
    fix,
    format: "json",
  });

  return {
    success: result.success,
    errorCount: result.errorCount,
    warningCount: result.warningCount,
    diagnostics: result.diagnostics,
    output: result.output,
  };
}

/**
 * Live export for the Azure lexicon — implements LexiconPlugin.exportResources()
 * so `chant import --from <azure-env>` regenerates Azure resources as chant
 * TypeScript.
 *
 * The environment argument is the Azure resource group. Export reads the live
 * ARM template with `az group export` and maps it to the import IR. All I/O
 * lives here; selector/ownership filtering and IR-building are pure in
 * `./import/live-export`.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { parseExportedTemplate } from "./import/live-export";

const execAsync = promisify(exec);

export async function exportResources(options: {
  environment: string;
  selector?: ResourceSelector;
  owned?: boolean;
}): Promise<ExportedTemplate> {
  const cmd = [
    "az", "group", "export",
    "--resource-group", options.environment,
    "--output", "json",
  ].join(" ");

  let stdout: string;
  try {
    ({ stdout } = await execAsync(cmd));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? (err as Error).message;
    throw new Error(`Failed to export resource group "${options.environment}": ${stderr}`);
  }

  return parseExportedTemplate(stdout, options.selector, options.owned);
}

/**
 * Live export for the Azure lexicon — implements LexiconPlugin.exportResources()
 * so `chant import --from <azure-env>` regenerates Azure resources as chant
 * TypeScript.
 *
 * The environment argument is the Azure resource group. Two transports, same
 * IR:
 *
 * - With `AZURE_ENDPOINT_URL` set (the emulator lane, and the var azure's own
 *   observers already read on every live call), export rides the applier's ARM
 *   transport (#1212's swap, extended to the cloud→code direction for #1214):
 *   list the group's resources, GET each one whole, scrub the server-managed
 *   surface back to the declared shape, and hand the result to the same
 *   `ArmParser` the static-import path uses. Unsigned, exactly like `azApply`
 *   — which is why this path is gated on the ambient var rather than replacing
 *   the CLI: real ARM wants a bearer token.
 * - Without it, the signed path: `az group export` via the Azure CLI,
 *   unchanged.
 *
 * Selector/ownership filtering and IR-building are pure in
 * `./import/live-export`; all I/O lives here.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { parseExportedTemplate } from "./import/live-export";
import { getResourceById, listResources, type ArmResourceBody } from "./api/read-client";
import { AZURE_READ_ONLY_NAMES, AZURE_SERVER_COMPUTED_NAMES } from "./deep-observe";

const execAsync = promisify(exec);

/** Generic ARM api-version, same as the read client's — adequate for every top-level type chant declares. */
const EXPORT_API_VERSION = "2021-04-01";

/**
 * Envelope bookkeeping ARM stamps on every body — never part of the declared
 * shape at any depth. `id` is NOT here: a nested `routeTable.id` is a declared
 * cross-reference; only an array element's self-`id` is scrubbed (below), the
 * same two rules deep observation applies.
 */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["etag", "systemData"]);

/**
 * Scrub a live ARM body back to the declared shape (the contract's default
 * fidelity): server-populated names, server-computed surfaces, NSG default
 * rules and nested envelope bookkeeping all drop; everything a user would
 * have authored stays.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((el) => {
      if (el !== null && typeof el === "object" && !Array.isArray(el)) {
        const { id: _selfId, ...rest } = el as Record<string, unknown>;
        return scrub(rest);
      }
      return scrub(el);
    });
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AZURE_READ_ONLY_NAMES.has(k) || AZURE_SERVER_COMPUTED_NAMES.has(k)) continue;
      if (ENVELOPE_KEYS.has(k) || k === "defaultSecurityRules") continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/** One live body → one ARM-template resource, the shape `ArmParser` reads. */
function toTemplateResource(body: ArmResourceBody, verbatim: boolean): Record<string, unknown> {
  const { id: _id, type, name, ...rest } = body;
  const content = verbatim ? rest : (scrub(rest) as Record<string, unknown>);
  return { type, apiVersion: EXPORT_API_VERSION, name, ...content };
}

async function exportViaArm(
  endpoint: string,
  options: { environment: string; selector?: ResourceSelector; owned?: boolean; verbatim?: boolean },
): Promise<ExportedTemplate> {
  const client = { endpoint, resourceGroup: options.environment };
  const listed = await listResources(client);
  const resources: Record<string, unknown>[] = [];
  for (const entry of listed) {
    if (typeof entry.id !== "string") continue;
    const body = await getResourceById(client, entry.id);
    resources.push(toTemplateResource(body, options.verbatim === true));
  }
  const template = {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    resources,
  };
  return parseExportedTemplate(JSON.stringify(template), options.selector, options.owned);
}

export async function exportResources(options: {
  environment: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}): Promise<ExportedTemplate> {
  const endpoint = process.env.AZURE_ENDPOINT_URL;
  if (endpoint) return exportViaArm(endpoint, options);

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

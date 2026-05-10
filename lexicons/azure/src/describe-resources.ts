/**
 * Live introspection of an Azure resource group via the az CLI.
 *
 * For each declared Azure entity, runs:
 *   az resource show --resource-group <env> --name <name> --resource-type <type> -o json
 *
 * and maps the response to a ResourceMetadata entry keyed by chant entity name
 * (using props.name from #39's entity-prop pass-through). The environment
 * argument is treated as the Azure resource group name.
 *
 * Resource-not-found is silent — `state diff --live` then reports as missing.
 * Nested resource types (e.g. `Microsoft.Storage/storageAccounts/blobServices`)
 * are warn-skipped since `az resource show` doesn't accept them directly; they
 * need a different query path.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

const execAsync = promisify(exec);

interface AzResourceShowResponse {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  properties?: {
    provisioningState?: string;
    [k: string]: unknown;
  };
  tags?: Record<string, string>;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Top-level ARM type — i.e. exactly one `/` separating provider from kind.
 * Nested types like `Microsoft.Storage/storageAccounts/blobServices` need a
 * different query path that this implementation doesn't yet support.
 */
function isTopLevelType(entityType: string): boolean {
  const slashCount = (entityType.match(/\//g) ?? []).length;
  return slashCount === 1;
}

export async function describeResources(options: {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ResourceMetadata>> {
  const result: Record<string, ResourceMetadata> = {};
  const skippedNested: string[] = [];

  for (const [entityName, { entityType, props }] of options.entities) {
    if (!entityType.startsWith("Microsoft.")) continue;

    if (!isTopLevelType(entityType)) {
      skippedNested.push(entityName);
      continue;
    }

    const name = props.name as string | undefined;
    if (!name) continue;

    const cmd = [
      "az", "resource", "show",
      "--resource-group", options.environment,
      "--name", name,
      "--resource-type", entityType,
      "-o", "json",
    ].join(" ");

    try {
      const { stdout } = await execAsync(cmd);
      const obj: AzResourceShowResponse = JSON.parse(stdout);
      result[entityName] = {
        type: entityType,
        physicalId: obj.id,
        status: obj.properties?.provisioningState ?? "PRESENT",
        attributes: pruneUndefined({
          location: obj.location,
          tags: obj.tags,
        }),
      };
    } catch {
      // az returned non-zero (not found, auth, etc.) — leave entity out
    }
  }

  if (skippedNested.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[azure] skipped ${skippedNested.length} nested-type entity(ies) — az resource show doesn't accept compound types: ${skippedNested.slice(0, 5).join(", ")}${skippedNested.length > 5 ? ", ..." : ""}`,
    );
  }

  return result;
}

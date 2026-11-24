/**
 * Fly naming strategy — maps Fly::Machines::{Kind} type names to
 * user-friendly TypeScript class names.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { flyShortName, flyServiceName, type FlyParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const flyNamingConfig: NamingConfig = {
  priorityNames: {
    "Fly::Machines::App": "App",
    "Fly::Machines::Machine": "Machine",
    "Fly::Machines::Volume": "Volume",
  },

  priorityAliases: {},

  priorityPropertyAliases: {},

  serviceAbbreviations: {
    Machines: "Machines",
  },

  shortName: flyShortName,
  serviceName: flyServiceName,
};

/**
 * Fly-specific naming strategy. Extends the core strategy with the fly config.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: FlyParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, flyNamingConfig);
  }
}

/** The committed surface snapshot beside this package's `src/`. */
export const SURFACE_SNAPSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "surface.snapshot.json");

/**
 * The property-type names the fly lexicon has published, by the upstream
 * schema each came from: schema -> class name. Read from the `source` the
 * committed surface snapshot records for each property type. Empty when there
 * is no snapshot or it cannot be parsed.
 */
export function publishedSchemaNames(snapshotPath: string = SURFACE_SNAPSHOT_PATH): Record<string, string> {
  try {
    if (!existsSync(snapshotPath)) return {};
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
      entries?: Record<string, { kind?: string; resourceType?: string; source?: string }>;
    };
    const names: Record<string, string> = {};
    for (const entry of Object.values(snapshot.entries ?? {})) {
      if (entry.kind !== "property" || !entry.source || !entry.resourceType) continue;
      names[entry.source] ??= flyShortName(entry.resourceType);
    }
    return names;
  } catch {
    return {};
  }
}

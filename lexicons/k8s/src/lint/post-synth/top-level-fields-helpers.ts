/**
 * Shared helper for WK8506: the top-level keys the lexicon says each kind
 * declares (#5111), keyed by `apiVersion/kind`, read from the packaged
 * `lexicon-k8s.json` the way ./crd-schema-helpers.ts reads the CRD spec
 * schemas. Excluded from check auto-discovery by the "helper" filename filter.
 */

import { createRequire } from "module";
import { moduleSourceUrl } from "@intentius/chant/module-source";
import type { K8sManifest } from "./k8s-helpers";

interface LexiconEntry {
  kind: "resource" | "property";
  apiVersion?: string;
  gvkKind?: string;
  topLevelFields?: string[];
}

let cachedRegistry: Map<string, string[]> | null = null;

/**
 * Declared top-level keys of every kind the lexicon ships, keyed by
 * `<apiVersion>/<kind>`. A kind with no schema is not in the map.
 */
export function getTopLevelFieldsRegistry(): Map<string, string[]> {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = new Map();
  try {
    // Built lazily: `createRequire` throws where import.meta.url is undefined
    // (bundled Workers), and there the registry is simply empty.
    const require = createRequire(moduleSourceUrl(import.meta.url));
    const lexicon = require("../../generated/lexicon-k8s.json") as Record<string, LexiconEntry>;
    for (const entry of Object.values(lexicon)) {
      if (entry.kind === "resource" && entry.apiVersion && entry.gvkKind && entry.topLevelFields) {
        const key = `${entry.apiVersion}/${entry.gvkKind}`;
        if (!cachedRegistry.has(key)) cachedRegistry.set(key, entry.topLevelFields);
      }
    }
  } catch {
    // Lexicon JSON not yet generated: empty registry, the check passes.
  }
  return cachedRegistry;
}

/** Test seam: replace the registry (pass `null` to reload from the lexicon JSON). */
export function setTopLevelFieldsRegistry(registry: Map<string, string[]> | null): void {
  cachedRegistry = registry;
}

/** The keys a manifest's kind declares, or undefined when the lexicon has no schema for it. */
export function declaredTopLevelFields(manifest: K8sManifest): string[] | undefined {
  if (typeof manifest.apiVersion !== "string" || typeof manifest.kind !== "string") return undefined;
  return getTopLevelFieldsRegistry().get(`${manifest.apiVersion}/${manifest.kind}`);
}

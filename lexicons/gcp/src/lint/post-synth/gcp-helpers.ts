/**
 * Shared helpers for GCP Config Connector post-synthesis lint rules.
 *
 * Provides YAML parsing for multi-document Config Connector manifests
 * and accessor utilities for common manifest fields.
 */

import { parseYAML } from "@intentius/chant/yaml";
export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

/**
 * A parsed Config Connector manifest (loosely typed).
 */
export interface GcpManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Split a multi-document YAML string on `---` boundaries and parse each
 * document into a GcpManifest.
 */
export function parseGcpManifests(yaml: string): GcpManifest[] {
  const documents = yaml.split(/^---\s*$/m);
  const manifests: GcpManifest[] = [];

  for (const doc of documents) {
    const trimmed = doc.trim();
    if (trimmed === "" || trimmed === "---") continue;
    try {
      const parsed = parseYAML(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        manifests.push(parsed as GcpManifest);
      }
    } catch {
      // Skip unparseable documents
    }
  }

  return manifests;
}

/**
 * Check if a manifest is a Config Connector resource
 * (apiVersion contains cnrm.cloud.google.com).
 */
export function isConfigConnectorResource(manifest: GcpManifest): boolean {
  return typeof manifest.apiVersion === "string" &&
    manifest.apiVersion.includes("cnrm.cloud.google.com");
}

/**
 * Safely extract the spec from a manifest.
 */
export function getSpec(manifest: GcpManifest): Record<string, unknown> | undefined {
  return manifest.spec ?? undefined;
}

/**
 * Safely extract annotations from a manifest's metadata.
 */
export function getAnnotations(manifest: GcpManifest): Record<string, string> | undefined {
  return manifest.metadata?.annotations ?? undefined;
}

/**
 * Get the resource name from metadata.
 */
export function getResourceName(manifest: GcpManifest): string {
  return manifest.metadata?.name ?? "unknown";
}

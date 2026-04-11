/**
 * CRD loader — loads Custom Resource Definitions from various sources.
 *
 * Supports loading from local files, remote URLs, and (placeholder)
 * live cluster introspection via kubectl.
 */

import { existsSync, readFileSync } from "fs";
import type { CRDSource, CRDSpec } from "./types";
import type { K8sParseResult } from "../spec/parse";
import { parseCRD } from "./parser";

/**
 * Load CRDs from a source and return parsed K8sParseResult entries.
 */
export async function loadCRDs(source: CRDSource): Promise<K8sParseResult[]> {
  const content = await fetchCRDContent(source);
  return parseCRD(content);
}

/**
 * Load CRDs from multiple sources and merge results.
 */
export async function loadMultipleCRDs(sources: CRDSource[]): Promise<K8sParseResult[]> {
  const results: K8sParseResult[] = [];
  for (const source of sources) {
    const parsed = await loadCRDs(source);
    results.push(...parsed);
  }
  return results;
}

/**
 * Fetch raw CRD YAML content from a source.
 */
async function fetchCRDContent(source: CRDSource): Promise<string> {
  switch (source.type) {
    case "file":
      return loadFromFile(source);
    case "url":
      return loadFromURL(source);
    case "cluster":
      return loadFromCluster(source);
    default:
      throw new Error(`Unsupported CRD source type: ${(source as CRDSource).type}`);
  }
}

/**
 * Load CRD YAML from a local file.
 */
async function loadFromFile(source: CRDSource): Promise<string> {
  if (!source.path) {
    throw new Error("CRD source type 'file' requires a 'path' property");
  }

  if (!existsSync(source.path)) {
    throw new Error(`CRD file not found: ${source.path}`);
  }

  return readFileSync(source.path, "utf8");
}

/**
 * Load CRD YAML from a remote URL.
 */
async function loadFromURL(source: CRDSource): Promise<string> {
  if (!source.url) {
    throw new Error("CRD source type 'url' requires a 'url' property");
  }

  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Failed to fetch CRD from ${source.url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Load CRDs from a live Kubernetes cluster via kubectl.
 *
 * This is a placeholder implementation. Full cluster introspection
 * requires kubectl access and proper authentication.
 */
async function loadFromCluster(source: CRDSource): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const args = ["get", "crds", "-o", "yaml"];
  if (source.context) args.push(`--context=${source.context}`);
  if (source.namespace) args.push(`--namespace=${source.namespace}`);

  const { stdout, stderr } = await execFileAsync("kubectl", args).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
    throw new Error(
      `kubectl failed: ${err.stderr?.trim() || err.message}. ` +
      "Ensure kubectl is installed and configured with access to the target cluster.",
    );
  });

  void stderr;
  return stdout;
}

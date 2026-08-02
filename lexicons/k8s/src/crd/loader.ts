/**
 * CRD loader — loads Custom Resource Definitions from various sources.
 *
 * Supports loading from local files, remote URLs, and (placeholder)
 * live cluster introspection via kubectl.
 */

import { existsSync, readFileSync } from "fs";
import { fetchWithRetry } from "@intentius/chant/codegen/fetch";
import type { CRDSource, CRDSpec } from "./types";
import type { K8sParseResult } from "../spec/parse";
import { parseCRD } from "./parser";

/**
 * Load CRDs from a source and return parsed K8sParseResult entries.
 */
export async function loadCRDs(source: CRDSource): Promise<K8sParseResult[]> {
  const content = await fetchCRDContent(source);
  const parsed = parseCRD(content);
  if (source.kinds && source.kinds.length > 0) {
    const allow = new Set(source.kinds);
    return parsed.filter((r) => allow.has(r.gvk.kind));
  }
  return parsed;
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
    case "helm":
      return loadFromHelmChart(source);
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

  // fetchWithRetry retries transient failures and throws on a permanent
  // status (or after exhausting retries); the returned response is `ok`.
  const response = await fetchWithRetry(source.url);
  return response.text();
}

/**
 * Load CRDs out of a Helm chart, by pulling and unpacking it.
 *
 * Helm's own convention is that CRDs live in a chart's `crds/` directory and
 * are applied before templates, so that is the default place to look. Every
 * YAML document found there is concatenated into one multi-doc string, which
 * the parser already handles, and the existing `kinds` allowlist then applies
 * unchanged — a chart carrying more CRDs than a consumer wants is the same
 * situation as Flux's install bundle.
 *
 * Needs the `helm` binary at generation time, the same shape of dependency
 * that type="cluster" has on `kubectl`.
 */
async function loadFromHelmChart(source: CRDSource): Promise<string> {
  if (!source.chart) {
    throw new Error("CRD source type 'helm' requires a 'chart' property");
  }
  if (!source.version) {
    throw new Error(
      `CRD source type 'helm' requires a 'version' property (chart: ${source.chart}). ` +
      "An unpinned chart makes generated output depend on when it was generated.",
    );
  }

  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { mkdtempSync, rmSync, readdirSync, readFileSync: read } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const execFileAsync = promisify(execFile);

  const workdir = mkdtempSync(join(tmpdir(), "chant-crd-helm-"));
  try {
    await execFileAsync("helm", [
      "pull", source.chart,
      "--version", source.version,
      "--untar",
      "--untardir", workdir,
    ]).catch((err: NodeJS.ErrnoException & { stderr?: string }) => {
      if (err.code === "ENOENT") {
        throw new Error(
          `helm not found on PATH, needed to read CRDs from ${source.chart}. ` +
          "Install helm, or vendor the CRDs and use a 'file' source.",
        );
      }
      throw new Error(
        `helm pull failed for ${source.chart} ${source.version}: ${err.stderr?.trim() || err.message}`,
      );
    });

    // --untar writes a single directory named after the chart, which need not
    // match the last segment of the reference, so read it rather than guess.
    const unpacked = readdirSync(workdir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (unpacked.length !== 1) {
      throw new Error(
        `expected one unpacked chart directory in ${workdir}, found ${unpacked.length}`,
      );
    }

    const subdir = source.chartSubdir ?? "crds";
    const crdDir = join(workdir, unpacked[0].name, subdir);

    let entries: string[];
    try {
      entries = readdirSync(crdDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
    } catch {
      throw new Error(
        `chart ${source.chart} ${source.version} has no '${subdir}' directory. ` +
        "Charts that template their CRDs instead of shipping them in crds/ need 'chartSubdir'.",
      );
    }
    if (entries.length === 0) {
      throw new Error(`chart ${source.chart} ${source.version} has no CRD YAML in '${subdir}'`);
    }

    return entries.map((f) => read(join(crdDir, f), "utf8")).join("\n---\n");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
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

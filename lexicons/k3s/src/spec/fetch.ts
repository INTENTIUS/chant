/**
 * k3s CLI flag-definition fetching — downloads the pinned Go sources that
 * define the server and agent flag surfaces, and caches them locally.
 *
 * k3s publishes no JSON Schema for config.yaml. The config file's keys ARE
 * the CLI flag names ("Every flag can be a config key", docs.k3s.io), and
 * the flags are defined as urfave/cli struct literals in pkg/cli/cmds/.
 * Those literals carry name, usage, default and hidden-ness, so the tagged
 * source tree is the machine-readable spec (#1599) — the same channel the
 * k3s binary itself is built from, pinned the same way k3d pins its
 * schema.json.
 */

import { join } from "path";
import { homedir } from "os";
import { fetchWithCache, clearCacheFile } from "@intentius/chant/codegen/fetch";

/**
 * Pinned upstream k3s release.
 *
 * Bump this constant (and re-generate) when adopting a newer k3s release.
 * The acceptance test's rancher/k3s image tag derives from it (`+` → `-`).
 */
export const K3S_VERSION = "v1.36.3+k3s1";

/** Docker image tag form of the pin: `+` is not legal in a tag. */
export const K3S_IMAGE_TAG = K3S_VERSION.replace("+", "-");

/**
 * The files that define flags reachable from the server and agent flag
 * lists. server.go owns ServerFlags; agent.go owns the agent command's
 * flags plus the shared node/token flag vars; config.go, root.go and
 * log.go define the shared vars both lists reference (ConfigFlag,
 * DebugFlag, VLevel, LogFile, ...).
 */
const SPEC_FILES = ["server.go", "agent.go", "config.go", "root.go", "log.go"] as const;

function rawUrl(file: string): string {
  // '+' must be percent-encoded in the raw.githubusercontent path.
  const tag = encodeURIComponent(K3S_VERSION);
  return `https://raw.githubusercontent.com/k3s-io/k3s/${tag}/pkg/cli/cmds/${file}`;
}

function cachePath(file: string): string {
  return join(homedir(), ".chant", `k3s-${K3S_VERSION}-${file}`);
}

/**
 * Fetch all pinned spec files, keyed by filename.
 */
export async function fetchSpecFiles(force?: boolean): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of SPEC_FILES) {
    const data = await fetchWithCache({ url: rawUrl(file), cacheFile: cachePath(file) }, force);
    files[file] = data.toString("utf-8");
  }
  return files;
}

/**
 * Fetch the spec as a Map<typeName, Buffer> compatible with the
 * generatePipeline fetchSchemas callback.
 *
 * Single entry keyed "K3s::Config" whose buffer is a JSON envelope of the
 * fetched files — the parse step needs them together to resolve flag-var
 * references across files.
 */
export async function fetchSchemas(force?: boolean): Promise<Map<string, Buffer>> {
  const files = await fetchSpecFiles(force);
  const schemas = new Map<string, Buffer>();
  schemas.set("K3s::Config", Buffer.from(JSON.stringify(files), "utf-8"));
  return schemas;
}

/**
 * Clear the cached spec files.
 */
export function clearCache(): void {
  for (const file of SPEC_FILES) clearCacheFile(cachePath(file));
}

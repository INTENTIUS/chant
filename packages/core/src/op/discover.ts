import { getRuntime } from "../runtime-adapter";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OpConfig } from "./types";

export interface DiscoveredOp {
  config: OpConfig;
  filePath: string;
}

export interface OpDiscoveryResult {
  ops: Map<string, DiscoveredOp>;
  errors: string[];
}

async function findGitRoot(cwd?: string): Promise<string> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (result.exitCode !== 0) throw new Error("Not in a git repository");
  return result.stdout.trim();
}

async function collectOpFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
      files.push(...await collectOpFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".op.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Discover all Op definitions from *.op.ts files under the git root.
 */
export async function discoverOps(opts?: { cwd?: string }): Promise<OpDiscoveryResult> {
  const errors: string[] = [];
  const ops = new Map<string, DiscoveredOp>();

  const gitRoot = await findGitRoot(opts?.cwd);
  const files = await collectOpFiles(gitRoot);

  const nameToFile = new Map<string, string>();

  for (const filePath of files) {
    try {
      const mod = await import(filePath);
      const entity = mod.default;

      if (!entity || typeof entity !== "object") {
        errors.push(`${filePath}: default export is not an object`);
        continue;
      }

      const config = entity.props as OpConfig | undefined;

      if (!config || typeof config.name !== "string" || !Array.isArray(config.phases)) {
        errors.push(`${filePath}: default export is not a valid Op (missing name or phases)`);
        continue;
      }

      if (nameToFile.has(config.name)) {
        errors.push(`Duplicate Op name "${config.name}" in ${filePath} and ${nameToFile.get(config.name)}`);
        continue;
      }

      nameToFile.set(config.name, filePath);
      ops.set(config.name, { config, filePath });
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ops, errors };
}

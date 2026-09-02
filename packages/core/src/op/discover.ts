import { getRuntime } from "../runtime-adapter";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/**
 * The root the `*.op.ts` scan starts from (#2058): the nearest chant project
 * root — the directory holding `chant.config.ts`/`chant.config.json`, walking
 * up from `cwd` and never past the git root. #1675's convention keeps Op
 * files OUTSIDE `sourceDir` (`ops/` beside `src/`), which is why discovery
 * walks up at all — but "up" used to mean the git root unconditionally, so a
 * chant project nested in a larger checkout (a monorepo, behold's committed
 * examples) discovered every SIBLING project's Ops as its own. The config
 * file is the project boundary, the same one entity discovery respects.
 * With no config anywhere up to the git root, the git root stands —
 * #1675's original scope, kept for configless layouts.
 */
async function findDiscoveryRoot(cwd?: string): Promise<string> {
  const gitRoot = resolve(await findGitRoot(cwd));
  let dir = resolve(cwd ?? process.cwd());
  for (;;) {
    if (existsSync(join(dir, "chant.config.ts")) || existsSync(join(dir, "chant.config.json"))) return dir;
    if (dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root — cwd was outside the git root
    dir = parent;
  }
  return gitRoot;
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
 * Discover all Op definitions from `*.op.ts` files under the nearest chant
 * project root (the directory holding `chant.config.ts`/`.json`, walking up
 * from `cwd`), or under the git root when no config exists — see
 * {@link findDiscoveryRoot} (#2058).
 */
export async function discoverOps(opts?: { cwd?: string }): Promise<OpDiscoveryResult> {
  const errors: string[] = [];
  const ops = new Map<string, DiscoveredOp>();

  const root = await findDiscoveryRoot(opts?.cwd);
  const files = await collectOpFiles(root);

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

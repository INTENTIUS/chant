import { getRuntime } from "../runtime-adapter";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { OpConfig } from "./types";

export interface DiscoveredOp {
  config: OpConfig;
  filePath: string;
  /**
   * The export this Op arrived on: `"default"`, or the named export's own
   * name (#2171). Diagnostic only, and the reason a file may carry more than
   * one Op without either becoming ambiguous.
   */
  exportName: string;
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

/** The `OpConfig` behind an exported value, or `undefined` when the value is not an Op. An Op entity carries its config on `.props` (`./resource.ts`); `name` and `phases` are what every consumer of a discovered Op reads. */
function opConfigOf(value: unknown): OpConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = (value as { props?: unknown }).props as OpConfig | undefined;
  if (!config || typeof config.name !== "string" || !Array.isArray(config.phases)) return undefined;
  return config;
}

/**
 * Every Op a module exports, default first (#2171).
 *
 * Discovery used to read `mod.default` and nothing else, which made
 * `export default op` the only shape a runnable Op could take. That is also
 * the one export shape the fold path refuses (`../discovery/fold-import.ts`
 * scans for it by name and falls the whole file back to run), so an Op living
 * under a project's `sourceDir` cost that project its fold coverage, and took
 * every file importing it down too. Accepting a named export removes the
 * conflict without moving the fold's rule: the default export still works, so
 * every Op file written against the documented shape keeps running unchanged.
 *
 * Non-Op exports are skipped in silence, not reported. An Op file is ordinary
 * TypeScript and may export a helper, a config literal or a type alongside its
 * Op; only a file exporting no Op at all is worth an error.
 *
 * A file may carry more than one Op, and each is registered on its own. Ops
 * are keyed by their declared `config.name`, never by the export name or the
 * file, so two Ops in one file are no more ambiguous to `chant run` than two
 * Ops in two files, and the duplicate-name check in {@link discoverOps}
 * covers both the same way. The same object exported twice (`export default
 * op` alongside `export { op }`) is one Op, deduplicated by identity, not a
 * self-collision.
 *
 * Export order is the module namespace's own: `default` first by construction
 * here, then the named exports, which the ECMAScript specification requires a
 * namespace object to enumerate in sorted order. So the discovered set is
 * deterministic across runs and platforms.
 */
function opsExportedBy(mod: Record<string, unknown>): Array<{ exportName: string; config: OpConfig }> {
  const found: Array<{ exportName: string; config: OpConfig }> = [];
  const seen = new Set<unknown>();

  const consider = (exportName: string, value: unknown): void => {
    if (seen.has(value)) return;
    const config = opConfigOf(value);
    if (!config) return;
    seen.add(value);
    found.push({ exportName, config });
  };

  consider("default", mod.default);
  for (const exportName of Object.keys(mod)) {
    if (exportName === "default") continue;
    consider(exportName, mod[exportName]);
  }
  return found;
}

/**
 * Discover all Op definitions from `*.op.ts` files under the nearest chant
 * project root (the directory holding `chant.config.ts`/`.json`, walking up
 * from `cwd`), or under the git root when no config exists — see
 * {@link findDiscoveryRoot} (#2058).
 *
 * An Op may be the file's default export or a named one, and a file may hold
 * several — see {@link opsExportedBy} (#2171).
 */
export async function discoverOps(opts?: { cwd?: string }): Promise<OpDiscoveryResult> {
  const errors: string[] = [];
  const ops = new Map<string, DiscoveredOp>();

  const root = await findDiscoveryRoot(opts?.cwd);
  const files = await collectOpFiles(root);

  const nameToFile = new Map<string, string>();

  for (const filePath of files) {
    try {
      const mod = (await import(filePath)) as Record<string, unknown>;
      const exported = opsExportedBy(mod);

      if (exported.length === 0) {
        errors.push(
          `${filePath}: exports no Op — expected \`export default Op({...})\` or a named export such as \`export const deploy = Op({...})\``,
        );
        continue;
      }

      for (const { exportName, config } of exported) {
        const priorFile = nameToFile.get(config.name);
        if (priorFile !== undefined) {
          errors.push(
            priorFile === filePath
              ? `Duplicate Op name "${config.name}" declared twice in ${filePath}`
              : `Duplicate Op name "${config.name}" in ${filePath} and ${priorFile}`,
          );
          continue;
        }

        nameToFile.set(config.name, filePath);
        ops.set(config.name, { config, filePath, exportName });
      }
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ops, errors };
}

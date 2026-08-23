import { basename, resolve } from "node:path";
import type { Declarable } from "./declarable";
import { discoverOps } from "./op/discover";
import { Op } from "./op/builders";
import { setProvenance } from "./provenance";

/**
 * #1675 — the graph IR is built from `discover(sourceDir)`, but the Op
 * convention keeps `*.op.ts` files OUTSIDE `sourceDir` (`ops/` or the project
 * root beside `sourceDir: "src"`), and `chant op` / `chant graph` find them via
 * {@link discoverOps}, which scans from the git root. Join the two scopes: every
 * Op `discoverOps` finds that discovery did not already load becomes a
 * `Temporal::Op` entity in the map, keyed the way discovery keys a default
 * export (the file's basename sans `.op.ts`), so the IR carries the declared
 * DAG whatever the layout. Ops discovery already loaded (same file) are left
 * alone. Returns the op-discovery errors for the caller to surface.
 */
export async function mergeProjectOps(
  entities: Map<string, Declarable>,
  sourceFiles: readonly string[],
  projectPath: string,
): Promise<{ added: string[]; errors: string[] }> {
  const added: string[] = [];
  let found: Awaited<ReturnType<typeof discoverOps>>;
  try {
    found = await discoverOps({ cwd: projectPath });
  } catch (err) {
    // Not a git checkout — nothing beyond sourceDir to join.
    return { added, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const loaded = new Set(sourceFiles.map((f) => resolve(f)));
  for (const { config, filePath } of found.ops.values()) {
    if (loaded.has(resolve(filePath))) continue;
    const key = basename(filePath).replace(/\.ts$/, "").replace(/\.op$/, "");
    if (entities.has(key)) continue;
    const entity = Op(config) as unknown as Declarable;
    setProvenance(entity, { sourceFile: resolve(filePath) });
    entities.set(key, entity);
    added.push(key);
  }
  return { added, errors: found.errors };
}

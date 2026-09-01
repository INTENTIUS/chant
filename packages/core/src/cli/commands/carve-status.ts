/**
 * `chant carve status` — the read over a tree of carve manifests (#2038).
 *
 * emit → bridge → apply each persist their step into `<target>.carve.json`
 * (./../../terraform/manifest.ts), but until now nothing read that state back
 * over more than one output dir at a time: a renderer wanting "what carves
 * exist under this project, and how far along is each" had to walk the tree
 * itself and guess at depth. This makes the walk a contract: recurse from
 * `--from` (default: cwd), read every manifest the way bridge/apply's own
 * `resolveCarveManifest` reads one, and answer with each manifest's target,
 * stage, and path. Read-only — it writes nothing and touches no live resource.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import {
  CARVE_MANIFEST_SUFFIX,
  readCarveManifest,
  type CarveManifest,
} from "../../terraform/manifest";

/**
 * How far along a carve is — the highest recorded step. `planned` is a
 * manifest holding only the boundary classification (written, but `carve
 * emit` recorded no emit section — e.g. a hand-seeded or partially-run
 * carve).
 */
export type CarveStage = "planned" | "emitted" | "bridged" | "applied";

export interface CarveStatusRow {
  /** Manifest path, relative to the walk root. */
  path: string;
  /** Terraform address of the carved resource. */
  target: string;
  /** Terraform resource type, when the manifest recorded one. */
  tfType?: string;
  /** The highest recorded step. */
  stage: CarveStage;
  /** ISO-8601 timestamp of each recorded step. */
  at: { emit?: string; bridge?: string; apply?: string };
  /** Emitted chant source file path(s), exactly as the manifest records them. */
  emittedFiles?: string[];
}

export interface CarveStatusOptions {
  /** Root of the walk (`--from`). Default: the current directory. */
  from?: string;
}

export interface CarveStatusResult {
  ok: boolean;
  error?: string;
  /** The resolved walk root. */
  from?: string;
  /** One row per readable manifest, sorted by path. */
  carves?: CarveStatusRow[];
  /** Manifest-suffixed files that did not read as a manifest (wrong version, malformed). */
  unreadable?: string[];
}

/**
 * Directories that never hold a carve output dir and make the walk expensive
 * or wrong: dependency trees, VCS internals, build output.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".chant"]);

/** Every `*.carve.json` under `root`, found by a bounded recursive walk. */
function findManifests(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip rather than fail the whole status
    }
    for (const entry of entries.sort()) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue; // dangling symlink
      }
      if (stat.isDirectory()) walk(path);
      else if (entry.endsWith(CARVE_MANIFEST_SUFFIX)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function stageOf(manifest: CarveManifest): CarveStage {
  if (manifest.apply) return "applied";
  if (manifest.bridge) return "bridged";
  if (manifest.emit) return "emitted";
  return "planned";
}

export function carveStatus(opts: CarveStatusOptions = {}): CarveStatusResult {
  const root = resolve(opts.from ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, error: `Not a directory: ${root}` };
  }

  const carves: CarveStatusRow[] = [];
  const unreadable: string[] = [];
  for (const path of findManifests(root)) {
    const rel = relative(root, path);
    const manifest = readCarveManifest(path);
    if (!manifest) {
      unreadable.push(rel);
      continue;
    }
    carves.push({
      path: rel,
      target: manifest.target,
      ...(manifest.tfType ? { tfType: manifest.tfType } : {}),
      stage: stageOf(manifest),
      at: {
        ...(manifest.emit?.at ? { emit: manifest.emit.at } : {}),
        ...(manifest.bridge?.at ? { bridge: manifest.bridge.at } : {}),
        ...(manifest.apply?.at ? { apply: manifest.apply.at } : {}),
      },
      ...(manifest.emit ? { emittedFiles: manifest.emit.files } : {}),
    });
  }

  return { ok: true, from: root, carves, ...(unreadable.length > 0 ? { unreadable } : {}) };
}

/** The JSON payload `--json` emits — everything but `ok`. */
export function carveStatusJson(result: CarveStatusResult): Record<string, unknown> {
  return {
    from: result.from,
    carves: result.carves ?? [],
    ...(result.unreadable ? { unreadable: result.unreadable } : {}),
  };
}

export function formatCarveStatus(result: CarveStatusResult): string {
  const carves = result.carves ?? [];
  if (carves.length === 0) {
    return `No carve manifests under ${result.from} — run \`chant carve emit\` first.`;
  }
  const L: string[] = [];
  L.push(`${carves.length} carve${carves.length === 1 ? "" : "s"} under ${result.from}`);
  L.push("");
  for (const row of carves) {
    const when = row.at.apply ?? row.at.bridge ?? row.at.emit;
    L.push(`  ${row.target}  [${row.stage}${when ? ` @ ${when}` : ""}]`);
    L.push(`    manifest: ${row.path}`);
    if (row.emittedFiles && row.emittedFiles.length > 0) {
      L.push(`    emitted:  ${row.emittedFiles.join(", ")}`);
    }
  }
  if (result.unreadable && result.unreadable.length > 0) {
    L.push("");
    L.push(`  Unreadable (malformed or unknown version): ${result.unreadable.join(", ")}`);
  }
  return L.join("\n");
}

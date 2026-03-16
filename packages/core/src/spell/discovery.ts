/**
 * Spell discovery: find, import, validate, and index spell files.
 */
import { getRuntime } from "../runtime-adapter";
import type { SpellDefinition, Status } from "./types";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface DiscoveredSpell {
  definition: SpellDefinition;
  filePath: string;
  status: Status;
}

export interface SpellDiscoveryResult {
  spells: Map<string, DiscoveredSpell>;
  errors: string[];
}

/**
 * Find the git root directory.
 */
async function findGitRoot(cwd?: string): Promise<string> {
  const rt = getRuntime();
  const result = await rt.spawn(["git", "rev-parse", "--show-toplevel"], { cwd });
  if (result.exitCode !== 0) {
    throw new Error("Not in a git repository");
  }
  return result.stdout.trim();
}

/**
 * Discover all spells from the spells/ directory at the git root.
 */
export async function discoverSpells(
  opts?: { cwd?: string },
): Promise<SpellDiscoveryResult> {
  const errors: string[] = [];
  const spells = new Map<string, DiscoveredSpell>();

  const gitRoot = await findGitRoot(opts?.cwd);
  const spellsDir = join(gitRoot, "spells");

  // List *.spell.ts files
  let files: string[];
  try {
    const entries = await readdir(spellsDir);
    files = entries.filter((f) => f.endsWith(".spell.ts")).map((f) => join(spellsDir, f));
  } catch {
    // spells/ directory doesn't exist — that's OK
    return { spells, errors };
  }

  // Import each file
  const fileMap = new Map<string, string>(); // name → filePath for duplicate detection
  for (const filePath of files) {
    try {
      const mod = await import(filePath);
      const def = mod.default as SpellDefinition | undefined;

      if (!def) {
        errors.push(`File ${filePath} has no default export`);
        continue;
      }

      // Validate shape
      if (!def.name || typeof def.name !== "string") {
        errors.push(`File ${filePath}: default export has no valid name`);
        continue;
      }
      if (!def.tasks || !Array.isArray(def.tasks)) {
        errors.push(`File ${filePath}: default export has no valid tasks`);
        continue;
      }

      // Duplicate check
      if (fileMap.has(def.name)) {
        errors.push(
          `Duplicate name "${def.name}" in ${filePath} and ${fileMap.get(def.name)}`,
        );
        continue;
      }

      fileMap.set(def.name, filePath);
      spells.set(def.name, {
        definition: def,
        filePath,
        status: "ready", // placeholder — computed after all are loaded
      });
    } catch (err) {
      errors.push(
        `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Validate dependencies
  for (const [name, spell] of spells) {
    const deps = spell.definition.depends;
    if (!deps) continue;

    for (const depName of deps) {
      if (!spells.has(depName)) {
        errors.push(
          `Spell "${name}" depends on "${depName}" which does not exist`,
        );
      }
    }
  }

  // Detect circular dependencies via topological sort
  const circularError = detectCycles(spells);
  if (circularError) {
    errors.push(circularError);
  }

  // Compute status for each spell
  computeStatuses(spells);

  return { spells, errors };
}

/**
 * Detect circular dependencies. Returns an error message or null.
 */
function detectCycles(spells: Map<string, DiscoveredSpell>): string | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string, path: string[]): string | null {
    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      return `Circular dependency: ${cycle.join(" → ")}`;
    }
    if (visited.has(name)) return null;

    visiting.add(name);
    path.push(name);

    const spell = spells.get(name);
    if (spell?.definition.depends) {
      for (const dep of spell.definition.depends) {
        if (spells.has(dep)) {
          const err = visit(dep, path);
          if (err) return err;
        }
      }
    }

    visiting.delete(name);
    visited.add(name);
    path.pop();
    return null;
  }

  for (const name of spells.keys()) {
    const err = visit(name, []);
    if (err) return err;
  }
  return null;
}

/**
 * Compute statuses: blocked / ready / done.
 */
function computeStatuses(spells: Map<string, DiscoveredSpell>): void {
  for (const [, spell] of spells) {
    const allTasksDone = spell.definition.tasks.every((t) => t.done);
    if (allTasksDone) {
      spell.status = "done";
      continue;
    }

    const deps = spell.definition.depends ?? [];
    const hasIncompleteDep = deps.some((depName) => {
      const dep = spells.get(depName);
      if (!dep) return true; // dangling dep counts as incomplete
      return !dep.definition.tasks.every((t) => t.done);
    });

    spell.status = hasIncompleteDep ? "blocked" : "ready";
  }
}

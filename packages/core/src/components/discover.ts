/**
 * Component discovery — Phase 2 (#560, epic #551).
 *
 * Mirrors chant's existing declarable discovery
 * (`../discovery/index.ts`'s `discover()`, built on `findInfraFiles`) as
 * closely as a structurally distinct type allows, and borrows its
 * file-suffix convention from Op discovery
 * (`../op/discover.ts`'s `discoverOps()`, `*.op.ts`): a component is any
 * `Component`-shaped value (see `./component.ts`'s `isComponent`) exported
 * (by any export name, not just `default`) from a `*.component.ts` file.
 *
 * Why a dedicated convention rather than folding into `discover()`:
 * `Declarable` (`../declarable.ts`) is a lexicon-resource marker —
 * `{ lexicon, entityType, kind, [DECLARABLE_MARKER]: true }` — and a
 * `Component` has none of that shape (no `lexicon`, and its `deploy`
 * composition is data the capability driver interprets, not a serializable
 * lexicon resource). Reusing `collectEntities`/`isDeclarable` would mean
 * either stretching the `Declarable` marker to cover an unrelated shape or
 * silently ignoring components during the existing walk. A parallel,
 * purpose-built collector keeps both conventions simple: `*.ts` + the
 * `Declarable` marker for resources, `*.component.ts` + the `Component`
 * shape for components — exactly how `*.op.ts` is already a parallel,
 * purpose-built convention for Ops.
 *
 * Filename convention (`*.component.ts`) is documented here rather than
 * inferred from export shape alone so a project can `grep` for its
 * components the same way it can for `*.op.ts` files, and so discovery does
 * not have to import (and risk side-effecting) every `.ts` file in the
 * project looking for stray `Component`-shaped objects.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { DiscoveryError } from "../errors";
import { isComponent, type Component } from "./component";

/** One discovered component, paired with the file it was exported from. */
export interface DiscoveredComponent {
  component: Component;
  /** The export name the component was found under (informational; components are keyed by their own `.name`, not this). */
  exportName: string;
  filePath: string;
}

export interface ComponentDiscoveryResult {
  /** Discovered components, keyed by `component.name` (the schema identity), not by export name or file. */
  components: Map<string, DiscoveredComponent>;
  /** Every `*.component.ts` file that was scanned. */
  sourceFiles: string[];
  errors: DiscoveryError[];
}

/**
 * Recursively find every `*.component.ts` file under `path`, the same
 * child-project boundary rule `findInfraFiles` (`../discovery/files.ts`)
 * uses: a subdirectory with its own `chant.config.ts` is a separate scope
 * once the outer project's own source root has been established.
 */
async function findComponentFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  let sourceRoot: string | null = null;

  async function scanDirectory(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip dependency and tool/VCS directories: component sources never live
        // in them, and descending in is both wasted work and a correctness bug —
        // e.g. a CI runner like gitlab-ci-local stages a copy of the project
        // under `.gitlab-ci-local/`, which discovery would otherwise pick up as
        // duplicate component names alongside the originals.
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

        const configPath = join(fullPath, "chant.config.ts");
        if (existsSync(configPath)) {
          if (sourceRoot === null) {
            sourceRoot = fullPath;
          } else {
            continue;
          }
        }
        await scanDirectory(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".component.ts") &&
        !entry.name.endsWith(".test.component.ts") &&
        !entry.name.endsWith(".spec.component.ts")
      ) {
        files.push(fullPath);
      }
    }
  }

  await scanDirectory(path);
  return files;
}

/**
 * Discover every `Component` declared under `path`: scan for `*.component.ts`
 * files, import each, and collect every export whose value satisfies
 * `isComponent` (any export name — not just `default` — so a file may
 * declare several related components, matching how a resource file can
 * export several `Declarable`s). Duplicate `component.name` across files (or
 * within one file) is a discovery error, matching `collectEntities`'s
 * duplicate-export handling and `discoverOps`'s duplicate-Op-name handling —
 * except the identity compared is the schema-level `name` field, since two
 * different export bindings could otherwise declare the same component name
 * and silently collide at deploy time.
 */
export async function discoverComponents(path: string): Promise<ComponentDiscoveryResult> {
  const errors: DiscoveryError[] = [];
  const sourceFiles = await findComponentFiles(path);
  const components = new Map<string, DiscoveredComponent>();
  const nameToFile = new Map<string, string>();

  for (const filePath of sourceFiles) {
    let exports: Record<string, unknown>;
    try {
      // Resolve to an absolute file:// URL before importing. A relative
      // `filePath` (e.g. from `chant build --components --generate`, which passes
      // a bare "." path) would otherwise be treated by `import()` as a bare
      // package specifier and fail with "Cannot find package 'x.component.ts'".
      exports = await import(pathToFileURL(resolve(filePath)).href);
    } catch (err) {
      errors.push(new DiscoveryError(filePath, err instanceof Error ? err.message : String(err), "import"));
      continue;
    }

    for (const [exportName, value] of Object.entries(exports)) {
      if (!isComponent(value)) continue;

      const existingFile = nameToFile.get(value.name);
      if (existingFile && existingFile !== filePath) {
        errors.push(
          new DiscoveryError(
            filePath,
            `Duplicate component name "${value.name}" in ${filePath} and ${existingFile}`,
            "resolution",
          ),
        );
        continue;
      }
      const existing = components.get(value.name);
      if (existing && existing.component !== value) {
        errors.push(
          new DiscoveryError(filePath, `Duplicate component name "${value.name}" in ${filePath}`, "resolution"),
        );
        continue;
      }

      nameToFile.set(value.name, filePath);
      components.set(value.name, { component: value, exportName, filePath });
    }
  }

  return { components, sourceFiles, errors };
}

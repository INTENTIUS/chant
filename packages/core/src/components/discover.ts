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
 *
 * chant #1051 — `discoverComponents` unconditionally `await import()`s every
 * discovered file in the CLI's own process, the same exposure #1045 Phase 2
 * closed for lexicon-resource discovery (`../discovery/index.ts`'s
 * `discover({ sandbox: true })`). `{ sandbox: true }` here runs that import
 * (and the duplicate-name collection below) together, isolated, in one
 * sandboxed child process instead — see `./sandbox/driver.ts`/`./sandbox/
 * run.ts`. Materially simpler than the entity path: a `Component` is plain
 * JSON (no `AttrRef` cross-references), so the child can hand back its result
 * with a bare `JSON.stringify` — no entity-wire codec needed (`projectToJson`,
 * `./component.ts`, already proves the plain-JSON round-trip).
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

/** Options for {@link discoverComponents}. */
export interface ComponentDiscoveryOptions {
  /**
   * chant #1051 — opt-in: import every discovered `*.component.ts` file
   * together, isolated, in one sandboxed child process (`./sandbox/run.ts`)
   * instead of in this (the CLI's own) process. Mirrors `discover({ sandbox:
   * true })` (`../discovery/index.ts`, chant #1045 Phase 2) for the parallel
   * `*.component.ts` convention. Default `false` — behavior, including
   * performance (no bundling, no child process, no IPC), is unchanged unless
   * requested.
   */
  sandbox?: boolean;
}

/** One already-imported `*.component.ts` module — the input to {@link collectComponents}. */
export interface ImportedComponentModule {
  file: string;
  exports: Record<string, unknown>;
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
 * Collect every `Component`-shaped export from already-imported `modules`,
 * enforcing the duplicate-`component.name` rule (across files, or within one
 * file): a discovery error, matching `collectEntities`'s duplicate-export
 * handling and `discoverOps`'s duplicate-Op-name handling — except the
 * identity compared is the schema-level `name` field, since two different
 * export bindings could otherwise declare the same component name and
 * silently collide at deploy time. `existing.component !== value` — object
 * identity, not deep equality — is what lets the SAME component re-exported
 * under several bindings pass through without tripping the duplicate check.
 *
 * Split out from {@link discoverComponents} (#1051) precisely because that
 * identity check has to run on the LIVE, still-in-memory export values —
 * identity does not survive a process boundary. That means this function
 * must run wherever `modules` were actually imported: in this process for
 * the default (unsandboxed) path below, or inside the sandboxed child for
 * `{ sandbox: true }` (`./sandbox/driver.ts`, which bundles and calls this
 * same function), mirroring how `collectEntities` runs inside `../discovery/
 * sandbox/driver.ts` for the lexicon-resource run-fallback set (chant #1045
 * Phase 2).
 */
export function collectComponents(modules: readonly ImportedComponentModule[]): {
  components: Map<string, DiscoveredComponent>;
  errors: DiscoveryError[];
} {
  const errors: DiscoveryError[] = [];
  const components = new Map<string, DiscoveredComponent>();
  const nameToFile = new Map<string, string>();

  for (const { file: filePath, exports } of modules) {
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

  return { components, errors };
}

/**
 * Import every already-discovered `*.component.ts` file in THIS process (the
 * unsandboxed default) and collect their `Component`-shaped exports.
 */
async function importAndCollectComponents(
  sourceFiles: readonly string[],
): Promise<{ components: Map<string, DiscoveredComponent>; errors: DiscoveryError[] }> {
  const modules: ImportedComponentModule[] = [];
  const importErrors: DiscoveryError[] = [];

  for (const filePath of sourceFiles) {
    try {
      // Resolve to an absolute file:// URL before importing. A relative
      // `filePath` (e.g. from `chant build --components --generate`, which passes
      // a bare "." path) would otherwise be treated by `import()` as a bare
      // package specifier and fail with "Cannot find package 'x.component.ts'".
      const exports = await import(pathToFileURL(resolve(filePath)).href);
      modules.push({ file: filePath, exports });
    } catch (err) {
      importErrors.push(new DiscoveryError(filePath, err instanceof Error ? err.message : String(err), "import"));
    }
  }

  const { components, errors: collectErrors } = collectComponents(modules);
  return { components, errors: [...importErrors, ...collectErrors] };
}

/**
 * Discover every `Component` declared under `path`: scan for `*.component.ts`
 * files, import each, and collect every export whose value satisfies
 * `isComponent` (any export name — not just `default` — so a file may
 * declare several related components, matching how a resource file can
 * export several `Declarable`s). See {@link collectComponents} for the
 * duplicate-name rule.
 *
 * `{ sandbox: true }` (#1051) imports every file together, isolated, in one
 * sandboxed child process instead (`./sandbox/run.ts`) — the same isolation
 * `discover({ sandbox: true })` (`../discovery/index.ts`) gives lexicon
 * resources, chant #1045 Phase 2.
 */
export async function discoverComponents(
  path: string,
  options?: ComponentDiscoveryOptions,
): Promise<ComponentDiscoveryResult> {
  const sourceFiles = await findComponentFiles(path);

  if (options?.sandbox && sourceFiles.length > 0) {
    // Dynamic, not static — for the same reason `../discovery/index.ts`
    // dynamically imports its own `./sandbox/run`: that module (transitively)
    // imports `esbuild`, a large package with its own module-scope filesystem
    // access, and this module is reachable from `@intentius/chant`'s package
    // root, which project source commonly imports. A static import here would
    // make `esbuild` bundled and eagerly evaluated by any build of a project
    // that itself imports chant. A dynamic import is only ever actually
    // reached here, at runtime, when a caller opts into `sandbox: true`.
    try {
      const { discoverComponentsSandboxed } = await import("./sandbox/run");
      const result = await discoverComponentsSandboxed(sourceFiles, path);
      return { components: result.components, sourceFiles, errors: result.errors };
    } catch (err) {
      return {
        components: new Map(),
        sourceFiles,
        errors: [new DiscoveryError(path, err instanceof Error ? err.message : String(err), "resolution")],
      };
    }
  }

  const { components, errors } = await importAndCollectComponents(sourceFiles);
  return { components, sourceFiles, errors };
}

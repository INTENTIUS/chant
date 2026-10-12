/**
 * Principal classes (#2524 D5; #3080, ws-079).
 *
 * A principal class names a set of principals so the declaration can scope
 * what they write. Four are core: `agent`, `runner` and `service`, each the
 * holders of the role of that name in the trust policy at base, and `human`,
 * everyone else. A plugin adds domain classes as data, the way it adds member
 * kinds: a JSON file at its `./workspace-principals` subpath, read through
 * the package's `package.json` and never imported. Each class it supplies
 * names the role whose grant puts a principal in it.
 *
 * A principal's classes are read only from role grants at base, through
 * {@link classesOf}. Core classes are tried first, then the domain classes
 * in pin order and file order; the first that holds is the class write scope
 * judges the principal as, and `human` is the rest. A gate or a record that
 * asks whether a principal is in a class (#3163) asks {@link classesOf},
 * which lists every class the principal's grants put it in.
 *
 * A path-pinned plugin's classes are read from the base revision when the
 * caller has it (write scope does), so a change can't remap a class by
 * editing its own copy of the plugin. A package pin is read from the
 * installed package, which must be at the version the base pins.
 */

import { createRequire } from "node:module";
import { checkClassData, diskFiles, mergePinClasses, readClassFiles, type ClassData, type PackageFiles, type PinClassRead } from "./class-data";
import { pinnedPackageDir, type KindLoadProblem, type PinLike } from "./kinds";
import schema from "./workspace-principals.schema.json" with { type: "json" };
import type { TrustPolicy } from "./trust/policy";
import { joinPath, type WorkspaceTree } from "./tree";
import { CORE_CLASSES, CORE_PRINCIPAL_CLASSES, grantedClasses, type PrincipalClass } from "./identity-gate-rule";

export const PRINCIPALS_SCHEMA_ID = schema.$id;

export { PRINCIPALS_SUBPATH } from "./class-data";

export { CORE_CLASSES, CORE_PRINCIPAL_CLASSES, type CorePrincipalClass, type PrincipalClass } from "./identity-gate-rule";

/** A class name: a core class, or a domain class a pinned package supplies. */
export type PrincipalClassName = string;

/** The grammar of a class name, as `workspace-principals.schema.json` and the declaration's writeScope keys say it. */
export const CLASS_NAME = /^(?!x-)[a-z][a-z0-9-]{0,39}$/;

export interface ClassRegistry {
  get(name: string): PrincipalClass | undefined;
  /** Every class name, core first, for "unknown class" messages. */
  names(): string[];
  /** Every class, core first, then the domain classes in pin order and file order. */
  all(): readonly PrincipalClass[];
}

export function createClassRegistry(extra: readonly PrincipalClass[] = []): ClassRegistry {
  const all = [...CORE_CLASSES, ...extra];
  const byName = new Map(all.map((c) => [c.name, c]));
  return {
    get: (name) => byName.get(name),
    names: () => all.map((c) => c.name),
    all: () => all,
  };
}

/** The four core classes and nothing else: what a workspace whose pins supply no class has. */
export function coreClassRegistry(): ClassRegistry {
  return createClassRegistry();
}

/**
 * The role grants a class is read from. Every read of roles for a class goes
 * through here, so where the grants live (`.chant/trust.json` today,
 * possibly the declaration, #2547) is decided in one place: the policy.
 */
export function roleGrants(policy: TrustPolicy): Record<string, string[]> {
  return policy.roles;
}

/**
 * Every class `principal`'s role grants at base put it in, in registry order
 * (core first). Empty for a principal in no class but `human`, and for null.
 * Names compare as `normalisePrincipal` (`./records.ts`) folds them.
 */
export function classesOf(classes: ClassRegistry, policy: TrustPolicy, principal: string | null): string[] {
  return grantedClasses(classes.all(), roleGrants(policy), principal);
}

/** The class write scope judges `principal` as: the first class its grants put it in, or `human`. */
export function principalClass(policy: TrustPolicy, principal: string | null, classes: ClassRegistry = coreClassRegistry()): string {
  return classesOf(classes, policy, principal)[0] ?? "human";
}

// ── Reading a plugin's classes ───────────────────────────────────────────────

interface AjvError {
  instancePath: string;
  message?: string;
}
type Validate = ((data: unknown) => boolean) & { errors?: AjvError[] | null };

let compiled: Validate | undefined;
function validator(): Validate {
  if (compiled) return compiled;
  const require = createRequire(import.meta.url);
  // ajv is CommonJS; its class is the default export, or that export's own default.
  const mod = require("ajv/dist/2020") as { default?: unknown };
  const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
  compiled = new Ajv({ allErrors: true, strict: true }).compile(schema);
  return compiled;
}

export type { ClassData, PackageFiles } from "./class-data";
export { diskFiles } from "./class-data";

/**
 * Check the text of a principals file against
 * `workspace-principals.schema.json` and the rules the schema can't say: no
 * core name or core role, and no name or role twice. `source` names the pin
 * in the classes and in the messages.
 */
export function parseClassData(text: string, source: string): ClassData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { classes: [], problems: [`${source}: the principals file is not JSON (${(err as Error).message})`] };
  }
  const validate = validator();
  if (!validate(raw)) {
    const problems = (validate.errors ?? []).map((e) => `${source}: ${e.instancePath || "the principals file"} ${e.message ?? "is invalid"}`);
    return { classes: [], problems: [...new Set(problems)] };
  }
  return checkClassData(raw as Parameters<typeof checkClassData>[0], source);
}

/** A package directory at `dir` in `tree`, such as the workspace at the base revision. */
export function treeFiles(tree: WorkspaceTree, dir: string): PackageFiles {
  return (path) => {
    const full = joinPath(dir, path);
    if (tree.stat(full) !== "file") return undefined;
    try {
      return tree.read(full);
    } catch {
      return undefined;
    }
  };
}

/** Read the classes a package publishes at `./workspace-principals`. Reads files only; imports nothing. A package that publishes none supplies none. */
export function readPackageClasses(files: PackageFiles, source: string): ClassData {
  return readClassFiles(files, source, parseClassData);
}

export interface LoadedClasses {
  registry: ClassRegistry;
  problems: KindLoadProblem[];
}

/**
 * The classes a workspace knows: the core four plus every class its pins
 * supply. A package pin is read from the installed package, looked up from
 * `workspaceRoot`, and must be at the pinned version. A path pin is read
 * through `tree` when given (the base revision, for write scope), else from
 * `workspaceRoot` on disk, checked against its integrity digest. A class
 * name, or a role, two pins both supply is a problem, and every class
 * involved is left out, so a writeScope entry for it reads as unknown and
 * fails closed. Never throws.
 */
export function loadClassRegistry(pins: readonly PinLike[], workspaceRoot: string, opts: { tree?: WorkspaceTree } = {}): LoadedClasses {
  const problems: KindLoadProblem[] = [];
  const reads: PinClassRead[] = [];
  pins.forEach((pin, i) => {
    let files: PackageFiles;
    let source: string;
    if (pin.path && opts.tree) {
      files = treeFiles(opts.tree, pin.path);
      source = pin.path;
    } else {
      const found = pinnedPackageDir(pin, workspaceRoot);
      if (found === null) return;
      if ("problem" in found) {
        problems.push({ pin: i, message: found.problem });
        return;
      }
      files = diskFiles(found.dir);
      source = found.source;
    }
    reads.push({ pin: i, source, read: readPackageClasses(files, source) });
  });
  const merged = mergePinClasses(reads);
  return { registry: createClassRegistry(merged.classes), problems: [...problems, ...merged.problems].sort((a, b) => a.pin - b.pin) };
}

/**
 * The writeScope keys no class in `classes` has, in file order. A writer
 * judged `human` may be in such a class, since nothing says which role puts
 * a principal in it, so write scope refuses that writer (fail closed).
 */
export function unknownScopeClasses(writeScope: Record<string, unknown> | null, classes: ClassRegistry): string[] {
  return Object.keys(writeScope ?? {}).filter((name) => classes.get(name) === undefined);
}

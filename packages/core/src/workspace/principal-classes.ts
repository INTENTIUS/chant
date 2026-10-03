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

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { kindsExportTarget, pinnedPackageDir, type KindLoadProblem, type PinLike } from "./kinds";
import { normalisePrincipal } from "./records";
import schema from "./workspace-principals.schema.json";
import type { TrustPolicy } from "./trust/policy";
import { joinPath, type WorkspaceTree } from "./tree";

export const PRINCIPALS_SCHEMA_ID = schema.$id;

/** The subpath a package publishes its principal classes at. */
export const PRINCIPALS_SUBPATH = "./workspace-principals";

/** The core classes, in the order a principal's roles are tried; `human` holds no role and is the rest. */
export const CORE_PRINCIPAL_CLASSES = ["human", "agent", "runner", "service"] as const;
export type CorePrincipalClass = (typeof CORE_PRINCIPAL_CLASSES)[number];

/** A class name: a core class, or a domain class a pinned package supplies. */
export type PrincipalClassName = string;

/** The grammar of a class name, as `workspace-principals.schema.json` and the declaration's writeScope keys say it. */
export const CLASS_NAME = /^(?!x-)[a-z][a-z0-9-]{0,39}$/;

export interface PrincipalClass {
  name: string;
  /** One line saying who is in the class. */
  description: string;
  /** The role whose grant at base puts a principal in the class, or null for `human`, the rest. */
  role: string | null;
  /** `core`, or the pin (package name or path) that supplies the class. */
  source: string;
}

export const CORE_CLASSES: readonly PrincipalClass[] = [
  { name: "human", description: "a principal holding none of the roles of another class", role: null, source: "core" },
  { name: "agent", description: "a principal holding the agent role, or a write naming an agent session", role: "agent", source: "core" },
  { name: "runner", description: "a principal holding the runner role, such as a CI job's signing identity", role: "runner", source: "core" },
  { name: "service", description: "a principal holding the service role", role: "service", source: "core" },
];

const CORE_ROLES = new Set(CORE_CLASSES.map((c) => c.role).filter((r): r is string => r !== null));

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
 * Names compare as {@link normalisePrincipal} folds them.
 */
export function classesOf(classes: ClassRegistry, policy: TrustPolicy, principal: string | null): string[] {
  if (principal === null) return [];
  const name = normalisePrincipal(principal);
  const grants = roleGrants(policy);
  return classes
    .all()
    .filter((c) => c.role !== null && (grants[c.role] ?? []).some((p) => normalisePrincipal(p) === name))
    .map((c) => c.name);
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

export interface ClassData {
  classes: PrincipalClass[];
  /** Why some of the data can't be used, one line each. Empty when all of it can. */
  problems: string[];
}

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
  const problems: string[] = [];
  const classes: PrincipalClass[] = [];
  const names = new Set<string>();
  const roles = new Set<string>();
  for (const c of (raw as { classes: { name: string; description: string; role: string }[] }).classes) {
    if ((CORE_PRINCIPAL_CLASSES as readonly string[]).includes(c.name)) {
      problems.push(`${source}: class ${c.name} is a core class and can't be supplied by a package`);
      continue;
    }
    if (CORE_ROLES.has(c.role)) {
      problems.push(`${source}: class ${c.name} names the role ${c.role}, which puts a principal in the core ${c.role} class`);
      continue;
    }
    if (names.has(c.name)) {
      problems.push(`${source}: class ${c.name} is listed twice`);
      continue;
    }
    if (roles.has(c.role)) {
      problems.push(`${source}: class ${c.name} names the role ${c.role}, which another class in the file names; a role puts a principal in one class`);
      continue;
    }
    names.add(c.name);
    roles.add(c.role);
    classes.push({ name: c.name, description: c.description, role: c.role, source });
  }
  return { classes, problems };
}

/** A package's files, by a `/`-separated path inside it, or undefined when one is not there. */
export type PackageFiles = (path: string) => string | undefined;

/** A package directory on disk. */
export function diskFiles(dir: string): PackageFiles {
  return (path) => {
    try {
      return readFileSync(join(dir, ...path.split("/")), "utf-8");
    } catch {
      return undefined;
    }
  };
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
  const manifest = files("package.json");
  if (manifest === undefined) return { classes: [], problems: [`${source}: no readable package.json`] };
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(manifest) as Record<string, unknown>;
  } catch {
    return { classes: [], problems: [`${source}: package.json is not JSON`] };
  }
  const target = kindsExportTarget(pkg, PRINCIPALS_SUBPATH);
  if (target === undefined) return { classes: [], problems: [] };
  if (typeof target !== "string") return { classes: [], problems: [`${source}: ${target.problem}`] };
  const inside = posix.normalize(target.slice(2));
  if (inside.startsWith("../") || inside === "..") return { classes: [], problems: [`${source}: exports["${PRINCIPALS_SUBPATH}"] points outside the package`] };
  const text = files(inside);
  if (text === undefined) return { classes: [], problems: [`${source}: exports["${PRINCIPALS_SUBPATH}"] names ${target}, which does not exist`] };
  return parseClassData(text, source);
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
  const extra: PrincipalClass[] = [];
  const byName = new Map<string, string>();
  const byRole = new Map<string, string>();
  const clashing = new Set<string>();
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
    const read = readPackageClasses(files, source);
    for (const p of read.problems) problems.push({ pin: i, message: p });
    for (const c of read.classes) {
      const named = byName.get(c.name);
      const roled = byRole.get(c.role!);
      if (named !== undefined || roled !== undefined) {
        clashing.add(c.name);
        if (named !== undefined) {
          problems.push({ pin: i, message: `class ${c.name} is supplied by both ${named} and ${source}; a class name has one source` });
        } else {
          const other = extra.find((e) => e.role === c.role)!;
          clashing.add(other.name);
          problems.push({ pin: i, message: `class ${c.name} (${source}) names the role ${c.role}, which class ${other.name} (${roled}) names; a role puts a principal in one class` });
        }
        continue;
      }
      byName.set(c.name, source);
      byRole.set(c.role!, source);
      extra.push(c);
    }
  });
  // A name or role two pins both supply is left out altogether: neither reading is safe.
  return { registry: createClassRegistry(extra.filter((c) => !clashing.has(c.name))), problems };
}

/**
 * The writeScope keys no class in `classes` has, in file order. A writer
 * judged `human` may be in such a class, since nothing says which role puts
 * a principal in it, so write scope refuses that writer (fail closed).
 */
export function unknownScopeClasses(writeScope: Record<string, unknown> | null, classes: ClassRegistry): string[] {
  return Object.keys(writeScope ?? {}).filter((name) => classes.get(name) === undefined);
}

/**
 * Reading the principal classes a pinned package supplies, without ajv or
 * any package code (#3888).
 *
 * `./principal-classes.ts` reads a package's `./workspace-principals` file
 * for chant, validating it with ajv against
 * `workspace-principals.schema.json`. `@intentius/chant/gate-decision` reads
 * the same files from a bare clone and must bundle without ajv, so the rules
 * both share live here: where a package's export points, where an installed
 * package is, what a file must hold beyond its schema, and how classes from
 * several pins merge. {@link classDataShapeProblems} is the schema written
 * out by hand for the bundle; `class-data.test.ts` holds it to ajv's answer.
 *
 * The module imports node:fs and node:path and nothing else.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { CORE_CLASSES, CORE_PRINCIPAL_CLASSES, type PrincipalClass } from "./identity-gate-rule";

/** The subpath a package publishes its principal classes at. */
export const PRINCIPALS_SUBPATH = "./workspace-principals";

export interface ClassData {
  classes: PrincipalClass[];
  /** Why some of the data can't be used, one line each. Empty when all of it can. */
  problems: string[];
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

/**
 * The directory of an installed package `name`, found the way Node finds a
 * bare import: `node_modules/<name>` in `fromDir` and each directory above it.
 * It looks for the directory, not for an entry point, so it works for a
 * package whose `exports` don't expose `package.json`.
 */
export function findInstalledPackage(name: string, fromDir: string): string | undefined {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, "package.json"))) return candidate;
    } catch {
      // Not here; keep walking.
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The file a package's `exports[subpath]` names: undefined when it names
 * none, a problem when it is not one `.json` file inside the package.
 */
export function dataExportTarget(pkg: Record<string, unknown>, subpath: string): string | undefined | { problem: string } {
  const exports = pkg.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return undefined;
  const entry = (exports as Record<string, unknown>)[subpath];
  if (entry === undefined) return undefined;
  let target: unknown = entry;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const conditions = target as Record<string, unknown>;
    target = conditions.default ?? conditions.import ?? conditions.require;
  }
  if (typeof target !== "string") {
    return { problem: `exports["${subpath}"] must name one file, as a string or a "default" condition` };
  }
  if (!target.startsWith("./") || !target.endsWith(".json")) {
    return { problem: `exports["${subpath}"] is ${target}; it must name a .json file inside the package, since chant reads plugin data as data and never runs a package's code` };
  }
  return target;
}

// ── The file ─────────────────────────────────────────────────────────────────

const NAME = /^(?!x-)[a-z][a-z0-9-]{0,39}$/u;
const ROLE = /^[a-z][a-z0-9-]*$/u;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const extra = (key: string, known: readonly string[]) => !known.includes(key) && !key.startsWith("x-");

/**
 * What `workspace-principals.schema.json` refuses in `raw`, one line each,
 * written out by hand so the gate-decision bundle needs no ajv. Empty when
 * the schema accepts it.
 */
export function classDataShapeProblems(raw: unknown, source: string): string[] {
  const p: string[] = [];
  const say = (where: string, what: string) => p.push(`${source}: ${where || "the principals file"} ${what}`);
  if (!isObject(raw)) {
    say("", "must be object");
    return p;
  }
  for (const key of Object.keys(raw)) if (extra(key, ["$schema", "$comment", "schema", "classes"])) say("", `must NOT have additional property ${key}`);
  for (const key of ["$schema", "$comment"]) if (key in raw && typeof raw[key] !== "string") say(`/${key}`, "must be string");
  if (!("schema" in raw)) say("", "must have required property 'schema'");
  else if (raw.schema !== 1) say("/schema", "must be equal to constant 1");
  if (!("classes" in raw)) say("", "must have required property 'classes'");
  else if (!Array.isArray(raw.classes)) say("/classes", "must be array");
  else {
    if (raw.classes.length < 1) say("/classes", "must NOT have fewer than 1 items");
    raw.classes.forEach((c: unknown, i: number) => {
      const at = `/classes/${i}`;
      if (!isObject(c)) return say(at, "must be object");
      for (const key of Object.keys(c)) if (extra(key, ["name", "description", "role"])) say(at, `must NOT have additional property ${key}`);
      for (const key of ["name", "description", "role"]) if (!(key in c)) say(at, `must have required property '${key}'`);
      if ("name" in c && (typeof c.name !== "string" || !NAME.test(c.name))) say(`${at}/name`, "must be a class name");
      if ("description" in c && (typeof c.description !== "string" || [...c.description].length < 1)) say(`${at}/description`, "must be a non-empty string");
      if ("role" in c && (typeof c.role !== "string" || !ROLE.test(c.role))) say(`${at}/role`, "must be a role name");
    });
  }
  return [...new Set(p)];
}

const CORE_ROLES = new Set(CORE_CLASSES.map((c) => c.role).filter((r): r is string => r !== null));

/**
 * The classes in a principals file the schema accepts, under the rules the
 * schema can't say: no core name or core role, and no name or role twice.
 * `source` names the pin in the classes and in the messages.
 */
export function checkClassData(valid: { classes: { name: string; description: string; role: string }[] }, source: string): ClassData {
  const problems: string[] = [];
  const classes: PrincipalClass[] = [];
  const names = new Set<string>();
  const roles = new Set<string>();
  for (const c of valid.classes) {
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

/** A principals file's text read with {@link classDataShapeProblems} for the schema: what chant's ajv-checked `parseClassData` reads, by the same rules. */
export function parseClassDataByHand(text: string, source: string): ClassData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { classes: [], problems: [`${source}: the principals file is not JSON (${(err as Error).message})`] };
  }
  const problems = classDataShapeProblems(raw, source);
  return problems.length > 0 ? { classes: [], problems } : checkClassData(raw as Parameters<typeof checkClassData>[0], source);
}

/** Read the classes a package publishes at `./workspace-principals` through `files`, checking the file with `parse`. Imports nothing. A package that publishes none supplies none. */
export function readClassFiles(files: PackageFiles, source: string, parse: (text: string, source: string) => ClassData): ClassData {
  const manifest = files("package.json");
  if (manifest === undefined) return { classes: [], problems: [`${source}: no readable package.json`] };
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(manifest) as Record<string, unknown>;
  } catch {
    return { classes: [], problems: [`${source}: package.json is not JSON`] };
  }
  const target = dataExportTarget(pkg, PRINCIPALS_SUBPATH);
  if (target === undefined) return { classes: [], problems: [] };
  if (typeof target !== "string") return { classes: [], problems: [`${source}: ${target.problem}`] };
  const inside = posix.normalize(target.slice(2));
  if (inside.startsWith("../") || inside === "..") return { classes: [], problems: [`${source}: exports["${PRINCIPALS_SUBPATH}"] points outside the package`] };
  const text = files(inside);
  if (text === undefined) return { classes: [], problems: [`${source}: exports["${PRINCIPALS_SUBPATH}"] names ${target}, which does not exist`] };
  return parse(text, source);
}

/** One pin's classes, as read. */
export interface PinClassRead {
  /** The pin's index in the declaration's `pins`. */
  pin: number;
  source: string;
  read: ClassData;
}

/**
 * The domain classes of every pin, in pin order and file order. A class
 * name, or a role, two pins both supply is a problem, and every class
 * involved is left out, so a rule naming it reads it as unknown and fails
 * closed.
 */
export function mergePinClasses(reads: readonly PinClassRead[]): { classes: PrincipalClass[]; problems: { pin: number; message: string }[] } {
  const problems: { pin: number; message: string }[] = [];
  const extra: PrincipalClass[] = [];
  const byName = new Map<string, string>();
  const byRole = new Map<string, string>();
  const clashing = new Set<string>();
  for (const { pin: i, source, read } of reads) {
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
  }
  // A name or role two pins both supply is left out altogether: neither reading is safe.
  return { classes: extra.filter((c) => !clashing.has(c.name)), problems };
}

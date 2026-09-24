/**
 * Member kinds (#2524 D3, #2535; ws-031 for the plugin shape, ws-051 for
 * `examples`).
 *
 * A kind is data: a name, a precedence and a probe that says what its
 * directory holds. Probes run no code (K3). Four kinds are built in: the
 * member kinds `chant`, `workspace` and `other`, and the group kind
 * `examples`. Every other kind comes from a pinned package, which publishes
 * its kinds as a JSON file at a `./workspace-kinds` subpath, the way a
 * lexicon publishes a slim `./detect` entry (#426). chant finds that file
 * through the package's `package.json` and reads it with the file system, so
 * reading kinds never imports the package and never loads a lexicon.
 *
 * The vocabulary is closed: a member whose kind no registry knows fails
 * closed, and the message lists the known kinds. When the probes of several
 * kinds claim one directory, the highest precedence decides, and a tie
 * fails ({@link resolveKind}).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import schema from "./workspace-kinds.schema.json";
import type { WorkspaceTree } from "./tree";
import { joinPath, skippedDir } from "./tree";

export const KINDS_SCHEMA_ID = schema.$id;

/** The subpath a package publishes its kinds at. */
export const KINDS_SUBPATH = "./workspace-kinds";

/**
 * The probe a package's kind carries (#2535, #2545). It passes when any of
 * its clauses does. A name in either clause may use `*`, which matches any
 * run of characters in one file name, so `*.tf` is every Terraform file.
 */
export interface FileProbe {
  /** A file matching one of these names sits directly in the directory. */
  anyFile?: string[];
  /**
   * A file directly in the directory whose name matches one of `in` has a
   * line that opens an unlabelled block named in `blocks`: leading space,
   * the name, optional space, then `{`. This is how a choudoufu root's
   * `live {` block is found without parsing HCL (#2545).
   */
  anyBlock?: { in: string[]; blocks: string[] };
}

/** What a kind's probe checks in a directory. */
export type KindProbe =
  /** Files, or blocks in files, sit directly in the directory. */
  | FileProbe
  /** The directory exists; nothing else is checked (`other`). */
  | { directory: true }
  /** The directory holds a chant project, as {@link holdsChantProject} says (`examples`). */
  | { chantProject: true };

/**
 * Which outputs a member of a kind exposes as link targets (#2524 D6,
 * #2539). A member link may only name an output its producer exposes.
 */
export type KindOutputs =
  /** The chant project's own outputs, read from its source without running it (`chant`). */
  | { from: "chant-source" }
  /** None: the member is opaque to links (`workspace`, and the group kind `examples`). */
  | { from: "none" }
  /** The names listed here, plus any the member entry lists in `outputs` (`other`, and kinds from a package). */
  | { from: "declared"; names: string[] };

export interface MemberKind {
  name: string;
  /** One line for listings and error messages. */
  description: string;
  probe: KindProbe;
  /**
   * When several kinds' probes claim one directory, the highest precedence
   * decides; equal highest precedences are a tie, and a tie fails. `other`
   * and `examples` are never claimants.
   */
  precedence: number;
  /** A member kind, or the kind of an example group (ws-051). */
  shape: "member" | "group";
  /** The outputs a member of this kind exposes as link targets (#2539). */
  outputs: KindOutputs;
  /** Where the kind comes from: `builtin`, or the package that supplies it. */
  source: string;
}

export interface KindRegistry {
  get(name: string): MemberKind | undefined;
  /** Every member kind's name, sorted, for "unknown kind" messages. */
  names(): string[];
  /** Every kind, group kinds included, in registration order. */
  all(): MemberKind[];
}

/** The group kind (ws-051). An entry of this kind is a group, not a member. */
export const EXAMPLES_KIND = "examples";

export const BUILTIN_KINDS: readonly MemberKind[] = [
  {
    name: "chant",
    description: "a chant project, with a chant.config.ts or chant.config.json in its directory",
    probe: { anyFile: ["chant.config.ts", "chant.config.json"] },
    precedence: 500,
    shape: "member",
    outputs: { from: "chant-source" },
    source: "builtin",
  },
  {
    name: "workspace",
    description: "a nested workspace, with its own chant.workspace.json; opaque to the outer one",
    probe: { anyFile: ["chant.workspace.json", "chant.workspace.jsonc"] },
    precedence: 1000,
    shape: "member",
    outputs: { from: "none" },
    source: "builtin",
  },
  {
    name: "other",
    description: "a directory chant does not read; the entry says why in `because`",
    probe: { directory: true },
    precedence: 0,
    shape: "member",
    outputs: { from: "declared", names: [] },
    source: "builtin",
  },
  {
    name: EXAMPLES_KIND,
    description: "an example group: every directory its glob matches that holds a chant project is built and linted",
    probe: { chantProject: true },
    precedence: 0,
    shape: "group",
    outputs: { from: "none" },
    source: "builtin",
  },
];

export const BUILTIN_KIND_NAMES: readonly string[] = BUILTIN_KINDS.map((k) => k.name);

/** A registry holding the built-in kinds and then `extra`, which must not repeat a name. */
export function createKindRegistry(extra: readonly MemberKind[] = []): KindRegistry {
  const byName = new Map<string, MemberKind>();
  for (const k of [...BUILTIN_KINDS, ...extra]) {
    if (byName.has(k.name)) throw new Error(`kind ${k.name} is registered twice`);
    byName.set(k.name, k);
  }
  return {
    get: (name) => byName.get(name),
    names: () => [...byName.values()].filter((k) => k.shape === "member").map((k) => k.name).sort(),
    all: () => [...byName.values()],
  };
}

export function builtinKindRegistry(): KindRegistry {
  return createKindRegistry();
}

/** Whether `dir` (tree-relative) passes `kind`'s probe. The directory is known to exist. */
export function probeKind(kind: MemberKind, tree: WorkspaceTree, dir: string): boolean {
  if ("directory" in kind.probe) return true;
  if ("chantProject" in kind.probe) return holdsChantProject(tree, dir);
  const { anyFile, anyBlock } = kind.probe;
  if (anyFile && filesMatching(tree, dir, anyFile).length > 0) return true;
  if (anyBlock) {
    const opener = new RegExp(`^\\s*(?:${anyBlock.blocks.map(escapeRegExp).join("|")})\\s*\\{`, "m");
    for (const file of filesMatching(tree, dir, anyBlock.in)) {
      try {
        if (opener.test(tree.read(file))) return true;
      } catch {
        // An unreadable file is no evidence either way.
      }
    }
  }
  return false;
}

/** Whether a probe looks at the directory's files, and so can claim it. */
function isFileProbe(probe: KindProbe): probe is FileProbe {
  return !("directory" in probe) && !("chantProject" in probe);
}

/**
 * The files directly in `dir` (tree-relative paths) whose names match one of
 * `names`. A name without `*` is looked up directly, so the common case needs
 * no listing.
 */
function filesMatching(tree: WorkspaceTree, dir: string, names: readonly string[]): string[] {
  const out: string[] = [];
  const globs = names.filter((n) => n.includes("*"));
  for (const name of names) {
    if (!name.includes("*") && tree.stat(joinPath(dir, name)) === "file") out.push(joinPath(dir, name));
  }
  if (globs.length > 0) {
    const patterns = globs.map((g) => new RegExp(`^${g.split("*").map(escapeRegExp).join("[^/]*")}$`));
    for (const e of tree.list(dir) ?? []) {
      if (e.type === "file" && patterns.some((p) => p.test(e.name))) out.push(joinPath(dir, e.name));
    }
  }
  return out.sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface KindResolution {
  /** Every member kind whose probe claims the directory, highest precedence first. */
  claims: MemberKind[];
  /** The kind the precedence order picks, when exactly one has the highest precedence. */
  winner: MemberKind | undefined;
  /** The kinds sharing the highest precedence, when there are two or more. A tie fails. */
  tie: MemberKind[];
}

/**
 * Which kind's probe claims `dir` (tree-relative). Only member kinds whose
 * probe looks at the directory take part: `other` claims every directory and
 * so claims none, and `examples` is a group kind. `exclude` leaves kinds out,
 * such as `workspace` for the root member, whose directory holds the
 * workspace's own declaration.
 */
export function resolveKind(kinds: KindRegistry, tree: WorkspaceTree, dir: string, exclude: readonly string[] = []): KindResolution {
  const claims = kinds
    .all()
    .filter((k) => k.shape === "member" && isFileProbe(k.probe) && !exclude.includes(k.name) && probeKind(k, tree, dir))
    .sort((a, b) => b.precedence - a.precedence || (a.name < b.name ? -1 : 1));
  const top = claims.filter((k) => k.precedence === claims[0]?.precedence);
  return { claims, winner: top.length === 1 ? top[0] : undefined, tie: top.length > 1 ? top : [] };
}

const CONFIG_FILES = ["chant.config.ts", "chant.config.json"];
const PROJECT_SEARCH_DEPTH = 4;

/**
 * Whether directory `dir` holds a chant project, for an example group's
 * matches (ws-051). That is true when a chant config sits in it or up to four
 * levels below it (many examples keep theirs in `src/`), or when its own
 * `package.json` depends on `@intentius/chant` or a chant lexicon, which is
 * how an example with no config names its lexicon.
 */
export function holdsChantProject(tree: WorkspaceTree, dir: string): boolean {
  const pkg = joinPath(dir, "package.json");
  if (tree.stat(pkg) === "file") {
    try {
      const json = JSON.parse(tree.read(pkg)) as Record<string, unknown>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = json[field];
        if (deps && typeof deps === "object" && Object.keys(deps).some(isChantPackage)) return true;
      }
    } catch {
      // An unreadable package.json names no lexicon; fall through to the config search.
    }
  }
  const search = (at: string, depth: number): boolean => {
    const entries = tree.list(at) ?? [];
    if (entries.some((e) => e.type === "file" && CONFIG_FILES.includes(e.name))) return true;
    if (depth === PROJECT_SEARCH_DEPTH) return false;
    return entries.some((e) => e.type === "dir" && !skippedDir(e.name) && search(joinPath(at, e.name), depth + 1));
  };
  return search(dir, 0);
}

function isChantPackage(name: string): boolean {
  return name === "@intentius/chant" || name.startsWith("@intentius/chant-lexicon-");
}

// ── Kinds as data ────────────────────────────────────────────────────────────

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

export interface KindData {
  kinds: MemberKind[];
  /** Why the data can't be used, one line each. Empty when it can. */
  problems: string[];
}

/**
 * Check the text of a kinds file against `workspace-kinds.schema.json` and
 * the rules the schema can't say: no built-in name, and no name twice.
 * `source` names the package in the kinds and in the messages.
 */
export function parseKindData(text: string, source: string): KindData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { kinds: [], problems: [`${source}: the kinds file is not JSON (${(err as Error).message})`] };
  }
  const validate = validator();
  if (!validate(raw)) {
    const problems = (validate.errors ?? []).map((e) => `${source}: ${e.instancePath || "the kinds file"} ${e.message ?? "is invalid"}`);
    return { kinds: [], problems: [...new Set(problems)] };
  }
  const problems: string[] = [];
  const kinds: MemberKind[] = [];
  const seen = new Set<string>();
  for (const k of (raw as { kinds: { name: string; description: string; precedence: number; probe: FileProbe; outputs?: string[] }[] }).kinds) {
    if (BUILTIN_KIND_NAMES.includes(k.name)) {
      problems.push(`${source}: kind ${k.name} is built in and can't be supplied by a package`);
      continue;
    }
    if (seen.has(k.name)) {
      problems.push(`${source}: kind ${k.name} is listed twice`);
      continue;
    }
    seen.add(k.name);
    kinds.push({
      name: k.name,
      description: k.description,
      probe: {
        ...(k.probe.anyFile ? { anyFile: [...k.probe.anyFile] } : {}),
        ...(k.probe.anyBlock ? { anyBlock: { in: [...k.probe.anyBlock.in], blocks: [...k.probe.anyBlock.blocks] } } : {}),
      },
      precedence: k.precedence,
      shape: "member",
      outputs: { from: "declared", names: [...(k.outputs ?? [])] },
      source,
    });
  }
  return { kinds, problems };
}

export interface PackageKinds extends KindData {
  /** The kinds file, absolute, or undefined when the package publishes none. */
  file: string | undefined;
}

/**
 * Where a package's `exports` send `./workspace-kinds`, or undefined when
 * the package doesn't export that subpath. Only the literal key counts: a
 * `./*` pattern maps the subpath to code, which chant never runs for kinds.
 */
export function kindsExportTarget(pkg: Record<string, unknown>): string | undefined | { problem: string } {
  const exports = pkg.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return undefined;
  const entry = (exports as Record<string, unknown>)[KINDS_SUBPATH];
  if (entry === undefined) return undefined;
  let target: unknown = entry;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const conditions = target as Record<string, unknown>;
    target = conditions.default ?? conditions.import ?? conditions.require;
  }
  if (typeof target !== "string") {
    return { problem: `exports["${KINDS_SUBPATH}"] must name one file, as a string or a "default" condition` };
  }
  if (!target.startsWith("./") || !target.endsWith(".json")) {
    return { problem: `exports["${KINDS_SUBPATH}"] is ${target}; it must name a .json file inside the package, since chant reads kinds as data and never runs a package's code` };
  }
  return target;
}

/** Read the kinds a package directory publishes. Reads files only; imports nothing. */
export function readPackageKinds(packageDir: string, source?: string): PackageKinds {
  const manifest = join(packageDir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf-8")) as Record<string, unknown>;
  } catch {
    return { kinds: [], problems: [`${source ?? packageDir}: no readable package.json in ${packageDir}`], file: undefined };
  }
  const name = source ?? (typeof pkg.name === "string" ? pkg.name : packageDir);
  const target = kindsExportTarget(pkg);
  if (target === undefined) return { kinds: [], problems: [], file: undefined };
  if (typeof target !== "string") return { kinds: [], problems: [`${name}: ${target.problem}`], file: undefined };
  const file = resolve(packageDir, target);
  const inside = relative(packageDir, file);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    return { kinds: [], problems: [`${name}: exports["${KINDS_SUBPATH}"] points outside the package`], file: undefined };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return { kinds: [], problems: [`${name}: exports["${KINDS_SUBPATH}"] names ${target}, which does not exist`], file };
  }
  return { ...parseKindData(text, name), file };
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

export interface PinLike {
  package: string | null;
  version: string | null;
  path: string | null;
}

export interface KindLoadProblem {
  /** The pin's index in the declaration's `pins`. */
  pin: number;
  message: string;
}

export interface LoadedKinds {
  registry: KindRegistry;
  problems: KindLoadProblem[];
}

/**
 * Build the registry for a workspace: the built-in kinds plus the kinds
 * every pin publishes. `workspaceRoot` is the absolute workspace root; a
 * package pin is looked up from there, and a path pin is relative to it.
 * An installed version that differs from the pin, a kinds file that doesn't
 * validate, and a kind name two packages both supply are problems; the kinds
 * involved are left out, so members of those kinds read as unknown.
 * Never throws.
 */
export function loadKindRegistry(pins: readonly PinLike[], workspaceRoot: string): LoadedKinds {
  const problems: KindLoadProblem[] = [];
  const extra: MemberKind[] = [];
  const owner = new Map<string, string>();
  const clashing = new Set<string>();
  pins.forEach((pin, i) => {
    let dir: string | undefined;
    let source: string;
    if (pin.package) {
      source = pin.package;
      dir = findInstalledPackage(pin.package, workspaceRoot);
      if (!dir) {
        problems.push({ pin: i, message: `pinned package ${pin.package} is not installed; install it to read the kinds it supplies` });
        return;
      }
      let installed: unknown;
      try {
        installed = (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: unknown }).version;
      } catch {
        installed = undefined;
      }
      if (pin.version && installed !== pin.version) {
        problems.push({ pin: i, message: `${pin.package} is pinned at ${pin.version}, and ${String(installed ?? "an unknown version")} is installed` });
        return;
      }
    } else if (pin.path) {
      source = pin.path;
      dir = join(workspaceRoot, ...pin.path.split("/"));
    } else {
      return;
    }
    const read = readPackageKinds(dir, source);
    for (const p of read.problems) problems.push({ pin: i, message: p });
    for (const k of read.kinds) {
      const first = owner.get(k.name);
      if (first) {
        clashing.add(k.name);
        problems.push({ pin: i, message: `kind ${k.name} is supplied by both ${first} and ${source}; a kind name has one source` });
        continue;
      }
      owner.set(k.name, source);
      extra.push(k);
    }
  });
  // A name two packages both supply is left out altogether: neither reading is safe.
  return { registry: createKindRegistry(extra.filter((k) => !clashing.has(k.name))), problems };
}

/**
 * Whether `file` (absolute, inside `packageDir`) is published, as far as the
 * package's `files` list says. A package with no `files` list publishes
 * everything npm doesn't ignore by default.
 */
export function kindsFileShips(packageDir: string, file: string): boolean {
  let pkg: { files?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as { files?: unknown };
  } catch {
    return false;
  }
  if (!Array.isArray(pkg.files)) return true;
  const rel = relative(packageDir, file).split("\\").join("/");
  return pkg.files.some((entry) => {
    if (typeof entry !== "string") return false;
    const e = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    return rel === e || rel.startsWith(`${e}/`);
  });
}

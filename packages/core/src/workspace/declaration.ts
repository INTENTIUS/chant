/**
 * The workspace declaration, `chant.workspace.json` or `.jsonc` (#2524 D1, D2;
 * ws-051 for example groups).
 *
 * Every read goes through {@link parseDeclaration}: the text is parsed with
 * positions, the declared `minReader` is checked, the result is validated
 * against the JSON Schema shipped beside this file, and then the rules JSON
 * Schema can't say are checked in code: unique names, and the placement rules.
 * Any failure is a {@link WorkspaceReadError} naming the file, line and
 * column. A declaration never reads as empty.
 *
 * Group matches depend on the tree, so their placement is checked when they
 * are expanded ({@link resolveGroups}).
 *
 * Everything under `workspace/` loads only when a `chant workspace` command
 * runs. The level-0 goldens (#2526) fail if a level-0 command loads it.
 */

import { createRequire } from "node:module";
import schema from "./declaration.schema.json";
import { expandGlob } from "./glob";
import { EXAMPLES_KIND, holdsChantProject } from "./kinds";
import { parseJsonText, pointerToken, type TextLocation } from "./jsonc";
import { joinPath, type WorkspaceTree } from "./tree";

export const DECLARATION_SCHEMA_ID = schema.$id;
export const DECLARATION_FILES = ["chant.workspace.json", "chant.workspace.jsonc"] as const;
export const DECLARATION_SCHEMA_VERSION = 1;

/** Names no member or group may take: ledger paths use them (#2524 D7, D17). */
export const RESERVED_NAMES = ["_workspace", "_members"] as const;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Why a workspace could not be read. The list is closed: a reader may switch
 * on it, and a new code is a contract change (#2524 D15).
 */
export const WORKSPACE_ERROR_CODES = [
  /** No chant.workspace.json or .jsonc between the directory and the git root. */
  "declaration-missing",
  /** Both chant.workspace.json and chant.workspace.jsonc are present. */
  "declaration-ambiguous",
  /** The file is not valid JSON (or JSONC, for .jsonc). */
  "declaration-unparseable",
  /** The file does not match the declaration schema, or repeats a name. */
  "declaration-invalid",
  /** A member or group match breaks a placement rule (#2524 D2, ws-051). */
  "placement-invalid",
  /** The declaration's minReader is newer than this chant. */
  "reader-too-old",
  /** `--at` was given outside a git repository. */
  "not-a-git-repository",
  /** `--at` names no commit. */
  "revision-unknown",
] as const;
export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export interface ErrorLocation extends TextLocation {
  /** The declaration file, relative to the workspace root's tree. */
  file: string;
}

export class WorkspaceReadError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly location?: ErrorLocation,
  ) {
    super(message);
    this.name = "WorkspaceReadError";
  }

  /** `file:line:column: message`, or the message alone. */
  describe(): string {
    const l = this.location;
    return l ? `${l.file}:${l.line}:${l.column}: ${this.message}` : this.message;
  }
}

// ── The shape ────────────────────────────────────────────────────────────────

export interface MemberRole {
  name: string;
  /** Relative to the member's directory, or null for the whole member. */
  path: string | null;
}

export interface Member {
  type: "member";
  name: string;
  /** Relative to the workspace root; `"."` is the root member. */
  dir: string;
  kind: string;
  roles: MemberRole[];
  upstream: string | null;
  because: string | null;
  /** The entry's JSON Pointer in the file, for messages. */
  pointer: string;
}

export interface Group {
  type: "group";
  name: string;
  kind: typeof EXAMPLES_KIND;
  globs: string[];
  pointer: string;
  /** Where the entry's `glob` sits in the file, for placement errors. */
  globLocation: TextLocation;
}

export type Entry = Member | Group;

export interface Pin {
  package: string | null;
  version: string | null;
  path: string | null;
  integrity: string | null;
}

export interface Declaration {
  name: string;
  schema: number;
  minReader: string | null;
  /** Members and groups, in file order. */
  entries: Entry[];
  members: Member[];
  groups: Group[];
  pins: Pin[];
  /** The file, relative to the workspace root's tree (`chant.workspace.json` or `.jsonc`). */
  file: string;
}

// ── This chant ───────────────────────────────────────────────────────────────

/** The version of the chant doing the reading. */
export function readerVersion(): string {
  return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Negative when `a` is older than `b`. Build metadata is not allowed, and prereleases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new Error(`not a version: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  if (ma[4] === mb[4]) return 0;
  if (ma[4] === undefined) return 1;
  if (mb[4] === undefined) return -1;
  return ma[4] < mb[4] ? -1 : 1;
}

// ── Validation ───────────────────────────────────────────────────────────────

interface AjvError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message?: string;
  params: Record<string, unknown>;
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

/** Readable text for one schema error, keyed on the rule that failed. */
function explain(e: AjvError, value: unknown): string {
  const def = /#\/\$defs\/([A-Za-z]+)\//.exec(e.schemaPath)?.[1];
  if (e.keyword === "pattern") {
    const shown = JSON.stringify(value);
    if (def === "name" && typeof value === "string" && (RESERVED_NAMES as readonly string[]).includes(value)) {
      return `${shown} is reserved; pick another name`;
    }
    if (def === "name") return `${shown} is not a valid name: use lowercase letters, digits and hyphens, starting with a letter or digit, at most 40 characters`;
    if (def === "kindName") return `${shown} is not a valid kind or role name`;
    if (def === "dir") return `${shown} is not a directory inside the workspace: use a relative path with / separators, and no . or .. segments`;
    if (def === "glob") return `${shown} is not a glob inside the workspace: use a relative pattern with / separators, and no . or .. segments`;
    if (def === "version") return `${shown} is not a version such as 1.2.3`;
    return `${shown} is not allowed here`;
  }
  if (e.keyword === "additionalProperties") {
    return `unknown field ${JSON.stringify(e.params.additionalProperty)}; only fields named x-... may be added`;
  }
  if (e.keyword === "required") {
    const missing = String(e.params.missingProperty);
    if (missing === "because") return `a member of kind other needs "because", saying why it is there`;
    return `missing required field ${JSON.stringify(missing)}`;
  }
  if (e.keyword === "const" && e.instancePath === "/schema") return `schema must be 1, the only declaration format this chant reads`;
  return e.message ?? "is invalid";
}

/** Keywords that only summarise errors reported on their own. */
const SUMMARY_KEYWORDS = new Set(["if", "then", "else", "oneOf", "anyOf"]);

function valueAt(root: unknown, pointer: string): unknown {
  let v: unknown = root;
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/**
 * Parse and check a declaration's text. `file` is the name used in messages
 * and decides the dialect: a name ending in `.jsonc` allows comments and
 * trailing commas.
 */
export function parseDeclaration(text: string, file: string, reader: string = readerVersion()): Declaration {
  const parsed = parseJsonText(text, { jsonc: file.endsWith(".jsonc") });
  if (!parsed.ok) {
    throw new WorkspaceReadError("declaration-unparseable", parsed.message, { file, ...parsed.location });
  }
  const at = (pointer: string, key = false): ErrorLocation => ({ file, ...parsed.locate(pointer, key) });
  const raw = parsed.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceReadError("declaration-invalid", "the declaration must be a JSON object", at(""));
  }
  const obj = raw as Record<string, unknown>;

  // minReader first: a declaration written for a newer chant may use fields
  // this one doesn't know, and "too old" is the true reason it can't read it.
  if (typeof obj.minReader === "string" && SEMVER.test(obj.minReader) && compareVersions(reader, obj.minReader) < 0) {
    throw new WorkspaceReadError(
      "reader-too-old",
      `this declaration needs chant ${obj.minReader} or newer to read it, and this is chant ${reader}`,
      at("/minReader"),
    );
  }

  const validate = validator();
  if (!validate(raw)) {
    const errors = (validate.errors ?? []).filter((e) => !SUMMARY_KEYWORDS.has(e.keyword));
    // The deepest error first: it is the one closest to what needs fixing.
    errors.sort((a, b) => b.instancePath.split("/").length - a.instancePath.split("/").length);
    const first = errors[0] ?? validate.errors![0];
    const isKey = first.keyword === "additionalProperties";
    const pointer = isKey ? `${first.instancePath}/${pointerToken(String(first.params.additionalProperty))}` : first.instancePath;
    const where = first.instancePath === "" ? "" : ` (at ${first.instancePath})`;
    const more = errors.length > 1 ? `; ${errors.length - 1} more problem${errors.length > 2 ? "s" : ""} after this one` : "";
    throw new WorkspaceReadError("declaration-invalid", `${explain(first, valueAt(raw, first.instancePath))}${where}${more}`, at(pointer, isKey));
  }

  const entries: Entry[] = (obj.members as Record<string, unknown>[]).map((e, i): Entry => {
    const pointer = `/members/${i}`;
    if (e.kind === EXAMPLES_KIND) {
      const glob = e.glob as string | string[];
      return {
        type: "group",
        name: e.name as string,
        kind: EXAMPLES_KIND,
        globs: typeof glob === "string" ? [glob] : [...glob],
        pointer,
        globLocation: parsed.locate(`${pointer}/glob`),
      };
    }
    const roles = ((e.roles as (string | { name: string; path?: string })[] | undefined) ?? []).map((r) =>
      typeof r === "string" ? { name: r, path: null } : { name: r.name, path: r.path ?? null },
    );
    return {
      type: "member",
      name: e.name as string,
      dir: e.dir as string,
      kind: e.kind as string,
      roles,
      upstream: (e.upstream as string | undefined) ?? null,
      because: (e.because as string | undefined) ?? null,
      pointer,
    };
  });

  // Names are unique across members and groups.
  const names = new Map<string, Entry>();
  for (const e of entries) {
    const first = names.get(e.name);
    if (first) {
      throw new WorkspaceReadError(
        "declaration-invalid",
        `the name ${JSON.stringify(e.name)} is already used by the entry at ${first.pointer}`,
        at(`${e.pointer}/name`),
      );
    }
    names.set(e.name, e);
  }

  // Placement (#2524 D2): one root member at most, no two members in one
  // directory, and only the root member contains other members.
  const members = entries.filter((e): e is Member => e.type === "member");
  const byDir = new Map<string, Member>();
  for (const m of members) {
    const other = byDir.get(m.dir);
    if (other) {
      throw new WorkspaceReadError(
        "placement-invalid",
        `member ${m.name} has the same directory as member ${other.name} (${m.dir})`,
        at(`${m.pointer}/dir`),
      );
    }
    byDir.set(m.dir, m);
  }
  for (const m of members) {
    const outer = members.find((o) => o !== m && o.dir !== "." && isInside(m.dir, o.dir));
    if (outer) {
      throw new WorkspaceReadError(
        "placement-invalid",
        `member ${m.name} (${m.dir}) sits inside member ${outer.name} (${outer.dir}); only the root member "." may contain other members`,
        at(`${m.pointer}/dir`),
      );
    }
  }

  const pins = ((obj.pins as Record<string, string>[] | undefined) ?? []).map((p) => ({
    package: p.package ?? null,
    version: p.version ?? null,
    path: p.path ?? null,
    integrity: p.integrity ?? null,
  }));

  return {
    name: obj.name as string,
    schema: obj.schema as number,
    minReader: (obj.minReader as string | undefined) ?? null,
    entries,
    members,
    groups: entries.filter((e): e is Group => e.type === "group"),
    pins,
    file,
  };
}

/** Whether `path` is `dir` or sits under it. Both are tree-relative; `"."` is the root. */
export function isInside(path: string, dir: string): boolean {
  if (dir === ".") return true;
  return path === dir || path.startsWith(`${dir}/`);
}

// ── Reading from a tree ──────────────────────────────────────────────────────

/**
 * Read the declaration in directory `dir` of `tree`. Throws
 * `declaration-missing` when neither name is there and
 * `declaration-ambiguous` when both are.
 */
export function readDeclaration(tree: WorkspaceTree, dir = ""): Declaration {
  const present = DECLARATION_FILES.map((name) => joinPath(dir, name)).filter((p) => tree.stat(p) === "file");
  if (present.length === 0) {
    throw new WorkspaceReadError("declaration-missing", `no ${DECLARATION_FILES.join(" or ")} in ${dir || "the workspace root"}${tree.label}`);
  }
  if (present.length > 1) {
    throw new WorkspaceReadError(
      "declaration-ambiguous",
      `both ${present.join(" and ")} exist${tree.label}; keep one of them`,
      { file: present[1], line: 1, column: 1 },
    );
  }
  return parseDeclaration(tree.read(present[0]), present[0]);
}

/**
 * Walk up from `start` (tree-relative) to the nearest directory holding a
 * declaration, within `tree`. The tree's root is the git root, so this is
 * `findWorkspaceRoot` for a revision. Returns the directory, or undefined.
 */
export function findDeclarationDir(tree: WorkspaceTree, start: string): string | undefined {
  for (let dir = start; ; dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "") {
    if (DECLARATION_FILES.some((name) => tree.stat(joinPath(dir, name)) === "file")) return dir;
    if (dir === "") return undefined;
  }
}

// ── Groups ───────────────────────────────────────────────────────────────────

export interface ResolvedGroup {
  group: Group;
  /** Directories the globs match that hold a chant project, sorted. */
  matches: string[];
  /** Directories the globs match that hold none; they are left alone. */
  skipped: string[];
}

/**
 * Expand every group's globs in `tree` (rooted at the workspace root) and
 * check where the matches sit (ws-051): a match is never a member's directory
 * and never contains one, it doesn't sit inside a nested workspace, and no
 * two groups claim the same directory. A match may sit inside any other
 * member's directory; that member leaves it to the group.
 */
export function resolveGroups(declaration: Declaration, tree: WorkspaceTree): ResolvedGroup[] {
  const at = (g: Group): ErrorLocation => ({ file: declaration.file, ...g.globLocation });
  const claimed = new Map<string, Group>();
  const resolved: ResolvedGroup[] = [];
  for (const group of declaration.groups) {
    const dirs = [...new Set(group.globs.flatMap((g) => expandGlob(tree, g)))].sort();
    const matches: string[] = [];
    const skipped: string[] = [];
    for (const dir of dirs) {
      if (!holdsChantProject(tree, dir)) {
        skipped.push(dir);
        continue;
      }
      const clash = (message: string) => new WorkspaceReadError("placement-invalid", `group ${group.name} matches ${dir}, ${message}`, at(group));
      for (const m of declaration.members) {
        if (m.dir === ".") continue;
        if (m.dir === dir) throw clash(`which is member ${m.name}'s directory; a match is never a member`);
        if (isInside(m.dir, dir)) throw clash(`which contains member ${m.name} (${m.dir})`);
        if (m.kind === "workspace" && isInside(dir, m.dir)) {
          throw clash(`which sits inside the nested workspace ${m.name}; that workspace declares its own examples`);
        }
      }
      const other = claimed.get(dir);
      if (other) throw clash(`which group ${other.name} also matches`);
      claimed.set(dir, group);
      matches.push(dir);
    }
    resolved.push({ group, matches, skipped });
  }
  return resolved;
}

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * Which entry owns `path` (relative to the workspace root): the group whose
 * match holds it, else the member with the deepest directory holding it, else
 * none. A group match wins over the member whose directory it sits in
 * (ws-051). Ledgers (#2538), telemetry attribution (#2558) and the root
 * project's discovery (#2537) all ask this question.
 */
export function ownerOf(
  declaration: Declaration,
  groups: ResolvedGroup[],
  path: string,
): { member: Member } | { group: Group; match: string } | undefined {
  for (const g of groups) {
    const match = g.matches.find((m) => isInside(path, m));
    if (match) return { group: g.group, match };
  }
  let best: Member | undefined;
  for (const m of declaration.members) {
    if (!isInside(path, m.dir)) continue;
    if (!best || best.dir === "." || (m.dir !== "." && m.dir.length > best.dir.length)) best = m;
  }
  return best ? { member: best } : undefined;
}

/**
 * The directories that leave the root project once the declaration exists
 * (#2524 D0, D2): every member's directory but the root's, and every group
 * match. The root project's build, lint, Op and audit discovery skip them
 * (#2537); `chant workspace init` prints them before it writes.
 */
export function rootExclusions(declaration: Declaration, groups: ResolvedGroup[]): { dir: string; owner: string }[] {
  const out: { dir: string; owner: string }[] = [];
  for (const m of declaration.members) if (m.dir !== ".") out.push({ dir: m.dir, owner: m.name });
  for (const g of groups) {
    for (const dir of g.matches) {
      // A match inside a member's directory already left with that member.
      if (declaration.members.some((m) => m.dir !== "." && isInside(dir, m.dir))) continue;
      out.push({ dir, owner: g.group.name });
    }
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

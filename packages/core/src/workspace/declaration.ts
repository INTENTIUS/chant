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

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import schema from "./declaration.schema.json";
import { expandGlob } from "./glob";
import { EXAMPLES_KIND, holdsChantProject } from "./kinds";
import { parseJsonText, pointerToken, type TextLocation } from "./jsonc";
import type { ReasonCode } from "./reason-codes";
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
  /** The declaration pins another chant, which is not installed at the root (#2524 D15, ws-021). */
  "root-chant-required",
  /** `--at` was given outside a git repository. */
  "not-a-git-repository",
  /** `--at` names no commit. */
  "revision-unknown",
] as const satisfies readonly ReasonCode[];
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

/** A declaration check suppressed for one entry (#2535). */
export interface Suppression {
  /** A `WSP` id. */
  check: string;
  because: string;
}

/** What `checks` may set a declaration check's severity to. */
export type CheckSeverity = "error" | "warning" | "info" | "off";

/** How `chant workspace check --changes` treats its findings (#2773): not at all, as warnings, or as failures. */
export type ChangeSeverity = "off" | "warn" | "fail";

/** The declaration's `changes` block (#2773): the severity of the forward coverage check, and the paths it never reports. */
export interface ChangesPolicy {
  /** Absent from the declaration, `warn`. */
  severity: ChangeSeverity;
  /** Globs over files, relative to the workspace root, whose changes need no record: lockfiles, generated output. */
  ignore: string[];
}

export interface MemberRole {
  name: string;
  /** Relative to the member's directory, or null for the whole member. */
  path: string | null;
}

/** A file a member lists as written by a command (#2524 D14, #2541). */
export interface GeneratedFile {
  /** Relative to the member's directory. */
  path: string;
  /** The command line that writes the file, run in the member's directory. */
  generator: string;
  /** What the generator reads, relative to the workspace root. */
  sources: string[];
  /** Set when the file is kept by hand instead of regenerated. */
  handWritten: { because: string } | null;
  /** The entry's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** A member link as the consumer states it (#2524 D6, #2539). */
export interface LinkDeclaration {
  /** The producer member. */
  member: string;
  /** The producer's output, compared exactly. */
  output: string;
  /** The link kind as written, or null for the default (`output`). */
  kind: string | null;
  /** The link's JSON Pointer in the file, for messages. */
  pointer: string;
}

/**
 * A record kind the declaration names (#2680): the workspace's own, in the
 * top-level `records`, or a member's, in that member's `records`.
 */
export interface RecordKindDeclaration {
  /** The kind file as the entry writes it: relative to the member's directory, or to the workspace root for the workspace's own. */
  kind: string;
  /** The kind file from the workspace root, with / separators. */
  path: string;
  /** The name the entry gives the kind, or null when readers use the kind file's own `recordKind.name`. */
  name: string | null;
  /** The member that declares it, or null for the workspace's own. */
  member: string | null;
  /** The entry's JSON Pointer in the file, for messages. */
  pointer: string;
}

/**
 * A capability a box reaches through a broker (#2726): inference, Fountain,
 * a third-party API. The broker is runtime (a lobby, a door, a studio) and
 * holds the credential; the declaration names it and the scope it enforces.
 */
export interface BoxCapability {
  name: string;
  /** What brokers it, such as `lobby`, or null when the entry names no broker (WSP122). */
  broker: string | null;
  /** What of the box's own the broker lets it reach, such as `agent`, `vault`, `conversations`, `sandboxes`. */
  scope: string[];
  /** The entry's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** A member that is a box, or a box's declarations (#2726). */
export interface BoxDeclaration {
  capabilities: BoxCapability[];
  /** The host and slot of the box's isolation, or null when the block declares none (#2727). The values are derived in `boxes.ts`. */
  isolation: BoxIsolationDeclaration | null;
  /** The block's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** What a box declares about its isolation (#2727): its identity on a host, and the names of what it needs kept apart. */
export interface BoxIsolationDeclaration {
  host: string;
  slot: number;
  /** Port name to offset in the box's block, in file order. */
  ports: Record<string, number>;
  /** State name to a path relative to the box's state directory, in file order. */
  state: Record<string, string>;
  cookies: string[];
}

/** A host boxes run on (#2727): one machine under one hostname. */
export interface Host {
  name: string;
  ports: { from: number; to: number; perBox: number };
  /** As written, or null for the default ({@link DEFAULT_STATE_ROOT}). */
  stateRoot: string | null;
  /** The entry's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** Where boxes keep state when their host names no stateRoot (#2727). */
export const DEFAULT_STATE_ROOT = "${XDG_STATE_HOME}/chant/boxes";

export interface Member {
  type: "member";
  name: string;
  /** Relative to the workspace root; `"."` is the root member. */
  dir: string;
  kind: string;
  roles: MemberRole[];
  /** Declared generated files, in file order. The implicit ones are not listed here (see `generated-files.ts`). */
  generated: GeneratedFile[];
  /** Outputs the entry lists as link targets, or null when it lists none (#2539). */
  outputs: string[] | null;
  /** The links this member states as a consumer, in file order (#2539). */
  links: LinkDeclaration[];
  /** The record kinds this member declares, in file order (#2680). */
  records: RecordKindDeclaration[];
  /** The member's box block, or null when it declares none (#2726). */
  box: BoxDeclaration | null;
  upstream: string | null;
  because: string | null;
  suppress: Suppression[];
  /** The entry's JSON Pointer in the file, for messages. */
  pointer: string;
}

export interface Group {
  type: "group";
  name: string;
  kind: typeof EXAMPLES_KIND;
  globs: string[];
  suppress: Suppression[];
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
  /** Severities set for declaration checks, keyed by `WSP` id (#2535). */
  checks: Record<string, CheckSeverity>;
  /** How many verdicts besides the decider's a record needs, or null when the declaration names none (#2671). */
  quorum: number | null;
  /** The workspace's own record kinds, from the top-level `records`, in file order (#2680). A member's are on the member. */
  records: RecordKindDeclaration[];
  /** The hosts boxes run on, in file order (#2727). */
  hosts: Host[];
  /** The forward coverage check's policy (#2773), or null when the declaration has no `changes` block. */
  changes: ChangesPolicy | null;
  /** The file, relative to the workspace root's tree (`chant.workspace.json` or `.jsonc`). */
  file: string;
}

// ── This chant ───────────────────────────────────────────────────────────────

/** The package whose pin names the root's chant (#2524 D15, ws-021). */
export const CHANT_PACKAGE = "@intentius/chant";

let readerVersionCache: string | undefined;

/**
 * The version of the chant doing the reading. Read as a file, not through
 * `require`: discovery reads the declaration on every walk under a workspace
 * root (#2527), and a CJS require of `package.json` took about a minute per
 * call in a vitest worker once a build had run in it, where a file read takes
 * well under a millisecond.
 */
export function readerVersion(): string {
  readerVersionCache ??= (
    JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8")) as { version: string }
  ).version;
  return readerVersionCache;
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
    if (def === "path") return `${shown} is not a path inside the member or workspace: use a relative path with / separators, and no . or .. segments`;
    if (def === "glob") return `${shown} is not a glob inside the workspace: use a relative pattern with / separators, and no . or .. segments`;
    if (def === "version") return `${shown} is not a version such as 1.2.3`;
    return `${shown} is not allowed here`;
  }
  if (e.keyword === "additionalProperties") {
    return `unknown field ${JSON.stringify(e.params.additionalProperty)}; only fields named x-... may be added`;
  }
  if (e.keyword === "required") {
    const missing = String(e.params.missingProperty);
    if (missing === "because" && e.instancePath.endsWith("/handWritten")) return `a hand-written generated file needs "because", saying why it is kept by hand`;
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

export interface ReadOptions {
  /**
   * Apply "which chant reads it" (#2524 D15, ws-021): when the declaration
   * pins `@intentius/chant` at a version other than `reader`, that pinned
   * chant, the root's, reads it, and this one refuses with
   * `root-chant-required`. The read-contract commands (`ls`, `graph`,
   * `check`, `status`) set it, and hand the command to the root's chant
   * first when it is installed (`which-chant.ts`). Other commands leave it
   * off: a member's own toolchain writes its ledger whatever the root pins.
   */
  rootChant?: boolean;
}

/** The version the declaration's `@intentius/chant` pin names, and where the pin is. Undefined without one. */
export function pinnedChant(obj: Record<string, unknown>): { version: string; index: number } | undefined {
  if (!Array.isArray(obj.pins)) return undefined;
  const index = obj.pins.findIndex(
    (p) => p !== null && typeof p === "object" && (p as Record<string, unknown>).package === CHANT_PACKAGE && typeof (p as Record<string, unknown>).version === "string",
  );
  return index < 0 ? undefined : { version: (obj.pins[index] as { version: string }).version, index };
}

/**
 * Parse and check a declaration's text. `file` is the name used in messages
 * and decides the dialect: a name ending in `.jsonc` allows comments and
 * trailing commas.
 */
export function parseDeclaration(text: string, file: string, reader: string = readerVersion(), options: ReadOptions = {}): Declaration {
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

  // The root's chant reads the declaration (ws-021). A pin to another chant
  // comes before minReader and the schema: that chant may know fields this
  // one doesn't.
  const pin = options.rootChant ? pinnedChant(obj) : undefined;
  if (pin && pin.version !== reader) {
    throw new WorkspaceReadError(
      "root-chant-required",
      `this declaration pins ${CHANT_PACKAGE} ${pin.version}, and this is chant ${reader}; the root's chant reads it, so install ${CHANT_PACKAGE}@${pin.version} at the workspace root`,
      at(`/pins/${pin.index}/version`),
    );
  }

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
    const suppress = ((e.suppress as Suppression[] | undefined) ?? []).map((x) => ({ check: x.check, because: x.because }));
    if (e.kind === EXAMPLES_KIND) {
      const glob = e.glob as string | string[];
      return {
        type: "group",
        name: e.name as string,
        kind: EXAMPLES_KIND,
        globs: typeof glob === "string" ? [glob] : [...glob],
        suppress,
        pointer,
        globLocation: parsed.locate(`${pointer}/glob`),
      };
    }
    const roles = ((e.roles as (string | { name: string; path?: string })[] | undefined) ?? []).map((r) =>
      typeof r === "string" ? { name: r, path: null } : { name: r.name, path: r.path ?? null },
    );
    const generated = ((e.generated as Record<string, unknown>[] | undefined) ?? []).map((g, j): GeneratedFile => ({
      path: g.path as string,
      generator: g.generator as string,
      sources: [...((g.sources as string[] | undefined) ?? [])],
      handWritten: g.handWritten ? { because: (g.handWritten as { because: string }).because } : null,
      pointer: `${pointer}/generated/${j}`,
    }));
    const links = ((e.links as { member: string; output: string; kind?: string }[] | undefined) ?? []).map((l, j) => ({
      member: l.member,
      output: l.output,
      kind: l.kind ?? null,
      pointer: `${pointer}/links/${j}`,
    }));
    const records = recordKindsOf(e.records, e.dir as string, e.name as string, `${pointer}/records`);
    const box = boxOf(e.box, `${pointer}/box`);
    return {
      type: "member",
      name: e.name as string,
      dir: e.dir as string,
      kind: e.kind as string,
      roles,
      generated,
      outputs: e.outputs === undefined ? null : [...(e.outputs as string[])],
      links,
      records,
      box,
      upstream: (e.upstream as string | undefined) ?? null,
      because: (e.because as string | undefined) ?? null,
      suppress,
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

  // A member lists a generated file once, and never one inside another
  // member's directory: that member owns the file and lists it (#2541).
  for (const m of members) {
    const seen = new Map<string, GeneratedFile>();
    for (const g of m.generated) {
      const first = seen.get(g.path);
      if (first) {
        throw new WorkspaceReadError("declaration-invalid", `member ${m.name} lists the generated file ${g.path} twice; the first is at ${first.pointer}`, at(`${g.pointer}/path`));
      }
      seen.set(g.path, g);
      const full = m.dir === "." ? g.path : `${m.dir}/${g.path}`;
      const inner = members.find((o) => o !== m && o.dir !== "." && isInside(o.dir, m.dir) && isInside(full, o.dir));
      if (inner) {
        throw new WorkspaceReadError(
          "placement-invalid",
          `member ${m.name} lists the generated file ${g.path}, which sits inside member ${inner.name} (${inner.dir}); list it there`,
          at(`${g.pointer}/path`),
        );
      }
    }
  }

  // A kind file is declared once, and a name the declaration gives a kind is
  // given once (#2680): readers key the kinds by both.
  const ownRecords = recordKindsOf(obj.records, ".", null, "/records");
  const byPath = new Map<string, RecordKindDeclaration>();
  const byName = new Map<string, RecordKindDeclaration>();
  for (const r of [...ownRecords, ...members.flatMap((m) => m.records)]) {
    const first = byPath.get(r.path);
    if (first) throw new WorkspaceReadError("declaration-invalid", `the record kind ${r.path} is already declared at ${first.pointer}`, at(`${r.pointer}/kind`));
    byPath.set(r.path, r);
    if (r.name === null) continue;
    const named = byName.get(r.name);
    if (named) throw new WorkspaceReadError("declaration-invalid", `the record kind name ${JSON.stringify(r.name)} is already given at ${named.pointer}`, at(`${r.pointer}/name`));
    byName.set(r.name, r);
  }

  // A box names each capability once (#2726): a broker reads its scope by name.
  for (const m of members) {
    const seen = new Map<string, BoxCapability>();
    for (const c of m.box?.capabilities ?? []) {
      const first = seen.get(c.name);
      if (first) throw new WorkspaceReadError("declaration-invalid", `member ${m.name}'s box lists the capability ${c.name} twice; the first is at ${first.pointer}`, at(`${c.pointer}/name`));
      seen.set(c.name, c);
    }
  }

  const hosts = hostsOf(obj, members, at);

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
    checks: { ...((obj.checks as Record<string, CheckSeverity> | undefined) ?? {}) },
    quorum: typeof obj.quorum === "number" ? obj.quorum : null,
    records: ownRecords,
    hosts,
    changes: changesOf(obj.changes as Record<string, unknown> | undefined),
    file,
  };
}

/** The `changes` block, already validated, with its defaults (#2773). */
function changesOf(block: Record<string, unknown> | undefined): ChangesPolicy | null {
  if (block === undefined) return null;
  return { severity: (block.severity as ChangeSeverity | undefined) ?? "warn", ignore: [...((block.ignore as string[] | undefined) ?? [])] };
}

/** The `records` list at `pointer`, already validated, with each kind file's path from the workspace root. */
function recordKindsOf(raw: unknown, dir: string, member: string | null, pointer: string): RecordKindDeclaration[] {
  return ((raw as { kind: string; name?: string }[] | undefined) ?? []).map((r, i) => ({
    kind: r.kind,
    path: dir === "." ? r.kind : `${dir}/${r.kind}`,
    name: r.name ?? null,
    member,
    pointer: `${pointer}/${i}`,
  }));
}

/** The `box` block at `pointer`, already validated, or null when there is none (#2726, #2727). */
function boxOf(raw: unknown, pointer: string): BoxDeclaration | null {
  if (raw === undefined) return null;
  const b = raw as {
    capabilities?: { name: string; broker?: string; scope?: string[] }[];
    host?: string;
    slot?: number;
    ports?: Record<string, number>;
    state?: Record<string, string>;
    cookies?: string[];
  };
  return {
    capabilities: (b.capabilities ?? []).map((c, i) => ({ name: c.name, broker: c.broker ?? null, scope: [...(c.scope ?? [])], pointer: `${pointer}/capabilities/${i}` })),
    // The schema requires host and slot together, and host for ports, state and cookies.
    isolation:
      b.host === undefined
        ? null
        : { host: b.host, slot: b.slot!, ports: { ...(b.ports ?? {}) }, state: { ...(b.state ?? {}) }, cookies: [...(b.cookies ?? [])] },
    pointer,
  };
}

/**
 * The hosts, already validated, with the rules the schema can't say (#2727):
 * host names are unique, a box's host is declared, its slot's block fits the
 * host's range and its offsets fit the block. What two boxes resolve to is
 * `chant workspace check`'s question (WSP123), not a read error.
 */
function hostsOf(obj: Record<string, unknown>, members: Member[], at: (pointer: string, key?: boolean) => ErrorLocation): Host[] {
  const hosts = ((obj.hosts as Record<string, unknown>[] | undefined) ?? []).map((h, i): Host => ({
    name: h.name as string,
    ports: { ...(h.ports as Host["ports"]) },
    stateRoot: (h.stateRoot as string | undefined) ?? null,
    pointer: `/hosts/${i}`,
  }));
  const invalid = (message: string, pointer: string) => new WorkspaceReadError("declaration-invalid", message, at(pointer));
  const byName = new Map<string, Host>();
  for (const h of hosts) {
    const first = byName.get(h.name);
    if (first) throw invalid(`the host name ${JSON.stringify(h.name)} is already used by the host at ${first.pointer}`, `${h.pointer}/name`);
    byName.set(h.name, h);
    if (h.ports.from > h.ports.to) throw invalid(`host ${h.name}'s port range starts at ${h.ports.from}, after its end ${h.ports.to}`, `${h.pointer}/ports`);
  }
  for (const m of members) {
    const iso = m.box?.isolation;
    if (!iso) continue;
    const box = m.box!.pointer;
    const host = byName.get(iso.host);
    if (!host) {
      const known = hosts.map((h) => h.name).join(", ") || "none are declared";
      throw invalid(`member ${m.name}'s box names the host ${JSON.stringify(iso.host)}, which hosts does not declare; declared hosts: ${known}`, `${box}/host`);
    }
    const { from, to, perBox } = host.ports;
    const last = from + (iso.slot + 1) * perBox - 1;
    if (last > to) {
      const slots = Math.floor((to - from + 1) / perBox);
      throw invalid(
        `member ${m.name}'s box has slot ${iso.slot} on host ${host.name}, which needs ports ${from + iso.slot * perBox} to ${last}, past the end of the host's range (${to}); the range holds ${slots} slot${slots === 1 ? "" : "s"}`,
        `${box}/slot`,
      );
    }
    for (const [port, offset] of Object.entries(iso.ports)) {
      if (offset >= perBox) {
        throw invalid(`member ${m.name}'s box gives port ${port} offset ${offset}, and host ${host.name} gives each box ${perBox} port${perBox === 1 ? "" : "s"} (offsets 0 to ${perBox - 1})`, `${box}/ports/${pointerToken(port)}`);
      }
    }
  }
  return hosts;
}

/**
 * Every record kind the declaration names (#2680), in the order readers use
 * them: the workspace's own first, then each member's, members in file order
 * and each list in its own order.
 */
export function declaredRecordKinds(declaration: Declaration): RecordKindDeclaration[] {
  return [...declaration.records, ...declaration.members.flatMap((m) => m.records)];
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
export function readDeclaration(tree: WorkspaceTree, dir = "", options: ReadOptions = {}): Declaration {
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
  return parseDeclaration(tree.read(present[0]), present[0], readerVersion(), options);
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

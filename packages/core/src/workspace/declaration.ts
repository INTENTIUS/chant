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

/** The core principal classes (#2524 D5). A pinned package may supply domain classes too (#3080, `principal-classes.ts`). */
export const PRINCIPAL_CLASSES = ["human", "agent", "runner", "service"] as const;
export type CorePrincipalClass = (typeof PRINCIPAL_CLASSES)[number];
/** A class name: a core class, or a domain class a pinned package supplies (#3080). */
export type PrincipalClass = string;

/** How a record is written, as the records commands name it (#2548). */
export const WRITE_VERBS = ["new", "amend", "review", "close"] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];

/** One principal class's entry in the declaration's `writeScope` (#2548, ws-067). */
export interface ClassScope {
  /** The members whose files the class may write, or null for every path. Always null for the agent class: a session writes the members it is bound to. */
  members: string[] | null;
  /** Kind name to the verbs the class may write it with, or null for every kind in reach with every verb. */
  records: Record<string, WriteVerb[]> | null;
  /** Paths the class may not write even inside a member it may (#3146, ws-077), in file order. Empty when the entry lists none. */
  protected: ProtectedPath[];
  pointer: string;
}

/**
 * A protected path in a write scope (#3146, ws-077): a glob from the
 * workspace root. It protects the files it matches and everything under a
 * directory it matches. `except` names top-level keys of a JSON file a write
 * may still change; empty when the entry allows none.
 */
export interface ProtectedPath {
  path: string;
  except: string[];
}

/**
 * The declaration's `writeScope` block: an entry per restricted class, in
 * file order. A class with no entry is not restricted. A key may name a
 * domain class a pinned package supplies (#3080); whether one does is known
 * only once the pins are read, so an unknown key is judged where the scope
 * is applied, not here.
 */
export type WriteScope = Record<PrincipalClass, ClassScope>;

/** A gate the declaration's `identity.gates` names (#3163, ws-080): it passes only on a signed approval. */
export interface SignedGate {
  gate: string;
  /** The class the signer must be in, or null for any signer the signers file at base lists. */
  class: PrincipalClass | null;
  pointer: string;
}

/** The declaration's `identity` block (#3163, ws-080), read at base. */
export interface IdentityPolicy {
  /** `identified`: a person-attributed write must name a forge identity, a signer at base, or an agent, runner or service principal. */
  attribution: "any" | "identified";
  /** By gate name. */
  gates: Record<string, SignedGate>;
}

/**
 * An agent session the declaration names (#2524 D20, #2548): bound to the
 * members it lists, one or more (ws-101). It writes the files of each, and
 * the records of kinds any of them or the workspace declares.
 */
export interface AgentDeclaration {
  name: string;
  /** The members the session is bound to, in file order: `members`, or the one `member` names. Never empty. */
  members: string[];
  /** The first of `members`, kept for readers of a one-member session. */
  member: string;
  /** Principals that write only as this session. */
  principals: string[];
  pointer: string;
}

/** What a check run that finished as skipped counts as in a CI phase (#3573). */
export type CiSkipped = "pass" | "fail";

/** One phase of `ci.green`: the check runs that make it up (#3573, ws-103). */
export interface CiPhase {
  name: string;
  /** Check-run name patterns, `*` standing for any run of characters. */
  runs: string[];
  /** `fail` (the default): a skipped run never passes. `pass`: it passes, for a job a path filter runs only on some commits. */
  skipped: CiSkipped;
  pointer: string;
}

/** The default `ci.green.window`. */
export const DEFAULT_CI_WINDOW = "24h";

/** The declaration's `ci.green` block (#3573, ws-103), with its defaults. */
export interface CiGreen {
  /** The branch whose first-parent commits are tagged. */
  branch: string;
  /** How far back a tick looks, such as `24h`. */
  window: string;
  /** The phases, in file order. */
  phases: CiPhase[];
  /** The phases a commit must pass, by name, in file order. */
  require: string[];
  pointer: string;
}

/** The declaration's `ci` block (#3573). */
export interface CiDeclaration {
  green: CiGreen | null;
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
  /** A telemetry link's OTLP protocol as written (#2558), or null. */
  protocol: string | null;
  /** The link's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** A renderer a diagram is pinned to (#2764): a closed list of tools chant does not run. */
export const DIAGRAM_TOOLS = ["d2", "mermaid", "graphviz", "excalidraw"] as const;
export type DiagramTool = (typeof DIAGRAM_TOOLS)[number];

/** The renderer a diagram's render was made with (#2764). chant never runs it; it is recorded so a reader can. */
export interface DiagramRenderer {
  tool: DiagramTool;
  /** The exact release the render was made with, such as "0.9.0". For mermaid or excalidraw, the release of the library a reader draws the source with. */
  version: string;
  /** Passed before the input and output paths, in order. */
  args: string[];
}

/**
 * A diagram artifact the declaration names (#2764): the workspace's own, in
 * the top-level `diagrams`, or a member's, in that member's `diagrams`. A
 * name is given once across the declaration, like a record kind's.
 */
export interface DiagramDeclaration {
  name: string;
  title: string;
  /** From the workspace root, with / separators. Null for an SVG with no source. */
  source: string | null;
  /** From the workspace root, with / separators. Null only for a mermaid or excalidraw diagram, which a reader draws from its source. */
  render: string | null;
  renderer: DiagramRenderer;
  /** sha256 hex of the source's bytes when the render was last produced (a mermaid or excalidraw diagram without a render: when the source was last pinned), for `chant workspace check`'s drift finding. Null when not recorded, or when source is null: the render is then never checked for drift. */
  sourceHash: string | null;
  /** The member that declares it, or null for the workspace's own. */
  member: string | null;
  /** The entry's JSON Pointer in the file, for messages. */
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
  /**
   * The id of the decision record that says what the box is for, or null when
   * the block names none (#2850). A box starts as a question: the record is
   * proposed with no choice until the person who answers it decides it.
   */
  intent: string | null;
  /**
   * The services the box runs under its supervisor (sprite-env on a sprite),
   * in file order, or empty when the block declares none (#2880). The fly
   * lexicon's `spriteServicesObserve`, `spriteServiceRestart` and
   * `spriteApplyServices` read them with `box: true`.
   */
  services: BoxService[];
  /** What the box builds and how (#3146, ws-077), or null when the block declares no factory. */
  factory: BoxFactory | null;
  /** What the box shows of itself on a home site (#3146), or null when the block declares no listing. */
  listing: BoxListing | null;
  /**
   * The command that publishes the box's work (#3165, ws-088), as declared,
   * or null when the block names none. `chant workspace box publish` runs it
   * (`box-publish.ts`).
   */
  publisher: string | null;
  /** Where the box's work in progress is replicated (#3172, ws-085), or null when the block declares no policy. */
  replicate: BoxReplicate | null;
  /** How the box ships its staged work to its own site (ws-100), or null when the block declares none. */
  ship: BoxShip | null;
  /** The block's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** The gate a ship Op stops at when the block names none (ws-100). */
export const DEFAULT_SHIP_GATE = "ship";
/** The environment a ship Op records its releases in when the block names none (ws-100). */
export const DEFAULT_SHIP_ENV = "box";

/**
 * How a box ships its staged work (ws-100): the Op in the box member that
 * commits the staged tree and releases it to the box's own site, the gate
 * it stops at, the environment whose release ledger it records each
 * release in, and the paths that are bookkeeping rather than the app (left
 * out of what is pending). Defaults are filled in.
 */
export interface BoxShip {
  op: string;
  gate: string;
  env: string;
  /** Path prefixes from the workspace root, in file order, whose changes never count as waiting to ship. */
  bookkeeping: string[];
  /** The block's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** What a replicate policy pushes (#3172): work branches, kept attempts, work-in-progress snapshots and the ledger branch. */
export const REPLICATE_REF_CLASSES = ["work", "kept", "wip", "ledger"] as const;
export type ReplicateRefClass = (typeof REPLICATE_REF_CLASSES)[number];

/** When chant pushes on its own under a replicate policy (#3172). */
export const REPLICATE_TRIGGERS = ["save", "release"] as const;
export type ReplicateTrigger = (typeof REPLICATE_TRIGGERS)[number];

/** The remote a replicate policy pushes to when it names none. */
export const DEFAULT_REPLICATE_REMOTE = "origin";

/**
 * Where a box's work in progress is replicated (#3172, ws-085), with the
 * defaults filled in: the git remote, which refs, and when chant pushes on
 * its own. `every` is an interval for the host's own scheduler.
 */
export interface BoxReplicate {
  remote: string;
  refs: ReplicateRefClass[];
  on: ReplicateTrigger[];
  every: string | null;
  /** The block's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** What a check command is (#3146). */
export const FACTORY_CHECK_KINDS = ["test", "build", "lint", "plan", "conformance"] as const;
export type FactoryCheckKind = (typeof FACTORY_CHECK_KINDS)[number];

/**
 * A box's factory (#3146, ws-077): what it builds, how a build is checked,
 * which member declares the builder agents and where a finished build is
 * published. Defaults are filled in, so a reader never guesses one.
 */
export interface BoxFactory {
  /** The members the factory builds, in file order; at least one. */
  builds: string[];
  /** The verdict command, run from the workspace root, or null when none is declared. */
  check: { run: string; kind: FactoryCheckKind } | null;
  /** Where a work item's builder writes its check, from the workspace root, or null for the orchestrator's choice. */
  checks: string | null;
  /** The member that declares the builder agents, or null when none is named. */
  builders: string | null;
  /** Which builder agent builds at which tier, and for which member kinds (#3152, ws-094), in file order; empty when none is declared. */
  tiers: FactoryTier[];
  /** Where a finished build is published, or null when the factory doesn't publish past the box. */
  publish: FactoryPublish | null;
  /** The block's JSON Pointer in the file, for messages. */
  pointer: string;
}

/** One builder agent at one tier (#3152): `kinds` null means every kind no other entry of the tier names. */
export interface FactoryTier {
  tier: string;
  /** The agent's name, as the builders member declares it. */
  agent: string;
  /** The member kinds it builds at this tier, or null for the tier's default. */
  kinds: string[] | null;
  /** The declared agent session it writes as, or null for the orchestrator's choice. */
  session: string | null;
}

/** Where a finished build goes (#3146): its branch is pushed and a pull request opened against `repo`'s `base`. */
export interface FactoryPublish {
  forge: "github";
  /** owner/name. */
  repo: string;
  /** The branch the pull request targets, or null for the repository's default branch. */
  base: string | null;
  /** What the published branch's name starts with, before the work item's id. */
  branchPrefix: string;
  /** The repository the branch is pushed to when it isn't `repo` (a fork), as owner/name, or null. */
  head: string | null;
}

/** The branch prefix a publish target uses when it names none: the work lease's own branch. */
export const DEFAULT_PUBLISH_BRANCH_PREFIX = "chant/work/";

/** What a box shows of itself (#3146, #3154). */
export interface BoxListing {
  published: boolean;
  title: string;
  line: string;
  /** The cover image, from the workspace root, or null. */
  cover: string | null;
}

/** A service a box runs under its supervisor (#2880). */
export interface BoxService {
  /** Unique in the box. */
  name: string;
  /** The command the supervisor runs, as written: `${VAR}` references are left for the applying process to expand. */
  cmd: string;
  /** Names of services in the same block that start first. Empty when none. */
  needs: string[];
  /** The port the supervisor routes the sprite's URL to, or null. At most one service of a box sets it. */
  httpPort: number | null;
  /** How long the service must stay up after a create or start, such as `3s` (`sprite-env services create --duration`), or null for the supervisor's default. */
  duration: string | null;
  /** A URL that answers 200 while the service works, or null when the supervisor's state decides. */
  health: string | null;
  /** True: an apply creates it only when named, and an observer skips it while the supervisor has no such service. */
  optional: boolean;
  /** The entry's JSON Pointer in the file, for messages. */
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
  /** The values the entry sets for its kind's fields (#3151), as written, or null when it sets none. Checked against the kind by `resolveMemberFields`. */
  fields: Record<string, unknown> | null;
  /** The links this member states as a consumer, in file order (#2539). */
  links: LinkDeclaration[];
  /** The record kinds this member declares, in file order (#2680). */
  records: RecordKindDeclaration[];
  /** The diagram artifacts this member declares, in file order (#2764). */
  diagrams: DiagramDeclaration[];
  /** The member's box block, or null when it declares none (#2726). */
  box: BoxDeclaration | null;
  upstream: string | null;
  because: string | null;
  /** Whether `chant workspace export` takes the member (#2552, D10). False when the entry does not say. */
  travel: boolean;
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
  /** The workspace's own diagram artifacts, from the top-level `diagrams`, in file order (#2764). A member's are on the member. */
  diagrams: DiagramDeclaration[];
  /** The hosts boxes run on, in file order (#2727). */
  hosts: Host[];
  /** The forward coverage check's policy (#2773), or null when the declaration has no `changes` block. */
  changes: ChangesPolicy | null;
  /** Who may write what (#2548), or null when the declaration has no `writeScope` block. */
  writeScope: WriteScope | null;
  /** The agent sessions, in file order (#2548). */
  agents: AgentDeclaration[];
  /** Who a person-attributed write may name, and which gates need a signed approval (#3163), or null when the declaration has no `identity` block. */
  identity: IdentityPolicy | null;
  /** What the workspace's CI decides about its commits (#3573), or null when the declaration has no `ci` block. */
  ci: CiDeclaration | null;
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
    const links = ((e.links as { member: string; output: string; kind?: string; protocol?: string }[] | undefined) ?? []).map((l, j) => ({
      member: l.member,
      output: l.output,
      kind: l.kind ?? null,
      protocol: l.protocol ?? null,
      pointer: `${pointer}/links/${j}`,
    }));
    const records = recordKindsOf(e.records, e.dir as string, e.name as string, `${pointer}/records`);
    const diagrams = diagramsOf(e.diagrams, e.name as string, `${pointer}/diagrams`);
    const box = boxOf(e.box, `${pointer}/box`);
    return {
      type: "member",
      name: e.name as string,
      dir: e.dir as string,
      kind: e.kind as string,
      roles,
      generated,
      outputs: e.outputs === undefined ? null : [...(e.outputs as string[])],
      fields: e.fields === undefined ? null : structuredClone(e.fields as Record<string, unknown>),
      links,
      records,
      diagrams,
      box,
      upstream: (e.upstream as string | undefined) ?? null,
      because: (e.because as string | undefined) ?? null,
      travel: e.travel === true,
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
    // Its services name each other only within the block, without a cycle (#2880).
    const problem = m.box ? boxServicesProblem(m.name, m.box.services) : null;
    if (problem) throw new WorkspaceReadError("declaration-invalid", problem.message, at(problem.pointer));
  }
  // One factory, building and naming declared members (#3146).
  const factory = factoryProblem(members);
  if (factory) throw new WorkspaceReadError("declaration-invalid", factory.message, at(factory.pointer));
  // One replicate policy (#3172): the checkout is the whole repository's, so one remote takes its work in progress.
  const replicating = members.filter((m) => m.box?.replicate);
  if (replicating.length > 1) {
    throw new WorkspaceReadError(
      "declaration-invalid",
      `members ${replicating[0].name} and ${replicating[1].name} both declare replicate in their box block; a checkout's work in progress goes to one remote, so a workspace has one replicate policy`,
      at(replicating[1].box!.replicate!.pointer),
    );
  }

  // A diagram name is given once across the declaration (#2764): a reader keys diagrams by name.
  const ownDiagrams = diagramsOf(obj.diagrams, null, "/diagrams");
  const byDiagramName = new Map<string, DiagramDeclaration>();
  for (const d of [...ownDiagrams, ...members.flatMap((m) => m.diagrams)]) {
    const first = byDiagramName.get(d.name);
    if (first) {
      throw new WorkspaceReadError("declaration-invalid", `the diagram name ${JSON.stringify(d.name)} is already used by the diagram at ${first.pointer}`, at(`${d.pointer}/name`));
    }
    byDiagramName.set(d.name, d);
  }

  const hosts = hostsOf(obj, members, at);
  const writeScope = writeScopeOf(obj.writeScope, members, at);
  const agents = agentsOf(obj.agents, members, at);
  const tierSession = factoryTierSessionProblem(members, agents);
  if (tierSession) throw new WorkspaceReadError("declaration-invalid", tierSession.message, at(tierSession.pointer));
  const ci = ciOf(obj.ci, at);

  const pins = ((obj.pins as Record<string, string>[] | undefined) ?? []).map((p) => ({
    package: p.package ?? null,
    version: p.version ?? null,
    path: p.path ?? null,
    integrity: p.integrity ?? null,
  }));

  const declaration: Declaration = {
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
    diagrams: ownDiagrams,
    hosts,
    changes: changesOf(obj.changes as Record<string, unknown> | undefined),
    writeScope,
    agents,
    identity: identityOf(obj.identity),
    ci,
    file,
  };
  written.set(declaration, raw);
  return declaration;
}

/** Each parsed declaration's JSON as written, for its x- keys (#3595). */
const written = new WeakMap<Declaration, unknown>();

/**
 * The `x-` keys of the object at `pointer` in the declaration as written
 * (#3595), in file order: what a reader of `status --json` or `ls --json`
 * gets back on the object the declaration holds them on. Empty when the
 * pointer names no object, and for a declaration not read through
 * {@link parseDeclaration}.
 */
export function extensionsAt(declaration: Declaration, pointer: string): Record<string, unknown> {
  const value = valueAt(written.get(declaration), pointer);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([k]) => k.startsWith("x-")));
}

/**
 * The `writeScope` block, already validated, with the rule the schema can't
 * say (#2548): a member it names is a declared member. Its keys are kept in
 * file order: the core classes and any domain class (#3080).
 */
function writeScopeOf(raw: unknown, members: Member[], at: (pointer: string, key?: boolean) => ErrorLocation): WriteScope | null {
  if (raw === undefined) return null;
  const block = raw as Record<PrincipalClass, { members?: "*" | string[]; records?: Record<string, WriteVerb[]>; protected?: (string | { path: string; except?: string[] })[] }>;
  const out: WriteScope = {};
  for (const [cls, entry] of Object.entries(block)) {
    const pointer = `/writeScope/${cls}`;
    const list = entry.members === undefined || entry.members === "*" ? null : [...entry.members];
    for (const [i, name] of (list ?? []).entries()) {
      if (!members.some((m) => m.name === name)) {
        throw new WorkspaceReadError(
          "declaration-invalid",
          `writeScope.${cls} names the member ${JSON.stringify(name)}, which the declaration does not declare; declared members: ${members.map((m) => m.name).join(", ") || "none"}`,
          at(`${pointer}/members/${i}`),
        );
      }
    }
    const records = entry.records === undefined ? null : Object.fromEntries(Object.entries(entry.records).map(([k, v]) => [k, [...v]]));
    const guarded = (entry.protected ?? []).map((p) => (typeof p === "string" ? { path: p, except: [] } : { path: p.path, except: [...(p.except ?? [])] }));
    out[cls] = { members: list, records, protected: guarded, pointer };
  }
  return out;
}

/**
 * The `agents` list, already validated, with the rules the schema can't say
 * (#2548, ws-101): names are unique, every member a session names is a
 * declared member, and a principal is listed by one session at most.
 */
/** The `identity` block, already validated by the schema (#3163). */
function identityOf(raw: unknown): IdentityPolicy | null {
  if (raw === undefined) return null;
  const block = raw as { attribution?: "any" | "identified"; gates?: Record<string, { class?: string }> };
  const gates: Record<string, SignedGate> = {};
  for (const [gate, entry] of Object.entries(block.gates ?? {})) {
    gates[gate] = { gate, class: entry.class ?? null, pointer: `/identity/gates/${gate.replace(/~/g, "~0").replace(/\//g, "~1")}` };
  }
  return { attribution: block.attribution ?? "any", gates };
}

/**
 * The `ci` block, already validated by the schema, with its defaults and the
 * rule the schema can't say (#3573): every phase `require` names is declared.
 */
function ciOf(raw: unknown, at: (pointer: string, key?: boolean) => ErrorLocation): CiDeclaration | null {
  if (raw === undefined) return null;
  const block = raw as { green?: { branch: string; window?: string; phases: Record<string, string[] | { runs: string[]; skipped?: CiSkipped }>; require: string[] } };
  if (block.green === undefined) return { green: null };
  const g = block.green;
  const phases: CiPhase[] = Object.entries(g.phases).map(([name, p]) => ({
    name,
    runs: [...(Array.isArray(p) ? p : p.runs)],
    skipped: Array.isArray(p) ? "fail" : (p.skipped ?? "fail"),
    pointer: `/ci/green/phases/${pointerToken(name)}`,
  }));
  for (const [i, name] of g.require.entries()) {
    if (phases.some((p) => p.name === name)) continue;
    throw new WorkspaceReadError(
      "declaration-invalid",
      `ci.green.require names the phase ${JSON.stringify(name)}, which ci.green.phases does not declare; declared phases: ${phases.map((p) => p.name).join(", ")}`,
      at(`/ci/green/require/${i}`),
    );
  }
  return { green: { branch: g.branch, window: g.window ?? DEFAULT_CI_WINDOW, phases, require: [...g.require], pointer: "/ci/green" } };
}

function agentsOf(raw: unknown, members: Member[], at: (pointer: string, key?: boolean) => ErrorLocation): AgentDeclaration[] {
  const agents = ((raw as { name: string; member?: string; members?: string[]; principals?: string[] }[] | undefined) ?? []).map((a, i) => {
    // The schema requires exactly one of member and members (ws-101).
    const bound = a.members !== undefined ? [...a.members] : [a.member!];
    return {
      name: a.name,
      members: bound,
      member: bound[0],
      principals: [...(a.principals ?? [])],
      pointer: `/agents/${i}`,
      listed: a.members !== undefined,
    };
  });
  const byName = new Map<string, AgentDeclaration>();
  const byPrincipal = new Map<string, AgentDeclaration>();
  for (const { listed, ...a } of agents) {
    const first = byName.get(a.name);
    if (first) throw new WorkspaceReadError("declaration-invalid", `the agent name ${JSON.stringify(a.name)} is already used by the agent at ${first.pointer}`, at(`${a.pointer}/name`));
    byName.set(a.name, a);
    for (const [i, name] of a.members.entries()) {
      if (members.some((m) => m.name === name)) continue;
      throw new WorkspaceReadError(
        "declaration-invalid",
        `agent ${a.name} is bound to ${JSON.stringify(name)}, which is not a declared member; an agent session is bound to members, not an example group`,
        at(listed ? `${a.pointer}/members/${i}` : `${a.pointer}/member`),
      );
    }
    for (const [i, p] of a.principals.entries()) {
      const other = byPrincipal.get(p);
      if (other) throw new WorkspaceReadError("declaration-invalid", `the principal ${JSON.stringify(p)} is already listed by agent ${other.name}`, at(`${a.pointer}/principals/${i}`));
      byPrincipal.set(p, a);
    }
  }
  return [...byName.values()];
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

/**
 * The `diagrams` list at `pointer`, already validated. `source` and `render`
 * are workspace-root-relative as written: unlike a generated file or a
 * record kind, a diagram's files need not sit inside the declaring member's
 * directory, so there is no member-relative form to resolve (#2764).
 */
function diagramsOf(raw: unknown, member: string | null, pointer: string): DiagramDeclaration[] {
  return (
    (raw as
      | { name: string; title: string; source?: string | null; render?: string | null; renderer: { tool: DiagramTool; version: string; args?: string[] }; sourceHash?: string | null }[]
      | undefined) ?? []
  ).map((d, i) => ({
    name: d.name,
    title: d.title,
    source: d.source ?? null,
    render: d.render ?? null,
    renderer: { tool: d.renderer.tool, version: d.renderer.version, args: [...(d.renderer.args ?? [])] },
    sourceHash: d.sourceHash ?? null,
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
    intent?: string;
    services?: { name: string; cmd: string; needs?: string[]; httpPort?: number; duration?: string; health?: string; optional?: boolean }[];
    factory?: {
      builds: string[];
      check?: string | { run: string; kind?: FactoryCheckKind };
      checks?: string;
      builders?: string;
      tiers?: { tier: string; agent: string; kinds?: string[]; session?: string }[];
      publish?: { forge?: "github"; repo: string; base?: string; branchPrefix?: string; head?: string };
    };
    listing?: { published?: boolean; title?: string; line?: string; cover?: string };
    publisher?: string;
    replicate?: { remote?: string; refs?: ReplicateRefClass[]; on?: ReplicateTrigger[]; every?: string };
    ship?: { op: string; gate?: string; env?: string; bookkeeping?: string[] };
  };
  const f = b.factory;
  const l = b.listing;
  const r = b.replicate;
  return {
    capabilities: (b.capabilities ?? []).map((c, i) => ({ name: c.name, broker: c.broker ?? null, scope: [...(c.scope ?? [])], pointer: `${pointer}/capabilities/${i}` })),
    // The schema requires host and slot together, and host for ports, state and cookies.
    isolation:
      b.host === undefined
        ? null
        : { host: b.host, slot: b.slot!, ports: { ...(b.ports ?? {}) }, state: { ...(b.state ?? {}) }, cookies: [...(b.cookies ?? [])] },
    intent: b.intent ?? null,
    services: (b.services ?? []).map((s, i) => ({
      name: s.name,
      cmd: s.cmd,
      needs: [...(s.needs ?? [])],
      httpPort: s.httpPort ?? null,
      duration: s.duration ?? null,
      health: s.health ?? null,
      optional: s.optional ?? false,
      pointer: `${pointer}/services/${i}`,
    })),
    factory:
      f === undefined
        ? null
        : {
            builds: [...f.builds],
            check: f.check === undefined ? null : typeof f.check === "string" ? { run: f.check, kind: "test" } : { run: f.check.run, kind: f.check.kind ?? "test" },
            checks: f.checks ?? null,
            builders: f.builders ?? null,
            tiers: (f.tiers ?? []).map((t) => ({ tier: t.tier, agent: t.agent, kinds: t.kinds === undefined ? null : [...t.kinds], session: t.session ?? null })),
            publish:
              f.publish === undefined
                ? null
                : {
                    forge: f.publish.forge ?? "github",
                    repo: f.publish.repo,
                    base: f.publish.base ?? null,
                    branchPrefix: f.publish.branchPrefix ?? DEFAULT_PUBLISH_BRANCH_PREFIX,
                    head: f.publish.head ?? null,
                  },
            pointer: `${pointer}/factory`,
          },
    listing: l === undefined ? null : { published: l.published ?? true, title: l.title ?? "", line: l.line ?? "", cover: l.cover ?? null },
    publisher: b.publisher ?? null,
    ship:
      b.ship === undefined
        ? null
        : {
            op: b.ship.op,
            gate: b.ship.gate ?? DEFAULT_SHIP_GATE,
            env: b.ship.env ?? DEFAULT_SHIP_ENV,
            bookkeeping: (b.ship.bookkeeping ?? []).map((p) => p.replace(/^\.\//, "").replace(/\/+$/, "")),
            pointer: `${pointer}/ship`,
          },
    replicate:
      r === undefined
        ? null
        : {
            remote: r.remote ?? DEFAULT_REPLICATE_REMOTE,
            // In the order the closed lists give, so a reader compares them without sorting.
            refs: REPLICATE_REF_CLASSES.filter((c) => (r.refs ?? REPLICATE_REF_CLASSES).includes(c)),
            on: REPLICATE_TRIGGERS.filter((t) => (r.on ?? REPLICATE_TRIGGERS).includes(t)),
            every: r.every ?? null,
            pointer: `${pointer}/replicate`,
          },
    pointer,
  };
}

/**
 * The rules the schema can't say about the factories (#3146, ws-077): at most
 * one box block declares one, and the members its builds and builders name
 * are declared members.
 */
function factoryProblem(members: readonly Member[]): { message: string; pointer: string } | null {
  const declaring = members.filter((m) => m.box?.factory);
  if (declaring.length > 1) {
    return {
      message: `members ${declaring[0].name} and ${declaring[1].name} both declare a factory in their box block; a workspace has one factory, so an orchestrator reads one`,
      pointer: declaring[1].box!.factory!.pointer,
    };
  }
  const factory = declaring[0]?.box?.factory;
  if (!factory) return null;
  const known = () => members.map((m) => m.name).join(", ");
  const j = factory.builds.findIndex((name) => !members.some((m) => m.name === name));
  if (j >= 0) {
    return { message: `the factory builds ${JSON.stringify(factory.builds[j])}, which is not a declared member; declared members: ${known()}`, pointer: `${factory.pointer}/builds/${j}` };
  }
  if (factory.builders !== null && !members.some((m) => m.name === factory.builders)) {
    return { message: `the factory's builders names ${JSON.stringify(factory.builders)}, which is not a declared member; declared members: ${known()}`, pointer: `${factory.pointer}/builders` };
  }
  // Builder tiers (#3152): their agents are the builders member's, and one entry answers each tier and kind.
  if (factory.tiers.length > 0 && factory.builders === null) {
    return { message: "the factory declares tiers and no builders; tiers name agents the builders member declares, so name it", pointer: `${factory.pointer}/tiers` };
  }
  const answered = new Map<string, number>();
  for (const [i, t] of factory.tiers.entries()) {
    for (const kind of t.kinds ?? [null]) {
      const key = `${t.tier}\0${kind ?? ""}`;
      const first = answered.get(key);
      if (first !== undefined) {
        const which = kind === null ? "with no kinds" : `for kind ${kind}`;
        return { message: `tiers/${first} and tiers/${i} both name a builder at tier ${t.tier} ${which}; a tier has one builder per kind, so one entry answers it`, pointer: `${factory.pointer}/tiers/${i}` };
      }
      answered.set(key, i);
    }
  }
  return null;
}

/** The rule the schema can't say about the factory's tiers once the sessions are read (#3152): a session is a declared agent session. */
function factoryTierSessionProblem(members: readonly Member[], agents: readonly AgentDeclaration[]): { message: string; pointer: string } | null {
  const factory = members.find((m) => m.box?.factory)?.box?.factory;
  if (!factory) return null;
  for (const [i, t] of factory.tiers.entries()) {
    if (t.session !== null && !agents.some((a) => a.name === t.session)) {
      const known = agents.map((a) => a.name).join(", ") || "none";
      return { message: `tiers/${i} names the session ${JSON.stringify(t.session)}, which is not a declared agent session; declared sessions: ${known}`, pointer: `${factory.pointer}/tiers/${i}/session` };
    }
  }
  return null;
}

/**
 * The rules the schema can't say about a box's services (#2880), as a
 * message and the pointer to show, or null when they hold: each name is
 * given once, every `needs` names a service of the same block, the `needs`
 * form no cycle, and at most one service sets `httpPort`. The fly lexicon
 * checks a list it is handed inline with the same rules.
 */
export function boxServicesProblem(member: string, services: readonly BoxService[]): { message: string; pointer: string } | null {
  const byName = new Map<string, BoxService>();
  for (const s of services) {
    const first = byName.get(s.name);
    if (first) return { message: `member ${member}'s box declares the service ${s.name} twice; the first is at ${first.pointer}`, pointer: `${s.pointer}/name` };
    byName.set(s.name, s);
  }
  let routed: BoxService | undefined;
  for (const s of services) {
    if (s.httpPort === null) continue;
    if (routed) {
      return {
        message: `member ${member}'s box gives both ${routed.name} (port ${routed.httpPort}) and ${s.name} (port ${s.httpPort}) an httpPort, and the supervisor routes the sprite's URL to one service`,
        pointer: `${s.pointer}/httpPort`,
      };
    }
    routed = s;
  }
  for (const s of services) {
    const j = s.needs.findIndex((n) => !byName.has(n));
    if (j >= 0) {
      const known = services.map((x) => x.name).join(", ");
      return { message: `member ${member}'s box service ${s.name} needs ${JSON.stringify(s.needs[j])}, which the block does not declare; declared services: ${known}`, pointer: `${s.pointer}/needs/${j}` };
    }
  }
  const cycle = serviceCycle(services);
  if (cycle) {
    const s = byName.get(cycle[0])!;
    return { message: `member ${member}'s box services need each other in a cycle: ${cycle.join(" -> ")}`, pointer: `${s.pointer}/needs` };
  }
  return null;
}

/** The first cycle the services' `needs` form, as names ending where it starts, or null. */
function serviceCycle(services: readonly { name: string; needs: readonly string[] }[]): string[] | null {
  const byName = new Map(services.map((s) => [s.name, s]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, trail: string[]): string[] | null => {
    const st = state.get(name);
    if (st === "done") return null;
    if (st === "visiting") return [...trail.slice(trail.indexOf(name)), name];
    state.set(name, "visiting");
    for (const dep of byName.get(name)?.needs ?? []) {
      const found = visit(dep, [...trail, name]);
      if (found) return found;
    }
    state.set(name, "done");
    return null;
  };
  for (const s of services) {
    const found = visit(s.name, []);
    if (found) return found;
  }
  return null;
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

/**
 * Every diagram artifact the declaration names (#2764), in the order readers
 * use them: the workspace's own first, then each member's, members in file
 * order and each list in its own order.
 */
export function declaredDiagrams(declaration: Declaration): DiagramDeclaration[] {
  return [...declaration.diagrams, ...declaration.members.flatMap((m) => m.diagrams)];
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

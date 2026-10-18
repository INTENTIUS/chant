/**
 * `chant workspace status <env> [--compare-to <env>] [--json]` (#2544): a
 * read-only view of each member's latest release in an environment, and
 * optionally a second environment beside it (#2524 D19, ws-043).
 *
 * Releases stay per member: a release is an artifact digest plus a git SHA in
 * the member's own ledger on the `chant/lifecycle` branch. Member ledgers
 * live under `_members/<member>/<env>/releases.jsonl` (#2524 D7, #2538), and
 * the root member `.` keeps the flat `<env>/releases.jsonl`. A member whose
 * `_members/<member>/` directory doesn't exist yet is read from the flat
 * ledger, which is where a chant from before #2538, or below the floor,
 * still writes it. Several members read that way share one ledger, and the
 * output says so.
 *
 * The command reads the local `chant/lifecycle` branch and never fetches it.
 * The output names the branch tip it read, so a stale copy is visible.
 *
 * A member whose ledger can't be read is still listed, with a reason code,
 * and the command still exits 0 (#2524 D15, ws-020), as `ls` does. Only a
 * declaration that can't be read, or an environment name that can't be one,
 * exits 1. The `--json` output is part of the read contract and is described
 * by `status.schema.json` beside this file.
 *
 * The JSON also lists each member's gates, read from its gate ledger on the
 * same branch (#2674, `status-gates.ts`): the state of each, the approvals
 * that count, and the `chant approve` line that answers it. The text view
 * doesn't show them. So does each member's box block (#2726): the
 * capabilities it reaches through a broker, with the broker and the scope a
 * broker enforces, and, when the block names a host, the box's ports, state
 * paths and cookie names resolved from its identity (#2727,
 * `box-isolation.ts`), so a runtime reads them instead of choosing its own.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { GATES_DIR } from "../lifecycle/gate-ledger";
import { readPathSha } from "../lifecycle/git";
import { latestPerComponent, readReleaseLedger, type ReleaseRecord } from "../lifecycle/release-ledger";
import { describeRevocation, revokedCommitsAt, revokedReleaseLookup, type ReleaseRevocation, type RevokedRelease } from "../lifecycle/release-revocation";
import { readReleasePlan, type ReleasePlan } from "../lifecycle/plan-ledger";
import { readDeployOutcomes, type DeployOutcome } from "../lifecycle/deploy-outcome";
import { mixedEnvironment, releaseRollbackLine, rollbackTarget, type MixedEnvironment, type ReleaseCheck } from "../lifecycle/mixed-environment";
import { listWorkLeases, type WorkLeaseState } from "../lifecycle/work-lease";
import { readCheckoutHead, worktreeChanges, type CheckoutHead } from "./records-checkout";
import { policyView, replicationState, type ReplicationState } from "./wip";
import { findWorkspaceRoot } from "../project-root";
import { resolveBoxes, type ResolvedIsolation } from "./box-isolation";
import { resolveBoxIntents, unresolvedIntent, type BoxIntent } from "./box-intent";
import { loadKindRegistry, resolveMemberFields, type MemberFields } from "./kinds";
import { factoryView, listingView, plantability, treeBytes, type FactoryView, type ListingView, type Plantable } from "./box-factory";
import { declaredRecordKinds, extensionsAt, readDeclaration, readerVersion, WorkspaceReadError, type Declaration, type ErrorLocation, type Member } from "./declaration";
import type { ReasonCode } from "./reason-codes";
import type { FlagDecision, FlagValue } from "./flags";
import type { OverlapChangeSetRef, OverlapReport } from "./overlap";
import type { WorkLink } from "./work";
import { readMemberPromotionOrder, type PromotionStep } from "./promotion-order";
import { gateAdmissionFrom, releaseRuleFrom } from "./identity";
import { checkReleaseSignature, type GateAdmissionRule, type ReleaseSignatureCheck } from "./identity-gate-rule";
import { scopeSource } from "./write-scope";
import { GATE_REASON_CODES, readMemberGates, type GateLedgerReader, type StatusGate, type StatusGateLedger } from "./status-gates";
import { STEWARD_REASON_CODES, readMemberStewards, type StatusSteward, type StewardReasonCode } from "./status-stewards";
import { gitTop, workingTree } from "./tree";
import { handToRootChant } from "./which-chant";

/** The version of the `status` output this chant writes. */
export const STATUS_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the `--json` output, shipped beside this file. */
export const STATUS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/status/v1/status.schema.json";

/** The branch every ledger lives on. */
export const LIFECYCLE_REF = "chant/lifecycle";

/** The directory on {@link LIFECYCLE_REF} that holds member ledgers (#2538). */
export const MEMBERS_DIR = "_members";

const USAGE = "chant workspace status <env> [dir] [--compare-to <env>] [--json]";

/**
 * Why a member's ledger for one environment can't be fully read. Closed: a
 * new code is a contract change.
 */
export const STATUS_REASON_CODES = [
  /** Reading the ledger failed, so nothing from it is listed. */
  "ledger-unreadable",
  /** Some lines of the ledger aren't release records; the rest are listed. */
  "ledger-malformed",
] as const satisfies readonly ReasonCode[];
export type StatusReasonCode = (typeof STATUS_REASON_CODES)[number];

/** Why a member's gates can't be listed (#2674). Closed, like {@link STATUS_REASON_CODES}. */
export const STATUS_GATE_REASON_CODES = GATE_REASON_CODES;

/** Why a member's stewards can't be fully listed (#2731). Closed, like {@link STATUS_REASON_CODES}. */
export const STATUS_STEWARD_REASON_CODES = STEWARD_REASON_CODES;

/**
 * Why the status couldn't be read at all. The declaration's own codes, except
 * the two that only `--at` returns, and one for the environment name.
 */
export const STATUS_ERROR_CODES = [
  "declaration-missing",
  "declaration-ambiguous",
  "declaration-unparseable",
  "declaration-invalid",
  "placement-invalid",
  "reader-too-old",
  "root-chant-required",
  /** The workspace isn't in a git repository, so it has no ledger branch. */
  "not-a-git-repository",
  /** An environment name that can't name a ledger directory. */
  "environment-invalid",
] as const satisfies readonly ReasonCode[];
export type StatusErrorCode = (typeof STATUS_ERROR_CODES)[number];

/** Environment names a ledger directory can have: no `/`, no leading `_` or `.` (those are chant's own directories). */
export const ENV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface StatusRelease {
  component: string;
  digest: string;
  gitSha: string;
  /** The input-side digest, when `digest` is a rendered one (a pinned helm deploy). Compare joins on it. */
  inputDigest: string | null;
  runId: string;
  timestamp: string;
  actor: string;
  /** Who approved the change at its gate (#1035), when it had one. Null for an ungated release. */
  approver: string | null;
  /** The gate resolution that admitted the release (#4020): the gate and when it was resolved. Null for an ungated release and for one recorded before chant 0.124.28. */
  admission: { op: string; gate: string; resolvedAt: string } | null;
  /** The release this deploy was made from (#4043): the `releaseDigest` of `_releases/<releaseDigest>.json`. Null for a deploy that named no release and for one recorded before chant 0.124.29. */
  releaseDigest: string | null;
  /** The label that release was cut with (#4043), or null when it has none, when no release is named, or when the cut can't be read. Chant 0.124.29 and newer write it. */
  releaseLabel: string | null;
  /** Read flags, such as `legacy-digest` (#2514). */
  flags: string[];
  /**
   * The release plan `digest` names, read from `_plans/<digest>.json` on
   * chant/lifecycle (ws-055, #2733) — the work items and evidence this
   * release shipped, without the runner's own files. Null when this
   * checkout has no plan stored under that digest: an ordinary component
   * release (most releases carry no plan at all), or a plan this checkout
   * hasn't fetched yet.
   */
  plan: ReleasePlan | null;
  /**
   * Set when the deploy names a release (`releaseDigest` on its record) that
   * was cut from a revoked commit (#4033, ws-105): the revoked tag on that
   * commit, the release and its label, and the line that rolls the component
   * back. Absent otherwise, and from chant older than 0.124.29.
   */
  revoked?: StatusRevokedRelease;
}

/** A release an environment runs that was cut from a revoked commit (#4033). */
export interface StatusRevokedRelease extends RevokedRelease {
  /**
   * The command that rolls the environment back, run in the member's
   * directory: `chant components rollback <env> --release <label|digest>`
   * naming the newest release the environment ran before this one that is
   * still kept and not revoked (#4035), or `chant components rollback <env>
   * --component <component>` when there is none.
   */
  rollback: string;
}

export interface StatusLedger {
  /** `members` for `_members/<member>/<env>/releases.jsonl`, `flat` for `<env>/releases.jsonl`. */
  layout: "members" | "flat";
  /** The ledger's path on the branch. */
  path: string;
  /** True when more than one member in this output reads this same flat ledger. */
  shared: boolean;
}

export interface StatusEnvironment {
  env: string;
  ledger: StatusLedger;
  /** The latest release of each component in the ledger, sorted by component. */
  releases: StatusRelease[];
  reason: { code: StatusReasonCode; message: string } | null;
  /**
   * Set when the environment runs a mix (#4035): a promote, rollback or
   * redeploy left a component failed or gated and nothing has been recorded
   * for it since, or its components' latest records name more than one
   * release. Each component with what it runs, and the lines that settle it.
   * Absent otherwise, and from chant older than 0.124.29.
   */
  mixed?: MixedEnvironment;
}

export type CompareState = "same" | "differs" | "only-env" | "only-compare";

export interface StatusCompare {
  /** True when any component is not `same`. */
  differs: boolean;
  components: { component: string; state: CompareState; digest: string | null; compareDigest: string | null }[];
}

export interface StatusMember {
  name: string;
  dir: string;
  kind: string;
  /**
   * The fields the member's kind declares (#3151), each set from the entry or
   * its default (null when it has none), or null when the kind declares no
   * fields or no pinned package supplies it. A value of the wrong type reads
   * as the default; `chant workspace check` reports it (WSP005).
   */
  fields: MemberFields["fields"];
  /** The environment asked for first, then the one compared to, if any. */
  environments: StatusEnvironment[];
  /** Null without `--compare-to`. */
  compare: StatusCompare | null;
  /** True when no environment's release ledger has a reason. Gate reasons don't change it. */
  readable: boolean;
  /** Where the member's gates were read from, and why none are listed when none can be (#2674). */
  gateLedger: StatusGateLedger;
  /** Each gate in the member's gate ledger, one per environment asked for, sorted by component then gate. */
  gates: StatusGate[];
  /** The member's box block as declared, or null when it declares none (#2726). A broker reads the scopes it enforces here. */
  box: StatusBox | null;
  /** The stewards the member declares (#2731), with their form in `env`, their Ops and each Op's last run. Sorted by name. */
  stewards: StatusSteward[];
  /** Why a steward or a last run may be missing from `stewards`. */
  stewardReasons: { code: StewardReasonCode; message: string }[];
  /**
   * The member's promotion order (#4030): the literal entries of the
   * `environments` array in its chant.config.ts, in order, each with whether
   * it is marked canary. A release moves from each step to the next. `[]`
   * when the config declares no environments, null when it could not be read.
   * Added in contract 1 by chant 0.124.28.
   */
  promotionOrder: PromotionStep[] | null;
  /**
   * The member's release cuts (#4026, ws-104), oldest first, each with
   * whether its signature verifies for its actor against the signers at
   * base and, when the declaration names a `release` gate with a class,
   * whether the actor is in it (#4031). `[]` when none is cut, null when the
   * cuts could not be read. Added in contract 1 by chant 0.124.28.
   */
  releaseCuts: StatusReleaseCut[] | null;
  /**
   * The member's feature flags (#4024): each record of a declared flag kind
   * that names this member, with its value per environment and the work item
   * it hides. Sorted by id. `[]` when none names it, null when the flag
   * records could not be read. Called `featureFlags` because a release
   * record's `flags` already means something else. Added in contract 1 by
   * chant 0.124.29.
   */
  featureFlags: StatusFeatureFlag[] | null;
}

/** One feature flag of a member (#4024), as `status --json` lists it. */
export interface StatusFeatureFlag {
  /** The flag's name, its record's id. */
  id: string;
  /** The build parameter of the member the flag sets. */
  param: string;
  owner: string;
  /** The value per environment, as the record writes it. An environment it leaves out builds with the parameter's default. */
  values: Record<string, FlagValue>;
  /** The work item the flag hides, with its state (null when no record has it), or null when the record names none. */
  work: WorkLink | null;
  /** Each decision the work item implements, with its state and whether it is confirmed. */
  implements: FlagDecision[];
  /** True when every decision the work item implements is confirmed: the flag is due for removal (check WSP118). */
  stale: boolean;
  /** The kind file and the record file, from the workspace root. */
  kind: string;
  path: string;
}

/** One cut of a member's release (#4031), as `status --json` lists it. */
export interface StatusReleaseCut {
  releaseDigest: string;
  label: string | null;
  /** The release's commit, or null when its release file can't be read. */
  commit: string | null;
  actor: string;
  timestamp: string;
  signature: string | null;
  signatureCheck: ReleaseSignatureCheck;
}

/** The most paths `ship.pending.paths` lists; `files` still counts them all. */
export const SHIP_PENDING_PATHS_MAX = 200;

/**
 * A box's ship (ws-100): the Op, gate and environment it declares, the
 * release its site serves (the latest in that environment's release ledger
 * under the box member), and what is waiting to ship.
 */
export interface StatusBoxShip {
  op: string;
  gate: string;
  env: string;
  bookkeeping: string[];
  /** The latest release in `env`'s ledger: the commit the box's site serves. Null when nothing has shipped, or the ledger can't be read. */
  serving: { commit: string; digest: string; component: string; at: string; actor: string | null } | null;
  /**
   * The files that differ between `serving.commit` and the working tree
   * (tracked changes, committed or not, and untracked files git does not
   * ignore), bookkeeping left out; `paths` sorted, at most
   * SHIP_PENDING_PATHS_MAX of them. Null when nothing has shipped or the
   * serving commit isn't in this checkout.
   */
  pending: { files: number; paths: string[] } | null;
}

/** A box's brokered capabilities, from the declaration (#2726). */
export interface StatusBox {
  capabilities: { name: string; broker: string | null; scope: string[] }[];
  /** The box's ports, state paths and cookie names, resolved from its identity, or null when the block declares no host (#2727). */
  isolation: ResolvedIsolation | null;
  /**
   * The decision record the block names as the box's intent (#2850): its id,
   * state, question, choice, answer (the chosen option's label), decided_by
   * and decided_on. Null when the block names none; every field but the id
   * is null when no decision record has the id (WSP126).
   */
  intent: BoxIntent | null;
  /** The services the block declares (#2880), in file order, so a reader has them before any converge tick. Empty when it declares none. */
  services: StatusBoxService[];
  /** What the box builds and how, with defaults filled in (#3146, ws-077), or null when the block declares no factory. */
  factory: FactoryView | null;
  /** What the box shows of itself on a home site, with the cover's sha256 (#3146), or null when the block declares no listing. */
  listing: ListingView | null;
  /** The command that publishes the box's work, as declared (#3165, ws-088), or null when the block names none. */
  publisher: string | null;
  /** How the box ships its staged work, what its site serves and what is waiting (ws-100), or null when the block declares no ship. */
  ship: StatusBoxShip | null;
  /** Where the box's work in progress is replicated, with defaults filled in (#3172, ws-085), or null when the block declares no policy. */
  replicate: { remote: string; refs: string[]; on: string[]; every: string | null } | null;
}

/** A declared box service as `status --json` prints it (#2880): every field present, null or false when not declared. */
export interface StatusBoxService {
  name: string;
  cmd: string;
  needs: string[];
  httpPort: number | null;
  duration: string | null;
  health: string | null;
  optional: boolean;
}

/**
 * One work lease (#2732): a work item's lease ref in the ledger of the member
 * that owns its work kind, read from the local refs without fetching.
 */
export interface StatusLease extends Omit<WorkLeaseState, "ref"> {
  /** The member whose ledger holds the lease, or null for the flat ledger (the root member, or a kind no member owns). */
  member: string | null;
  ref: string;
}

/**
 * One work item's acceptance criteria, counted (#2772): each current record
 * of a declared work kind with acceptance criteria that lists some.
 */
export interface StatusAcceptance {
  /** The member that declares the work kind, or null for the workspace's own. */
  member: string | null;
  /** The work kind file, from the workspace root. */
  kind: string;
  item: string;
  state: string | null;
  met: number;
  total: number;
}

export type StatusDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      env: string;
      compareTo: string | null;
      lifecycle: { ref: string; commit: string | null };
      /** The branch, head and base of the checkout read (#3160). `records --uncommitted` lists the records it holds uncommitted. */
      checkout: CheckoutHead;
      workspace: { name: string; root: string; file: string };
      /** Whether a host can plant the workspace as one box (#3146): exactly one member's box block declares services. */
      plantable: Plantable;
      members: StatusMember[];
      /** Every work lease in the workspace's ledgers, active and expired, by member then item (#2732). A released lease has no ref and is not listed. */
      leases: StatusLease[];
      /** Each work item's acceptance criteria, met of total, by declared kind then item (#2772). Empty when no declared work kind has criteria. */
      acceptance: StatusAcceptance[];
      /** How far each ref the box's replicate policy names is from its remote (#3172), read locally; null when no box declares one. */
      replication: ReplicationState | null;
      /**
       * Overlap between in-flight work items (#4025): pairs of items whose
       * linked commits touch the same files, or that both reach one entry of
       * a change set a pending or approved gate binds. A report, never a
       * lock. Null when no work kind is declared or the work records or
       * history can't be read. Added in contract 1 by chant 0.124.29.
       */
      overlap: OverlapReport | null;
      summary: { members: number; released: number; unreadable: number; differing: number | null };
    }
  | {
      $schema: string;
      contract: number;
      chant: string;
      error: { code: StatusErrorCode; message: string; location: ErrorLocation | null };
    };

type LedgerReader = (path: string, cwd: string) => Promise<{ records: ReleaseRecord[]; malformed: number }>;

export interface StatusQuery {
  /** Where the walk up to the declaration starts. */
  cwd: string;
  env: string;
  compareTo?: string;
  /** Reads one ledger; the lifecycle reader unless a test swaps it. */
  readLedger?: LedgerReader;
  /** Reads the deploy outcomes beside one ledger (#4035), given the ledger's path; the lifecycle reader unless a test swaps it. */
  readOutcomes?: OutcomeReader;
  /** Reads one member's gate ledger directory; git unless a test swaps it. */
  readGates?: GateLedgerReader;
  /** The instant a gate's expiry is measured against; now by default. */
  now?: string;
  /** Reads one member's stewards; the declaration and ledger reader unless a test swaps it. */
  readStewards?: typeof readMemberStewards;
  /** Reads one member's promotion order from its directory; its chant.config.ts unless a test swaps it. */
  readPromotionOrder?: (dir: string) => Promise<PromotionStep[] | null>;
}

/** A factory view with the declaration's x- keys on it and on its check, publish and tiers (#3595). */
function factoryWithX(view: FactoryView | null, pointer: string, x: (pointer: string) => Record<string, unknown>): FactoryView | null {
  if (view === null) return null;
  return {
    ...view,
    check: view.check === null ? null : { ...view.check, ...x(`${pointer}/check`) },
    tiers: view.tiers.map((t, i) => ({ ...t, ...x(`${pointer}/tiers/${i}`) })),
    publish: view.publish === null ? null : { ...view.publish, ...x(`${pointer}/publish`) },
    ...x(pointer),
  };
}

class StatusError extends Error {
  constructor(
    readonly code: StatusErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function checkEnv(env: string, flag: string): void {
  if (!ENV_PATTERN.test(env) || env.includes("..")) {
    throw new StatusError(
      "environment-invalid",
      `${flag}${JSON.stringify(env)} can't be an environment: use letters, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }
}

function lifecycleTip(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${LIFECYCLE_REF}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Whether the member writes under `_members/<member>/` (#2538). The root member never does. */
async function hasMemberLedger(member: Member, cwd: string): Promise<boolean> {
  return member.dir !== "." && (await readPathSha(MEMBERS_DIR, member.name, { cwd })) !== null;
}

/** Which ledger a member's releases for `env` are in (#2524 D7). */
async function ledgerFor(member: Member, env: string, cwd: string): Promise<Omit<StatusLedger, "shared">> {
  if (await hasMemberLedger(member, cwd)) {
    return { layout: "members", path: `${MEMBERS_DIR}/${member.name}/${env}/releases.jsonl` };
  }
  return { layout: "flat", path: `${env}/releases.jsonl` };
}

/** A box's ship as status prints it (ws-100). Never throws: what can't be read is null. */
async function shipView(member: Member, cwd: string, read: LedgerReader): Promise<StatusBoxShip | null> {
  const ship = member.box?.ship;
  if (!ship) return null;
  const view: StatusBoxShip = { op: ship.op, gate: ship.gate, env: ship.env, bookkeeping: [...ship.bookkeeping], serving: null, pending: null };
  let records: ReleaseRecord[] = [];
  try {
    records = (await read((await ledgerFor(member, ship.env, cwd)).path, cwd)).records;
  } catch {
    return view;
  }
  const last = records[records.length - 1];
  if (!last) return view;
  view.serving = { commit: last.gitSha, digest: last.digest, component: last.component, at: last.timestamp, actor: last.actor ?? null };
  const top = gitTop(cwd);
  if (!top) return view;
  const lines = (args: string[]): string[] | null => {
    try {
      return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    } catch {
      return null;
    }
  };
  // The commit must be here: a release from a commit this checkout never had says nothing about it.
  if (lines(["cat-file", "-e", `${last.gitSha}^{commit}`]) === null) return view;
  // A diff against the working tree writes the index; run it on a copy.
  const changed = worktreeChanges(top, last.gitSha, ".") ?? null;
  const untracked = lines(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (changed === null || untracked === null) return view;
  const bookkeeping = (path: string) => ship.bookkeeping.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const paths = [...new Set([...changed, ...untracked])].filter((path) => !bookkeeping(path)).sort();
  view.pending = { files: paths.length, paths: paths.slice(0, SHIP_PENDING_PATHS_MAX) };
  return view;
}

const defaultReader: LedgerReader = (path, cwd) => readReleaseLedger(path.slice(0, -"/releases.jsonl".length), { cwd });

/** Reads the deploy outcomes (#4035) in the directory of the ledger at `path`. */
type OutcomeReader = (path: string, cwd: string) => Promise<DeployOutcome[]>;

const defaultOutcomeReader: OutcomeReader = (path, cwd) => readDeployOutcomes(path.slice(0, -"/releases.jsonl".length), { cwd }).catch(() => []);

/** A release digest's revocation, for one member, or null (#4033). */
type RevokedOf = (releaseDigest: string) => Promise<RevokedRelease | null>;

/** The per-component rollback line, for a component an environment runs from a revoked release when no earlier release can be named (#4033). */
export function rollbackLine(env: string, component: string): string {
  return `chant components rollback ${env} --component ${component}`;
}

async function readEnvironment(
  member: Member,
  env: string,
  cwd: string,
  read: LedgerReader,
  revokedOf: RevokedOf = async () => null,
  readOutcomes: OutcomeReader = defaultOutcomeReader,
): Promise<StatusEnvironment> {
  const ledger = await ledgerFor(member, env, cwd);
  let records: ReleaseRecord[];
  let malformed: number;
  try {
    ({ records, malformed } = await read(ledger.path, cwd));
  } catch (err) {
    return {
      env,
      ledger: { ...ledger, shared: false },
      releases: [],
      reason: { code: "ledger-unreadable", message: `${ledger.path}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` },
    };
  }
  // A member's plans live beside its other lifecycle stores (#2524 D7,
  // #2538): _members/<member>/_plans/ for the "members" layout, the flat
  // top-level _plans/ for "flat" — the same split ledger.path already
  // resolved above for releases.jsonl, mirrored here since readReleasePlan
  // reads through one process for every member without changing cwd per
  // member (see plan-ledger.ts's readReleasePlan doc).
  const planPrefix = ledger.layout === "members" ? `${MEMBERS_DIR}/${member.name}/` : "";
  const latest = [...latestPerComponent(records).values()].sort((a, b) => (a.component < b.component ? -1 : a.component > b.component ? 1 : 0));
  // #4043: a release item names the label of the release it was deployed from.
  const memberDir = resolve(cwd, member.dir);
  let labels = new Map<string, string>();
  let labelsRead = false;
  const readLabels = async (): Promise<Map<string, string>> => {
    if (labelsRead) return labels;
    labelsRead = true;
    try {
      const { readCuts, labelsByDigest } = await import("../lifecycle/release-store");
      labels = labelsByDigest((await readCuts({ cwd: memberDir })).cuts);
    } catch {
      // The label is a convenience; the digest is the join key.
    }
    return labels;
  };
  if (latest.some((r) => r.releaseDigest !== undefined)) await readLabels();
  // #4035: whether a release a rollback could go back to is kept and not revoked.
  const checks = new Map<string, Promise<ReleaseCheck>>();
  const check = (digest: string): Promise<ReleaseCheck> => {
    let found = checks.get(digest);
    if (!found) {
      found = (async () => {
        const { readRelease } = await import("../lifecycle/release-store");
        const kept = (await readRelease(digest, { cwd: memberDir }).catch(() => null)) !== null;
        return { kept, revoked: kept && (await revokedOf(digest)) !== null };
      })();
      checks.set(digest, found);
    }
    return found;
  };
  const back = { records, check, label: async (digest: string) => (await readLabels()).get(digest) };
  const releases: StatusRelease[] = await Promise.all(
    latest.map(async (r) => ({
      component: r.component,
      digest: r.digest,
      gitSha: r.gitSha,
      inputDigest: r.inputDigest ?? null,
      runId: r.runId,
      timestamp: r.timestamp,
      actor: r.actor,
      approver: r.approver ?? null,
      admission: r.admission ? { op: r.admission.op, gate: r.admission.gate, resolvedAt: r.admission.resolvedAt } : null,
      releaseDigest: r.releaseDigest ?? null,
      releaseLabel: (r.releaseDigest !== undefined ? labels.get(r.releaseDigest) : undefined) ?? null,
      flags: [...(r.flags ?? [])],
      plan: await readReleasePlan(r.digest, { cwd, prefix: planPrefix }),
      ...(await revokedItem(r, env, revokedOf, back)),
    })),
  );
  const mixed = await mixedEnvironment({ env, records, outcomes: await readOutcomes(ledger.path, cwd), label: back.label, check });
  return {
    env,
    ledger: { ...ledger, shared: false },
    releases,
    reason:
      malformed > 0
        ? { code: "ledger-malformed", message: `${ledger.path}: ${malformed} line${malformed === 1 ? " is" : "s are"} not a release record and ${malformed === 1 ? "was" : "were"} skipped` }
        : null,
    ...(mixed ? { mixed } : {}),
  };
}

/**
 * `{ revoked }` when the record names a release cut from a revoked commit
 * (#4033), else nothing. Its rollback line names the newest release the
 * environment ran before this one that is kept and not revoked (#4035).
 */
async function revokedItem(
  r: ReleaseRecord,
  env: string,
  revokedOf: RevokedOf,
  back: { records: readonly ReleaseRecord[]; check: (digest: string) => Promise<ReleaseCheck>; label: (digest: string) => Promise<string | undefined> },
): Promise<{ revoked?: StatusRevokedRelease }> {
  if (r.releaseDigest === undefined) return {};
  const revoked = await revokedOf(r.releaseDigest);
  if (!revoked) return {};
  const target = await rollbackTarget({ records: back.records, exclude: new Set([r.releaseDigest]), before: r.timestamp, check: back.check });
  const rollback = target ? releaseRollbackLine(env, target, await back.label(target)) : rollbackLine(env, r.component);
  return { revoked: { ...revoked, rollback } };
}

/**
 * A release gate whose release was cut from a revoked commit is superseded
 * (#4033): `chant approve` refuses it and the promote refuses the release, so
 * neither an approval nor a pending fact will pass it. An expired gate stays
 * expired. The gate carries the revocation.
 */
async function supersedeRevokedGates(gates: StatusGate[], revokedOf: RevokedOf): Promise<StatusGate[]> {
  return Promise.all(
    gates.map(async (g) => {
      if (g.releaseDigest === undefined) return g;
      const revoked = await revokedOf(g.releaseDigest);
      if (!revoked) return g;
      const { releaseDigest: _d, label: _l, ...revocation } = revoked;
      return { ...g, state: g.state === "expired" ? g.state : "superseded", revoked: revocation };
    }),
  );
}

/** The digest two environments are compared on: the input side when there is one. */
const compareKey = (r: StatusRelease): string => r.inputDigest ?? r.digest;

export function compareEnvironments(a: StatusEnvironment, b: StatusEnvironment): StatusCompare {
  const left = new Map(a.releases.map((r) => [r.component, r]));
  const right = new Map(b.releases.map((r) => [r.component, r]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const components = names.map((component) => {
    const l = left.get(component);
    const r = right.get(component);
    const state: CompareState = !r ? "only-env" : !l ? "only-compare" : compareKey(l) === compareKey(r) ? "same" : "differs";
    return { component, state, digest: l?.digest ?? null, compareDigest: r?.digest ?? null };
  });
  return { differs: components.some((c) => c.state !== "same"), components };
}

/** Find the workspace, read every member's ledger and build the document `--json` prints. */
export async function workspaceStatus(query: StatusQuery): Promise<StatusDocument> {
  const chant = readerVersion();
  const head = { $schema: STATUS_OUTPUT_SCHEMA_ID, contract: STATUS_CONTRACT_VERSION, chant };
  try {
    checkEnv(query.env, "");
    if (query.compareTo !== undefined) checkEnv(query.compareTo, "--compare-to ");
    const found = findWorkspaceRoot(query.cwd);
    if (!found) {
      throw new WorkspaceReadError(
        "declaration-missing",
        "no chant.workspace.json or .jsonc between this directory and the git root; chant workspace init proposes one",
      );
    }
    const declaration = readDeclaration(workingTree(found.dir), "", { rootChant: true });
    const top = gitTop(found.dir);
    if (!top) throw new StatusError("not-a-git-repository", `${found.dir} is not in a git repository, so it has no ${LIFECYCLE_REF} branch to read`);
    const rootDir = relative(top, realpathSync(found.dir)).split("\\").join("/");
    const read = query.readLedger ?? defaultReader;
    const envs = query.compareTo !== undefined && query.compareTo !== query.env ? [query.env, query.compareTo] : [query.env];

    const commit = lifecycleTip(found.dir);
    const now = query.now ?? new Date().toISOString();

    const isolation = new Map(resolveBoxes(declaration).map((b) => [b.member.name, b.isolation]));
    const intents = new Map((await resolveBoxIntents(declaration, found.dir)).map((i) => [i.member, i.record?.intent ?? unresolvedIntent(i.id)]));
    const coverBytes = treeBytes(workingTree(found.dir));
    // The kinds the pins supply (#3151), for each member's fields. A pin that can't be read is check's to report (WSP002).
    const kinds = loadKindRegistry(declaration.pins, found.dir).registry;
    // #3163: the declaration's identity.gates at base, read once for every member's gates.
    const ruleSource = scopeSource(found.dir);
    const rules = (gate: string) => gateAdmissionFrom(ruleSource, gate);
    const releaseRule = releaseRuleFrom(ruleSource).rule;
    // #4033 (ws-105): revoked commits, read from local tags once and only when a release is met.
    // Tags that can't be judged read as none revoked; workspace check reports the declaration.
    let revokedCommits: Promise<ReadonlyMap<string, ReleaseRevocation>> | undefined;
    const revoked = () => (revokedCommits ??= revokedCommitsAt(top, ruleSource.declaration?.ci?.green ?? null).catch(() => new Map()));
    // #4024: the flag records, read once for every member. Unreadable records list as null.
    const flags = await readStatusFlags(declaration, found.dir);
    const members: StatusMember[] = [];
    for (const m of declaration.members) {
      const revokedOf = revokedReleaseLookup(resolve(found.dir, m.dir), revoked);
      const environments: StatusEnvironment[] = [];
      for (const env of envs) environments.push(await readEnvironment(m, env, found.dir, read, revokedOf, query.readOutcomes));
      const own = await hasMemberLedger(m, found.dir);
      const gates = await readMemberGates(own ? `${MEMBERS_DIR}/${m.name}/${GATES_DIR}` : GATES_DIR, own ? "members" : "flat", commit, envs, found.dir, now, query.readGates, rules);
      const stewards = await (query.readStewards ?? readMemberStewards)(resolve(found.dir, m.dir), query.env, now, m.kind, m.box);
      // The declaration's x- keys go back on the objects that hold them (#3595).
      const x = (pointer: string) => extensionsAt(declaration, pointer);
      const bp = m.box?.pointer ?? "";
      const withX = <T extends object>(view: T | null, pointer: string): T | null => (view === null ? null : { ...view, ...x(pointer) });
      members.push({
        name: m.name,
        dir: m.dir,
        kind: m.kind,
        fields: resolveMemberFields(kinds.get(m.kind), m.fields).fields,
        environments,
        compare: query.compareTo === undefined ? null : compareEnvironments(environments[0], environments[environments.length - 1]),
        readable: environments.every((e) => e.reason === null),
        gateLedger: gates.ledger,
        gates: await supersedeRevokedGates(gates.gates, revokedOf),
        box:
          m.box === null
            ? null
            : {
                capabilities: m.box.capabilities.map((c) => ({ name: c.name, broker: c.broker, scope: [...c.scope], ...x(c.pointer) })),
                isolation: isolation.get(m.name) ?? null,
                intent: intents.get(m.name) ?? null,
                services: m.box.services.map((s) => ({
                  name: s.name,
                  cmd: s.cmd,
                  needs: [...s.needs],
                  httpPort: s.httpPort,
                  duration: s.duration,
                  health: s.health,
                  optional: s.optional,
                  ...x(s.pointer),
                })),
                factory: factoryWithX(factoryView(m.box.factory, declaration.members), `${bp}/factory`, x),
                listing: withX(listingView(m.box.listing, coverBytes), `${bp}/listing`),
                publisher: m.box.publisher,
                ship: withX(await shipView(m, found.dir, read), `${bp}/ship`),
                replicate: withX(m.box.replicate === null ? null : (({ box: _box, ...rest }) => rest)(policyView(m.name, m.box.replicate)), `${bp}/replicate`),
                ...x(bp),
              },
        stewards: stewards.stewards,
        stewardReasons: stewards.reasons,
        promotionOrder: await (query.readPromotionOrder ?? readMemberPromotionOrder)(resolve(found.dir, m.dir)),
        releaseCuts: await readReleaseCuts(resolve(found.dir, m.dir), releaseRule),
        featureFlags: flags === null ? null : flags.filter((f) => f.member === m.name).map(({ member: _member, ...f }) => f),
        ...x(m.pointer),
      });
    }
    // Several members read from one flat ledger see the same records; say so.
    const readers = new Map<string, number>();
    for (const m of members) for (const e of m.environments) if (e.ledger.layout === "flat") readers.set(e.ledger.path, (readers.get(e.ledger.path) ?? 0) + 1);
    for (const m of members) for (const e of m.environments) e.ledger.shared = e.ledger.layout === "flat" && (readers.get(e.ledger.path) ?? 0) > 1;
    const flatGates = members.filter((m) => m.gateLedger.layout === "flat").length;
    for (const m of members) m.gateLedger.shared = m.gateLedger.layout === "flat" && flatGates > 1;

    const leases = await readWorkspaceLeases(declaration.members, found.dir, new Date(now));
    const acceptance = await readWorkspaceAcceptance(declaration, found.dir);
    // #4025: the change sets still waiting to apply, the ones a pending or approved gate binds.
    const pendingChangeSets: OverlapChangeSetRef[] = [];
    for (const m of members) {
      const own = m.gateLedger.layout === "members";
      for (const g of m.gates) {
        if (g.changeSet === undefined || (g.state !== "pending" && g.state !== "approved")) continue;
        pendingChangeSets.push({ digest: g.changeSet, cwd: resolve(found.dir, m.dir), ledgerMember: own ? m.name : null, gitSha: g.gitSha ?? null });
      }
    }
    const overlap = await readStatusOverlap(declaration, found.dir, top, pendingChangeSets);

    return {
      ...head,
      env: query.env,
      compareTo: query.compareTo ?? null,
      lifecycle: { ref: LIFECYCLE_REF, commit },
      checkout: readCheckoutHead(top),
      workspace: { name: declaration.name, root: rootDir === "" ? "." : rootDir, file: declaration.file },
      plantable: plantability(declaration),
      members,
      leases,
      acceptance,
      replication: replicationOf(declaration, top),
      overlap,
      summary: {
        members: members.length,
        released: members.filter((m) => m.environments[0].releases.length > 0).length,
        unreadable: members.filter((m) => !m.readable).length,
        differing: query.compareTo === undefined ? null : members.filter((m) => m.compare!.differs).length,
      },
    };
  } catch (err) {
    if (err instanceof WorkspaceReadError) {
      // Without --at, the two --at codes can't come back; anything else is the declaration's.
      return { ...head, error: { code: err.code as StatusErrorCode, message: err.message, location: err.location ?? null } };
    }
    if (err instanceof StatusError) return { ...head, error: { code: err.code, message: err.message, location: null } };
    throw err;
  }
}

/**
 * A member's release cuts with their signatures judged (#4031), read from
 * its ledger on the local `chant/lifecycle`. Null when they can't be read.
 */
async function readReleaseCuts(memberDir: string, rule: GateAdmissionRule): Promise<StatusReleaseCut[] | null> {
  try {
    const { readCuts, readRelease } = await import("../lifecycle/release-store");
    const loc = { cwd: memberDir };
    const { cuts } = await readCuts(loc);
    const commits = new Map<string, string | null>();
    const out: StatusReleaseCut[] = [];
    for (const c of cuts) {
      if (!commits.has(c.releaseDigest)) commits.set(c.releaseDigest, (await readRelease(c.releaseDigest, loc))?.commit ?? null);
      out.push({
        releaseDigest: c.releaseDigest,
        label: c.label,
        commit: commits.get(c.releaseDigest) ?? null,
        actor: c.actor,
        timestamp: c.timestamp,
        signature: c.signature,
        signatureCheck: checkReleaseSignature(rule, c),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The work leases of the flat ledger and of each member's (#2732). Leases are
 * env-independent, so the environment asked for doesn't narrow them. Never
 * fetches: the remote's leases are the ones last fetched.
 */
async function readWorkspaceLeases(members: Member[], cwd: string, now: Date): Promise<StatusLease[]> {
  const ledgers: { member: string | null; prefix: string }[] = [{ member: null, prefix: "" }];
  for (const m of members) if (m.dir !== ".") ledgers.push({ member: m.name, prefix: `${MEMBERS_DIR}/${m.name}/` });
  const out: StatusLease[] = [];
  for (const l of ledgers) {
    for (const lease of await listWorkLeases({ cwd, memberPrefix: l.prefix, now })) out.push({ ...lease, member: l.member });
  }
  return out;
}

/** Every flag of the declared flag kinds (#4024), read in the working tree, sorted by id; null when they can't be read. */
async function readStatusFlags(declaration: Declaration, root: string): Promise<Array<StatusFeatureFlag & { member: string }> | null> {
  if (declaredRecordKinds(declaration).length === 0) return [];
  try {
    const { readWorkspaceFlags } = await import("./flags-read");
    const { flags } = await readWorkspaceFlags(root);
    return flags
      .map((f) => ({ id: f.id, member: f.member, param: f.param, owner: f.owner, values: f.values, work: f.work, implements: f.implements, stale: f.stale, kind: f.kind, path: f.path }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch {
    return null;
  }
}

/** The overlap report (#4025); null when no work kind is declared or it can't be read. */
async function readStatusOverlap(declaration: Declaration, root: string, top: string, changeSets: OverlapChangeSetRef[]): Promise<OverlapReport | null> {
  if (declaredRecordKinds(declaration).length === 0) return null;
  try {
    const { readOverlap } = await import("./overlap");
    return await readOverlap({ declaration, root, top, changeSets });
  } catch {
    return null;
  }
}

/** The acceptance counts of every declared work kind with criteria (#2772), read in the working tree. */
async function readWorkspaceAcceptance(declaration: Declaration, root: string): Promise<StatusAcceptance[]> {
  if (declaredRecordKinds(declaration).length === 0) return [];
  const { loadDeclaredKinds } = await import("./declared-kinds");
  const kinds = await loadDeclaredKinds(declaration, workingTree(root), root, { acceptance: true });
  return kinds.flatMap((k) =>
    (k.acceptance ?? []).map((a) => ({ member: k.declared.member, kind: k.declared.path, item: a.item, state: a.state, met: a.met, total: a.total })),
  );
}

export async function runWorkspaceStatus(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.extraPositional;
  if (!env) {
    console.error(formatError({ message: "chant workspace status needs an environment", hint: USAGE }));
    return 1;
  }
  if (args.compareTo === "--live" || args.live) {
    console.error(
      formatError({
        message: "chant workspace status doesn't read live state yet",
        hint: "Run chant components status <env> --live in a member's directory for that member's live state. The workspace view reads the ledgers only.",
      }),
    );
    return 1;
  }
  if (args.compareTo !== undefined && (args.compareTo === "" || args.compareTo.startsWith("-"))) {
    console.error(formatError({ message: "--compare-to needs an environment", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(args.extraPositional2 ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021).
  const handed = await handToRootChant(cwd, undefined);
  if (handed !== undefined) return handed;
  const doc = await workspaceStatus({ cwd, env, compareTo: args.compareTo });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else if ("error" in doc) {
    const l = doc.error.location;
    const where = l ? `${l.file}:${l.line}:${l.column}: ` : "";
    console.error(formatError({ message: `${doc.error.code}: ${where}${doc.error.message}`, hint: USAGE }));
  } else {
    console.log(formatStatus(doc));
  }
  return "error" in doc ? 1 : 0;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join("  ").trimEnd());
}

/** `sha256:0123456789ab 1a2b3c4d`: enough of the digest and the SHA to tell releases apart. */
function shortRelease(r: StatusRelease | undefined): string {
  if (!r) return "-";
  const colon = r.digest.indexOf(":");
  const digest = colon < 0 ? r.digest.slice(0, 12) : r.digest.slice(0, colon + 13);
  return `${digest} ${r.gitSha.slice(0, 8)}`;
}

export function formatStatus(doc: Extract<StatusDocument, { members: unknown }>): string {
  const lines: string[] = [];
  const envs = doc.members[0]?.environments.map((e) => e.env) ?? [doc.env];
  const title = doc.compareTo !== null && doc.compareTo !== doc.env ? `${doc.env} compared to ${doc.compareTo}` : doc.env;
  lines.push(`${doc.workspace.name}  ${title}  (${doc.lifecycle.ref} ${doc.lifecycle.commit ? `at ${doc.lifecycle.commit.slice(0, 8)}` : "is not in this checkout"})`);
  if (doc.members.length > 0) {
    lines.push("");
    const rows: string[][] = [["MEMBER", "COMPONENT", ...envs.map((e) => e.toUpperCase()), ...(doc.compareTo !== null ? [""] : [])]];
    const notes = new Map<number, string[]>();
    for (const m of doc.members) {
      const byEnv = m.environments.map((e) => new Map(e.releases.map((r) => [r.component, r])));
      const components = [...new Set(m.environments.flatMap((e) => e.releases.map((r) => r.component)))].sort();
      if (components.length === 0) rows.push([m.name, "-", ...envs.map(() => "no release"), ...(doc.compareTo !== null ? [""] : [])]);
      for (const c of components) {
        const state = m.compare?.components.find((x) => x.component === c)?.state;
        rows.push([m.name, c, ...byEnv.map((b) => shortRelease(b.get(c))), ...(doc.compareTo !== null ? [state && state !== "same" ? state : ""] : [])]);
      }
      const memberNotes: string[] = [];
      for (const e of m.environments) {
        if (e.reason) memberNotes.push(`  ${e.reason.code}: ${e.reason.message}`);
        else if (e.ledger.shared && e.releases.length > 0) memberNotes.push(`  ${e.env} is read from the shared flat ledger ${e.ledger.path}`);
        // #4033: a component running a release cut from a revoked commit, and the way back.
        for (const r of e.releases) {
          if (!r.revoked) continue;
          const name = r.revoked.label ?? r.revoked.releaseDigest;
          memberNotes.push(`  ${e.env}: ${r.component} runs release ${name}, revoked by ${r.revoked.tag} (${describeRevocation(r.revoked)}); roll back: ${r.revoked.rollback}`);
        }
        // #4035: an environment running a mix, what each component runs, and the lines that settle it.
        if (e.mixed) {
          const what = e.mixed.components.map((c) => {
            const runs = c.releaseDigest ? `release ${c.releaseLabel ?? c.releaseDigest.slice(0, 24)}` : c.digest ? "no release" : "nothing recorded";
            return c.state === "settled" ? `${c.component} runs ${runs}` : `${c.component} ${c.state} (${c.attempt!.verb} ${c.attempt!.runId}), recorded ${runs}`;
          });
          memberNotes.push(`  ${e.env} is mixed: ${what.join("; ")}`);
          for (const line of e.mixed.redeploy) memberNotes.push(`    redeploy: ${line}`);
          if (e.mixed.rollback) memberNotes.push(`    roll back: ${e.mixed.rollback}`);
        }
      }
      if (memberNotes.length > 0) notes.set(rows.length - 1, memberNotes);
    }
    table(rows).forEach((line, i) => {
      lines.push(line);
      for (const n of notes.get(i) ?? []) lines.push(n);
    });
  }
  if (doc.leases.length > 0) {
    lines.push("");
    const rows: string[][] = [["WORK ITEM", "HOLDER", "EXPIRES", "STATE"]];
    for (const l of doc.leases) rows.push([l.member ? `${l.member}/${l.item}` : l.item, l.holder, l.expiresAt, l.state]);
    lines.push(...table(rows));
  }
  if (doc.acceptance.length > 0) {
    lines.push("");
    const rows: string[][] = [["WORK ITEM", "STATE", "CRITERIA MET"]];
    for (const a of doc.acceptance) rows.push([a.member ? `${a.member}/${a.item}` : a.item, a.state ?? "-", `${a.met}/${a.total}`]);
    lines.push(...table(rows));
  }
  const cut = doc.members.filter((m) => (m.releaseCuts ?? []).length > 0);
  if (cut.length > 0) {
    lines.push("");
    const rows: string[][] = [["MEMBER", "RELEASE", "COMMIT", "CUT BY", "SIGNATURE"]];
    for (const m of cut) {
      for (const c of m.releaseCuts!) rows.push([m.name, c.label ?? c.releaseDigest.slice(0, 24), c.commit?.slice(0, 12) ?? "-", c.actor, c.signatureCheck.status]);
    }
    lines.push(...table(rows));
  }
  const flagged = doc.members.filter((m) => (m.featureFlags ?? []).length > 0);
  if (flagged.length > 0) {
    lines.push("");
    const rows: string[][] = [["FLAG", "PARAM", doc.env.toUpperCase(), "WORK ITEM", ""]];
    for (const m of flagged) {
      for (const f of m.featureFlags!) {
        const value = f.values[doc.env];
        rows.push([`${m.name}/${f.id}`, f.param, value === undefined ? "default" : JSON.stringify(value), f.work ? `${f.work.id} (${f.work.state ?? "unknown"})` : "-", f.stale ? "due for removal" : ""]);
      }
    }
    lines.push(...table(rows));
  }
  // #4025: in-flight work items that changed the same thing.
  if (doc.overlap && doc.overlap.pairs.length > 0) {
    lines.push("");
    const rows: string[][] = [["OVERLAP", "FILES", "ADDRESSES"]];
    for (const p of doc.overlap.pairs) {
      const list = (xs: string[]) => (xs.length === 0 ? "-" : xs.length <= 2 ? xs.join(", ") : `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more`);
      rows.push([`${p.items[0]} and ${p.items[1]}`, list(p.files), list([...new Set(p.addresses.map((x) => x.node ?? x.address))])]);
    }
    lines.push(...table(rows));
  }
  const boxes = doc.members.filter((m) => m.box?.isolation);
  if (boxes.length > 0) {
    lines.push("");
    const rows: string[][] = [["BOX", "HOST", "SLOT", "PORTS", "STATE"]];
    for (const m of boxes) {
      const i = m.box!.isolation!;
      rows.push([m.name, i.host, String(i.slot), `${i.portRange.from}-${i.portRange.to}`, i.stateDir]);
    }
    lines.push(...table(rows));
  }
  const s = doc.summary;
  lines.push("");
  lines.push(
    `${s.members} member${s.members === 1 ? "" : "s"}, ${s.released} with a release in ${doc.env}` +
      (s.differing !== null ? `, ${s.differing} differ${s.differing === 1 ? "s" : ""} from ${doc.compareTo}` : "") +
      `, ${s.unreadable} unreadable`,
  );
  return lines.join("\n");
}

/** Where the box's work in progress stands against its remote (#3172), or null when no box block declares replicate. */
function replicationOf(declaration: Declaration, top: string): ReplicationState | null {
  const m = declaration.members.find((x) => x.box?.replicate);
  return m ? replicationState(top, policyView(m.name, m.box!.replicate!)) : null;
}

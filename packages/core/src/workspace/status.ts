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
import { readReleasePlan, type ReleasePlan } from "../lifecycle/plan-ledger";
import { listWorkLeases, type WorkLeaseState } from "../lifecycle/work-lease";
import { findWorkspaceRoot } from "../project-root";
import { resolveBoxes, type ResolvedIsolation } from "./box-isolation";
import { readDeclaration, readerVersion, WorkspaceReadError, type ErrorLocation, type Member } from "./declaration";
import type { ReasonCode } from "./reason-codes";
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
}

/** A box's brokered capabilities, from the declaration (#2726). */
export interface StatusBox {
  capabilities: { name: string; broker: string | null; scope: string[] }[];
  /** The box's ports, state paths and cookie names, resolved from its identity, or null when the block declares no host (#2727). */
  isolation: ResolvedIsolation | null;
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

export type StatusDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      env: string;
      compareTo: string | null;
      lifecycle: { ref: string; commit: string | null };
      workspace: { name: string; root: string; file: string };
      members: StatusMember[];
      /** Every work lease in the workspace's ledgers, active and expired, by member then item (#2732). A released lease has no ref and is not listed. */
      leases: StatusLease[];
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
  /** Reads one member's gate ledger directory; git unless a test swaps it. */
  readGates?: GateLedgerReader;
  /** The instant a gate's expiry is measured against; now by default. */
  now?: string;
  /** Reads one member's stewards; the declaration and ledger reader unless a test swaps it. */
  readStewards?: typeof readMemberStewards;
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

const defaultReader: LedgerReader = (path, cwd) => readReleaseLedger(path.slice(0, -"/releases.jsonl".length), { cwd });

async function readEnvironment(member: Member, env: string, cwd: string, read: LedgerReader): Promise<StatusEnvironment> {
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
  const releases: StatusRelease[] = await Promise.all(
    latest.map(async (r) => ({
      component: r.component,
      digest: r.digest,
      gitSha: r.gitSha,
      inputDigest: r.inputDigest ?? null,
      runId: r.runId,
      timestamp: r.timestamp,
      actor: r.actor,
      flags: [...(r.flags ?? [])],
      plan: await readReleasePlan(r.digest, { cwd, prefix: planPrefix }),
    })),
  );
  return {
    env,
    ledger: { ...ledger, shared: false },
    releases,
    reason:
      malformed > 0
        ? { code: "ledger-malformed", message: `${ledger.path}: ${malformed} line${malformed === 1 ? " is" : "s are"} not a release record and ${malformed === 1 ? "was" : "were"} skipped` }
        : null,
  };
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
    const members: StatusMember[] = [];
    for (const m of declaration.members) {
      const environments: StatusEnvironment[] = [];
      for (const env of envs) environments.push(await readEnvironment(m, env, found.dir, read));
      const own = await hasMemberLedger(m, found.dir);
      const gates = await readMemberGates(own ? `${MEMBERS_DIR}/${m.name}/${GATES_DIR}` : GATES_DIR, own ? "members" : "flat", commit, envs, found.dir, now, query.readGates);
      const stewards = await (query.readStewards ?? readMemberStewards)(resolve(found.dir, m.dir), query.env, now, m.kind, m.box);
      members.push({
        name: m.name,
        dir: m.dir,
        kind: m.kind,
        environments,
        compare: query.compareTo === undefined ? null : compareEnvironments(environments[0], environments[environments.length - 1]),
        readable: environments.every((e) => e.reason === null),
        gateLedger: gates.ledger,
        gates: gates.gates,
        box:
          m.box === null
            ? null
            : {
                capabilities: m.box.capabilities.map((c) => ({ name: c.name, broker: c.broker, scope: [...c.scope] })),
                isolation: isolation.get(m.name) ?? null,
              },
        stewards: stewards.stewards,
        stewardReasons: stewards.reasons,
      });
    }
    // Several members read from one flat ledger see the same records; say so.
    const readers = new Map<string, number>();
    for (const m of members) for (const e of m.environments) if (e.ledger.layout === "flat") readers.set(e.ledger.path, (readers.get(e.ledger.path) ?? 0) + 1);
    for (const m of members) for (const e of m.environments) e.ledger.shared = e.ledger.layout === "flat" && (readers.get(e.ledger.path) ?? 0) > 1;
    const flatGates = members.filter((m) => m.gateLedger.layout === "flat").length;
    for (const m of members) m.gateLedger.shared = m.gateLedger.layout === "flat" && flatGates > 1;

    const leases = await readWorkspaceLeases(declaration.members, found.dir, new Date(now));

    return {
      ...head,
      env: query.env,
      compareTo: query.compareTo ?? null,
      lifecycle: { ref: LIFECYCLE_REF, commit },
      workspace: { name: declaration.name, root: rootDir === "" ? "." : rootDir, file: declaration.file },
      members,
      leases,
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

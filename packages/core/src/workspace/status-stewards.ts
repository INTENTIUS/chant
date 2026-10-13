/**
 * Stewards in `chant workspace status --json` (#2731): which steward runs a
 * member's operational work, the form it takes in the environment asked for,
 * its Ops with their schedules, and each Op's last run.
 *
 * The steward itself is read from its declaration, the same `*.op.ts` files
 * `chant operator --steward` reads (`../op/discover.ts`), through the index
 * kept per tree (`./steward-index.ts`, #3636), and only for a member
 * of kind `chant` that is a chant project of its own (a `chant.config.ts` or
 * `.json` in its directory), so a member never lists a parent project's
 * steward. Everything
 * else is read from the local `chant/lifecycle` branch and refs, never
 * fetched, as the rest of status is:
 *
 * - each Op's last run is the newest record in its run ledger,
 *   `<env>/runs__<op>.jsonl` under the member's ledger prefix, where `<env>`
 *   is the Op's own `labels.Env` or `local`;
 * - an Op's `inFlight` is the run of it in flight now, from the record a
 *   run keeps beside the checkout's git directory while it runs
 *   (`../op/run-live.ts`): its phase and step, the phases it has finished and
 *   its newest activity lines. Null once the run's ledger record is written,
 *   or when the process that wrote it is gone;
 * - `waiting` lists the open decision points the steward waits on (#2749):
 *   each Op whose newest run is the steward's own and stopped on a question
 *   that is still open. The question's state is read now, the way `points`
 *   reads it (`readQuestionStates`), not copied from the run ledger, which
 *   keeps the state the run stopped with. A question answered since, or
 *   whose record is gone, is not waited on; nor is one whose Op has a newer
 *   run in flight that has not written its record yet: the Op's lease or one
 *   of its work leases was taken after the waiting run ended
 *   (`newerRunInFlight`). When the questions can't be read, the ledger's
 *   state stands, as the operator's does. A run is the steward's when its
 *   record names it (`steward`, written for a run started in the steward's
 *   turn or under `CHANT_STEWARD`), so this also covers the member's other
 *   Ops, those no steward lists, that such a run belongs to, such as an Op
 *   the steward's process starts itself;
 * - `lease` is the local steward's own lease ref
 *   (`refs/chant/lease/[<prefix>]_stewards/<name>`), present while a
 *   `chant operator --steward` holds it or until it expires;
 * - an Op's `workLease.held` is the work leases its turns hold (#2748): those
 *   whose holder is `<steward>/<op>@...` (`stewardWorkHolder`), read from the
 *   ledger of the Op's work kind, or the member's own;
 * - an Op the steward runs beside its turns (#2861) has `beside`: whether it
 *   declares a ready step, and the Op's own lease
 *   (`refs/chant/lease/[<prefix>]<op>`), which a run of it holds while it runs.
 *   Its waiting run and its work leases are listed as for any of its Ops.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stewardFormFor, stewardLeaseName, type StewardForm } from "../op/steward";
import { readRunLedger, runEnvOf } from "../lifecycle/run-ledger";
import { readConvergeLedger, type ConvergeTickRecord } from "../lifecycle/converge-ledger";
import { leaseRef } from "../lifecycle/lease";
import { readBlobBySha, readRefSha } from "../lifecycle/git";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { listWorkLeases } from "../lifecycle/work-lease";
import { stewardWorkHolder } from "../op/work-lease-run";
import { readStewardIndex, type IndexedOp, type IndexedSteward, type StewardIndex } from "./steward-index";
import type { OpRunRecord } from "../op/runtime";
import { readInFlightRun } from "../op/run-live";
import { approveCommand } from "./status-gates";
import type { ReasonCode } from "./reason-codes";

/** Why a member's stewards can't be fully listed. Closed: a new code is a contract change. */
export const STEWARD_REASON_CODES = [
  /** An `*.op.ts` file could not be imported, so a steward it declares may be missing. */
  "stewards-unreadable",
  /** A steward was dropped: its name, or an Op it lists, belongs to another steward. */
  "stewards-conflict",
  /** Reading an Op's run ledger, or a ConvergeOp's converge ledger, failed, so its last run or last tick is null. */
  "steward-runs-unreadable",
] as const satisfies readonly ReasonCode[];
export type StewardReasonCode = (typeof STEWARD_REASON_CODES)[number];

export interface StatusStewardRun {
  id: string;
  status: OpRunRecord["status"];
  started: string;
  ended: string;
  /**
   * The gate the run stopped at, for a `gated` run: its name, when the run
   * stopped there, the op it is recorded under (the Op's own, or the
   * command's for a step whose command stopped at its own gate, #2779, such
   * as `workspace-upgrade`), and the command that approves it.
   */
  gate: { name: string; since: string; op: string; approve: string } | null;
  /**
   * The decision point the run stopped on, for a `waiting` run (#2749). Its
   * state is the question's now, `answered` once a person has answered it.
   */
  point: StatusStewardWait | null;
  /** Each phase in execution order, with its wall-clock time, or the sum of its steps' for a record that kept none. */
  phases: StatusStewardPhase[];
}

/** A phase of a run: its verdict and how long it took. */
export interface StatusStewardPhase {
  name: string;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
}

/**
 * The run of an Op in flight now (../op/run-live.ts): what it is doing while
 * its ledger record is not yet written.
 */
export interface StatusStewardInFlight {
  id: string;
  started: string;
  /** When the run last changed its record. */
  updated: string;
  steward: string | null;
  /** The work item the run's lease holds, once it is claimed. */
  item: string | null;
  phase: { name: string; started: string } | null;
  step: { name: string; fn: string; started: string } | null;
  /** The phases it has finished, in order. */
  phases: StatusStewardPhase[];
  /** The newest activity lines its steps reported; `total` counts every line of the run. */
  activity: { total: number; lines: { seq: number; at: string | null; text: string }[] };
}

/** A decision point a steward's run stopped on (#2749). */
export interface StatusStewardWait {
  /** The answer record's id: what `points --open` lists and `points answer` names. */
  id: string;
  point: string;
  /**
   * The question's state now, as `points` reads it. The state the run
   * stopped with when the questions can't be read or its record is gone.
   * Never `answered` in a steward's `waiting`.
   */
  state: "escalated" | "proposed" | "answered";
  path: string;
  subject: string | null;
  since: string;
}

/** A ConvergeOp's newest tick on the converge ledger (#2778). */
export interface StatusStewardTick {
  /** The tick's id, or null for a tick recorded before ticks had ids. */
  id: string | null;
  timestamp: string;
  /** The tick's one log line. */
  log: string;
  /** Every rule that fired. */
  firedRuleIds: string[];
  /** What each fired rule did, and for which resource on a ConvergeOp with an observer step. */
  outcomes: {
    ruleId: string;
    action: ConvergeTickRecord["outcomes"][number]["action"];
    op: string | null;
    resource: string | null;
    reason: string | null;
  }[];
  /** What the observer step reported, or null for a ConvergeOp that observes a lexicon environment. */
  resources: { name: string; status: "in-sync" | "drifted" | "unknown"; detail: string | null }[] | null;
}

export interface StatusStewardOp {
  name: string;
  /** The Op's cadence, or null for an Op the steward runs only when asked. */
  schedule: { cron: string; overlap: "skip" } | null;
  /** The environment its runs are recorded under: its `labels.Env`, or `local`. */
  env: string;
  /** The newest run in its run ledger, or null when it has none. */
  lastRun: StatusStewardRun | null;
  /** The run in flight now, or null when none is. */
  inFlight: StatusStewardInFlight | null;
  /** For a ConvergeOp, its newest tick on the converge ledger (#2778); null for any other Op, or before its first tick. */
  lastTick: StatusStewardTick | null;
  /** Whether the Op changes the checkout, and so runs under a work lease on a branch of its own (#2748). */
  changesCheckout: boolean;
  /**
   * The Op's work lease (#2748), or null when it declares none: the work kind
   * file whose ledger holds it (null for the member's own), and the leases
   * the steward's turns of this Op hold, a live one while a turn runs.
   */
  workLease: { kind: string | null; held: StatusStewardWorkLease[] } | null;
  /**
   * For an Op the steward runs beside its turns (#2861): whether a ready step
   * says when to start it, and the Op's own lease, which a run of it holds
   * while it runs (null when none has held it). Null for an Op run as one of
   * the steward's turns.
   */
  beside: { ready: boolean; lease: StatusStewardLease | null } | null;
}

/** A lease ref as status reads it: locally, never fetched. `live` is false once `expiresAt` has passed. */
export interface StatusStewardLease {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  live: boolean;
}

/** A work lease a steward's turn holds (#2748). */
export interface StatusStewardWorkLease {
  item: string;
  holder: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
  state: "active" | "expired";
}

export interface StatusSteward {
  name: string;
  /** The `*.op.ts` file declaring it, relative to the member's directory. */
  file: string;
  /** Its form in the environment status was asked for. */
  form: StewardForm;
  /** The declared form: a default and the environments that differ from it. */
  forms: { default: StewardForm; environments: Record<string, StewardForm> };
  /** The vault the steward holds on Fountain, by name, or null. */
  vault: string | null;
  /**
   * The box capabilities the steward reaches through a broker (#2726), joined
   * with the member's box block: `broker` is the block's, and `declared` is
   * false when the block doesn't list the capability (or there is no block).
   */
  capabilities: { name: string; broker: string | null; declared: boolean }[];
  /** The local steward's own lease, or null when no local operator has held it. */
  lease: StatusStewardLease | null;
  ops: StatusStewardOp[];
  /**
   * The open decision points the steward waits on (#2749): each Op whose
   * newest run is the steward's own and stopped on a question still open,
   * with no newer run of the Op in flight. Its declared
   * Ops come first, in `ops` order, then any other Op of the member whose
   * newest run names the steward, by Op name.
   */
  waiting: (StatusStewardWait & { op: string; run: string })[];
}

export interface MemberStewards {
  stewards: StatusSteward[];
  reasons: { code: StewardReasonCode; message: string }[];
}

/** Every question's state in the workspace by id, or null when they can't all be read. */
export type ReadQuestionStates = (cwd: string) => Promise<Map<string, string> | null>;

async function readQuestionStates(cwd: string): Promise<Map<string, string> | null> {
  const { readQuestionStates: read } = await import("./points-cli");
  return read(cwd);
}

/**
 * The point a run stopped on, with the question's state now and whether it
 * is still open. A question whose record is gone is not open, as the
 * operator reads it (`stewardWaits` in `../op/operator.ts`); when the
 * questions can't be read, the run ledger's state stands and it is open.
 */
function pointOf(p: NonNullable<OpRunRecord["point"]>, states: Map<string, string> | null): { wait: StatusStewardWait; open: boolean } {
  const recorded = p.state === "proposed" ? "proposed" : "escalated";
  const now = states?.get(p.id);
  const state = now === "escalated" || now === "proposed" || now === "answered" ? now : recorded;
  return {
    wait: { id: p.id, point: p.point, state, path: p.path, subject: p.subject ?? null, since: p.since },
    open: states === null || (now !== undefined && now !== "answered"),
  };
}

/**
 * Whether a newer run of the Op is in flight than the one that ended at
 * `ended`: the Op's own lease is live, or one of its work leases is active,
 * and was taken after that run ended. A run writes its record when it ends,
 * so until then the ledger's newest record is the older run's.
 */
function newerRunInFlight(ended: string, lease: StatusStewardLease | null, held: StatusStewardWorkLease[]): boolean {
  const after = (at: string) => Date.parse(at) >= Date.parse(ended);
  return (lease?.live === true && after(lease.acquiredAt)) || held.some((l) => l.state === "active" && after(l.acquiredAt));
}

/** The Op's run in flight, unless its ledger record is already the newest. Never throws. */
async function inFlightOf(memberDir: string, env: string, op: string, lastRunId: string | null): Promise<StatusStewardInFlight | null> {
  try {
    const run = await readInFlightRun(memberDir, env, op);
    if (!run || run.id === lastRunId) return null;
    return {
      id: run.id,
      started: run.started,
      updated: run.updated,
      steward: run.steward,
      item: run.item,
      phase: run.phase,
      step: run.step,
      phases: run.phases.map((p) => ({ name: p.name, status: p.status, durationMs: p.durationMs })),
      activity: run.activity,
    };
  } catch {
    return null;
  }
}

function gateOf(g: NonNullable<OpRunRecord["gate"]>, opName: string): NonNullable<StatusStewardRun["gate"]> {
  const op = g.op ?? opName;
  return { name: g.name, since: g.since, op, approve: approveCommand(op, g.name, null) };
}

function tickOf(t: ConvergeTickRecord): StatusStewardTick {
  return {
    id: t.id ?? null,
    timestamp: t.timestamp,
    log: t.log,
    firedRuleIds: [...t.firedRuleIds],
    outcomes: t.outcomes.map((o) => ({
      ruleId: o.ruleId,
      action: o.action,
      op: o.op ?? null,
      resource: o.resource ?? null,
      reason: o.reason ?? null,
    })),
    resources: t.resources ? t.resources.map((r) => ({ name: r.name, status: r.status, detail: r.detail ?? null })) : null,
  };
}

/** Whether a directory is a chant project of its own. */
function isChantProject(dir: string): boolean {
  return existsSync(join(dir, "chant.config.ts")) || existsSync(join(dir, "chant.config.json"));
}

/** A lease ref of the member, by its lease name (`_stewards/<name>`, or an Op's). */
async function readLeaseRef(leaseName: string, memberDir: string, now: string): Promise<StatusStewardLease | null> {
  try {
    const { prefix } = await resolveMemberLedger(memberDir);
    const sha = await readRefSha(leaseRef(leaseName, prefix), { cwd: memberDir });
    if (!sha) return null;
    const record = JSON.parse((await readBlobBySha(sha, { cwd: memberDir })) ?? "") as Record<string, unknown>;
    if (typeof record.holder !== "string" || typeof record.expiresAt !== "string" || typeof record.acquiredAt !== "string") return null;
    return {
      holder: record.holder,
      acquiredAt: record.acquiredAt,
      expiresAt: record.expiresAt,
      live: new Date(record.expiresAt).getTime() > new Date(now).getTime(),
    };
  } catch {
    return null;
  }
}

/** An Op's `beside` entry (#2861): null for an Op run as one of the steward's turns. */
async function besideOf(steward: IndexedSteward, op: string, memberDir: string, now: string): Promise<StatusStewardOp["beside"]> {
  const beside = steward.beside.find((b) => b.op === op);
  if (!beside) return null;
  return { ready: beside.ready, lease: await readLeaseRef(op, memberDir, now) };
}

/** The work leases `steward`'s turns of `op` hold, from the ledger of the Op's kind or the member's. */
async function readHeldWorkLeases(steward: string, op: IndexedOp, memberDir: string, now: string): Promise<StatusStewardWorkLease[]> {
  try {
    const kind = op.workLease?.kind;
    const cwd = kind ? dirname(resolve(memberDir, kind)) : memberDir;
    const { prefix } = await resolveMemberLedger(cwd);
    const mine = stewardWorkHolder(steward, op.name, "");
    return (await listWorkLeases({ cwd, memberPrefix: prefix, now: new Date(now) }))
      .filter((l) => l.holder.startsWith(mine))
      .map((l) => ({ item: l.item, holder: l.holder, token: l.token, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt, state: l.state }));
  } catch {
    return [];
  }
}

/**
 * The stewards declared in one member, for `env`. `memberDir` is absolute.
 * Only a member of kind `chant` with a config of its own is read.
 */
export async function readMemberStewards(
  memberDir: string,
  env: string,
  now: string,
  kind = "chant",
  box: { capabilities: { name: string; broker: string | null }[] } | null = null,
  deps: { readQuestions?: ReadQuestionStates; readIndex?: (memberDir: string) => Promise<StewardIndex> } = {},
): Promise<MemberStewards> {
  const reasons: MemberStewards["reasons"] = [];
  // Read once per member, and only when a run stopped on a question.
  let states: Promise<Map<string, string> | null> | undefined;
  const questionStates = () => (states ??= (deps.readQuestions ?? readQuestionStates)(memberDir));
  if (kind !== "chant" || !isChantProject(memberDir)) return { stewards: [], reasons };

  let index: StewardIndex;
  try {
    index = await (deps.readIndex ?? readStewardIndex)(memberDir);
  } catch (err) {
    reasons.push({ code: "stewards-unreadable", message: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    return { stewards: [], reasons };
  }
  for (const message of index.errors) reasons.push({ code: "stewards-unreadable", message });
  for (const message of index.conflicts) reasons.push({ code: "stewards-conflict", message });

  const stewards: StatusSteward[] = [];
  for (const declaration of [...index.stewards].sort((a, b) => a.name.localeCompare(b.name))) {
    const ops: StatusStewardOp[] = [];
    const waiting: StatusSteward["waiting"] = [];
    for (const op of declaration.ops) {
      const opEnv = runEnvOf(op);
      const workLease = op.workLease
        ? { kind: op.workLease.kind ?? null, held: await readHeldWorkLeases(declaration.name, op, memberDir, now) }
        : null;
      const beside = await besideOf(declaration, op.name, memberDir, now);
      let lastRun: StatusStewardRun | null = null;
      try {
        const newest = (await readRunLedger(opEnv, op.name, { cwd: memberDir })).records.at(-1);
        if (newest) {
          const point = newest.point ? pointOf(newest.point, await questionStates()) : null;
          lastRun = {
            id: newest.id,
            status: newest.status,
            started: newest.started,
            ended: newest.ended,
            gate: newest.gate ? gateOf(newest.gate, op.name) : null,
            point: point?.wait ?? null,
            phases: newest.phases.map((p) => ({
              name: p.name,
              status: p.status,
              durationMs: p.durationMs ?? p.steps.reduce((sum, st) => sum + st.durationMs, 0),
            })),
          };
          if (
            newest.status === "waiting" &&
            point?.open &&
            newest.steward === declaration.name &&
            !newerRunInFlight(newest.ended, beside?.lease ?? null, workLease?.held ?? [])
          ) {
            waiting.push({ op: op.name, run: newest.id, ...point.wait });
          }
        }
      } catch (err) {
        reasons.push({
          code: "steward-runs-unreadable",
          message: `${opEnv}/runs__${op.name}.jsonl: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        });
      }
      const inFlight = await inFlightOf(memberDir, opEnv, op.name, lastRun?.id ?? null);
      let lastTick: StatusStewardTick | null = null;
      if (op.labels?.Converge === "true") {
        try {
          const newest = (await readConvergeLedger(opEnv, { cwd: memberDir })).records.filter((r) => r.op === op.name).at(-1);
          if (newest) lastTick = tickOf(newest);
        } catch (err) {
          reasons.push({
            code: "steward-runs-unreadable",
            message: `${opEnv}/converge.jsonl: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
          });
        }
      }
      ops.push({
        name: op.name,
        schedule: op.schedule ? { cron: op.schedule.cron, overlap: "skip" } : null,
        env: opEnv,
        lastRun,
        inFlight,
        lastTick,
        changesCheckout: op.changesCheckout === true,
        workLease,
        beside,
      });
    }
    stewards.push({
      name: declaration.name,
      file: relative(realpathSync(memberDir), realpathSync(declaration.filePath)).split("\\").join("/"),
      form: stewardFormFor(declaration, env),
      forms: { default: declaration.form.default, environments: { ...declaration.form.environments } },
      vault: declaration.vault,
      capabilities: declaration.capabilities.map((name) => {
        const declared = box?.capabilities.find((c) => c.name === name);
        return { name, broker: declared?.broker ?? null, declared: declared !== undefined };
      }),
      lease: await readLeaseRef(stewardLeaseName(declaration.name), memberDir, now),
      ops,
      waiting,
    });
  }
  if (stewards.length > 0 && index.otherOps) await addUndeclaredWaits(memberDir, stewards, index.otherOps, reasons, now, questionStates);
  return { stewards, reasons };
}

/**
 * The waiting runs of the member's Ops that no steward lists, each under the
 * steward its record names. A steward's process can start an Op itself
 * with `CHANT_STEWARD` set (studio#137), and the run ledger then records
 * the run as the steward's though the declaration does not list the Op.
 * `ops` are the member's Ops no steward lists, from the index; import
 * failures are left out there, as discovering the stewards reported them as
 * `stewards-unreadable`.
 */
async function addUndeclaredWaits(
  memberDir: string,
  stewards: StatusSteward[],
  ops: IndexedOp[],
  reasons: MemberStewards["reasons"],
  now: string,
  questionStates: () => Promise<Map<string, string> | null>,
): Promise<void> {
  const byName = new Map(stewards.map((s) => [s.name, s]));
  for (const op of [...ops].sort((a, b) => a.name.localeCompare(b.name))) {
    const opEnv = runEnvOf(op);
    try {
      const newest = (await readRunLedger(opEnv, op.name, { cwd: memberDir })).records.at(-1);
      const steward = newest?.steward ? byName.get(newest.steward) : undefined;
      if (steward && newest?.status === "waiting" && newest.point) {
        const point = pointOf(newest.point, await questionStates());
        const held = op.workLease ? await readHeldWorkLeases(steward.name, op, memberDir, now) : [];
        if (point.open && !newerRunInFlight(newest.ended, await readLeaseRef(op.name, memberDir, now), held)) {
          steward.waiting.push({ op: op.name, run: newest.id, ...point.wait });
        }
      }
    } catch (err) {
      reasons.push({
        code: "steward-runs-unreadable",
        message: `${opEnv}/runs__${op.name}.jsonl: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  }
}

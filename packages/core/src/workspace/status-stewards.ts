/**
 * Stewards in `chant workspace status --json` (#2731): which steward runs a
 * member's operational work, the form it takes in the environment asked for,
 * its Ops with their schedules, and each Op's last run.
 *
 * The steward itself is read from its declaration, the same `*.op.ts` files
 * `chant operator --steward` reads (`../op/discover.ts`), and only for a member
 * of kind `chant` that is a chant project of its own (a `chant.config.ts` or
 * `.json` in its directory), so a member never lists a parent project's
 * steward. Everything
 * else is read from the local `chant/lifecycle` branch and refs, never
 * fetched, as the rest of status is:
 *
 * - each Op's last run is the newest record in its run ledger,
 *   `<env>/runs__<op>.jsonl` under the member's ledger prefix, where `<env>`
 *   is the Op's own `labels.Env` or `local`;
 * - `waiting` lists the open decision points the steward waits on (#2749):
 *   each Op whose newest run is the steward's own and stopped on a question,
 *   as the run ledger records it. The question's state now is `points`'s.
 *   A run is the steward's when its record names it (`steward`, written for
 *   a run started in the steward's turn or under `CHANT_STEWARD`), so this
 *   also covers the member's other Ops, those no steward lists, that such a
 *   run belongs to, such as an Op the steward's process starts itself;
 * - `lease` is the local steward's own lease ref
 *   (`refs/chant/lease/[<prefix>]_stewards/<name>`), present while a
 *   `chant operator --steward` holds it or until it expires;
 * - an Op's `workLease.held` is the work leases its turns hold (#2748): those
 *   whose holder is `<steward>/<op>@...` (`stewardWorkHolder`), read from the
 *   ledger of the Op's work kind, or the member's own.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { discoverOps, discoverStewards } from "../op/discover";
import { stewardFormFor, stewardLeaseName, type StewardForm } from "../op/steward";
import { readRunLedger, runEnvOf } from "../lifecycle/run-ledger";
import { readConvergeLedger, type ConvergeTickRecord } from "../lifecycle/converge-ledger";
import { leaseRef } from "../lifecycle/lease";
import { readBlobBySha, readRefSha } from "../lifecycle/git";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { listWorkLeases } from "../lifecycle/work-lease";
import { stewardWorkHolder } from "../op/work-lease-run";
import type { OpConfig } from "../op/types";
import type { OpRunRecord } from "../op/runtime";
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
  /** The open decision point the run stopped on, for a `waiting` run (#2749). */
  point: StatusStewardWait | null;
}

/** An open decision point a steward's run stopped on (#2749), as the run ledger records it. */
export interface StatusStewardWait {
  /** The answer record's id: what `points --open` lists and `points answer` names. */
  id: string;
  point: string;
  /** The question's state when the run stopped. */
  state: "escalated" | "proposed";
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
  lease: { holder: string; acquiredAt: string; expiresAt: string; live: boolean } | null;
  ops: StatusStewardOp[];
  /**
   * The open decision points the steward waits on (#2749): each Op whose
   * newest run is the steward's own and stopped on a question. Its declared
   * Ops come first, in `ops` order, then any other Op of the member whose
   * newest run names the steward, by Op name.
   */
  waiting: (StatusStewardWait & { op: string; run: string })[];
}

export interface MemberStewards {
  stewards: StatusSteward[];
  reasons: { code: StewardReasonCode; message: string }[];
}

function waitOf(p: NonNullable<OpRunRecord["point"]>): StatusStewardWait {
  return {
    id: p.id,
    point: p.point,
    state: p.state === "proposed" ? "proposed" : "escalated",
    path: p.path,
    subject: p.subject ?? null,
    since: p.since,
  };
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

async function readStewardLease(name: string, memberDir: string, now: string): Promise<StatusSteward["lease"]> {
  try {
    const { prefix } = await resolveMemberLedger(memberDir);
    const sha = await readRefSha(leaseRef(stewardLeaseName(name), prefix), { cwd: memberDir });
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

/** The work leases `steward`'s turns of `op` hold, from the ledger of the Op's kind or the member's. */
async function readHeldWorkLeases(steward: string, op: OpConfig, memberDir: string, now: string): Promise<StatusStewardWorkLease[]> {
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
): Promise<MemberStewards> {
  const reasons: MemberStewards["reasons"] = [];
  if (kind !== "chant" || !isChantProject(memberDir)) return { stewards: [], reasons };

  let discovered: Awaited<ReturnType<typeof discoverStewards>>;
  try {
    discovered = await discoverStewards({ cwd: memberDir });
  } catch (err) {
    reasons.push({ code: "stewards-unreadable", message: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    return { stewards: [], reasons };
  }
  const { stewards: found, errors, conflicts } = discovered;
  for (const message of errors) reasons.push({ code: "stewards-unreadable", message });
  for (const message of conflicts) reasons.push({ code: "stewards-conflict", message });

  const stewards: StatusSteward[] = [];
  for (const { declaration, filePath } of [...found.values()].sort((a, b) => a.declaration.name.localeCompare(b.declaration.name))) {
    const ops: StatusStewardOp[] = [];
    const waiting: StatusSteward["waiting"] = [];
    for (const op of declaration.ops) {
      const opEnv = runEnvOf(op);
      let lastRun: StatusStewardRun | null = null;
      try {
        const newest = (await readRunLedger(opEnv, op.name, { cwd: memberDir })).records.at(-1);
        if (newest) {
          lastRun = {
            id: newest.id,
            status: newest.status,
            started: newest.started,
            ended: newest.ended,
            gate: newest.gate ? gateOf(newest.gate, op.name) : null,
            point: newest.point ? waitOf(newest.point) : null,
          };
          if (newest.status === "waiting" && lastRun.point && newest.steward === declaration.name) {
            waiting.push({ op: op.name, run: newest.id, ...lastRun.point });
          }
        }
      } catch (err) {
        reasons.push({
          code: "steward-runs-unreadable",
          message: `${opEnv}/runs__${op.name}.jsonl: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        });
      }
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
        lastTick,
        changesCheckout: op.changesCheckout === true,
        workLease: op.workLease
          ? { kind: op.workLease.kind ?? null, held: await readHeldWorkLeases(declaration.name, op, memberDir, now) }
          : null,
      });
    }
    stewards.push({
      name: declaration.name,
      file: relative(realpathSync(memberDir), realpathSync(filePath)).split("\\").join("/"),
      form: stewardFormFor(declaration, env),
      forms: { default: declaration.form.default, environments: { ...declaration.form.environments } },
      vault: typeof declaration.vault === "string" ? declaration.vault : null,
      capabilities: (Array.isArray(declaration.capabilities) ? declaration.capabilities : []).map((name) => {
        const declared = box?.capabilities.find((c) => c.name === name);
        return { name, broker: declared?.broker ?? null, declared: declared !== undefined };
      }),
      lease: await readStewardLease(declaration.name, memberDir, now),
      ops,
      waiting,
    });
  }
  if (stewards.length > 0) await addUndeclaredWaits(memberDir, stewards, found, reasons);
  return { stewards, reasons };
}

/**
 * The waiting runs of the member's Ops that no steward lists, each under the
 * steward its record names. A steward's process can start an Op itself
 * with `CHANT_STEWARD` set (studio#137), and the run ledger then records
 * the run as the steward's though the declaration does not list the Op.
 * Import failures are left out here: `discoverStewards` read the same files
 * and reported them as `stewards-unreadable`.
 */
async function addUndeclaredWaits(
  memberDir: string,
  stewards: StatusSteward[],
  found: Awaited<ReturnType<typeof discoverStewards>>["stewards"],
  reasons: MemberStewards["reasons"],
): Promise<void> {
  const declared = new Set([...found.values()].flatMap(({ declaration }) => declaration.ops.map((op) => op.name)));
  let ops: OpConfig[];
  try {
    ops = [...(await discoverOps({ cwd: memberDir })).ops.values()].map((d) => d.config).filter((op) => !declared.has(op.name));
  } catch {
    return;
  }
  const byName = new Map(stewards.map((s) => [s.name, s]));
  for (const op of ops.sort((a, b) => a.name.localeCompare(b.name))) {
    const opEnv = runEnvOf(op);
    try {
      const newest = (await readRunLedger(opEnv, op.name, { cwd: memberDir })).records.at(-1);
      const steward = newest?.steward ? byName.get(newest.steward) : undefined;
      if (steward && newest?.status === "waiting" && newest.point) {
        steward.waiting.push({ op: op.name, run: newest.id, ...waitOf(newest.point) });
      }
    } catch (err) {
      reasons.push({
        code: "steward-runs-unreadable",
        message: `${opEnv}/runs__${op.name}.jsonl: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      });
    }
  }
}

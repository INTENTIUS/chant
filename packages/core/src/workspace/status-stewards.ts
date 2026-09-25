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
 * - `lease` is the local steward's own lease ref
 *   (`refs/chant/lease/[<prefix>]_stewards/<name>`), present while a
 *   `chant operator --steward` holds it or until it expires;
 * - an Op's `workLease.held` is the work leases its turns hold (#2748): those
 *   whose holder is `<steward>/<op>@...` (`stewardWorkHolder`), read from the
 *   ledger of the Op's work kind, or the member's own.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { discoverStewards } from "../op/discover";
import { stewardFormFor, stewardLeaseName, type StewardForm } from "../op/steward";
import { readRunLedger, runEnvOf } from "../lifecycle/run-ledger";
import { leaseRef } from "../lifecycle/lease";
import { readBlobBySha, readRefSha } from "../lifecycle/git";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { listWorkLeases } from "../lifecycle/work-lease";
import { stewardWorkHolder } from "../op/work-lease-run";
import type { OpConfig } from "../op/types";
import type { OpRunRecord } from "../op/runtime";
import type { ReasonCode } from "./reason-codes";

/** Why a member's stewards can't be fully listed. Closed: a new code is a contract change. */
export const STEWARD_REASON_CODES = [
  /** An `*.op.ts` file could not be imported, so a steward it declares may be missing. */
  "stewards-unreadable",
  /** A steward was dropped: its name, or an Op it lists, belongs to another steward. */
  "stewards-conflict",
  /** Reading an Op's run ledger failed, so its last run is null. */
  "steward-runs-unreadable",
] as const satisfies readonly ReasonCode[];
export type StewardReasonCode = (typeof STEWARD_REASON_CODES)[number];

export interface StatusStewardRun {
  id: string;
  status: OpRunRecord["status"];
  started: string;
  ended: string;
  /** The gate the run stopped at, for a `gated` run. */
  gate: { name: string; since: string } | null;
}

export interface StatusStewardOp {
  name: string;
  /** The Op's cadence, or null for an Op the steward runs only when asked. */
  schedule: { cron: string; overlap: "skip" } | null;
  /** The environment its runs are recorded under: its `labels.Env`, or `local`. */
  env: string;
  /** The newest run in its run ledger, or null when it has none. */
  lastRun: StatusStewardRun | null;
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
}

export interface MemberStewards {
  stewards: StatusSteward[];
  reasons: { code: StewardReasonCode; message: string }[];
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
            gate: newest.gate ? { name: newest.gate.name, since: newest.gate.since } : null,
          };
        }
      } catch (err) {
        reasons.push({
          code: "steward-runs-unreadable",
          message: `${opEnv}/runs__${op.name}.jsonl: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        });
      }
      ops.push({
        name: op.name,
        schedule: op.schedule ? { cron: op.schedule.cron, overlap: "skip" } : null,
        env: opEnv,
        lastRun,
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
    });
  }
  return { stewards, reasons };
}

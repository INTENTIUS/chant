/**
 * The rollback activities for a release a release Op shipped as a source tree
 * (#2800): plan the rollback from the release ledger, and record it once the
 * site serves the earlier release again.
 *
 * - {@link releaseRollbackPlan}: pick the release to go back to, read its plan
 *   from `_plans/` (ws-055), archive the same directory of the same commit
 *   again and refuse unless it hashes to the digest that plan recorded, then
 *   write a rollback plan named by its own sha256. The rollback gate binds to
 *   that digest. The step that restores the Machine reads the archive again,
 *   checked against the same digest, before the Machine changes.
 * - {@link releaseRollbackRecord}: append a release record with the restored
 *   release's digest and commit, `restores` naming that release, the actor who
 *   ran it and the gate's approver, the way `chant components rollback`
 *   records one. Nothing is written when the ledger already records it.
 *
 * Which release: by default, the one the site served before the latest
 * release the release Op shipped. A rollback's own record does not count as
 * a release here, so running the rollback again plans the same rollback, its
 * approval still holds, the Machine already serves it, and nothing is
 * recorded twice. `to` names another release by its digest.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReleaseRecord, ReleaseRef } from "../../lifecycle/release-ledger";
import { archiveSourceTree } from "../source-archive";
import { readReleasePlan, releasePlan, releasePlanDigest } from "./source-release";

// ── releaseRollbackPlan ───────────────────────────────────────────────────────

export interface ReleaseRollbackPlanArgs {
  /** The component the releases are recorded under. */
  component: string;
  /** The environment whose ledger records them. */
  env: string;
  /** The digest of the release to go back to. Default: the release the site served before the latest one. */
  to?: string;
  /**
   * The directory the release archived, relative to the Op's working
   * directory, for a plan that does not record `artifact.dir`.
   */
  path?: string;
  /** Where plans are written. Default: `dist/plans`. */
  dir?: string;
  cwd?: string;
}

export interface ReleaseRollbackPlanResult {
  /** `sha256:` of the rollback plan. The rollback gate binds to it. */
  digest: string;
  /** Where the rollback plan was written. */
  file: string;
  /** The release it goes back to: that release's plan digest, which the ledger and the Machine's metadata name. */
  to: string;
  /** The release it replaces. */
  from: string;
  /** The commit the restored release shipped. */
  gitSha: string;
  /** The restored release's source tree, archived again from that commit. */
  archive: string;
  /** Its sha256, the one the restored release's plan recorded. */
  archiveDigest: string;
  /** The directory the archive holds. */
  dir: string;
}

/** A record's reference, the way `restores` and `promotedFrom` name one. */
const refTo = (r: ReleaseRecord): ReleaseRef => ({ env: r.env, runId: r.runId, timestamp: r.timestamp });

/**
 * The release a rollback goes back to, and the release it replaces. Pure.
 *
 * The replaced release is the component's latest record that is not itself a
 * rollback. By default the target is the latest record before it with another
 * digest: what the site served before that release. With `to`, the target is
 * the latest record with that digest.
 */
export function pickRollback(
  records: ReleaseRecord[],
  component: string,
  env: string,
  to?: string,
): { target: ReleaseRecord; replaced: ReleaseRecord } | { error: string } {
  // Ledger order, oldest first; a later append wins a tied timestamp.
  const own = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.component === component)
    .sort((a, b) => (a.r.timestamp === b.r.timestamp ? a.i - b.i : a.r.timestamp < b.r.timestamp ? -1 : 1))
    .map(({ r }) => r);
  if (own.length === 0) return { error: `no release of "${component}" is recorded in "${env}"` };
  const releasedAt = own.map((r) => !r.restores).lastIndexOf(true);
  if (releasedAt < 0) return { error: `"${component}" has no release in "${env}" that was not itself a rollback` };
  const replaced = own[releasedAt];
  if (to !== undefined) {
    const target = own.filter((r) => r.digest === to).at(-1);
    if (!target) return { error: `no release of "${component}" in "${env}" has digest ${to}` };
    return { target, replaced };
  }
  const target = own.slice(0, releasedAt).filter((r) => r.digest !== replaced.digest).at(-1);
  if (!target) return { error: `"${component}" has no release in "${env}" before ${replaced.digest} to roll back to` };
  return { target, replaced };
}

/** Plan a rollback: the earlier release, its plan, and its source tree archived again and checked against the recorded digest. */
export async function releaseRollbackPlan(args: ReleaseRollbackPlanArgs): Promise<ReleaseRollbackPlanResult> {
  if (!args.component || !args.env) throw new Error("releaseRollbackPlan: name the component and the environment");
  const cwd = resolve(args.cwd ?? process.cwd());
  const opts = { cwd };
  const { readReleaseLedger } = await import("../../lifecycle/release-ledger");
  const { readReleasePlan: readPersistedPlan } = await import("../../lifecycle/plan-ledger");

  const picked = pickRollback((await readReleaseLedger(args.env, opts)).records, args.component, args.env, args.to);
  if ("error" in picked) throw new Error(`releaseRollbackPlan: ${picked.error}`);
  const { target, replaced } = picked;

  // The restored release's plan, as it was approved: its content still hashes to its name.
  const plan = await readPersistedPlan(target.digest, opts);
  if (!plan) throw new Error(`releaseRollbackPlan: no plan is recorded for ${target.digest} (_plans/ on chant/lifecycle), so its source tree is unknown`);
  const planDigest = releasePlanDigest(plan);
  if (planDigest !== target.digest) throw new Error(`releaseRollbackPlan: the plan recorded for ${target.digest} hashes to ${planDigest}`);
  const artifact = plan.artifact as { digest?: unknown; dir?: unknown } | undefined;
  if (typeof artifact?.digest !== "string") throw new Error(`releaseRollbackPlan: the plan for ${target.digest} records no artifact digest`);
  const gitSha = (plan.gitSha as string | undefined) ?? target.gitSha;

  // The same directory of the same commit, archived again: git archive gives the same bytes.
  let dir: string;
  if (typeof artifact.dir === "string") {
    const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" }).trim());
    dir = join(root, artifact.dir);
  } else if (args.path) {
    dir = args.path;
  } else {
    throw new Error(`releaseRollbackPlan: the plan for ${target.digest} records no artifact.dir; pass path, the directory the release archived`);
  }
  const archive = archiveSourceTree({ dir, ref: gitSha, cwd });
  if (archive.digest !== artifact.digest) {
    throw new Error(
      `releaseRollbackPlan: ${archive.dir} at ${gitSha.slice(0, 12)} archives to ${archive.digest}, not the ${artifact.digest} release ${target.digest} recorded; refusing to restore it`,
    );
  }

  const written = await releasePlan({
    component: args.component,
    env: args.env,
    gitSha,
    content: {
      rollback: { to: target.digest, from: replaced.digest, restores: refTo(target) },
      artifact: { ...(plan.artifact as Record<string, unknown>), digest: archive.digest, dir: archive.dir },
    },
    ...(args.dir ? { dir: args.dir } : {}),
    cwd,
  });
  return {
    digest: written.digest,
    file: written.file,
    to: target.digest,
    from: replaced.digest,
    gitSha,
    archive: archive.archive,
    archiveDigest: archive.digest,
    dir: archive.dir,
  };
}

// ── releaseRollbackRecord ─────────────────────────────────────────────────────

export interface ReleaseRollbackRecordArgs {
  /** The rollback plan `releaseRollbackPlan` wrote. */
  plan: string;
  /** The digest the gate approved. The plan must be that one. */
  digest?: string;
  /** Who approved it: the resolution bound to this digest on this Op's gate is looked up. */
  approval?: { op: string; gate: string };
  /** Who ran the rollback. Default: GITHUB_ACTOR, GITLAB_USER_LOGIN, USER. */
  actor?: string;
  runId?: string;
  cwd?: string;
}

export interface ReleaseRollbackRecordResult {
  /** False when the ledger already recorded this rollback. */
  recorded: boolean;
  /** The restored release's digest, which the record carries. */
  digest: string;
  env: string;
  component: string;
  approver: string | null;
}

/** Record a rollback in the release ledger, once. */
export async function releaseRollbackRecord(args: ReleaseRollbackRecordArgs): Promise<ReleaseRollbackRecordResult> {
  const cwd = args.cwd;
  const opts = cwd ? { cwd } : undefined;
  const plan = readReleasePlan(resolve(cwd ?? process.cwd(), args.plan), args.digest);
  const rollback = plan.rollback as { to?: string; restores?: ReleaseRef } | undefined;
  if (!rollback?.to || !rollback.restores) throw new Error(`releaseRollbackRecord: ${args.plan} is not a rollback plan (no rollback.to)`);
  const component = plan.component as string;
  const env = plan.env as string;
  const gitSha = plan.gitSha as string;

  const { readReleaseLedger, latestPerComponent, appendReleaseRecord, resolveRunId } = await import("../../lifecycle/release-ledger");
  const { pushLifecycle } = await import("../../lifecycle/git");

  let approver: string | null = null;
  if (args.approval) {
    const { readGateLedger } = await import("../../lifecycle/gate-ledger");
    const { resolutions } = await readGateLedger(args.approval.op, opts);
    const bound = resolutions.filter((r) => r.gate === args.approval!.gate && r.planDigest === plan.digest);
    approver = bound.length > 0 ? [...new Set(bound.map((r) => r.resolvedBy))].join(", ") : null;
  }

  const latest = latestPerComponent((await readReleaseLedger(env, opts)).records.filter((r) => r.component === component)).get(component);
  if (latest?.digest === rollback.to && latest.restores?.runId === rollback.restores.runId && latest.restores.timestamp === rollback.restores.timestamp) {
    return { recorded: false, digest: rollback.to, env, component, approver };
  }

  const actor = args.actor || process.env.GITHUB_ACTOR || process.env.GITLAB_USER_LOGIN || process.env.USER;
  if (!actor) throw new Error("releaseRollbackRecord: no actor: pass one, or set GITHUB_ACTOR, GITLAB_USER_LOGIN or USER");
  const { runId, runOrigin } = resolveRunId(args.runId);
  await appendReleaseRecord(
    {
      component,
      env,
      digest: rollback.to,
      gitSha,
      runId,
      ...(runOrigin ? { runOrigin } : {}),
      timestamp: new Date().toISOString(),
      actor,
      ...(approver ? { approver } : {}),
      restores: rollback.restores,
    },
    opts,
  );
  await pushLifecycle(opts);
  return { recorded: true, digest: rollback.to, env, component, approver };
}

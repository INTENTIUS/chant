/**
 * The release activities an Op ships a source tree with (#2782): archive the
 * tree, plan the release, and record it once it serves.
 *
 * - {@link sourceArchive}: one directory of HEAD as a tar (../source-archive.ts),
 *   named by its sha256. The same commit archives to the same bytes.
 * - {@link releasePlan}: what a release will ship, as a JSON object named by
 *   the sha256 of its own canonical form. The ship gate binds to that digest
 *   (`gate("ship", { plan: plan.out.digest })`), the step that ships reads the
 *   plan back by it, and the release ledger records it (ws-055: a release
 *   record's digest names its plan). Nothing in a plan changes from one run of
 *   the same commit to the next, so a retried release plans the same digest
 *   and its approval still holds.
 * - {@link releaseRecord}: persist the plan to `_plans/<digest>.json` on
 *   chant/lifecycle and append the release record, as `chant components
 *   release --release-plan` does. When the environment's latest record for
 *   the component already names this digest, nothing is written, so a
 *   retried release records once.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sortedJsonReplacer } from "../../utils";
import { archiveSourceTree, sha256Digest, type SourceArchive } from "../source-archive";

// ── sourceArchive ─────────────────────────────────────────────────────────────

export interface SourceArchiveArgs {
  /** The directory to archive, relative to the Op's working directory (the app member: `../app`). */
  path: string;
  /** The commit. Default: HEAD. */
  ref?: string;
  /** Where to write the archive. Default: `dist/releases/<commit>.tar`. */
  out?: string;
  cwd?: string;
}

export type SourceArchiveResult = SourceArchive;

/** Archive a directory of a commit (default HEAD); see ../source-archive.ts. */
export async function sourceArchive(args: SourceArchiveArgs): Promise<SourceArchiveResult> {
  return archiveSourceTree({ dir: args.path, ref: args.ref, out: args.out, cwd: args.cwd });
}

// ── releasePlan ───────────────────────────────────────────────────────────────

export interface ReleasePlanArgs {
  /** The component the release is recorded under. */
  component: string;
  /** The environment it ships to. */
  env: string;
  /** The commit it ships. */
  gitSha: string;
  /** What ships and why: the artifact, the answers the release asked, the target. Any JSON. */
  content: Record<string, unknown>;
  /** Where plans are written. Default: `dist/plans`. */
  dir?: string;
  cwd?: string;
}

export interface ReleasePlanResult {
  /** `sha256:` of the plan's canonical JSON, without this field. */
  digest: string;
  /** Where the plan was written: `<dir>/<digest>.json`. (Not `path`: that name is reserved on a step's `.out`.) */
  file: string;
  gitSha: string;
}

/** The digest of a plan: sha256 of its canonical JSON (keys sorted), `digest` left out. Pure. */
export function releasePlanDigest(plan: Record<string, unknown>): string {
  const { digest: _digest, ...rest } = plan;
  return sha256Digest(JSON.stringify(rest, sortedJsonReplacer));
}

/** Write a release plan, named by its own digest. */
export async function releasePlan(args: ReleasePlanArgs): Promise<ReleasePlanResult> {
  if (!args.component || !args.env || !args.gitSha) throw new Error("releasePlan: a plan names its component, its environment and its commit");
  const body = { component: args.component, env: args.env, gitSha: args.gitSha, ...args.content };
  const digest = releasePlanDigest(body);
  const dir = resolve(args.cwd ?? process.cwd(), args.dir ?? join("dist", "plans"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${digest.replace(":", "_")}.json`);
  writeFileSync(file, JSON.stringify({ digest, ...body }, sortedJsonReplacer, 2) + "\n");
  return { digest, file, gitSha: args.gitSha };
}

/** A plan `releasePlan` wrote, checked against its digest. */
export function readReleasePlan(path: string, digest?: string): Record<string, unknown> & { digest: string } {
  const plan = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown> & { digest: string };
  const actual = releasePlanDigest(plan);
  if (plan.digest !== actual) throw new Error(`${path} names digest ${plan.digest}, but its content is ${actual}`);
  if (digest !== undefined && digest !== actual) throw new Error(`${path} is plan ${actual}, not the approved ${digest}`);
  return plan;
}

// ── releaseRecord ─────────────────────────────────────────────────────────────

export interface ReleaseRecordArgs {
  /** The plan `releasePlan` wrote. Its component, environment, commit and digest are what is recorded. */
  plan: string;
  /** The digest the gate approved. The plan must be that one. */
  digest?: string;
  /** Who approved it: the resolution bound to this digest on this Op's gate is looked up. */
  approval?: { op: string; gate: string };
  /** Who ran the release. Default: GITHUB_ACTOR, GITLAB_USER_LOGIN, USER. */
  actor?: string;
  runId?: string;
  cwd?: string;
}

export interface ReleaseRecordResult {
  /** False when the latest record already named this release. */
  recorded: boolean;
  digest: string;
  env: string;
  component: string;
  approver: string | null;
}

/** Persist the plan and record the release in the ledger, once. */
export async function releaseRecord(args: ReleaseRecordArgs): Promise<ReleaseRecordResult> {
  const cwd = args.cwd;
  const opts = cwd ? { cwd } : undefined;
  const plan = readReleasePlan(resolve(cwd ?? process.cwd(), args.plan), args.digest);
  const component = plan.component as string;
  const env = plan.env as string;
  const gitSha = plan.gitSha as string;

  const { readReleaseLedger, latestPerComponent, appendReleaseRecord, resolveRunId } = await import("../../lifecycle/release-ledger");
  const { persistReleasePlan } = await import("../../lifecycle/plan-ledger");
  const { pushLifecycle } = await import("../../lifecycle/git");

  let approver: string | null = null;
  if (args.approval) {
    const { readGateLedger } = await import("../../lifecycle/gate-ledger");
    const { resolutions } = await readGateLedger(args.approval.op, opts);
    const bound = resolutions.filter((r) => r.gate === args.approval!.gate && r.planDigest === plan.digest);
    approver = bound.length > 0 ? [...new Set(bound.map((r) => r.resolvedBy))].join(", ") : null;
  }

  const latest = latestPerComponent((await readReleaseLedger(env, opts)).records).get(component);
  if (latest?.digest === plan.digest && latest.gitSha === gitSha) {
    await persistReleasePlan(plan, opts);
    await pushLifecycle(opts);
    return { recorded: false, digest: plan.digest, env, component, approver };
  }

  const actor = args.actor || process.env.GITHUB_ACTOR || process.env.GITLAB_USER_LOGIN || process.env.USER;
  if (!actor) throw new Error("releaseRecord: no actor: pass one, or set GITHUB_ACTOR, GITLAB_USER_LOGIN or USER");
  const { runId, runOrigin } = resolveRunId(args.runId);
  await persistReleasePlan(plan, opts);
  await appendReleaseRecord(
    {
      component,
      env,
      digest: plan.digest,
      gitSha,
      runId,
      ...(runOrigin ? { runOrigin } : {}),
      timestamp: new Date().toISOString(),
      actor,
      ...(approver ? { approver } : {}),
    },
    opts,
  );
  await pushLifecycle(opts);
  return { recorded: true, digest: plan.digest, env, component, approver };
}

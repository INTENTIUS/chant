/**
 * Release records from op-wave applies (#4615): a wave whose spec names a
 * `step` records each run it applied on the environment's release ledger,
 * as `chant components promote` records each component it deployed. So
 * `chant components rollback <env> --component <name>` reads a stack or a
 * root applied through op waves the way it reads a promoted one.
 *
 * Each run applied through its step gets one record, written once the
 * wave's apply loop ends, whatever happened to the other runs:
 *
 * - `env` is the run's `release.env`, else the spec's, else `labels.Env`,
 *   else the wave's name, the environment the step planned and applied in
 *   (`opWaveStepContext`). `component` is the run's `release.component`,
 *   else the spec's, else the run's target. Strings have `{target}`, `{op}`
 *   and `{wave}` filled, as the step's input does.
 * - When a release cut from the applied commit records the component's
 *   templates for that environment, the record names the release
 *   (`releaseDigest`) and carries its templates digest with `digestKind:
 *   "templates"`, the record `promote --release` writes. A rollback then
 *   runs under that release (#4542). With several such cuts the newest wins.
 * - Otherwise the record is an apply record: the step's plan digest with
 *   `digestKind: "plan"`, the record `pr-apply` writes (#4274). It shows on
 *   `workspace status` and `release list`, and rollback skips it, since no
 *   recorded files can be applied again.
 *
 * `"release": false` on the spec writes none. A spec without a `step`
 * writes none either, since its apply command records what it applies.
 * A failed write is a line in the log and never changes the job's exit code,
 * as `maybeRecordAutoRelease` treats an auto-recorded release.
 */

import type { OpWave, OpWaveRun, OpWavesSpec } from "./op-waves";
import type { Release, ReleaseCut } from "../lifecycle/release-store";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant whose op-wave applies write release records (#4615). */
export const OP_WAVE_RELEASE_RECORD_FLOOR = NEXT_RELEASE;

/** Where an op-wave apply's release record goes (#4615), and under which names. */
export interface OpWaveReleaseNames {
  /** The environment ledger the record goes on. Default `labels.Env`, else the wave's name. */
  env?: string;
  /** The component the record names, which `rollback --component` takes. Default the run's target. */
  component?: string;
}

/** One record an op-wave apply asks for (#4615). */
export interface OpWaveReleaseRequest {
  env: string;
  component: string;
  target: string;
  /** The step's plan digest, which the record carries when no release covers the commit. */
  planDigest: string;
  /** The applied commit. */
  gitSha?: string;
  /** Who approved the wave, when a person did. */
  approver?: string;
}

/** How one record came out. */
export type OpWaveReleaseOutcome =
  | { recorded: true; env: string; component: string; digest: string; releaseDigest?: string }
  | { recorded: false; reason: string };

/** Where an op wave job's release records go (#4615). */
export interface OpWaveReleasePort {
  record(requests: readonly OpWaveReleaseRequest[]): Promise<OpWaveReleaseOutcome[]>;
}

/** What is wrong with a spec's or a run's `release`, empty when nothing is. */
export function opWaveReleaseProblems(spec: Pick<OpWavesSpec, "release" | "waves">): string[] {
  const problems: string[] = [];
  const check = (value: unknown, where: string, allowFalse: boolean): void => {
    if (value === undefined) return;
    if (value === false && allowFalse) return;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${where} must be { "env"?: "<env>", "component"?: "<name>" }${allowFalse ? " or false" : ""}`);
      return;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key !== "env" && key !== "component") problems.push(`${where} has an unknown key "${key}"; it takes env and component`);
      else if (typeof v !== "string" || v.trim() === "") problems.push(`${where}.${key} must be a non-empty string`);
    }
  };
  check(spec.release, "`release`", true);
  for (const wave of spec.waves) for (const run of wave.runs ?? []) check(run.release, `wave "${wave.name}" run "${run.target}": \`release\``, false);
  return problems;
}

function fill(text: string, vars: { target: string; op: string; wave: string }): string {
  return text.replaceAll("{target}", vars.target).replaceAll("{op}", vars.op).replaceAll("{wave}", vars.wave);
}

/**
 * The environment and component a run's release record goes under (#4615),
 * or null when the spec writes none (no `step`, or `"release": false`).
 */
export function opWaveReleaseNames(spec: Pick<OpWavesSpec, "op" | "step" | "labels" | "release">, wave: Pick<OpWave, "name">, run: OpWaveRun): { env: string; component: string } | null {
  if (!spec.step || spec.release === false) return null;
  const vars = { target: run.target, op: run.op ?? spec.op, wave: wave.name };
  const own = spec.release ?? {};
  const env = run.release?.env ?? own.env;
  const component = run.release?.component ?? own.component;
  return {
    env: env !== undefined ? fill(env, vars) : spec.labels?.Env ?? wave.name,
    component: component !== undefined ? fill(component, vars) : run.target,
  };
}

/**
 * The release a record of `component` in `env` applied at `commit` joins
 * (#4615): a release cut from that commit whose target for `env` records the
 * component's templates, the newest cut first. Null when none does.
 */
export function releaseOfCommit(
  releases: readonly Release[],
  cuts: readonly ReleaseCut[],
  at: { commit: string; env: string; component: string },
  templatesDigest: (release: Release, env: string, component: string) => string | null,
): { releaseDigest: string; templatesDigest: string } | null {
  const cutAt = new Map<string, string>();
  for (const c of cuts) {
    const prior = cutAt.get(c.releaseDigest);
    if (prior === undefined || c.timestamp > prior) cutAt.set(c.releaseDigest, c.timestamp);
  }
  const matching = releases
    .filter((r) => r.commit === at.commit)
    .map((r) => ({ r, digest: templatesDigest(r, at.env, at.component) }))
    .filter((x): x is { r: Release; digest: string } => x.digest !== null)
    .sort((a, b) => (cutAt.get(b.r.releaseDigest) ?? "").localeCompare(cutAt.get(a.r.releaseDigest) ?? "") || a.r.releaseDigest.localeCompare(b.r.releaseDigest));
  const first = matching[0];
  return first ? { releaseDigest: first.r.releaseDigest, templatesDigest: first.digest } : null;
}

/**
 * The release ledger on `chant/lifecycle` (#4615): each request through
 * `maybeRecordAutoRelease`, which appends and pushes, with the release a cut
 * from the commit names when there is one. Loaded behind dynamic imports, so
 * the wave-job runtime bundle stays without them until a step applied.
 */
export function gitOpWaveReleasePort(opts: { cwd?: string; actor?: string } = {}): OpWaveReleasePort {
  return {
    async record(requests) {
      if (requests.length === 0) return [];
      const { maybeRecordAutoRelease } = await import("../components/auto-release");
      const { resolveRunId } = await import("../lifecycle/release-ledger");
      const { readAllReleases, readCuts } = await import("../lifecycle/release-store");
      const { releaseTemplatesDigest } = await import("../components/release-promote");
      const location = opts.cwd ? { cwd: opts.cwd } : undefined;
      let releases: Release[] = [];
      let cuts: ReleaseCut[] = [];
      try {
        releases = (await readAllReleases(location)).releases;
        cuts = (await readCuts(location)).cuts;
      } catch {
        // No release could be read: every record is an apply record.
      }
      const templates = (release: Release, env: string, component: string): string | null => {
        const target = release.targets.find((t) => t.env === env);
        return target ? releaseTemplatesDigest(target, component) : null;
      };
      const { runId, runOrigin } = resolveRunId();
      const out: OpWaveReleaseOutcome[] = [];
      for (const req of requests) {
        const joined = req.gitSha ? releaseOfCommit(releases, cuts, { commit: req.gitSha, env: req.env, component: req.component }, templates) : null;
        const got = await maybeRecordAutoRelease(
          {
            component: req.component,
            env: req.env,
            success: true,
            runId,
            ...(runOrigin ? { runOrigin } : {}),
            ...(req.approver ? { approver: req.approver } : {}),
            ...(joined ? { releaseDigest: joined.releaseDigest, templatesDigest: joined.templatesDigest } : {}),
            appliedDigest: { digest: req.planDigest, kind: "plan" },
          },
          { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(req.gitSha ? { gitSha: req.gitSha } : {}), ...(opts.actor ? { actor: opts.actor } : {}) },
        );
        if (got.recorded) {
          out.push({ recorded: true, env: req.env, component: req.component, digest: got.record.digest, ...(got.record.releaseDigest ? { releaseDigest: got.record.releaseDigest } : {}) });
        } else {
          out.push({ recorded: false, reason: got.reason === "error" ? got.error : got.detail ?? got.reason });
        }
      }
      return out;
    },
  };
}

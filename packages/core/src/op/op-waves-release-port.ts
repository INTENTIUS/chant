/**
 * The git-backed release port for op waves (#4615), apart from
 * `./op-waves-release.ts` so the spec checks `./op-waves.ts` imports reach no
 * release ledger, store or compile module. Only the wave loop
 * (`./op-waves-run.ts`) and the package index load this file.
 */

import type { Release, ReleaseCut } from "../lifecycle/release-store";
import { releaseOfCommit, type OpWaveReleaseOutcome, type OpWaveReleasePort } from "./op-waves-release";

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
          out.push({ recorded: false, reason: got.reason === "error" ? got.error : got.detail ?? got.reason, ...(got.reason === "error" && got.lost ? { lost: true as const } : {}) });
        }
      }
      return out;
    },
  };
}

/**
 * A fixture ledger for the estate (#4612), as `loadQueryData` would return
 * its `runs`, `gates`, `applies` and `pr_envs` tables. Two members apply
 * through `chant run wave`: `network`, a Terraform member (spec `tf-apply`,
 * targets are roots), and `web`, a Pulumi member (spec `pulumi-up`,
 * targets are stacks). `db` has no row; a schedule names it.
 *
 * The clock is {@link NOW}, Tuesday 2026-10-27 12:00 UTC.
 *
 * network
 *   change A (dA, c1)  deciding job 10-20 09:00; pending at the gate 09:05;
 *                      approved 10:00; two share jobs apply vpc (10:30)
 *                      and dns (10:40)
 *   change B (dB, c2)  10-22 08:10 fails on vpc
 *   change C (dC, c3)  10-22 12:10 applies vpc, restoring B after 4 hours
 *   drift (tf-drift, WatchOp, daily 06:00)
 *                      10-23 06:05 finds vpc drifted (after C: a failed change);
 *                      10-24 06:05 finds none; nothing since, so overdue
 * web
 *   change D (dD, p1)  10-21 14:20 applies web-prod, no gate
 *   change E (dE, p2)  10-27 09:02 waits at wave-1
 *   drift (pulumi-drift, Drift outcome, daily 07:00)
 *                      10-27 07:05 finds drift on no named stack
 *   pr-12 up and live; pr-9 up and torn down
 */
import type { QueryRow } from "../lifecycle/query";
import type { EstateTables } from "../ci-estate/rows";

export const NOW = new Date("2026-10-27T12:00:00.000Z");

const wave = (spec: string, number: number, job: "wave" | "decide" | "share" | "group", digest: string, applied: string[], failed: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ spec, number, name: `wave-${number}`, job, digest, exitCode: failed.length ? 1 : 0, applied, failed, moved: [], ...extra });

function run(member: string, id: string, op: string, started: string, ended: string, status: string, gitSha: string | null, w: string | null, outcomes: Record<string, unknown> = {}, labels: Record<string, string> = {}, gate: string | null = null): QueryRow {
  return {
    member,
    id,
    op,
    env: "local",
    started,
    ended,
    status,
    git_sha: gitSha,
    forge: "github",
    run_url: `https://forge.example/run/${id}`,
    failure_code: status === "fail" ? "command-failed" : null,
    failure_reason: null,
    failed_phase: null,
    gate,
    steward: null,
    labels: JSON.stringify(labels),
    outcomes: JSON.stringify(outcomes),
    root_member: null,
    wave: w,
  };
}

function gate(member: string, op: string, name: string, kind: "pending" | "resolution", timestamp: string, planDigest: string, resolvedBy: string | null = null): QueryRow {
  return { member, op, gate: name, kind, timestamp, resolved_by: resolvedBy, relayed_by: null, approver_kind: null, plan_digest: planDigest, environment: null, release_digest: null, git_sha: null, run_id: null, url: null, note: null, expires_at: null, origin: null, empty: 0, signed: 0, change_set: null, request: null };
}

export const ESTATE_TABLES: EstateTables = {
  runs: [
    // network: change A, decided then applied in two shares.
    run("network", "r-a0", "tf-apply", "2026-10-20T09:00:00.000Z", "2026-10-20T09:05:00.000Z", "gated", "c1", wave("tf-apply", 1, "decide", "dA", [], []), {}, {}, "wave-1"),
    run("network", "r-a1", "tf-apply", "2026-10-20T10:20:00.000Z", "2026-10-20T10:30:00.000Z", "ok", "c1", wave("tf-apply", 1, "share", "dA", ["vpc"], [], { share: 0 })),
    run("network", "r-a2", "tf-apply", "2026-10-20T10:25:00.000Z", "2026-10-20T10:40:00.000Z", "ok", "c1", wave("tf-apply", 1, "share", "dA", ["dns"], [], { share: 1 })),
    // network: change B fails, change C restores it.
    run("network", "r-b", "tf-apply", "2026-10-22T08:00:00.000Z", "2026-10-22T08:10:00.000Z", "fail", "c2", wave("tf-apply", 1, "wave", "dB", [], ["vpc"])),
    run("network", "r-c", "tf-apply", "2026-10-22T12:00:00.000Z", "2026-10-22T12:10:00.000Z", "ok", "c3", wave("tf-apply", 1, "wave", "dC", ["vpc"], [])),
    // network: drift checks by a WatchOp.
    run("network", "d-1", "tf-drift", "2026-10-23T06:00:00.000Z", "2026-10-23T06:05:00.000Z", "ok", "c3", null, { Drift: true, DriftedRoots: ["vpc"] }, { Watch: "true", Env: "local" }),
    run("network", "d-2", "tf-drift", "2026-10-24T06:00:00.000Z", "2026-10-24T06:05:00.000Z", "ok", "c3", null, { Drift: false }, { Watch: "true", Env: "local" }),
    // web: change D applies with no gate; change E waits.
    run("web", "r-d", "pulumi-up", "2026-10-21T14:00:00.000Z", "2026-10-21T14:20:00.000Z", "ok", "p1", wave("pulumi-up", 1, "wave", "dD", ["web-prod"], [])),
    run("web", "r-e", "pulumi-up", "2026-10-27T09:00:00.000Z", "2026-10-27T09:02:00.000Z", "gated", "p2", wave("pulumi-up", 1, "wave", "dE", [], []), {}, {}, "wave-1"),
    // web: a drift check named by its outcome alone.
    run("web", "d-3", "pulumi-drift", "2026-10-27T07:00:00.000Z", "2026-10-27T07:05:00.000Z", "ok", "p1", null, { Drift: true }),
    // A plain run that is neither a wave nor a drift check.
    run("web", "x-1", "notify", "2026-10-26T00:00:00.000Z", "2026-10-26T00:00:01.000Z", "ok", null, null),
  ],
  gates: [
    gate("network", "tf-apply", "wave-1", "pending", "2026-10-20T09:05:00.000Z", "dA"),
    gate("network", "tf-apply", "wave-1", "resolution", "2026-10-20T10:00:00.000Z", "dA", "alice"),
    gate("web", "pulumi-up", "wave-1", "pending", "2026-10-27T09:02:00.000Z", "dE"),
  ],
  applies: [
    { member: "network", op: "tf-apply", gate: "wave-1", kind: "applied", plan_digest: "dA", approved_at: "2026-10-20T10:00:00.000Z", approved_by: "alice", timestamp: "2026-10-20T10:20:00.000Z", run_id: "r-a1", git_sha: "c1", wave: JSON.stringify({ number: 1, name: "wave-1" }), finished_at: "2026-10-20T10:40:00.000Z", result: "applied", detail: null },
  ],
  pr_envs: [
    { member: "web", kind: "up", pr: 9, env: "pr-9", env_member: "web", template: "dev", git_sha: "p9", components: "[]", plan_digest: "d9", result: "applied", by: "bob", timestamp: "2026-10-25T10:00:00.000Z", expires_at: "2026-10-28T10:00:00.000Z", approvers: null, reason: null, run_url: null },
    { member: "web", kind: "down", pr: 9, env: "pr-9", env_member: "web", template: "dev", git_sha: "p9", components: "[]", plan_digest: "", result: "destroyed", by: "bob", timestamp: "2026-10-26T09:00:00.000Z", expires_at: null, approvers: null, reason: null, run_url: null },
    { member: "web", kind: "up", pr: 12, env: "pr-12", env_member: "web", template: "dev", git_sha: "p12", components: "[]", plan_digest: "d12", result: "applied", by: "carol", timestamp: "2026-10-26T10:00:00.000Z", expires_at: "2026-10-29T10:00:00.000Z", approvers: null, reason: null, run_url: "https://forge.example/run/pr12" },
  ],
};

/** The drift schedules the fixture's members run. `db` has none on record. */
export const ESTATE_SCHEDULES = [
  { op: "tf-drift", cron: "0 6 * * *", members: ["network", "db"] },
  { op: "pulumi-drift", cron: "0 7 * * *" },
] as const;

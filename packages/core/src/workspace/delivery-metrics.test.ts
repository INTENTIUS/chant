/**
 * #4039: the four DORA metrics from the deploy records, the releases and the
 * ci/revoked tags, with a failure window of 7 days. Against a temp repo;
 * nothing is pushed.
 *
 * The fixture's prod ledger, one member, failure window 7 days:
 *
 *   api  09-01 R1 | 09-03 R2 (R2's commit revoked 09-05) | 09-06 R3
 *   web  09-01 R1 | 09-10 R3 | 09-11 redeploy R3 | 09-14 rollback to R1 | 09-20 R4 | 09-30 rollback to R3
 *   db   09-21 no release, commit c4
 *
 * api's 09-03 deploy fails by revocation and is restored by the 09-06 deploy.
 * web's 09-10 deploy fails by the rollback 4 days later, which restores it;
 * the redeploy between them neither restores it nor hides the rollback, and
 * is counted apart from the deploys.
 * web's 09-20 deploy is rolled back 10 days later, outside the window, so it
 * did not fail.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import schema from "./delivery-metrics.schema.json";
import { contract } from "./__fixtures__/contract-repo";
import { deliveryMetrics, formatMetrics, type DeliveryMetricsDocument } from "./delivery-metrics";
import { appendCut, makeRelease, persistRelease, type Release } from "../lifecycle/release-store";
import { appendReleaseRecord, type ReleaseRecord, type ReleaseRecordInput } from "../lifecycle/release-ledger";
import { environmentMetrics, rollbackOf, type MetricsLookups } from "../lifecycle/delivery-metrics";
import { contentDigest } from "../content-digest";

const { expectValid } = contract(schema);

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const DAY = 86_400;
const t = (day: string) => `2026-09-${day}T00:00:00.000Z`;
const dated = (iso: string) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });

interface Fixture {
  commits: string[];
  releases: Release[];
}

/** Write the declaration, with `metrics` when given. Only the working tree's copy is read for it. */
function declare(dir: string, metrics: object | undefined): void {
  writeFileSync(
    join(dir, "chant.workspace.json"),
    JSON.stringify({ name: "acme", schema: 1, minReader: "0.80.0", members: [{ name: "root", dir: ".", kind: "other", because: "the fixture" }], ...(metrics ? { metrics } : {}) }, null, 2),
  );
}

/** The workspace, its four commits and releases, and the prod ledger above. */
async function setup(dir: string): Promise<Fixture> {
  git(dir, {}, "init", "-q", "-b", "main");
  git(dir, {}, "config", "user.email", "t@chant.dev");
  git(dir, {}, "config", "user.name", "T");
  declare(dir, { failureWindowDays: 7 });
  git(dir, {}, "add", ".");
  git(dir, dated("2026-08-30T00:00:00.000Z"), "commit", "-q", "-m", "c1");
  const commits = [git(dir, {}, "rev-parse", "HEAD")];
  for (const day of ["02", "05", "19"]) {
    git(dir, dated(t(day)), "commit", "-q", "--allow-empty", "-m", `c ${day}`);
    commits.push(git(dir, {}, "rev-parse", "HEAD"));
  }
  const releases = commits.map((commit) =>
    makeRelease({ member: null, commit, artifactDigests: [], targets: [{ env: "prod", templates: [{ component: "api", path: "t.json", digest: `sha256:${"c".repeat(64)}` }], params: [] }] }),
  );
  for (const [i, r] of releases.entries()) {
    await persistRelease(r, [], { cwd: dir });
    await appendCut({ releaseDigest: r.releaseDigest, label: `v1.${i}.0`, actor: "alice", timestamp: t("01"), runOrigin: null }, { cwd: dir });
  }

  const [R1, R2, R3, R4] = releases;
  const deploy = (component: string, day: string, release: Release | null, extra: Partial<ReleaseRecordInput> = {}): ReleaseRecordInput => ({
    component,
    env: "prod",
    digest: contentDigest(`${component} ${release?.releaseDigest ?? "plain"}`),
    gitSha: release?.commit ?? commits[3],
    runId: `${component}-${day}`,
    timestamp: t(day),
    actor: "ci",
    ...(release ? { releaseDigest: release.releaseDigest } : {}),
    ...extra,
  });
  const ref = (component: string, day: string) => ({ env: "prod", runId: `${component}-${day}`, timestamp: t(day) });
  const ledger: ReleaseRecordInput[] = [
    deploy("api", "01", R1),
    deploy("web", "01", R1),
    deploy("api", "03", R2),
    deploy("api", "06", R3),
    deploy("web", "10", R3),
    deploy("web", "11", R3, { redeploys: ref("web", "10") }),
    deploy("web", "14", R1, { restores: ref("web", "01") }),
    deploy("web", "20", R4),
    deploy("db", "21", null),
    deploy("web", "30", R3, { restores: ref("web", "10") }),
  ];
  for (const record of ledger) await appendReleaseRecord(record, { cwd: dir });

  // R2's commit is revoked on 09-05, two days after api deployed it.
  const record = { schema: 1, tag: "revoked", commit: commits[1], branch: "main", at: t("05"), phase: "test", run: { name: "test", id: 7, conclusion: "failure", url: null } };
  git(dir, dated(t("05")), "tag", "-a", "-m", `ci: phase test failed\n\n${JSON.stringify(record)}\n`, `ci/revoked/${commits[1]}`, commits[1]);
  return { commits, releases };
}

function result(doc: DeliveryMetricsDocument): Extract<DeliveryMetricsDocument, { members: unknown }> {
  expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const NOW = "2026-10-01T00:00:00.000Z";

// One fixture for the file: its ledger takes a commit per record. Each test
// sets the declaration it needs.
let dir: string;
let fixture: Fixture;
beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-4039-")));
  fixture = await setup(dir);
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DORA metrics from release, gate and revocation records (#4039)", () => {
  test("with N = 7: a revoked release, a rollback inside the window, a rollback outside it, and the restore time of each failure", async () => {
    declare(dir, { failureWindowDays: 7 });
    const { commits, releases } = fixture;
    const doc = result(await deliveryMetrics({ cwd: dir, since: t("01"), now: NOW }));
    expect(doc.failureWindowDays).toBe(7);
    expect(doc.workspace).toEqual({ name: "acme" });
    expect(doc.window).toEqual({ since: t("01"), until: NOW, days: 30 });
    const [prod] = doc.members[0].environments;
    expect(doc.members[0]).toMatchObject({ member: "root", reason: null });

    expect(prod.deployments).toEqual({ count: 9, redeploys: 1, runs: 9, fromRelease: 8, perWeek: 2.1 });

    // R1 2 days after c1, R2, R3 and R4 a day after theirs, db's plain commit c4 2 days after it.
    expect(prod.leadTime).toEqual({ changes: 5, fromRelease: 4, fromCommit: 1, unknown: 0, medianSeconds: DAY });

    expect(prod.changeFailure).toEqual({ deployments: 9, failed: 2, revoked: 1, rolledBack: 1, rate: 0.2222 });
    expect(prod.failures).toEqual([
      {
        component: "api",
        timestamp: t("03"),
        runId: "api-03",
        releaseDigest: releases[1].releaseDigest,
        label: "v1.1.0",
        commit: commits[1],
        causes: ["revoked"],
        revoked: { tag: `ci/revoked/${commits[1]}`, tagged: expect.stringMatching(/^2026-09-05T00:00:00/) },
        rolledBackBy: null,
        restoredBy: { runId: "api-06", timestamp: t("06") },
        restoreSeconds: 3 * DAY,
      },
      {
        component: "web",
        timestamp: t("10"),
        runId: "web-10",
        releaseDigest: releases[2].releaseDigest,
        label: "v1.2.0",
        commit: commits[2],
        causes: ["rolled-back"],
        revoked: null,
        rolledBackBy: { runId: "web-14", timestamp: t("14") },
        restoredBy: { runId: "web-14", timestamp: t("14") },
        restoreSeconds: 4 * DAY,
      },
    ]);
    // web's 09-20 deploy, rolled back on 09-30, is outside the 7 days and did not fail.
    expect(prod.failures.some((f) => f.timestamp === t("20"))).toBe(false);
    expect(prod.restore).toEqual({ restored: 2, open: 0, medianSeconds: 3.5 * DAY });

    expect(formatMetrics(doc)).toContain("root prod: 9 deploys (2.1/week), lead time 1d, change failure 22.2% (2/9), restore 3.5d");
  });

  test("the declaration's failure window decides, and 7 is the default", async () => {
    declare(dir, { failureWindowDays: 14 });
    const wide = result(await deliveryMetrics({ cwd: dir, since: t("01"), now: NOW }));
    // With 14 days the 09-30 rollback of the 09-20 deploy counts too.
    expect(wide.members[0].environments[0].changeFailure).toMatchObject({ failed: 3, rolledBack: 2 });
    expect(wide.members[0].environments[0].failures.at(-1)).toMatchObject({ timestamp: t("20"), restoredBy: { runId: "web-30" }, restoreSeconds: 10 * DAY });

    declare(dir, undefined);
    const doc = result(await deliveryMetrics({ cwd: dir, since: t("01"), now: NOW, env: "prod", members: ["root"] }));
    expect(doc.failureWindowDays).toBe(7);
    expect(doc.members[0].environments[0].changeFailure.failed).toBe(2);
    expect(await deliveryMetrics({ cwd: dir, env: "../x" })).toMatchObject({ error: { code: "environment-invalid" } });
    expect(await deliveryMetrics({ cwd: dir, members: ["nope"] })).toMatchObject({ error: { code: "declaration-invalid" } });
  });
});

describe("environmentMetrics", () => {
  const record = (component: string, day: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
    version: 1,
    component,
    env: "prod",
    digest: `sha256:${"a".repeat(64)}`,
    gitSha: "c".repeat(40),
    runId: `${component}-${day}`,
    timestamp: t(day),
    actor: "ci",
    ...extra,
  });
  const lookups: MetricsLookups = {
    releaseOf: (r) => r.releaseDigest,
    commitOfRelease: () => null,
    labelOf: () => null,
    revocationOf: () => null,
    commitTime: () => Date.parse("2026-08-31T00:00:00.000Z"),
  };

  test("a deploy before the window is not counted, and a failed deploy with no restore is open", () => {
    const m = environmentMetrics(
      "prod",
      [record("api", "01"), record("api", "10"), record("api", "12", { restores: { env: "prod", runId: "api-01", timestamp: t("01") } })],
      { ...lookups, revocationOf: (sha) => (sha === "c".repeat(40) ? { tag: "ci/revoked/c", tagged: null } : null) },
      { since: t("05"), until: NOW },
    );
    // Every commit is revoked here, with a lightweight tag, so nothing restores.
    expect(m.changeFailure).toEqual({ deployments: 2, failed: 2, revoked: 2, rolledBack: 1, rate: 1 });
    expect(m.restore).toEqual({ restored: 0, open: 2, medianSeconds: null });
    // The commit's first deploy was before the window, so it has no lead time here.
    expect(m.leadTime.changes).toBe(0);
  });

  test("a rollback is a record with restores; nothing else is", () => {
    expect(rollbackOf(record("api", "01"))).toBeNull();
    expect(rollbackOf(record("api", "02", { restores: { env: "prod", runId: "x", timestamp: t("01") } }))).toEqual({ env: "prod", runId: "x", timestamp: t("01") });
  });
});

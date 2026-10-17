/**
 * #4035: an environment a promote left mixed, as `workspace status --json`
 * shows it: what each component runs, and the redeploy and rollback lines
 * that settle it. Against temp repos; nothing is pushed.
 */

import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import statusSchema from "./status.schema.json";
import { formatStatus, workspaceStatus, type StatusDocument } from "./status";
import { appendCut, makeRelease, persistRelease, type Release } from "../lifecycle/release-store";
import { appendReleaseRecord, type ReleaseRecordInput } from "../lifecycle/release-ledger";
import { appendDeployOutcome } from "../lifecycle/deploy-outcome";
import { contentDigest } from "../content-digest";

const validateStatus = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
const NOW = "2026-10-17T14:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function result(doc: StatusDocument): Extract<StatusDocument, { members: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(validateStatus(doc), JSON.stringify(validateStatus.errors, null, 2)).toBe(true);
  return doc;
}

/** A workspace whose root member has releases v1.0.0 and v1.1.0 of api and web, and runs v1.0.0 in prod. */
async function setup(dir: string): Promise<{ v1: Release; v2: Release; deploy: (input: Partial<ReleaseRecordInput> & { component: string; timestamp: string; releaseDigest: string }) => Promise<void> }> {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  writeFileSync(
    join(dir, "chant.workspace.json"),
    JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the fixture" }] }, null, 2),
  );
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--allow-empty", "-m", "next");
  const second = git(dir, "rev-parse", "HEAD");
  const at = (commit: string) =>
    makeRelease({
      member: null,
      commit,
      artifactDigests: ["api", "web"].map((component) => ({ component, kind: "image" as const, path: `${component}.tar`, digest: contentDigest(`${component} ${commit}`) })),
      targets: [{ env: "prod", templates: [], params: [] }],
    });
  const v1 = at(first);
  const v2 = at(second);
  for (const [r, label, ts] of [[v1, "v1.0.0", "10"], [v2, "v1.1.0", "11"]] as const) {
    await persistRelease(r, [], { cwd: dir });
    await appendCut({ releaseDigest: r.releaseDigest, label, actor: "alice", timestamp: `2026-10-17T${ts}:00:00.000Z`, runOrigin: null }, { cwd: dir });
  }
  const deploy = async (input: Partial<ReleaseRecordInput> & { component: string; timestamp: string; releaseDigest: string }) => {
    await appendReleaseRecord(
      { env: "prod", digest: contentDigest(`${input.component} ${input.releaseDigest}`), gitSha: first, runId: "r", actor: "ci", ...input },
      { cwd: dir },
    );
  };
  for (const component of ["api", "web"]) await deploy({ component, timestamp: "2026-10-17T12:00:00.000Z", releaseDigest: v1.releaseDigest });
  return { v1, v2, deploy };
}

describe("a mixed environment in workspace status (#4035)", () => {
  test("a partly applied promote shows the environment mixed, with the redeploy and rollback lines, until it is settled", async () => {
    await withTestDir(async (dir) => {
      const { v1, v2, deploy } = await setup(dir);

      // Before the promote: one release, nothing mixed.
      const before = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW }));
      expect(before.members[0].environments[0]).not.toHaveProperty("mixed");

      // The promote of v1.1.0 deploys api and fails on web.
      const at = "2026-10-17T13:00:00.000Z";
      await deploy({ component: "api", timestamp: at, releaseDigest: v2.releaseDigest, runId: "run-9", promotedFrom: { env: "staging", runId: "run-8", timestamp: "2026-10-17T12:30:00.000Z" } });
      await appendDeployOutcome(
        {
          version: 1, env: "prod", verb: "promote", runId: "run-9", timestamp: at, actor: "bob", releaseDigest: v2.releaseDigest, status: "fail",
          components: [
            { component: "api", outcome: "deployed", digest: contentDigest(`api ${v2.releaseDigest}`), releaseDigest: v2.releaseDigest },
            { component: "web", outcome: "failed", digest: contentDigest(`web ${v2.releaseDigest}`), releaseDigest: v2.releaseDigest },
          ],
        },
        { cwd: dir },
      );

      const doc = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW }));
      const prod = doc.members[0].environments[0];
      expect(prod.mixed).toEqual({
        components: [
          { component: "api", digest: contentDigest(`api ${v2.releaseDigest}`), releaseDigest: v2.releaseDigest, releaseLabel: "v1.1.0", state: "settled", attempt: null },
          {
            component: "web",
            digest: contentDigest(`web ${v1.releaseDigest}`),
            releaseDigest: v1.releaseDigest,
            releaseLabel: "v1.0.0",
            state: "failed",
            attempt: { verb: "promote", runId: "run-9", timestamp: at, digest: contentDigest(`web ${v2.releaseDigest}`), releaseDigest: v2.releaseDigest, releaseLabel: "v1.1.0" },
          },
        ],
        redeploy: ["chant components redeploy prod --component web"],
        rollback: "chant components rollback prod --release v1.0.0",
      });
      expect(formatStatus(doc)).toContain("  prod is mixed: api runs release v1.1.0; web failed (promote run-9), recorded release v1.0.0");
      expect(formatStatus(doc)).toContain("    redeploy: chant components redeploy prod --component web");
      expect(formatStatus(doc)).toContain("    roll back: chant components rollback prod --release v1.0.0");

      // A redeploy of web settles it, but prod still runs two releases.
      await deploy({ component: "web", timestamp: "2026-10-17T13:10:00.000Z", releaseDigest: v1.releaseDigest, redeploys: { env: "prod", runId: "r", timestamp: "2026-10-17T12:00:00.000Z" } });
      const redeployed = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW })).members[0].environments[0];
      expect(redeployed.mixed).toMatchObject({
        components: [{ component: "api", state: "settled", releaseLabel: "v1.1.0" }, { component: "web", state: "settled", releaseLabel: "v1.0.0" }],
        redeploy: [],
        rollback: "chant components rollback prod --release v1.0.0",
      });

      // The same promote run again puts web on v1.1.0: one release, nothing mixed.
      await deploy({ component: "web", timestamp: "2026-10-17T13:20:00.000Z", releaseDigest: v2.releaseDigest });
      const settled = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW })).members[0].environments[0];
      expect(settled).not.toHaveProperty("mixed");
    });
  });

  test("a revoked release's rollback line names the release the environment ran before it", async () => {
    await withTestDir(async (dir) => {
      const { v2, deploy } = await setup(dir);
      for (const component of ["api", "web"]) await deploy({ component, timestamp: "2026-10-17T13:00:00.000Z", releaseDigest: v2.releaseDigest });
      writeFileSync(
        join(dir, "chant.workspace.json"),
        JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the fixture" }], ci: { green: { branch: "main", phases: { test: ["test"] }, require: ["test"] } } }, null, 2),
      );
      git(dir, "commit", "-q", "-am", "ci.green");
      const record = { schema: 1, tag: "revoked", commit: v2.commit, branch: "main", at: "2026-10-17T13:30:00.000Z", phase: "test", run: { name: "test", id: 77, conclusion: "failure", url: null } };
      git(dir, "tag", "-a", "-m", `ci: phase test failed\n\n${JSON.stringify(record, null, 2)}\n`, `ci/revoked/${v2.commit}`, v2.commit);

      const prod = result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW })).members[0].environments[0];
      expect(prod.releases.map((r) => [r.component, r.revoked?.rollback])).toEqual([
        ["api", "chant components rollback prod --release v1.0.0"],
        ["web", "chant components rollback prod --release v1.0.0"],
      ]);
      expect(prod).not.toHaveProperty("mixed");
    });
  });
});

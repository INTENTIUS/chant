import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { LedgerReadPort } from "./ledger-port";
import { writeBlobToPath } from "./git";
import { clearMemberLedgerCache } from "./member-ledger";
import { PLAN_STALE_FLOOR, PLAN_STALE_SCHEMA_ID, planStaleness } from "./plan-stale";
import { loadQueryData } from "./query";
import { NEXT_RELEASE } from "../release-floors";
import { planStaleDocument } from "../cli/handlers/plan";
import { loadAjv2020 } from "../workspace/ajv2020";
import planStaleSchema from "../workspace/plan-stale.schema.json";

/** A port over a map of `<dir>/<file>` to text, the shape `gitLedgerReadPort` reads. */
function port(files: Record<string, string>): LedgerReadPort {
  const dirs = (): string[] => [...new Set(Object.keys(files).map((p) => p.slice(0, p.indexOf("/"))))];
  return {
    read: async (dir, file) => files[`${dir}/${file}`] ?? null,
    list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    trees: async () => dirs(),
  };
}

const lines = (...rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const P1 = `jcs1-sha256:${"1".repeat(64)}`;
const P2 = `jcs1-sha256:${"2".repeat(64)}`;
const P3 = `jcs1-sha256:${"3".repeat(64)}`;

/** The run that planned P1 reached gate `prod` of op `deploy` in env `prod` at 10:00. */
const planned = {
  "_gates/deploy.jsonl": lines({ version: 1, kind: "pending", op: "deploy", gate: "prod", runId: "run-plan", gitSha: "a".repeat(40), timestamp: "2026-11-01T10:00:00Z", expiresAt: "2026-11-08T10:00:00Z", planDigest: P1 }),
  "prod/runs__deploy.jsonl": lines({ version: 1, id: "run-plan", op: "deploy", env: "prod", started: "2026-11-01T09:59:00Z", ended: "2026-11-01T10:00:00Z", status: "gated", labels: { Env: "prod" }, outcomes: {}, phases: [], gate: { name: "prod", since: "2026-11-01T10:00:00Z" } }),
};

const applied = (op: string, planDigest: string, timestamp: string, runId: string) => ({ version: 1, kind: "applied", op, gate: "prod", planDigest, approvedAt: timestamp, approvedBy: "carol", timestamp, runId, commit: "b".repeat(40) });
const deploy = (env: string, timestamp: string, actor: string, runId: string) => ({ version: 1, component: "api", env, digest: "sha256:aa", gitSha: "c".repeat(40), runId, runOrigin: { forge: "github", url: `https://example.test/run/${runId}` }, timestamp, actor, approver: "dave" });

async function stale(files: Record<string, string>, digest = P1, member: string | null = null) {
  const { data } = await loadQueryData([{ member, port: port(files) }]);
  return planStaleness(data, digest, "0.0.0-test");
}

describe("chant plan stale (#4648)", () => {
  test("an apply under an approval from another run after the plan makes it stale, and names who, when and which run", async () => {
    const doc = await stale({
      ...planned,
      "_gates/deploy/applied.jsonl": lines(applied("deploy", P2, "2026-11-01T11:00:00Z", "run-laptop"), { version: 1, kind: "finished", op: "deploy", gate: "prod", planDigest: P2, applied: "2026-11-01T11:00:00Z", result: "failed", timestamp: "2026-11-01T11:05:00Z" }),
    });
    expect(doc).toMatchObject({
      $schema: PLAN_STALE_SCHEMA_ID,
      contract: 1,
      digest: P1,
      plan: { recordedAt: "2026-11-01T10:00:00Z", runId: "run-plan", gitSha: "a".repeat(40), targets: [{ member: null, op: "deploy", gate: "prod", environment: "prod" }] },
      stale: true,
    });
    expect(!("error" in doc) && doc.applies).toEqual([
      { source: "applies", member: null, op: "deploy", gate: "prod", environment: null, component: null, planDigest: P2, at: "2026-11-01T11:00:00Z", actor: null, approvedBy: "carol", runId: "run-laptop", runUrl: null, gitSha: "b".repeat(40), result: "failed" },
    ]);
  });

  test("a deploy to the plan's environment after it makes it stale", async () => {
    const doc = await stale({ ...planned, "prod/releases.jsonl": lines(deploy("prod", "2026-11-01T12:00:00Z", "laptop-alex", "ci-77")) });
    expect(doc).toMatchObject({ stale: true, applies: [{ source: "deploys", environment: "prod", component: "api", actor: "laptop-alex", approvedBy: "dave", runId: "ci-77", runUrl: "https://example.test/run/ci-77", at: "2026-11-01T12:00:00Z" }] });
  });

  test("applies to unrelated targets, before the plan, or of the plan itself leave it current", async () => {
    const doc = await stale({
      ...planned,
      // Another op, and this op before the plan was recorded.
      "_gates/migrate/applied.jsonl": lines(applied("migrate", P3, "2026-11-01T11:00:00Z", "run-other")),
      "_gates/deploy/applied.jsonl": lines(applied("deploy", P2, "2026-11-01T09:00:00Z", "run-earlier"), applied("deploy", P1, "2026-11-01T10:30:00Z", "run-this-plan")),
      // Another environment, and this one before the plan.
      "staging/releases.jsonl": lines(deploy("staging", "2026-11-01T12:00:00Z", "ci", "ci-1")),
      "prod/releases.jsonl": lines(deploy("prod", "2026-11-01T09:30:00Z", "ci", "ci-0")),
    });
    expect(doc).toMatchObject({ stale: false, applies: [] });
  });

  test("another member's applies don't count", async () => {
    const { data } = await loadQueryData([
      { member: "app", port: port(planned) },
      { member: "db", port: port({ "_gates/deploy/applied.jsonl": lines(applied("deploy", P2, "2026-11-01T11:00:00Z", "r")), "prod/releases.jsonl": lines(deploy("prod", "2026-11-01T12:00:00Z", "ci", "c")) }) },
    ]);
    expect(planStaleness(data, P1, "0.0.0-test")).toMatchObject({ plan: { targets: [{ member: "app" }] }, stale: false, applies: [] });
  });

  test("a component gate's own environment is the target, and a plan nobody recorded is null", async () => {
    const component = {
      "_gates/api.jsonl": lines({ version: 1, kind: "pending", op: "api", gate: "release", environment: "staging", timestamp: "2026-11-01T10:00:00Z", expiresAt: "2026-11-08T10:00:00Z", planDigest: P1 }),
      "staging/releases.jsonl": lines(deploy("staging", "2026-11-01T10:01:00Z", "ci", "ci-2")),
    };
    expect(await stale(component)).toMatchObject({ plan: { targets: [{ op: "api", environment: "staging" }] }, stale: true, applies: [{ runId: "ci-2" }] });
    expect(await stale(component, P3)).toMatchObject({ plan: null, stale: null, applies: [] });
  });

  test("its floor is the release it shipped in", () => {
    expect(PLAN_STALE_FLOOR).toBe("0.124.63");
    expect(planStaleSchema.description).toContain(`written by chant ${NEXT_RELEASE} and newer`);
  });
});

describe("chant plan stale on a real ledger (#4648)", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });
  const git = (args: string[], cwd: string): void => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  test("reads the local chant/lifecycle branch, and the document matches its schema", async () => {
    clearMemberLedgerCache();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-plan-stale-")));
    scratch.push(dir);
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "test@chant.dev"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "README.md"), "fixture\n");
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "init"], dir);
    for (const [path, text] of Object.entries(planned)) {
      const at = path.lastIndexOf("/");
      await writeBlobToPath(path.slice(0, at), path.slice(at + 1), text, "fixture", { cwd: dir });
    }
    const Ajv = loadAjv2020();
    const validate = new Ajv({ strict: false, allErrors: true }).compile(planStaleSchema) as ((d: unknown) => boolean) & { errors?: unknown };

    const current = await planStaleDocument({ cwd: dir, digest: P1 });
    expect(current).toMatchObject({ stale: false, applies: [] });
    expect(validate(current), JSON.stringify(validate.errors)).toBe(true);

    await writeBlobToPath("_gates/deploy", "applied.jsonl", lines(applied("deploy", P2, "2026-11-01T11:00:00Z", "run-other")), "Applied under prod", { cwd: dir });
    const staled = await planStaleDocument({ cwd: dir, digest: P1 });
    expect(staled).toMatchObject({ stale: true, applies: [{ source: "applies", runId: "run-other", approvedBy: "carol" }] });
    expect(validate(staled), JSON.stringify(validate.errors)).toBe(true);

    const unknown = await planStaleDocument({ cwd: dir, digest: P3 });
    expect(unknown).toMatchObject({ plan: null, stale: null });
    expect(validate(unknown), JSON.stringify(validate.errors)).toBe(true);

    const nowhere = realpathSync(mkdtempSync(join(tmpdir(), "chant-plan-stale-nogit-")));
    scratch.push(nowhere);
    const failed = await planStaleDocument({ cwd: nowhere, digest: P1 });
    expect(failed).toMatchObject({ error: { code: "not-a-git-repository" } });
    expect(validate(failed), JSON.stringify(validate.errors)).toBe(true);
  });
});

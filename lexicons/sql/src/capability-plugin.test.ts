/**
 * The sql lexicon's capabilities (#4569): `sql-migrate` runs sql-yodeler's
 * engine through the fixed argv list (ruling A on sql-yodeler#285), and
 * `sql-apply` plans and applies a build with the lexicon's appliers. The
 * runner, planner and applier are fakes; the last block runs
 * `testdata/fake-yodel.mjs` as the project's `node_modules/.bin/yodel`, so no
 * real yodel and no server is involved.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { CapabilityRegistry, isPlanMovedError } from "@intentius/chant/components/capability";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { planOpWaveStep, applyOpWaveStep } from "@intentius/chant/op/op-waves-capability";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import {
  createSqlApplyCapability,
  createSqlMigrateCapability,
  sqlCapabilityPlugin,
  sqlMigrateFiles,
  wavePlanDestructive,
  YodelRunError,
  type SqlDeclarativePlan,
} from "./capability-plugin";
import { allowedYodelArgv, defaultYodelRunner, readerEnv, runAllowedYodel, YODEL_COMMANDS, type YodelRunner } from "./yodel-run";

const scratch = () => mkdtempSync(join(tmpdir(), "chant-sql-capability-"));

function writeJson(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
}

const part = (env: string, digest = "jcs1-sha256:migrations", status: "planned" | "failed" = "planned") => ({
  member: { member: "app", lexicon: "sql", planner: "sql", scope: env, status, ...(status === "failed" ? { error: "0001_init's checksum does not match the history" } : {}), planDigest: status === "failed" ? null : digest, holes: [] },
  entries: [{ member: "app", lexicon: "sql", planner: "sql", address: "app.users", type: "Postgres::Table", action: "update", disruption: "rolling", scope: env, attributes: [] }],
});

/** A runner that writes what yodel would, and records each call with its environment. */
function fakeRunner(cwd: string, answers: { planStatus?: "planned" | "failed"; waveDigest?: string; applyCode?: number; applyStderr?: string } = {}) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run: YodelRunner = async (args, opts) => {
    calls.push({ args, env: opts.env });
    if (args[0] === "plan") {
      writeJson(join(cwd, args[3]!), part(args[1]!, undefined, answers.planStatus));
      return { code: answers.planStatus === "failed" ? 4 : 0, stdout: "", stderr: "" };
    }
    if (args[2] === "--wave-plan") {
      writeJson(join(cwd, args[3]!), {
        planDigest: answers.waveDigest ?? "jcs1-sha256:wave",
        migrations: "jcs1-sha256:migrations",
        environment: args[1],
        empty: false,
        pending: ["0002_users_email"],
        destructiveSteps: [{ migration: "0002_users_email", step: 0, why: "pg-rewrite, pg-lock" }],
      });
      return { code: 0, stdout: "", stderr: "" };
    }
    const code = answers.applyCode ?? 0;
    return { code, stdout: code === 0 ? "Applied: 0002_users_email\n" : "", stderr: answers.applyStderr ?? "" };
  };
  return { run, calls };
}

const jobEnv = { PATH: "/usr/bin", YODEL_ROLE: "writer:dev", DEV_POSTGRES_WRITER_USER: "w", DEV_POSTGRES_WRITER_PASSWORD: "secret", DEV_POSTGRES_READER_USER: "r", DEV_POSTGRES_READER_PASSWORD: "read" };

describe("the yodel argv list (ruling A on sql-yodeler#285)", () => {
  test("the three commands, with the optional tail in order, are allowed", () => {
    expect(YODEL_COMMANDS).toEqual(["yodel plan <env> --part <file>", "yodel apply <env> --wave-plan <file> --spec <spec>", "yodel apply <env> --wave-apply <file> --spec <spec>"]);
    expect(allowedYodelArgv(["plan", "dev", "--part", "p.json"])).toBe(true);
    expect(allowedYodelArgv(["apply", "prod/@1of4", "--wave-plan", "w.json", "--spec", "yodel-waves.json", "--dir", "db", "--op", "migrate-prod", "--allow-out-of-order"])).toBe(true);
    expect(allowedYodelArgv(["apply", "dev", "--wave-apply", "w.json", "--spec", "yodel-waves.json"])).toBe(true);
  });

  test("anything else is refused before it runs", async () => {
    for (const args of [
      ["apply", "dev", "--execute"],
      ["apply", "dev"],
      ["plan", "dev", "--part", "p.json", "--comment"],
      ["plan", "dev", "--part", "--comment"],
      ["plan", "--json", "--part", "p.json"],
      ["apply", "dev", "--wave-apply", "w.json", "--spec", "s.json", "--op", "x", "--dir", "db"],
      ["apply", "dev", "--wave-apply", "w.json"],
      ["revert", "dev", "0001"],
      ["approve", "dev"],
    ]) {
      expect(allowedYodelArgv(args)).toBe(false);
    }
    let ran = false;
    await expect(runAllowedYodel(async () => ((ran = true), { code: 0, stdout: "", stderr: "" }), ["apply", "dev", "--execute"], { cwd: ".", env: {} })).rejects.toThrow(/chant runs only/);
    expect(ran).toBe(false);
  });

  test("the planning environment has no writer", () => {
    const env = readerEnv({ ...jobEnv, YODEL_CREDENTIALS: "writer", PROD_CLICKHOUSE_WRITER_PASSWORD: "x" });
    expect(env).toEqual({ PATH: "/usr/bin", DEV_POSTGRES_READER_USER: "r", DEV_POSTGRES_READER_PASSWORD: "read" });
  });
});

describe("sql-migrate", () => {
  test("a pull request's plan: the part with real counts, under the migrations' digest", async () => {
    const cwd = scratch();
    const { run, calls } = fakeRunner(cwd);
    const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
    const planned = await cap.plan!({ env: "dev", component: "db" }, { environment: "dev" });
    expect(calls.map((c) => c.args)).toEqual([["plan", "dev", "--part", sqlMigrateFiles("dev").part]]);
    expect(planned.member).toBe("dev");
    expect(planned.planDigest).toBe("jcs1-sha256:migrations");
    expect(planned.changeSet?.member.member).toBe("dev");
    expect(planned.changeSet?.entries.map((e) => [e.member, e.address, e.action])).toEqual([["dev", "app.users", "update"]]);
    expect(planned.destructive).toBeUndefined();
    expect(calls[0]!.env.YODEL_ROLE).toBeUndefined();
    expect(calls[0]!.env.DEV_POSTGRES_WRITER_PASSWORD).toBeUndefined();
  });

  test("a pull request's plan does not apply: run refuses without a wave's plan (ruling E)", async () => {
    const cwd = scratch();
    const { run, calls } = fakeRunner(cwd);
    const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
    const planned = await cap.plan!({ env: "dev", component: "db" }, { environment: "dev" });
    await expect(cap.run({ env: "dev", component: "db", plans: { dev: planned.artifact } }, { environment: "dev" })).rejects.toThrow(/merged branch/);
    await expect(cap.run({ env: "dev", component: "db" }, { environment: "dev" })).rejects.toThrow(/only the plan an op wave decided/);
    expect(calls.filter((c) => c.args[2] === "--wave-apply")).toEqual([]);
  });

  test("a plan the engine would refuse fails, naming the refusal", async () => {
    const cwd = scratch();
    const { run } = fakeRunner(cwd, { planStatus: "failed" });
    const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
    const err = await cap.plan!({ env: "dev", component: "db" }, { environment: "dev" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YodelRunError);
    expect((err as Error).message).toMatch(/checksum does not match/);
    expect((err as YodelRunError).chantExit).toBe(CHANT_EXIT.failed);
  });

  test("in an op wave: the wave plan's digest, the engine's destructive classes, then the apply with the writer", async () => {
    const cwd = scratch();
    writeJson(join(cwd, "yodel-waves.json"), { name: "yodel-apply", waves: [{ name: "dev", runs: [{ target: "dev" }] }] });
    const { run, calls } = fakeRunner(cwd);
    const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
    const input = { environment: "dev", spec: "yodel-waves.json", dir: "db" };
    const planned = await cap.plan!({ env: "dev", component: "dev" }, input);
    expect(planned.planDigest).toBe("jcs1-sha256:wave");
    expect(planned.changeSet?.member.planDigest).toBe("jcs1-sha256:wave");
    expect(planned.destructive).toEqual(["pg-lock", "pg-rewrite"]);
    const out = await cap.run({ env: "dev", component: "dev", plans: { dev: planned.artifact } }, input);
    expect(out.summary).toBe("Applied: 0002_users_email");
    const files = sqlMigrateFiles("dev");
    expect(calls.map((c) => c.args)).toEqual([
      ["plan", "dev", "--part", files.part, "--dir", "db"],
      ["apply", "dev", "--wave-plan", files.wavePlan, "--spec", "yodel-waves.json", "--dir", "db"],
      ["apply", "dev", "--wave-apply", files.wavePlan, "--spec", "yodel-waves.json", "--dir", "db"],
    ]);
    // The writer reaches the apply alone.
    expect(calls.map((c) => c.env.DEV_POSTGRES_WRITER_PASSWORD ?? null)).toEqual([null, null, "secret"]);
    expect(calls.map((c) => c.env.YODEL_ROLE ?? null)).toEqual([null, null, "writer:dev"]);
  });

  test("an apply the engine refuses as moved is a moved plan; a held lock is not", async () => {
    const cwd = scratch();
    writeJson(join(cwd, "yodel-waves.json"), { name: "yodel-apply", waves: [{ name: "dev", runs: [{ target: "dev" }] }] });
    const input = { environment: "dev", spec: "yodel-waves.json" };
    for (const [answers, moved, chantExit] of [
      [{ applyCode: 4 }, true, CHANT_EXIT.moved],
      [{ applyCode: 1, applyStderr: "refused: dev's wave plan moved since the wave was decided" }, false, CHANT_EXIT.failed],
      [{ applyCode: 5 }, false, CHANT_EXIT.held],
    ] as const) {
      const { run } = fakeRunner(cwd, answers);
      const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
      const planned = await cap.plan!({ env: "dev", component: "dev" }, input);
      const err = await cap.run({ env: "dev", component: "dev", plans: { dev: planned.artifact } }, input).catch((e: unknown) => e);
      expect(isPlanMovedError(err)).toBe(moved);
      if (!moved) expect((err as YodelRunError).chantExit).toBe(chantExit);
    }
  });

  test("a legacy yodel's moved plan is read from its line", async () => {
    const cwd = scratch();
    writeJson(join(cwd, "yodel-waves.json"), { name: "yodel-apply", waves: [{ name: "dev", runs: [{ target: "dev" }] }] });
    const input = { environment: "dev", spec: "yodel-waves.json", legacyExit: true };
    const { run } = fakeRunner(cwd, { applyCode: 1, applyStderr: "refused: dev's wave plan moved since the wave was decided (decided a, now b)" });
    const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
    const planned = await cap.plan!({ env: "dev", component: "dev" }, input);
    const err = await cap.run({ env: "dev", component: "dev", plans: { dev: planned.artifact } }, input).catch((e: unknown) => e);
    expect(isPlanMovedError(err)).toBe(true);
  });

  test("a wave plan file rewritten since the decision refuses as moved, and yodel never runs", async () => {
    const cwd = scratch();
    writeJson(join(cwd, "yodel-waves.json"), { name: "yodel-apply", waves: [{ name: "dev", runs: [{ target: "dev" }] }] });
    const input = { environment: "dev", spec: "yodel-waves.json" };
    const { run, calls } = fakeRunner(cwd);
    const cap = createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv });
    const planned = await cap.plan!({ env: "dev", component: "dev" }, input);
    writeJson(join(cwd, sqlMigrateFiles("dev").wavePlan), { planDigest: "jcs1-sha256:other", migrations: "x" });
    const err = await cap.run({ env: "dev", component: "dev", plans: { dev: planned.artifact } }, input).catch((e: unknown) => e);
    expect(isPlanMovedError(err)).toBe(true);
    expect(calls.some((c) => c.args[2] === "--wave-apply")).toBe(false);
  });

  test("an op wave's step plans through it, destructive by the engine's classes, and applies with no callback", async () => {
    const cwd = scratch();
    writeJson(join(cwd, "yodel-waves.json"), { name: "yodel-apply", waves: [{ name: "dev", runs: [{ target: "dev" }] }] });
    const { run, calls } = fakeRunner(cwd);
    const registry = new CapabilityRegistry().register(createSqlMigrateCapability({ run, cwd: () => cwd, env: () => jobEnv }));
    const spec = { name: "yodel-apply", op: "migrate-dev", step: { kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" }, waves: [{ name: "dev", runs: [{ target: "dev" }] }] } as unknown as OpWavesSpec;
    const wave = spec.waves[0]!;
    const runOf = wave.runs![0]!;
    const plan = await planOpWaveStep({ spec, wave, cwd, registry, planPath: ".chant/op-waves/yodel-apply/wave-1/dev.plan.json" }, runOf);
    expect(plan.planDigest).toBe("jcs1-sha256:wave");
    expect(plan.destructive).toBe(true);
    expect(plan.empty).toBe(false);
    const applied = await applyOpWaveStep({ spec, wave, registry }, runOf, plan);
    expect(applied.outcome).toBe("applied");
    expect(calls.map((c) => c.args[2] ?? c.args[0])).toEqual(["--part", "--wave-plan", "--wave-apply"]);
  });

  test("wavePlanDestructive splits and sorts each step's rules", () => {
    expect(wavePlanDestructive({ destructiveSteps: [{ why: "op-step" }, { why: "destructive, pg-lock" }, { why: "pg-lock" }] })).toEqual(["destructive", "op-step", "pg-lock"]);
    expect(wavePlanDestructive({})).toEqual([]);
  });
});

describe("sql-migrate against a fake yodel binary", () => {
  test("the project's node_modules/.bin/yodel runs, and only the apply holds the writer", async () => {
    const cwd = scratch();
    const bin = join(cwd, "node_modules", ".bin", "yodel");
    mkdirSync(dirname(bin), { recursive: true });
    copyFileSync(join(import.meta.dirname, "testdata", "fake-yodel.mjs"), bin);
    chmodSync(bin, 0o755);
    writeJson(join(cwd, "yodel-waves.json"), { name: "yodel-apply", waves: [{ name: "dev", runs: [{ target: "dev" }] }] });
    const log = join(cwd, "calls.jsonl");
    const cap = createSqlMigrateCapability({ run: defaultYodelRunner, cwd: () => cwd, env: () => ({ ...process.env, ...jobEnv, PATH: process.env.PATH, FAKE_YODEL_LOG: log }) });
    const input = { environment: "dev", spec: "yodel-waves.json" };
    const planned = await cap.plan!({ env: "dev", component: "dev" }, input);
    expect(planned.changeSet?.entries.map((e) => e.action).sort()).toEqual(["create", "update"]);
    const out = await cap.run({ env: "dev", component: "dev", plans: { dev: planned.artifact } }, input);
    expect(out.summary).toBe("Applied: 0002_users_email");
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; role: string | null; writer: string | null });
    expect(lines.map((l) => [l.args[0], l.args[2], l.role, l.writer])).toEqual([
      ["plan", "--part", null, null],
      ["apply", "--wave-plan", null, null],
      ["apply", "--wave-apply", "writer:dev", "secret"],
    ]);
  });
});

describe("sql-apply", () => {
  const build = (dialect: "clickhouse" | "postgres") => {
    const cwd = scratch();
    const path = join(cwd, "schema.json");
    writeJson(path, { dialect });
    return path;
  };
  const plan = (over: Partial<SqlDeclarativePlan> = {}): SqlDeclarativePlan => ({
    dialect: "postgres",
    changes: [
      { object: "app.users", field: "columns.email", rule: "SQLPG201", class: "metadata", after: "text" },
      { object: "app.users", field: "columns.name", rule: "SQLPG240", class: "rewrite" },
      { object: "app.audit", field: "name", rule: "SQLPG100", class: "create" },
    ],
    refused: [],
    holes: [],
    problems: [],
    ...over,
  });

  test("plans the build against the server as one entry per object, and applies the decided plan", async () => {
    const path = build("postgres");
    const applied: string[] = [];
    const cap = createSqlApplyCapability({ plan: async () => plan(), apply: async (input, dialect) => (applied.push(`${dialect}:${input.environment}`), { applied: ["table/app.users"], pruned: [], notAttempted: [] }) });
    const planned = await cap.plan!({ env: "prod", component: "db" }, { environment: "prod", build: path });
    expect(planned.changeSet?.entries.map((e) => [e.address, e.action, e.disruption])).toEqual([
      ["app.users", "update", "rolling"],
      ["app.audit", "create", undefined],
    ]);
    const out = await cap.run({ env: "prod", component: "db", plans: { prod: planned.artifact } }, { environment: "prod", build: path });
    expect(out.applied).toEqual(["table/app.users"]);
    expect(applied).toEqual(["postgres:prod"]);
  });

  test("a server that moved since the decision refuses as moved and sends nothing", async () => {
    const path = build("postgres");
    let n = 0;
    let sent = false;
    const cap = createSqlApplyCapability({
      plan: async () => (n++ === 0 ? plan() : plan({ changes: [{ object: "app.users", field: "columns.email", rule: "SQLPG201", class: "drop", destructive: true }] })),
      apply: async () => ((sent = true), { applied: [], pruned: [], notAttempted: [] }),
    });
    const planned = await cap.plan!({ env: "prod", component: "db" }, { environment: "prod", build: path });
    const err = await cap.run({ env: "prod", component: "db", plans: { prod: planned.artifact } }, { environment: "prod", build: path }).catch((e: unknown) => e);
    expect(isPlanMovedError(err)).toBe(true);
    expect(sent).toBe(false);
  });

  test("a rebuild the applier refuses fails the plan, naming the Op", async () => {
    const path = build("clickhouse");
    const cap = createSqlApplyCapability({ plan: async () => plan({ dialect: "clickhouse", refused: [{ object: "db.events", field: "orderBy", op: "ClickHouseRebuildOp" }] }) });
    await expect(cap.plan!({ env: "prod", component: "db" }, { environment: "prod", build: path })).rejects.toThrow(/ClickHouseRebuildOp/);
  });

  test("run refuses with no decided plan", async () => {
    const path = build("postgres");
    const cap = createSqlApplyCapability({ plan: async () => plan() });
    await expect(cap.run({ env: "prod", component: "db" }, { environment: "prod", build: path })).rejects.toThrow(/planned and decided first/);
  });
});

describe("the plugin", () => {
  test("is a capability plugin with both kinds", () => {
    expect(isCapabilityPlugin(sqlCapabilityPlugin)).toBe(true);
    expect(sqlCapabilityPlugin.capabilities().map((c) => c.kind)).toEqual(["sql-migrate", "sql-apply"]);
  });
});

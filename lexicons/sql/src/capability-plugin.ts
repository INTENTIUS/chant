/**
 * The sql lexicon's capability plugin (#4569): `sql-migrate` and
 * `sql-apply`, so op waves (`step: { kind, ...input }`, #4545) and
 * `chant components pr-plan` plan and apply a SQL member through chant, as
 * they do a Terraform root (`terraform-apply`). A project that lists `sql`
 * among its lexicons gets both registered when its registry is built
 * (`loadCapabilityPluginsFromLexicons`).
 *
 * ## sql-migrate: the versioned path
 *
 * The versioned migration engine stays in sql-yodeler (ruling A on
 * sql-yodeler#285), and this capability runs it through the fixed argv list
 * in `./yodel-run.ts`:
 *
 * ```json
 * { "step": { "kind": "sql-migrate", "environment": "{target}", "spec": "yodel-waves.json" } }
 * ```
 *
 * - `plan` runs `yodel plan <env> --part <file>` for the change-set part,
 *   one entry per object the pending migrations touch, with real counts.
 *   With `spec` (an op wave) it also runs `yodel apply <env> --wave-plan
 *   <file> --spec <spec>`, and the wave plan's digest is the member's: the
 *   value the wave's gate binds and the engine checks again under its lock.
 *   The wave plan's destructive steps come back as
 *   {@link CapabilityPlan.destructive}, each the lint rule that classes it,
 *   so `on-destructive` waits on what the engine calls destructive. Without
 *   `spec` (a pull request's plan) the digest is the migrations' own, the
 *   one `yodel approve` binds. A plan the engine would refuse fails the
 *   plan, naming the refusal.
 * - `run` runs `yodel apply <env> --wave-apply <file> --spec <spec>` with
 *   the plan the wave decided, which `DeployContext.plans` hands back. The
 *   engine plans again under its lock and refuses a plan that moved; that
 *   refusal is a moved plan here ({@link SqlPlanMovedError}), and the wave
 *   exits 4. The engine also checks chant's decision for the wave and the
 *   gate ledger's approval itself (ruling A on sql-yodeler#300), so an
 *   apply that chant let through and the ledger does not hold still refuses.
 *   `run` applies only a plan an op wave made with `spec`: an apply happens
 *   on the merged branch, never before the merge (ruling E on
 *   sql-yodeler#285).
 *
 * yodel's exit status reads through `yodelExitOf` (`./exit-codes.ts`,
 * #4570). A yodel before sql-yodeler#288 exits by its own table; set
 * `legacyExit: true` for one, and its moved plan is read from the line it
 * prints.
 *
 * The planning commands run without the writer's variables; only the apply
 * gets them (`readerEnv` in `./yodel-run.ts`).
 *
 * ## sql-apply: the declarative path
 *
 * `sql-apply` plans a build (`chant build -o dist/schema.json`) against the
 * environment's server, as `chant sql plan` does, and applies it with the
 * lexicon's applier, `clickhouseApply` or `postgresApply`, by the build's
 * dialect:
 *
 * ```json
 * { "kind": "sql-apply", "environment": "prod", "build": "dist/schema.json" }
 * ```
 *
 * The part has one entry per object the classified changes touch. A change
 * the applier refuses (a ClickHouse rebuild, a Postgres expand and contract),
 * an object the plan cannot read, or a named collection the server lacks
 * fails the plan, naming the migration Op to run instead. `run` plans again
 * and applies only when the digest is still the one decided; otherwise it
 * refuses as moved and sends nothing.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capability, CapabilityPlan, DeployContext } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { readChangeSetPartFile, type ChangeSetHole, type ChangeSetPart } from "@intentius/chant/change-set";
import { CHANT_EXIT, type ChantExitCode } from "@intentius/chant/exit-codes";
import { sqlDeclarativePlanPart, type SqlDeclarativeChange } from "./change-set";
import { yodelExitOf } from "./exit-codes";
import {
  defaultYodelRunner,
  readerEnv,
  runAllowedYodel,
  yodelPlanArgs,
  yodelWaveApplyArgs,
  yodelWavePlanArgs,
  type YodelCommonOptions,
  type YodelRun,
  type YodelRunner,
} from "./yodel-run";

/** A plan that moved since it was decided: nothing was applied (core's `isPlanMovedError`). */
export class SqlPlanMovedError extends Error {
  readonly planMoved = true;
  constructor(
    readonly member: string,
    message: string,
  ) {
    super(message);
    this.name = "SqlPlanMovedError";
  }
}

/** A yodel run that did not succeed, with the code chant's table gives it. */
export class YodelRunError extends Error {
  constructor(
    message: string,
    /** The table's code for the run (`CHANT_EXIT`). Named so core never reads it as an exit code. */
    readonly chantExit: ChantExitCode,
    readonly yodelExit: number | null,
  ) {
    super(message);
    this.name = "YodelRunError";
  }
}

// ── sql-migrate ───────────────────────────────────────────────────────────────

/** The input of a `sql-migrate` step. */
export interface SqlMigrateStepInput {
  /** The yodel environment (`{target}` in an op wave), a tenant (`<env>/<tenant>`) or a slot of a tenant set. */
  environment: string;
  /** The yodel project directory, relative to the job's working directory. Default: the working directory. */
  dir?: string;
  /** The migrations Op, when more than one applies the environment. */
  op?: string;
  allowOutOfOrder?: boolean;
  /**
   * The op-waves spec file the wave runs (`yodel-waves.json`), which the
   * engine reads chant's decision for the wave by. Set: plan the wave plan
   * and allow `run`. Absent: plan the migrations only, as a pull request's
   * plan does; `run` refuses.
   */
  spec?: string;
  /** The yodel predates sql-yodeler#288 and exits by its own table. */
  legacyExit?: boolean;
}

/** What `sql-migrate`'s plan hands its run. */
export interface SqlMigrateArtifact {
  kind: "sql-migrate";
  environment: string;
  planDigest: string;
  /** The wave plan file `--wave-plan` wrote, relative to the working directory. */
  wavePlan?: string;
  spec?: string;
  /** The migrations' own digest, as `yodel apply --digest` prints it. */
  migrations?: string;
  pending: string[];
}

export interface SqlMigrateStepOutput {
  environment: string;
  planDigest: string;
  /** What yodel printed on standard output: `Applied: ...`, `Nothing to apply.` or the stand-down line. */
  summary: string;
}

/** The parts of the wave plan file `yodel apply --wave-plan` writes that the capability reads. */
interface YodelWavePlanFile {
  planDigest: string;
  migrations?: string;
  environment?: string;
  empty?: boolean;
  pending?: string[];
  destructiveSteps?: Array<{ migration?: string; step?: number; why?: string }>;
}

/** What `sql-migrate` is built with. Tests pass a fake runner. */
export interface SqlMigrateDeps {
  run?: YodelRunner;
  /** The job's working directory. Default `process.cwd()`. */
  cwd?: () => string;
  /** The job's environment. Default `process.env`. */
  env?: () => NodeJS.ProcessEnv;
}

/** Where the capability keeps a run's yodel files, relative to the working directory. */
export function sqlMigrateFiles(environment: string): { part: string; wavePlan: string } {
  const key = environment.replace(/[^A-Za-z0-9._-]/g, "_");
  return { part: `.chant/sql/yodel/${key}.part.json`, wavePlan: `.chant/sql/yodel/${key}.wave-plan.json` };
}

function requireEnvironment(input: SqlMigrateStepInput): void {
  if (typeof input?.environment !== "string" || input.environment.trim() === "" || input.environment.startsWith("-")) {
    throw new Error("sql-migrate: the step needs `environment`, the yodel environment to migrate (\"{target}\" in an op wave)");
  }
  if (input.spec !== undefined && (typeof input.spec !== "string" || input.spec === "" || input.spec.startsWith("-"))) {
    throw new Error("sql-migrate: `spec` must name the op-waves spec file, such as \"yodel-waves.json\"");
  }
}

const commonOf = (input: SqlMigrateStepInput): YodelCommonOptions => ({
  ...(input.dir ? { dir: input.dir } : {}),
  ...(input.op ? { op: input.op } : {}),
  ...(input.allowOutOfOrder ? { allowOutOfOrder: true } : {}),
});

/** The last few lines a failed run printed, for a message. */
function tail(run: YodelRun): string {
  const text = (run.stderr || run.stdout).trim();
  return text.split("\n").slice(-4).join("\n");
}

/** A failed yodel run as an error, its exit read through chant's table. */
function runError(what: string, run: YodelRun, command: string, legacy: boolean): YodelRunError {
  if (run.missingBinary) return new YodelRunError(`${what}: the yodel binary was not found (the project's node_modules/.bin/yodel, or yodel on PATH); install @intentius/sql-yodeler`, CHANT_EXIT.failed, null);
  const chantExit = yodelExitOf({ code: run.code, command, legacy });
  return new YodelRunError(`${what} exited ${run.code === null ? "without a status" : String(run.code)}: ${tail(run)}`, chantExit, run.code);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

/** The destructive classes of a wave plan: each step's rules, as the engine's lint names them, sorted. */
export function wavePlanDestructive(plan: Pick<YodelWavePlanFile, "destructiveSteps">): string[] {
  const out = new Set<string>();
  for (const s of plan.destructiveSteps ?? []) for (const why of (s.why ?? "").split(",")) if (why.trim()) out.add(why.trim());
  return [...out].sort();
}

function isSqlMigrateArtifact(value: unknown): value is SqlMigrateArtifact {
  const v = value as Partial<SqlMigrateArtifact> | undefined;
  return v?.kind === "sql-migrate" && typeof v.environment === "string" && typeof v.planDigest === "string";
}

/** A legacy yodel's moved wave plan, read from the line it prints (it exits 1, as for any error). */
const LEGACY_MOVED = /wave plan moved since the wave was decided/;

/** The `sql-migrate` capability, with its runner and environment injectable. */
export function createSqlMigrateCapability(deps: SqlMigrateDeps = {}): Capability<SqlMigrateStepInput, SqlMigrateStepOutput> {
  const run = deps.run ?? defaultYodelRunner;
  const cwdOf = deps.cwd ?? (() => process.cwd());
  const envOf = deps.env ?? (() => process.env);
  return {
    kind: "sql-migrate",
    // A migration has no undo short of a revert, which is a change of its own (`yodel revert`).
    rollbackPolicy: "needs-opt-out",
    targets: { refuse: "sql-migrate applies an environment's pending migrations in chain order, so it cannot narrow to some objects" },
    async plan(_ctx: DeployContext, input: SqlMigrateStepInput): Promise<CapabilityPlan> {
      requireEnvironment(input);
      const cwd = cwdOf();
      const env = input.environment;
      const files = sqlMigrateFiles(env);
      const legacy = input.legacyExit === true;
      const reader = readerEnv(envOf());
      const opts = { cwd, env: reader, ...(input.dir ? { dir: input.dir } : {}) };
      mkdirSync(dirname(join(cwd, files.part)), { recursive: true });
      // A file an earlier plan left must not pass for this one's.
      rmSync(join(cwd, files.part), { force: true });
      rmSync(join(cwd, files.wavePlan), { force: true });

      // The part: real counts, one entry per object the pending migrations touch.
      const planned = await runAllowedYodel(run, yodelPlanArgs(env, files.part, commonOf(input)), opts);
      if (!existsSync(join(cwd, files.part))) throw runError(`sql-migrate: yodel plan ${env}`, planned, "plan", legacy);
      const part: ChangeSetPart = readChangeSetPartFile(readJson(join(cwd, files.part)), "sql", env, "sql");
      if (part.member.status === "failed") {
        // A refusal no approval fixes (a checksum, a fork, the directory): `failed` on chant's table (#4570).
        throw new YodelRunError(`sql-migrate: yodel would refuse to apply ${env}: ${part.member.error ?? tail(planned)}`, CHANT_EXIT.failed, planned.code);
      }

      // 2: a pending step the engine does not run; the part still says which, and the wave plan refuses it.
      if (planned.code !== 0 && planned.code !== 2) throw runError(`sql-migrate: yodel plan ${env}`, planned, "plan", legacy);

      if (input.spec === undefined) {
        // A pull request's plan: the migrations' digest, the one `yodel approve` binds.
        const planDigest = part.member.planDigest!;
        const artifact: SqlMigrateArtifact = { kind: "sql-migrate", environment: env, planDigest, migrations: planDigest, pending: [] };
        return { member: env, planDigest, artifact, changeSet: part };
      }

      if (!existsSync(join(cwd, input.spec))) throw new Error(`sql-migrate: the op-waves spec ${input.spec} is not in ${cwd}; the engine reads chant's decision for the wave by it`);
      const waved = await runAllowedYodel(run, yodelWavePlanArgs(env, files.wavePlan, input.spec, commonOf(input)), opts);
      if (waved.code !== 0 || !existsSync(join(cwd, files.wavePlan))) throw runError(`sql-migrate: yodel apply ${env} --wave-plan`, waved, "apply", legacy);
      const wave = readJson(join(cwd, files.wavePlan)) as YodelWavePlanFile;
      if (typeof wave.planDigest !== "string" || wave.planDigest === "") throw new Error(`sql-migrate: ${files.wavePlan} has no planDigest; it is not a plan yodel apply --wave-plan wrote`);
      const destructive = wavePlanDestructive(wave);
      const artifact: SqlMigrateArtifact = {
        kind: "sql-migrate",
        environment: env,
        planDigest: wave.planDigest,
        wavePlan: files.wavePlan,
        spec: input.spec,
        ...(wave.migrations ? { migrations: wave.migrations } : {}),
        pending: wave.pending ?? [],
      };
      // The member's digest is the wave plan's, so a gate on the member alone and the wave bind one value.
      const changeSet: ChangeSetPart = { ...part, member: { ...part.member, planDigest: wave.planDigest } };
      return { member: env, planDigest: wave.planDigest, artifact, changeSet, ...(destructive.length > 0 ? { destructive } : {}) };
    },
    async run(ctx: DeployContext, input: SqlMigrateStepInput): Promise<SqlMigrateStepOutput> {
      requireEnvironment(input);
      const env = input.environment;
      const decided = ctx.plans?.[env];
      if (!isSqlMigrateArtifact(decided) || decided.wavePlan === undefined || decided.spec === undefined) {
        throw new Error(
          `sql-migrate: ${env} applies only the plan an op wave decided, planned with \`spec\`; migrations apply on the merged branch, never before the merge (sql-yodeler#285, ruling E). Nothing was applied`,
        );
      }
      const cwd = cwdOf();
      const legacy = input.legacyExit === true;
      const file = join(cwd, decided.wavePlan);
      if (!existsSync(file)) throw new Error(`sql-migrate: the wave plan of ${env} is gone from ${decided.wavePlan}; nothing was applied. Run the wave again`);
      const onDisk = readJson(file) as Partial<YodelWavePlanFile>;
      if (onDisk.planDigest !== decided.planDigest) {
        throw new SqlPlanMovedError(env, `sql-migrate: ${decided.wavePlan} holds plan ${String(onDisk.planDigest)}, and the wave decided ${decided.planDigest}; nothing was applied`);
      }
      // The apply alone runs with the job's environment, so the writer reaches it and nothing else.
      const applied = await runAllowedYodel(run, yodelWaveApplyArgs(env, decided.wavePlan, decided.spec, commonOf(input)), { cwd, env: envOf(), ...(input.dir ? { dir: input.dir } : {}) });
      if (applied.code === 0) return { environment: env, planDigest: decided.planDigest, summary: applied.stdout.trim() };
      const error = runError(`sql-migrate: yodel apply ${env} --wave-apply`, applied, "apply", legacy);
      if (error.chantExit === CHANT_EXIT.moved || (legacy && LEGACY_MOVED.test(`${applied.stderr}\n${applied.stdout}`))) throw new SqlPlanMovedError(env, error.message);
      throw error;
    },
  };
}

export const sqlMigrateCapability = createSqlMigrateCapability();

// ── sql-apply ─────────────────────────────────────────────────────────────────

/** The input of a `sql-apply` step. */
export interface SqlApplyStepInput {
  /** The chant environment, which selects `sql.profiles.<environment>`. */
  environment: string;
  /** The build's output (`chant build src --lexicon sql -o dist/schema.json`). */
  build: string;
  /** Drop this project's objects the build no longer declares. Destructive, so off by default. */
  prune?: boolean;
  stack?: string;
  ownershipEnv?: string;
  /** Postgres: `lock_timeout` per statement, in ms. */
  lockTimeoutMs?: number;
  /** Postgres: `statement_timeout` for a catalog-only statement, in ms. */
  statementTimeoutMs?: number;
  /** Postgres: `statement_timeout` for a statement that reads or rewrites rows, in ms. */
  scanTimeoutMs?: number;
  /** ClickHouse: how long to wait for one table's background rewrite, in ms. */
  mutationTimeoutMs?: number;
  /** Project directory for `chant.config.ts`. Default: the working directory. */
  cwd?: string;
}

/** A declarative plan, as `sql-apply` reads it from the dialect's planner. */
export interface SqlDeclarativePlan {
  dialect: "clickhouse" | "postgres";
  changes: SqlDeclarativeChange[];
  /** Changes the applier will not make in place, each with the Op to run instead when the planner names one. */
  refused: Array<{ object: string; field: string; op?: string }>;
  holes: ChangeSetHole[];
  /** Why the plan cannot be applied besides (a named collection missing on the server). */
  problems: string[];
}

export interface SqlApplyArtifact {
  kind: "sql-apply";
  environment: string;
  dialect: "clickhouse" | "postgres";
  planDigest: string;
}

export interface SqlApplyStepOutput {
  environment: string;
  dialect: "clickhouse" | "postgres";
  planDigest: string;
  applied: string[];
  pruned: string[];
}

/** What `sql-apply` is built with. Tests pass fakes for the planner and the applier. */
export interface SqlApplyDeps {
  plan?: (input: SqlApplyStepInput, dialect: "clickhouse" | "postgres") => Promise<SqlDeclarativePlan>;
  apply?: (input: SqlApplyStepInput, dialect: "clickhouse" | "postgres") => Promise<{ applied: string[]; pruned: string[]; notAttempted: Array<{ name: string; reason: string }> }>;
}

/** The dialect a build output names: `postgres`, else `clickhouse`. */
export function buildDialect(path: string): "clickhouse" | "postgres" {
  let raw: { dialect?: unknown; sql?: { dialect?: unknown } };
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as typeof raw;
  } catch (err) {
    throw new Error(`sql-apply: the build ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}. Run chant build first`);
  }
  const d = raw.sql && typeof raw.sql === "object" ? raw.sql.dialect : raw.dialect;
  return d === "postgres" ? "postgres" : "clickhouse";
}

const pick = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

async function defaultPlan(input: SqlApplyStepInput, dialect: "clickhouse" | "postgres"): Promise<SqlDeclarativePlan> {
  const cwd = input.cwd ? { cwd: input.cwd } : {};
  if (dialect === "postgres") {
    const { planPgAgainstServer } = await import("./postgres/plan/commands");
    const diff = await planPgAgainstServer(input.environment, input.build, cwd);
    const { HANDED_OFF } = await import("./postgres/migrate/handoff");
    return {
      dialect,
      changes: diff.changes,
      // A column rename or a type change across kinds is a PostgresMigrationOp's; the other expand and contract changes are made by hand.
      refused: diff.refused.map((c) => ({ object: c.object, field: c.field, ...(HANDED_OFF.has(c.rule) ? { op: "PostgresMigrationOp" } : {}) })),
      holes: [],
      problems: [],
    };
  }
  const { planAgainstServer } = await import("./clickhouse/plan/commands");
  const { namedCollectionsFail } = await import("./clickhouse/live/named-collections");
  const diff = await planAgainstServer(input.environment, input.build, cwd);
  const missing = namedCollectionsFail(diff.namedCollections) ? diff.namedCollections!.missing : [];
  return {
    dialect,
    changes: diff.changes,
    refused: diff.rebuilds.map((c) => ({ object: c.object, field: c.field, op: "ClickHouseRebuildOp" })),
    holes: (diff.unreadable ?? []).map((u) => ({ address: u.object, type: u.type, reason: u.reason })),
    problems: missing.length > 0 ? [`the build references named collection(s) the server does not have: ${missing.join(", ")}`] : [],
  };
}

async function defaultApply(input: SqlApplyStepInput, dialect: "clickhouse" | "postgres"): Promise<{ applied: string[]; pruned: string[]; notAttempted: Array<{ name: string; reason: string }> }> {
  const args = pick({ buildPath: input.build, environment: input.environment, prune: input.prune, stack: input.stack, ownershipEnv: input.ownershipEnv, cwd: input.cwd });
  const outcome =
    dialect === "postgres"
      ? await (await import("./op/activities/postgres-apply")).postgresApply({
          ...args,
          buildPath: input.build,
          ...pick({ lockTimeoutMs: input.lockTimeoutMs, statementTimeoutMs: input.statementTimeoutMs, scanTimeoutMs: input.scanTimeoutMs }),
        })
      : await (await import("./op/activities/clickhouse-apply")).clickhouseApply({ ...args, buildPath: input.build, ...pick({ mutationTimeoutMs: input.mutationTimeoutMs }) });
  return {
    applied: outcome.applied.map((a) => `${a.kind}/${a.name}`),
    pruned: outcome.pruned.map((p) => `${p.kind}/${p.name}`),
    notAttempted: outcome.notAttempted.map((n) => ({ name: `${n.kind}/${n.name}`, reason: `${n.reason}${n.detail ? `: ${n.detail}` : ""}` })),
  };
}

function requireApplyInput(input: SqlApplyStepInput): void {
  if (typeof input?.environment !== "string" || input.environment.trim() === "") throw new Error("sql-apply: the step needs `environment`, which selects sql.profiles.<environment>");
  if (typeof input.build !== "string" || input.build.trim() === "") throw new Error("sql-apply: the step needs `build`, the chant build output to apply (dist/schema.json)");
}

/** Plan `input` and say why it cannot be applied, if it cannot. */
async function planDeclarative(plan: NonNullable<SqlApplyDeps["plan"]>, input: SqlApplyStepInput): Promise<{ part: ChangeSetPart; dialect: "clickhouse" | "postgres" }> {
  const dialect = buildDialect(input.build);
  const planned = await plan(input, dialect);
  const why: string[] = [...planned.problems];
  if (planned.refused.length > 0) {
    why.push(`the applier does not make ${planned.refused.map((r) => `${r.object} (${r.field}${r.op ? `, run a ${r.op}` : ""})`).join(", ")} in place`);
  }
  if (planned.holes.length > 0) why.push(`the plan cannot read ${planned.holes.map((h) => `${h.address}: ${h.reason}`).join("; ")}`);
  if (why.length > 0) throw new Error(`sql-apply: ${input.environment} cannot apply this build: ${why.join("; and ")}`);
  const part = sqlDeclarativePlanPart({ member: input.environment, dialect, environment: input.environment, changes: planned.changes });
  return { part, dialect };
}

/** The `sql-apply` capability, with its planner and applier injectable. */
export function createSqlApplyCapability(deps: SqlApplyDeps = {}): Capability<SqlApplyStepInput, SqlApplyStepOutput> {
  const plan = deps.plan ?? defaultPlan;
  const apply = deps.apply ?? defaultApply;
  return {
    kind: "sql-apply",
    // An apply has no undo short of applying the previous build, which is a change of its own.
    rollbackPolicy: "needs-opt-out",
    targets: { refuse: "sql-apply applies a whole build, since its objects depend on each other in creation order" },
    async plan(_ctx: DeployContext, input: SqlApplyStepInput): Promise<CapabilityPlan> {
      requireApplyInput(input);
      const { part, dialect } = await planDeclarative(plan, input);
      const planDigest = part.member.planDigest!;
      const artifact: SqlApplyArtifact = { kind: "sql-apply", environment: input.environment, dialect, planDigest };
      return { member: input.environment, planDigest, artifact, changeSet: part };
    },
    async run(ctx: DeployContext, input: SqlApplyStepInput): Promise<SqlApplyStepOutput> {
      requireApplyInput(input);
      const decided = ctx.plans?.[input.environment] as Partial<SqlApplyArtifact> | undefined;
      if (decided?.kind !== "sql-apply" || typeof decided.planDigest !== "string") {
        throw new Error(`sql-apply: ${input.environment} applies only a plan that was planned and decided first (DeployContext.plans); nothing was applied`);
      }
      // Planned again just before the apply: a server or build that moved since the decision applies nothing.
      const { part, dialect } = await planDeclarative(plan, input);
      if (part.member.planDigest !== decided.planDigest) {
        throw new SqlPlanMovedError(input.environment, `sql-apply: ${input.environment}'s plan moved since it was decided (decided ${decided.planDigest}, now ${String(part.member.planDigest)}); nothing was applied`);
      }
      const outcome = await apply(input, dialect);
      if (outcome.notAttempted.length > 0 && outcome.applied.length === 0 && outcome.pruned.length === 0 && part.entries.length > 0) {
        throw new Error(`sql-apply: nothing was applied to ${input.environment}: ${outcome.notAttempted.map((n) => `${n.name} (${n.reason})`).join(", ")}`);
      }
      return { environment: input.environment, dialect, planDigest: decided.planDigest, applied: outcome.applied, pruned: outcome.pruned };
    },
  };
}

export const sqlApplyCapability = createSqlApplyCapability();

// ── the plugin ────────────────────────────────────────────────────────────────

export const SQL_VERB_FAMILIES = {
  apply: ["sql-apply", "sql-migrate"],
} as const;

export const sqlCapabilityPlugin: CapabilityPlugin = {
  name: "sql",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [sqlMigrateCapability as Capability<never, unknown>, sqlApplyCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return SQL_VERB_FAMILIES;
  },
};

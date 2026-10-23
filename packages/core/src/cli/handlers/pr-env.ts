/**
 * `chant components pr-env up|down|sweep` (#4298): an environment per open
 * pull request, `pr-<n>`, derived from `ci.prEnvironment.template`
 * (../../components/pr-environment.ts says what each does and why).
 *
 * ```
 * chant components pr-env up    --base <ref> --pr <n> [--forge <kind>] [--member <name>] [--output <dir>] [--no-push]
 * chant approve pr-<n> pr-env --plan <digest> --approver <you> --sign
 * chant components pr-env down  --pr <n> [--reason closed|expired] [--forge <kind>] [--member <name>]
 * chant components pr-env post  --pr <n> --head <sha> [--result <r>] --forge <kind>
 * chant components pr-env sweep [--forge <kind>]
 * ```
 *
 * In the generated jobs (#4295) `up` runs the change's code with no forge
 * token, so it passes `--no-push` and hands its report and record on, and
 * `post` runs in a fresh job at the target branch's commit, appends the
 * record and posts the note.
 *
 * `up` prepares the change as `pr-plan` does, with `--env pr-<n>` and the
 * build parameter `ownership.env` reads set to `pr-<n>`, so every resource
 * the apply creates carries that environment's marker. It applies only when
 * the plan is empty or an approval of its digest stands under gate `pr-env`,
 * since a non-empty plan never applies with no person approving (ws-080).
 *
 * `down` reads the environment's record on chant/lifecycle, checks it names
 * this pull request's environment, and tears down what `planTeardown` finds
 * under the record's marker, after dropping any entry whose marker is not
 * exactly that one. The lexicons tear down what they own, and the command
 * `ci.prEnvironment.teardown` names tears down the rest (#4330). No gate
 * holds it: closing the pull request is the decision, as is the TTL the base
 * set for `sweep`.
 *
 * The runs themselves are ../../components/pr-env-run.ts, which a product
 * calls with an adapter of its own (#4330). This file supplies the
 * components adapter and the CLI's ports.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadChantConfig, type ChantConfig } from "../../config";
import { ENV_VAR } from "../../env";
import { isEmptyChangeSet } from "../../change-set";
import {
  PR_ENV_EXIT,
  PR_ENV_GATE,
  PR_ENV_RECORD_FILE,
  PR_ENV_REPORT_DIR,
  acceptHandedRecord,
  handedPrEnvReport,
  PR_ENV_TEMPLATE_VAR,
  derivePrEnvironment,
  prEnvApproveCommand,
  prEnvStatusState,
  prEnvironmentName,
  prEnvironmentSite,
  renderPrEnvNote,
  ttlMs,
  type PrEnvReport,
  type PrEnvReportRow,
  type PrEnvTeardownAdapter,
} from "../../components/pr-environment";
import {
  commandTeardownAdapter,
  prEnvDown as prEnvDownRun,
  prEnvOp,
  prEnvSweep as prEnvSweepRun,
  prEnvUp as prEnvUpRun,
  type PrEnvAdapter,
  type PrEnvPorts,
  type PrEnvTarget,
} from "../../components/pr-env-run";
import { forgePrEnvPublisher, lifecyclePrEnvPorts } from "../../components/pr-env-ports";
import { applyPrSet, type PrPlanSet } from "../../components/pr-run";
import { prOp } from "../../pr-loop";
import { FORGE_KINDS, forgeFromEnv, forgePrincipalOf, type ForgeKind, type PrForge } from "../../pr-forge";
import { formatError, formatInfo, formatWarning } from "../format";
import { withComponentEndpoint } from "../component-endpoint";
import type { CommandContext } from "../registry";
import type { Prepared } from "./pr";

const USAGE = "chant components pr-env up --base <ref> --pr <n> [--no-push] | post --pr <n> --head <sha> | down --pr <n> [--reason closed|expired] | sweep";

const fail = (message: string, hint?: string): number => {
  console.error(formatError({ message, ...(hint ? { hint } : {}) }));
  return PR_ENV_EXIT.failed;
};

/** chant components pr-env <up|down|sweep> */
export async function runComponentsPrEnv(ctx: CommandContext): Promise<number> {
  const action = ctx.args.extraPositional;
  if (action === "up") return prEnvUp(ctx);
  if (action === "down") return prEnvDown(ctx);
  if (action === "sweep") return prEnvSweep(ctx);
  if (action === "post") return prEnvPost(ctx);
  return fail(action ? `pr-env ${action} is not one of up, post, down or sweep` : "pr-env needs an action: up, post, down or sweep", USAGE);
}

function forgeOf(ctx: CommandContext): PrForge | undefined | number {
  const kind = ctx.args.forge;
  if (kind === undefined || ctx.args.noStatus) return undefined;
  if (!(FORGE_KINDS as readonly string[]).includes(kind)) return fail(`--forge ${kind} is not one of ${FORGE_KINDS.join(", ")}`);
  try {
    return forgeFromEnv(kind as ForgeKind);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function actor(): string {
  return process.env.GITHUB_ACTOR || process.env.GITLAB_USER_LOGIN || process.env.USER || "chant";
}

function memberOf(ctx: CommandContext): string | undefined {
  return ctx.args.members?.length === 1 ? ctx.args.members[0] : undefined;
}

// ── the ports ──────────────────────────────────────────────────────────────

const log = (line: string): void => console.error(formatInfo(line));
const warn = (message: string): void => console.error(formatWarning({ message }));

/**
 * The ports `pr-env` runs with (../../components/pr-env-run.ts): the records
 * and the gate ledger on chant/lifecycle here, and the report written under
 * `--output` and posted through `forge`. With `--no-push` (#4295) the record
 * is written to `pr-env-record.json` under `--output` instead, for `pr-env
 * post` to append from a job that runs none of the change's code.
 */
function cliPorts(ctx: CommandContext, forge: PrForge | undefined): PrEnvPorts {
  const lifecycle = lifecyclePrEnvPorts({ ...(forge ? { forge } : {}), log, warn });
  return {
    ...lifecycle,
    async appendRecord(record) {
      if (!ctx.args.noPush) return lifecycle.appendRecord(record);
      const dir = resolve(ctx.args.output ?? PR_ENV_REPORT_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PR_ENV_RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
    },
    publish: (report) => finish(ctx, forge, report),
  };
}

// ── the report and the note ────────────────────────────────────────────────

async function finish(ctx: CommandContext, forge: PrForge | undefined, report: PrEnvReport): Promise<void> {
  const dir = resolve(ctx.args.output ?? PR_ENV_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const note = renderPrEnvNote(report, forge ? forgePrincipalOf(forge.kind, forge.host, "<your-login>") : "<you>");
  writeFileSync(join(dir, `pr-env-${report.stage}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(dir, "pr-env-note.md"), note);
  if (ctx.args.json) console.log(JSON.stringify(report, null, 2));
  if (forge) await forgePrEnvPublisher(forge, warn)(report);
}

// ── up ─────────────────────────────────────────────────────────────────────

async function prEnvUp(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.pr === undefined) return fail("pr-env up needs the pull or merge request: --pr <n>", "The environment is pr-<n>, and its approval is recorded under op pr-<n>.");
  if (!args.base) return fail("pr-env up needs the commit the change is measured from: --base <ref>", "On a pull request, the target branch's commit. ci.prEnvironment is read from the declaration there.");
  const pr = args.pr;
  const projectPath = resolve(".");

  // The settings at base, never the pull request's own: a change cannot name another template or a longer TTL.
  const { scopeSource } = await import("../../workspace/write-scope");
  const source = scopeSource(projectPath, args.base);
  const setting = source.from === "base" ? source.declaration?.ci?.prEnvironment : undefined;
  if (!setting) {
    return fail(
      `the workspace declaration at ${args.base.slice(0, 12)} names no ci.prEnvironment, so pull request ${pr} gets no environment`,
      'Declare ci.prEnvironment: { "template": "<env>" } in chant.workspace.json and merge it first.',
    );
  }
  const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }));
  const derived = derivePrEnvironment(config, setting.template, pr);
  if ("refusal" in derived) return fail(derived.refusal);

  // The build sees pr-<n> as its environment and the template's name beside it.
  process.env[ENV_VAR] = derived.env;
  process.env[PR_ENV_TEMPLATE_VAR] = derived.template;
  const envCtx: CommandContext = {
    ...ctx,
    args: { ...args, env: derived.env, param: [...(args.param ?? []).filter((p) => !p.startsWith(`${derived.param}=`)), `${derived.param}=${derived.env}`] },
  };
  console.error(formatInfo(`pr-env up: ${derived.env}, derived from ${derived.template}${derived.endpoint ? ` at ${derived.endpoint}` : ""}, marker ${derived.stack}/${derived.env}`));
  return withComponentEndpoint(envCtx, () => up(envCtx, pr, derived, setting.ttl), { config: { ...config, environments: derived.environments }, environment: derived.env });
}

async function up(ctx: CommandContext, pr: number, derived: Exclude<ReturnType<typeof derivePrEnvironment>, { refusal: string }>, ttl: string): Promise<number> {
  const { prepare, planAll, placeHooks, runStageHook } = await import("./pr");
  const p = await prepare(ctx, "plan");
  if (typeof p === "number") return p;
  // ci.hooks (#4288), read at base as the other pull-request jobs read them, around the plan and the apply.
  placeHooks(ctx, p, "apply", prEnvOp(pr, p.member));
  const result = await prEnvUpRun({
    pr,
    head: p.head,
    template: derived.template,
    ttl,
    stack: derived.stack,
    ...(p.member ? { member: p.member } : {}),
    ...(derived.endpoint ? { endpoint: derived.endpoint } : {}),
    adapter: componentsPrEnvAdapter(p, { planAll, runStageHook }),
    ports: cliPorts(ctx, p.forge),
    actor: actor(),
    ...(p.forge?.runUrl ? { runUrl: p.forge.runUrl } : {}),
  });
  if (result.report.status === "waiting" || result.report.status === "changed") console.error(formatInfo(`approve : ${prEnvApproveCommand(result.report.op, result.report.digest)}`));
  return result.exit;
}

/**
 * The components as a pull request environment's adapter: the plan is
 * `pr-plan`'s, with the plan-side hooks around it, and the apply is the
 * fan-out's, with the apply-side hooks around it. Each row carries the
 * component's site in `pr-<n>`, carried over from the template's (#4330,
 * `prEnvironmentSite`).
 */
function componentsPrEnvAdapter(p: Prepared, run: { planAll: typeof import("./pr").planAll; runStageHook: typeof import("./pr").runStageHook }): PrEnvAdapter {
  let set: PrPlanSet | undefined;
  const rows = (target: PrEnvTarget, status: (component: string) => string): PrEnvReportRow[] =>
    p.plan.order.map((component) => {
      const ms = (set?.members ?? []).filter((m) => m.component === component);
      const sum = (k: "create" | "update" | "replace" | "delete") => ms.reduce((n, m) => n + m.counts[k], 0);
      const found = prEnvironmentSite(p.sites?.[component], target.template, target.env);
      const site = found ? { ...(found.runtime ? { runtime: found.runtime } : {}), ...(found.url ? { url: found.url } : {}), ...(found.domain ? { domain: found.domain } : {}) } : undefined;
      return { component, status: status(component), create: sum("create"), update: sum("update"), replace: sum("replace"), delete: sum("delete"), ...(site && Object.keys(site).length > 0 ? { site } : {}) };
    });
  return {
    async plan(target) {
      if (p.plan.order.length === 0) return { digest: "", empty: true, rows: [], ...(p.routedAway ? { message: p.routedAway } : {}) };
      set = await run.planAll(p);
      const planned = set;
      return {
        digest: planned.doc.digest,
        empty: isEmptyChangeSet(planned.doc),
        ...(planned.failed ? { failed: true } : {}),
        rows: rows(target, (c) => (planned.failed && planned.members.some((m) => m.component === c && m.status === "plan-failed") ? "plan failed" : "planned")),
        ...(p.hookFailed ? { message: p.hookFailed } : {}),
      };
    },
    async apply(target) {
      const planned = set!;
      const hookStop = run.runStageHook(p, "before-apply", p.plan.order, planned);
      if (hookStop) return { status: "stopped", rows: rows(target, () => "planned"), message: hookStop };
      const applied = await applyPrSet({ components: p.components, plan: p.plan, registry: p.registry, env: target.env, set: planned, gate: PR_ENV_GATE });
      const afterHook = run.runStageHook(p, "after-apply", p.plan.order, planned, "the environment stands as applied");
      const status = (component: string) => applied.members.find((m) => m.component === component)?.status ?? "planned";
      return {
        status: applied.status === "applied" ? "applied" : applied.status === "waiting" ? "waiting" : "failed",
        rows: rows(target, status),
        ...(afterHook ? { afterFailure: afterHook } : {}),
      };
    },
  };
}

// ── post ───────────────────────────────────────────────────────────────────

/**
 * `pr-env post --pr <n> --head <sha> [--result <r>]` (#4295): from a job at
 * the target branch's commit that runs none of the change's code, take the
 * report and the record `pr-env up --no-push` handed on, check the record
 * as data against the settings at this commit, append it to chant/lifecycle,
 * and post the note and the `chant/pr-env` status with the forge token the
 * up job never held.
 */
async function prEnvPost(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.pr === undefined || !args.head) return fail("pr-env post needs the pull request and the commit its environment was applied from: --pr <n> --head <sha>");
  const forge = forgeOf(ctx);
  if (typeof forge === "number") return forge;
  const pr = args.pr;
  const env = prEnvironmentName(pr);
  const member = memberOf(ctx);
  const dir = resolve(args.output ?? PR_ENV_REPORT_DIR);
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf-8"));
    } catch {
      return undefined;
    }
  };
  const { scopeSource } = await import("../../workspace/write-scope");
  const setting = scopeSource(resolve("."), "HEAD").declaration?.ci?.prEnvironment;
  const handed = handedPrEnvReport(read("pr-env-up.json"), { pr, head: args.head, ...(member ? { member } : {}) });
  const report: PrEnvReport =
    "report" in handed
      ? handed.report
      : { stage: "up", pr, env, ...(member ? { member } : {}), template: setting?.template ?? "", head: args.head, op: prOp(pr, member), gate: PR_ENV_GATE, digest: "", status: "failed", components: [], message: handed.refusal + (args.planResult && args.planResult !== "success" ? ` The env-up job's result is ${args.planResult}.` : "") };
  const raw = read(PR_ENV_RECORD_FILE);
  let code: number = "report" in handed ? (report.status === "waiting" || report.status === "changed" ? PR_ENV_EXIT.waiting : prEnvStatusState(report) === "failure" ? PR_ENV_EXIT.failed : PR_ENV_EXIT.done) : PR_ENV_EXIT.failed;
  if (raw !== undefined) {
    if (!setting) {
      report.message = `${report.message ? `${report.message} ` : ""}The declaration here names no ci.prEnvironment, so the record was not kept.`;
      code = PR_ENV_EXIT.failed;
    } else {
      const accepted = acceptHandedRecord(raw, { pr, head: args.head, template: setting.template, ttlMs: ttlMs(setting.ttl) ?? ttlMs("72h")!, now: new Date(), by: actor(), ...(member ? { member } : {}), ...(forge?.runUrl ? { runUrl: forge.runUrl } : {}) });
      if ("refusal" in accepted) {
        report.message = `${report.message ? `${report.message} ` : ""}${accepted.refusal}`;
        code = PR_ENV_EXIT.failed;
      } else {
        await lifecyclePrEnvPorts({ warn }).appendRecord(accepted.record);
        if (accepted.record.expiresAt) report.expiresAt = accepted.record.expiresAt;
      }
    }
  }
  await finish(ctx, forge, report);
  return code;
}

// ── down ───────────────────────────────────────────────────────────────────

/**
 * What tears the environment down: the lexicons, and the command
 * `ci.prEnvironment.teardown` names in the declaration at this commit
 * (#4330), which the down and sweep jobs check out from the base branch.
 */
async function teardownSources(): Promise<{ config: ChantConfig; adapters: PrEnvTeardownAdapter[] }> {
  const projectPath = resolve(".");
  const { config } = await loadChantConfig(projectPath).catch(() => ({ config: {} as ChantConfig }));
  const { scopeSource } = await import("../../workspace/write-scope");
  const hook = scopeSource(projectPath, "HEAD").declaration?.ci?.prEnvironment?.teardown;
  return { config, adapters: hook ? [commandTeardownAdapter(hook, { cwd: projectPath })] : [] };
}

async function prEnvDown(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.pr === undefined) return fail("pr-env down needs the pull or merge request: --pr <n>");
  const reason = args.reason ?? "closed";
  if (reason !== "closed" && reason !== "expired") return fail(`--reason ${reason} is not closed or expired`);
  const forge = forgeOf(ctx);
  if (typeof forge === "number") return forge;
  const member = memberOf(ctx);
  const result = await prEnvDownRun({
    pr: args.pr,
    reason,
    ...(member ? { member } : {}),
    ports: cliPorts(ctx, forge),
    ...(await teardownSources()),
    plugins: ctx.plugins,
    commit: await headCommit(),
    actor: actor(),
    ...(forge?.runUrl ? { runUrl: forge.runUrl } : {}),
  });
  if (result.report.status === "refused") return fail(result.report.message ?? "refused");
  return result.exit;
}

async function headCommit(): Promise<string> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

// ── sweep ──────────────────────────────────────────────────────────────────

async function prEnvSweep(ctx: CommandContext): Promise<number> {
  const forge = forgeOf(ctx);
  if (typeof forge === "number") return forge;
  const result = await prEnvSweepRun({
    ports: cliPorts(ctx, forge),
    ...(await teardownSources()),
    plugins: ctx.plugins,
    commit: await headCommit(),
    actor: actor(),
    ...(forge?.runUrl ? { runUrl: forge.runUrl } : {}),
  });
  return result.exit;
}

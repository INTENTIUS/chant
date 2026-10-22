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
 * exactly that one. No gate holds it: closing the pull request is the
 * decision, as is the TTL the base set for `sweep`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadChantConfig, type ChantConfig } from "../../config";
import { ENV_VAR } from "../../env";
import { isEmptyChangeSet } from "../../change-set";
import {
  PR_ENV_EXIT,
  PR_ENV_GATE,
  PR_ENV_LEDGER_DIR,
  PR_ENV_LEDGER_FILE,
  PR_ENV_RECORD_FILE,
  PR_ENV_REPORT_DIR,
  acceptHandedRecord,
  handedPrEnvReport,
  PR_ENV_TEMPLATE_VAR,
  derivePrEnvironment,
  expired,
  livePrEnvironments,
  parsePrEnvRecords,
  prEnvApproveCommand,
  prEnvNoteMarker,
  prEnvStatusContext,
  prEnvStatusDescription,
  prEnvStatusState,
  prEnvironmentName,
  renderPrEnvNote,
  teardownComplete,
  teardownCounts,
  tearDownPrEnvironment,
  ttlMs,
  type LivePrEnvironment,
  type PrEnvRecord,
  type PrEnvReport,
} from "../../components/pr-environment";
import { applyPrSet, approvalOf, decidePrGate, readOnlyLedger } from "../../components/pr-run";
import { gitGateLedgerPort } from "../../op/gate";
import { prOp } from "../../pr-loop";
import { FORGE_KINDS, forgeFromEnv, forgePrincipalOf, type ForgeKind, type PrForge } from "../../pr-forge";
import { formatError, formatInfo, formatWarning } from "../format";
import { withComponentEndpoint } from "../component-endpoint";
import type { CommandContext } from "../registry";

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

// ── the ledger ─────────────────────────────────────────────────────────────

async function readRecords(): Promise<PrEnvRecord[]> {
  const { fetchLifecycle, readBlobFromPath } = await import("../../lifecycle/git");
  await fetchLifecycle().catch(() => false);
  return parsePrEnvRecords(await readBlobFromPath(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE));
}

/**
 * Append `record` to chant/lifecycle and push it. With `--no-push` (#4295)
 * the record is written to `pr-env-record.json` under `--output` instead,
 * for `pr-env post` to append from a job that runs none of the change's
 * code. A failure warns: what was applied or torn down stands.
 */
async function appendRecord(ctx: CommandContext, record: PrEnvRecord): Promise<void> {
  if (ctx.args.noPush) {
    const dir = resolve(ctx.args.output ?? PR_ENV_REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PR_ENV_RECORD_FILE), JSON.stringify(record, null, 2) + "\n");
    return;
  }
  const { appendLedgerLine, fetchLifecycle, pushLifecycleReport } = await import("../../lifecycle/git");
  try {
    await fetchLifecycle().catch(() => false);
    await appendLedgerLine(PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, JSON.stringify(record), `Pull request environment ${record.env} ${record.kind} (${record.result})`);
    const pushed = await pushLifecycleReport();
    if (pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
  } catch (err) {
    console.error(formatWarning({ message: `could not record ${record.env}'s ${record.kind} on chant/lifecycle: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

// ── the report and the note ────────────────────────────────────────────────

async function finish(ctx: CommandContext, forge: PrForge | undefined, report: PrEnvReport): Promise<void> {
  const dir = resolve(ctx.args.output ?? PR_ENV_REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const note = renderPrEnvNote(report, forge ? forgePrincipalOf(forge.kind, forge.host, "<your-login>") : "<you>");
  writeFileSync(join(dir, `pr-env-${report.stage}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(dir, "pr-env-note.md"), note);
  if (ctx.args.json) console.log(JSON.stringify(report, null, 2));
  if (!forge) return;
  if (report.head) {
    try {
      await forge.setStatus(report.head, {
        context: prEnvStatusContext(report.member),
        state: prEnvStatusState(report),
        description: prEnvStatusDescription(report),
        ...(forge.runUrl ? { url: forge.runUrl } : {}),
      });
    } catch (err) {
      console.error(formatWarning({ message: `could not set the ${prEnvStatusContext(report.member)} status: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  try {
    await forge.upsertNote(report.pr, prEnvNoteMarker(report.env, report.member), note);
  } catch (err) {
    console.error(formatWarning({ message: `could not post the note on #${report.pr}: ${err instanceof Error ? err.message : String(err)}` }));
  }
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
  const ttl = ttlMs(setting.ttl) ?? ttlMs("72h")!;

  // The build sees pr-<n> as its environment and the template's name beside it.
  process.env[ENV_VAR] = derived.env;
  process.env[PR_ENV_TEMPLATE_VAR] = derived.template;
  const envCtx: CommandContext = {
    ...ctx,
    args: { ...args, env: derived.env, param: [...(args.param ?? []).filter((p) => !p.startsWith(`${derived.param}=`)), `${derived.param}=${derived.env}`] },
  };
  console.error(formatInfo(`pr-env up: ${derived.env}, derived from ${derived.template}${derived.endpoint ? ` at ${derived.endpoint}` : ""}, marker ${derived.stack}/${derived.env}`));
  return withComponentEndpoint(envCtx, () => up(envCtx, pr, derived, ttl), { config: { ...config, environments: derived.environments }, environment: derived.env });
}

async function up(ctx: CommandContext, pr: number, derived: Exclude<ReturnType<typeof derivePrEnvironment>, { refusal: string }>, ttl: number): Promise<number> {
  const { prepare, planAll, placeHooks, runStageHook } = await import("./pr");
  const p = await prepare(ctx, "plan");
  if (typeof p === "number") return p;
  const forge = p.forge;
  const op = prOp(pr, p.member);
  // ci.hooks (#4288), read at base as the other pull-request jobs read them, around the plan and the apply.
  placeHooks(ctx, p, "apply", op);
  const base: PrEnvReport = {
    stage: "up",
    pr,
    env: derived.env,
    ...(p.member ? { member: p.member } : {}),
    template: derived.template,
    head: p.head,
    op,
    gate: PR_ENV_GATE,
    digest: "",
    status: "nothing",
    ...(derived.endpoint ? { endpoint: derived.endpoint } : {}),
    components: [],
  };
  if (p.plan.order.length === 0) {
    await finish(ctx, forge, { ...base, ...(p.routedAway ? { message: p.routedAway } : {}) });
    console.error(formatInfo(`pr-env up: nothing this change touches is deployed by a component, so ${derived.env} gets nothing`));
    return PR_ENV_EXIT.done;
  }

  const set = await planAll(p);
  const rows = (status: (component: string) => string) =>
    p.plan.order.map((component) => {
      const ms = set.members.filter((m) => m.component === component);
      const sum = (k: "create" | "update" | "replace" | "delete") => ms.reduce((n, m) => n + m.counts[k], 0);
      return { component, status: status(component), create: sum("create"), update: sum("update"), replace: sum("replace"), delete: sum("delete") };
    });
  const digest = set.doc.digest;
  if (set.failed) {
    await finish(ctx, forge, { ...base, digest, status: "plan-failed", ...(p.hookFailed ? { message: p.hookFailed } : {}), components: rows((c) => (set.members.some((m) => m.component === c && m.status === "plan-failed") ? "plan failed" : "planned")) });
    return PR_ENV_EXIT.failed;
  }

  // ws-080, ws-104: a non-empty plan applies only under a person's approval of its digest. An empty one passes.
  let approvedBy: string[] | undefined;
  if (!isEmptyChangeSet(set.doc)) {
    let approval;
    try {
      approval = approvalOf(await decidePrGate(readOnlyLedger(gitGateLedgerPort()), { op, gate: PR_ENV_GATE, digest, description: `${derived.env}: ${p.plan.order.join(", ")}` }));
    } catch (err) {
      return fail(`could not read the gate ledger, so ${derived.env} does not apply: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (approval.status !== "approved") {
      const status = approval.status === "changed" ? "changed" : "waiting";
      await finish(ctx, forge, { ...base, digest, status, components: rows(() => "planned") });
      console.error(formatInfo(`pr-env up: ${derived.env} waits for an approval of ${digest}`));
      console.error(formatInfo(`approve : ${prEnvApproveCommand(op, digest)}`));
      return PR_ENV_EXIT.waiting;
    }
    approvedBy = approval.approvedBy ?? [];
  }

  const hookStop = runStageHook(p, "before-apply", p.plan.order, set);
  if (hookStop) {
    await finish(ctx, forge, { ...base, digest, status: "failed", message: hookStop, components: rows(() => "planned"), ...(approvedBy ? { approvedBy } : {}) });
    return PR_ENV_EXIT.failed;
  }
  const applied = await applyPrSet({ components: p.components, plan: p.plan, registry: p.registry, env: derived.env, set, gate: PR_ENV_GATE });
  const afterHook = runStageHook(p, "after-apply", p.plan.order, set, "the environment stands as applied");
  const status = (component: string) => applied.members.find((m) => m.component === component)?.status ?? "planned";
  const ok = applied.status === "applied";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  // A copy that failed part way is live too: what applied is torn down on close or at expiry like the rest.
  await appendRecord(ctx, {
    version: 1,
    kind: "up",
    pr,
    env: derived.env,
    ...(p.member ? { member: p.member } : {}),
    template: derived.template,
    marker: { stack: derived.stack, env: derived.env },
    commit: p.head,
    components: p.plan.order,
    planDigest: digest,
    result: ok ? "applied" : "failed",
    by: actor(),
    timestamp: now.toISOString(),
    expiresAt,
    ...(approvedBy ? { approvedBy } : {}),
    releaseTarget: false,
    ...(forge?.runUrl ? { runUrl: forge.runUrl } : {}),
  });
  await finish(ctx, forge, {
    ...base,
    digest,
    status: ok ? "applied" : "failed",
    components: rows(status),
    ...(approvedBy ? { approvedBy } : {}),
    expiresAt,
    ...(ok ? (afterHook ? { message: afterHook } : {}) : { message: applied.status === "waiting" ? "A component read an upstream output that moved when it applied; run the job again to plan it against the new value." : "A component failed to apply; what applied stays in the environment and is torn down with it." }),
  });
  console.error((ok ? formatInfo : (m: string) => formatWarning({ message: m }))(`pr-env up: ${derived.env} ${ok ? "applied" : applied.status}; it expires ${expiresAt}`));
  return ok && !afterHook ? PR_ENV_EXIT.done : PR_ENV_EXIT.failed;
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
        await appendRecord({ ...ctx, args: { ...args, noPush: false } }, accepted.record);
        if (accepted.record.expiresAt) report.expiresAt = accepted.record.expiresAt;
      }
    }
  }
  await finish(ctx, forge, report);
  return code;
}

// ── down ───────────────────────────────────────────────────────────────────

async function prEnvDown(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.pr === undefined) return fail("pr-env down needs the pull or merge request: --pr <n>");
  const reason = args.reason ?? "closed";
  if (reason !== "closed" && reason !== "expired") return fail(`--reason ${reason} is not closed or expired`);
  const forge = forgeOf(ctx);
  if (typeof forge === "number") return forge;
  const live = livePrEnvironments(await readRecords()).get(prEnvironmentName(args.pr));
  return teardown(ctx, forge, args.pr, live, reason);
}

async function teardown(ctx: CommandContext, forge: PrForge | undefined, pr: number, live: LivePrEnvironment | undefined, reason: "closed" | "expired"): Promise<number> {
  const env = prEnvironmentName(pr);
  const member = memberOf(ctx);
  const report: PrEnvReport = { stage: "down", pr, env, ...(member ? { member } : {}), template: live?.template ?? "", head: "", op: prOp(pr, member), gate: PR_ENV_GATE, digest: "", status: "absent", components: [] };
  if (!live) {
    console.error(formatInfo(`pr-env down: ${env} has no live record, so there is nothing to tear down`));
    if (forge) await finish(ctx, forge, report);
    return PR_ENV_EXIT.done;
  }
  const { config } = await loadChantConfig(resolve(".")).catch(() => ({ config: {} as ChantConfig }));
  const torn = await tearDownPrEnvironment({ pr, live, config, plugins: ctx.plugins, warn: (message) => console.error(formatWarning({ message })) });
  if ("refusal" in torn) {
    await finish(ctx, forge, { ...report, template: live.template, status: "refused", message: torn.refusal });
    return fail(torn.refusal);
  }
  const { report: result, dropped, marker } = torn;
  const counts = teardownCounts(result);
  const complete = teardownComplete(result);
  const lexicons = [...new Set(result.outcomes.map((o) => o.lexicon))].sort();
  const head = await headCommit();
  await appendRecord(ctx, {
    version: 1,
    kind: "down",
    pr,
    env,
    ...(live.member ? { member: live.member } : {}),
    template: live.template,
    marker,
    commit: head,
    components: lexicons,
    planDigest: "",
    result: complete ? "destroyed" : "incomplete",
    by: actor(),
    timestamp: new Date().toISOString(),
    reason,
    outcomes: counts,
    releaseTarget: false,
    ...(forge?.runUrl ? { runUrl: forge.runUrl } : {}),
  });
  const why: string[] = [];
  if (dropped > 0) why.push(`${dropped} candidate${dropped === 1 ? "" : "s"} whose marker was not ${marker.stack}/${env} left alone`);
  if (result.unimplemented.length > 0) why.push(`no teardown execution in ${result.unimplemented.join(", ")}`);
  if (result.plan.holes.length > 0) why.push(`${result.plan.holes.length} part${result.plan.holes.length === 1 ? "" : "s"} could not be read`);
  for (const o of result.outcomes.filter((x) => x.outcome === "failed")) why.push(`${o.lexicon} ${o.name}: ${o.detail ?? "failed"}`);
  await finish(ctx, forge, { ...report, template: live.template, status: complete ? "destroyed" : "incomplete", outcomes: counts, ...(why.length > 0 ? { message: why.join("; ") } : {}) });
  console.error((complete ? formatInfo : (m: string) => formatWarning({ message: m }))(`pr-env down: ${env} ${complete ? "torn down" : "not wholly torn down; it stays live and the sweep tries again"} (${counts.deleted} deleted, ${counts.failed} failed, ${counts.skipped} skipped)`));
  return complete ? PR_ENV_EXIT.done : PR_ENV_EXIT.failed;
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
  const live = [...livePrEnvironments(await readRecords()).values()];
  if (live.length === 0) {
    console.error(formatInfo("pr-env sweep: no pull request environment is live"));
    return PR_ENV_EXIT.done;
  }
  const now = new Date();
  let code: number = PR_ENV_EXIT.done;
  for (const e of live) {
    let reason: "closed" | "expired" | undefined = expired(e, now) ? "expired" : undefined;
    if (!reason && forge?.pullRequestState) {
      try {
        const state = await forge.pullRequestState(e.pr);
        if (state !== "open") reason = "closed";
      } catch (err) {
        console.error(formatWarning({ message: `could not read whether #${e.pr} is open (${err instanceof Error ? err.message : String(err)}); its TTL still holds` }));
      }
    }
    if (!reason) {
      console.error(formatInfo(`pr-env sweep: ${e.env} stays; it expires ${e.expiresAt}`));
      continue;
    }
    const c = await teardown(ctx, forge, e.pr, e, reason);
    if (c !== PR_ENV_EXIT.done) code = PR_ENV_EXIT.failed;
  }
  return code;
}

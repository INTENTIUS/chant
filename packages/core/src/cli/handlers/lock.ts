/**
 * `chant lock` and `chant unlock` (#4293): take, list and release the target
 * locks a pull request holds (../../lifecycle/target-lock.ts).
 *
 * ```
 * chant lock <target>... --pr <n> [--stage plan|apply|lock] [--head <sha>] [--by <who>] [--gate <name>] [--forge <kind>] [--json]
 * chant lock --from-report <pr-plan.json> --pr <n> [--stage plan] [--forge <kind>] [--json]
 * chant lock --keep --pr <n> [--head <sha>] [--gate <name>] [--forge <kind>] [--json]
 * chant lock --reach --pr <n> --head <sha> --base <sha> --forge <kind> [--stage plan|apply|lock] [--gate <name>] [--json]
 * chant lock --reach --open --base <sha> --forge gitlab [--branch <name>] [--stage plan] [--gate <name>] [--json]
 * chant lock --list [--gate <name>] [--json]
 * chant lock --alive <run>
 * chant unlock --pr <n> [<target>...] [--gate <name>] [--json]
 * chant unlock --run <id> [--gate <name>] [--json]
 * ```
 *
 * The targets are names: the components `chant components pr-plan` selects,
 * which are what `pr-apply` checks under `ci.locks`, or any other name a
 * pipeline locks by. `--from-report` reads them from a pull-request report
 * (`selection.waves`), so a lock job that runs the target branch's code can
 * lock what the plan job, which ran the pull request's code, selected. When
 * a member is on the resource lock grain (#4552) the report carries
 * `lockTargets`, its row keys, and those are locked instead.
 *
 * `--reach` (#4979) locks what a change reaches by the pipeline's reach line
 * in `CHANT_LOCK_REACH`, which prints target names one a line from the
 * change's files read as data (../../lifecycle/reach-locks.ts). chant first
 * fetches the pull request's head and checks it is `--head`. With `--open`
 * (GitLab's plan notes pipeline) every open merge request into the branch is
 * locked, and a holder that is no longer open releases its locks.
 *
 * `--list` prints the target locks, then the apply rows of the gate's rows
 * file (#4552, #4594), each with the run that holds it and when it took it.
 *
 * `--keep` (#4588) takes again, at stage `lock`, every lock the pull request
 * holds now: the components (or row keys) its plan locked under `ci.locks:
 * plan`. A plan lock is let go when a later plan no longer reaches the
 * target; a kept one stays until the pull request closes or `chant unlock`.
 * It is what a `/<product> lock` comment runs, on the target branch's
 * commit, so no code of the change runs. A pull request that holds no lock
 * yet fails with a line saying its plan has to run first.
 *
 * `--alive <run>` prints `alive` or `dead` for a run that holds rows or the
 * Forgejo repo lock tag (#4552): `dead` when the forge says the run
 * finished, `alive` while it runs or when nobody can say. The lock tag's
 * shell asks it before taking a lease over.
 *
 * `chant unlock --run <id>` (#4660) frees every row run `<id>` holds on the
 * gate and drops its place in the queue, for a hold whose run is gone and
 * that no beat or forge answer has freed. `--beat <run> --parent <pid>` is
 * the heartbeat side process of a hold (../../lifecycle/lock-beat.ts).
 *
 * `--forge` reads which holders are still open, so a lock whose pull
 * request merged or closed is taken over, and, with `--head`, posts the
 * `chant/lock` status on that commit. Without it every lock counts as held.
 *
 * Exit 0 when the locks are taken or released, 3 when another open pull
 * request holds a target (nothing is locked), 1 on an error.
 */
import { readFileSync } from "node:fs";
import { CHANT_EXIT } from "../../exit-codes";
import { resolve } from "node:path";
import type { CommandContext } from "../registry";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../format";
import { FORGE_KINDS, type ForgeKind, type PrForge } from "../../pr-forge";
// #4964: a status for a pull_request run's merge preview goes on the pull request's head.
import { forgeFromJobEnv } from "../../pr-forge-job";
import { PR_APPLY_GATE } from "../../pr-loop";
import { actorFromEnv } from "../../actor";
import {
  describeHeldTargetLocks,
  readTargetLocks,
  releaseTargetLocks,
  takeTargetLocks,
  targetLockGateProblem,
  targetLockPathAt,
  TARGET_LOCK_STAGES,
  type TargetLockStage,
} from "../../lifecycle/target-lock";
import { LOCK_REACH_ENV, reachedTargets, reachOpen } from "../../lifecycle/reach-locks";

/** The exit for a target another open pull request holds: `CHANT_EXIT.held`, 5 (#4553). */
const HELD_EXIT_CODE = CHANT_EXIT.held;

/** The status `chant lock --head <sha> --forge <kind>` posts. */
export const LOCK_STATUS_CONTEXT = "chant/lock";

const fail = (message: string, hint?: string): number => {
  console.error(formatError({ message, ...(hint ? { hint } : {}) }));
  return 1;
};

/** The targets named after the command word. */
function targetsOf(ctx: CommandContext): string[] {
  return (ctx.args.positionals ?? []).filter((t) => t !== "");
}

function gateOf(ctx: CommandContext): string | { error: string } {
  const gate = ctx.args.gate ?? PR_APPLY_GATE;
  const problem = targetLockGateProblem(gate);
  return problem ? { error: problem } : gate;
}

function forgeOf(ctx: CommandContext): PrForge | undefined | { error: string } {
  const kind = ctx.args.forge;
  if (kind === undefined) return undefined;
  if (!(FORGE_KINDS as readonly string[]).includes(kind)) return { error: `--forge ${kind} is not one of ${FORGE_KINDS.join(", ")}` };
  try {
    return forgeFromJobEnv(kind as ForgeKind);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const prName = (forge: PrForge | undefined) => (n: number) => (forge?.kind === "gitlab" ? `merge request !${n}` : `pull request ${n}`);

/** The components a `pr-plan.json` selected, and the head it planned, checked against `--pr`. */
function fromReport(file: string, pr: number): { targets: string[]; head?: string } | { error: string } {
  let doc: { pr?: unknown; head?: unknown; selection?: { waves?: unknown }; lockTargets?: unknown };
  try {
    doc = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (err) {
    return { error: `--from-report: could not read "${file}": ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc.pr !== pr) return { error: `--from-report: "${file}" is the report of ${doc.pr === null || doc.pr === undefined ? "no pull request" : `pull request ${String(doc.pr)}`}, not ${pr}` };
  // #4552: a member on the resource grain locks its row keys, which the report lists.
  if (Array.isArray(doc.lockTargets) && doc.lockTargets.every((t) => typeof t === "string" && t !== "")) {
    return { targets: doc.lockTargets as string[], ...(typeof doc.head === "string" ? { head: doc.head } : {}) };
  }
  const waves = doc.selection?.waves;
  if (!Array.isArray(waves) || !waves.every((w) => Array.isArray(w) && w.every((n) => typeof n === "string"))) {
    return { error: `--from-report: "${file}" has no selection.waves; pass a pr-plan.json that chant components pr-plan wrote` };
  }
  return { targets: (waves as string[][]).flat(), ...(typeof doc.head === "string" ? { head: doc.head } : {}) };
}

async function postStatus(forge: PrForge | undefined, head: string | undefined, state: "success" | "failure", description: string): Promise<void> {
  if (!forge || !head) return;
  try {
    await forge.setStatus(head, { context: LOCK_STATUS_CONTEXT, state, description: description.length > 140 ? `${description.slice(0, 137)}...` : description, ...(forge.runUrl ? { url: forge.runUrl } : {}) });
  } catch (err) {
    console.error(formatWarning({ message: `could not post ${LOCK_STATUS_CONTEXT} on ${head}: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

/** chant lock */
export async function runLock(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const gate = gateOf(ctx);
  if (typeof gate !== "string") return fail(gate.error);

  if (args.aliveRun !== undefined) {
    const { forgeLockLiveness } = await import("../../lifecycle/resource-lock");
    // The lease's age is the caller's to judge (the tag carries its own), so only the forge and the process are asked here.
    const verdict = await forgeLockLiveness(process.env)({ run: args.aliveRun, at: new Date().toISOString() });
    console.log(verdict);
    return 0;
  }

  if (args.beatRun !== undefined) {
    if (args.parentPid === undefined) return fail("--beat needs the process it beats for: --beat <run> --parent <pid>");
    const { beatLockRows, lockBeatSeconds } = await import("../../lifecycle/resource-lock");
    const { runBeatLoop } = await import("../../lifecycle/lock-beat");
    const run = args.beatRun;
    await runBeatLoop({
      gate,
      run,
      parent: args.parentPid,
      intervalMs: lockBeatSeconds(process.env) * 1000,
      beat: (at) => beatLockRows(gate, run, at),
      log: (line) => console.error(line),
    });
    return 0;
  }

  if (args.list) {
    if (targetsOf(ctx).length > 0 || args.pr !== undefined) return fail("--list prints every lock; drop the targets and --pr");
    let file;
    let held;
    try {
      file = await readTargetLocks(gate);
      // #4594: the apply rows of the gate (#4552), each with the run that holds it.
      const { readLockRows } = await import("../../lifecycle/resource-lock");
      held = await readLockRows(gate);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const rows = Object.entries(file.locks).sort(([a], [b]) => a.localeCompare(b));
    const leased = Object.entries(held.rows)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, run]) => ({ key, holder: held.holders[run]! }));
    if (args.json) {
      const { lockRowsPath } = await import("../../lifecycle/resource-lock");
      console.log(
        JSON.stringify(
          { gate, path: await targetLockPathAt(gate), locks: Object.fromEntries(rows), rowsPath: lockRowsPath(gate), rows: Object.fromEntries(leased.map((r) => [r.key, r.holder])) },
          null,
          2,
        ),
      );
      return 0;
    }
    if (rows.length === 0) console.error(formatInfo(`no target locks on ${gate}`));
    for (const [target, l] of rows) console.log(`${target}\tpull request ${l.pr}\t${l.stage}\t${l.by}\t${l.at}`);
    if (leased.length === 0) console.error(formatInfo(`no apply rows held on ${gate}`));
    for (const { key, holder } of leased) console.log(`${key}\trun ${holder.run}\t${holder.at}${holder.url ? `\t${holder.url}` : ""}${holder.beat ? `\tbeat ${holder.beat}` : ""}`);
    return 0;
  }

  // #4979: GitLab's lock job, in the target branch's plan notes pipeline, locks what every open merge request reaches.
  if (args.lockReach && args.open) return runReachOpen(ctx, gate);
  if (args.pr === undefined) return fail("chant lock needs the pull or merge request that holds the locks: --pr <n>", "chant lock --list prints the locks held now.");
  const stage = (args.lockStage ?? "lock") as TargetLockStage;
  if (!(TARGET_LOCK_STAGES as readonly string[]).includes(stage)) return fail(`--stage ${args.lockStage} is not one of ${TARGET_LOCK_STAGES.join(", ")}`);

  let targets = targetsOf(ctx);
  let head = args.head;
  if (args.lockReach) {
    // #4979: the targets the change reaches, from the pipeline's reach line, after the head is fetched and checked.
    if (targets.length > 0 || args.fromReport || args.keepLocks) return fail("--reach locks what the reach line prints; drop the names, --from-report and --keep");
    const line = process.env[LOCK_REACH_ENV] ?? "";
    if (!line.trim()) return fail(`--reach runs the reach line in ${LOCK_REACH_ENV}, which is not set`, "The generated lock job sets it from the product plan's reach.");
    if (args.forge === undefined || !(FORGE_KINDS as readonly string[]).includes(args.forge)) return fail("--reach fetches the pull request's head from the forge: give --forge github, gitlab or forgejo");
    if (!head || args.base === undefined) return fail("--reach measures the change from --base <sha> to --head <sha>");
    const reached = reachedTargets({ forge: args.forge as ForgeKind, pr: args.pr, head, base: args.base, line });
    if ("error" in reached) return fail(reached.error);
    if ("moved" in reached) {
      console.error(formatInfo(reached.moved));
      return 0;
    }
    targets = reached.targets;
  } else if (args.keepLocks) {
    if (targets.length > 0 || args.fromReport) return fail("--keep keeps the locks the pull request holds; drop the names and --from-report");
    let file;
    try {
      file = await readTargetLocks(gate);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    targets = Object.entries(file.locks).filter(([, l]) => l.pr === args.pr).map(([target]) => target).sort();
    head ??= Object.values(file.locks).find((l) => l.pr === args.pr)?.head;
    if (targets.length === 0) return fail(`pull request ${args.pr} holds no lock on ${gate} yet, so there is nothing to keep`, "Its plan takes the locks under ci.locks: plan; comment again once the plan job ran.");
  } else if (args.fromReport) {
    if (targets.length > 0) return fail("--from-report reads the targets from the report; drop the names");
    const read = fromReport(args.fromReport, args.pr);
    if ("error" in read) return fail(read.error);
    targets = read.targets;
    head ??= read.head;
  } else if (targets.length === 0 && stage !== "plan") {
    return fail("chant lock needs the targets to lock: chant lock <target>... --pr <n>", "Or --from-report <pr-plan.json> to lock what a plan selected.");
  }

  const forge = forgeOf(ctx);
  if (forge && "error" in forge) return fail(forge.error);
  const isOpen = forge?.pullRequestOpen?.bind(forge);
  const by = args.by ?? actorFromEnv();
  const name = prName(forge);

  let result;
  try {
    result = await takeTargetLocks(
      gate,
      targets,
      { pr: args.pr, by, at: new Date().toISOString(), stage, ...(head ? { head } : {}) },
      { ...(isOpen ? { isOpen } : {}), releaseStalePlan: stage === "plan" },
    );
  } catch (err) {
    return fail(`could not take the locks of ${gate}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!result.ok) {
    const holders = [...new Set(result.held.map((h) => h.pr))].sort((a, b) => a - b);
    const text = `${describeHeldTargetLocks(result.held, name)}, so ${name(args.pr)} is not locked`;
    await postStatus(forge, head, "failure", `locked by ${holders.map(name).join(", ")}: ${result.held.map((h) => h.target).join(", ")}`);
    if (args.json) console.log(JSON.stringify({ gate, pr: args.pr, ok: false, held: result.held }, null, 2));
    console.error(formatError({ message: text, hint: `Lock again once ${holders.length === 1 ? "it merges or closes" : "they merge or close"}, or after chant unlock --pr ${holders[0]}.${isOpen ? "" : " Without --forge every lock counts as held."}` }));
    return HELD_EXIT_CODE;
  }

  const holds = result.taken.length > 0 ? `holds ${result.taken.join(", ")}` : "reaches no target";
  await postStatus(forge, head, "success", holds);
  if (args.json) {
    console.log(JSON.stringify({ gate, pr: args.pr, ok: true, stage, taken: result.taken, released: result.released, expired: result.expired, pushed: result.pushed }, null, 2));
    return 0;
  }
  console.error(formatSuccess(`${name(args.pr)} ${holds} on ${gate}`));
  if (result.released.length > 0) console.error(formatInfo(`released ${result.released.join(", ")}, which it no longer reaches`));
  if (result.expired.length > 0) console.error(formatInfo(`took over ${result.expired.join(", ")} from pull requests that merged or closed`));
  if (!result.pushed && (result.taken.length > 0 || result.released.length > 0)) console.error(formatInfo("chant/lifecycle was not pushed: this repository has no remote, or recording is off"));
  return 0;
}

/**
 * `chant lock --reach --open --base <sha> --forge gitlab [--branch <name>]`
 * (#4979): GitLab's lock job, in a pipeline of the target branch. Every
 * open merge request from the project that merges into the branch (default
 * `CI_COMMIT_BRANCH`) takes the locks of what its change reaches, and a
 * holder that is no longer open releases its locks. Exit 3 when another
 * merge request holds what one reaches, 1 when a reach could not be read.
 */
async function runReachOpen(ctx: CommandContext, gate: string): Promise<number> {
  const { args } = ctx;
  const line = process.env[LOCK_REACH_ENV] ?? "";
  if (!line.trim()) return fail(`--reach runs the reach line in ${LOCK_REACH_ENV}, which is not set`);
  if (args.pr !== undefined || targetsOf(ctx).length > 0) return fail("--open locks every open merge request; drop --pr and the names");
  if (args.base === undefined) return fail("--reach measures each change from --base <sha>, the target branch's commit");
  const stage = (args.lockStage ?? "plan") as TargetLockStage;
  if (!(TARGET_LOCK_STAGES as readonly string[]).includes(stage)) return fail(`--stage ${args.lockStage} is not one of ${TARGET_LOCK_STAGES.join(", ")}`);
  const forge = forgeOf(ctx);
  if (!forge) return fail("--open asks the forge for the open merge requests: give --forge gitlab");
  if ("error" in forge) return fail(forge.error);
  const branch = args.branch ?? process.env.CI_COMMIT_BRANCH ?? "";
  if (!branch) return fail("--open locks the merge requests into one branch: give --branch <name>, or run it in a branch pipeline");
  if (!forge.openPullRequests || !forge.pullRequestOpen) return fail(`the ${forge.kind} client cannot list the open merge requests`);
  const isOpen = forge.pullRequestOpen.bind(forge);
  const name = prName(forge);
  let open;
  try {
    open = await forge.openPullRequests(branch);
  } catch (err) {
    return fail(`could not list the open merge requests into ${branch}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const by = actorFromEnv();
  const { outcomes, released } = await reachOpen({
    forge: forge.kind,
    base: args.base,
    line,
    branch,
    open,
    isOpen,
    take: async (pr, head, targets) => {
      const r = await takeTargetLocks(gate, targets, { pr, by, at: new Date().toISOString(), stage, head }, { isOpen, releaseStalePlan: stage === "plan" });
      if (r.ok) {
        await postStatus(forge, head, "success", r.taken.length > 0 ? `holds ${r.taken.join(", ")}` : "reaches no target");
        return { ok: true, released: r.released };
      }
      await postStatus(forge, head, "failure", `locked by ${[...new Set(r.held.map((h) => h.pr))].map(name).join(", ")}: ${r.held.map((h) => h.target).join(", ")}`);
      return { ok: false, held: `${describeHeldTargetLocks(r.held, name)}, so ${name(pr)} is not locked` };
    },
    holders: async () => [...new Set(Object.values((await readTargetLocks(gate)).locks).map((l) => l.pr))].sort((a, b) => a - b),
    release: async (pr) => (await releaseTargetLocks(gate, pr)).released,
  });
  let code = 0;
  for (const o of outcomes) {
    if (o.kind === "locked") console.error(formatSuccess(`${name(o.pr)} ${o.targets.length > 0 ? `holds ${o.targets.join(", ")}` : "reaches no target"} on ${gate}${o.released.length > 0 ? `; released ${o.released.join(", ")}, which it no longer reaches` : ""}`));
    else if (o.kind === "skipped") console.error(formatInfo(o.text));
    else if (o.kind === "held") {
      console.error(formatError({ message: o.text }));
      if (code === 0) code = HELD_EXIT_CODE;
    } else {
      console.error(formatError({ message: `${name(o.pr)}: ${o.text}` }));
      code = 1;
    }
  }
  for (const r of released) console.error(formatInfo(`${name(r.pr)} is not open, so its locks on ${r.targets.join(", ")} are released`));
  if (args.json) console.log(JSON.stringify({ gate, outcomes, released }, null, 2));
  return code;
}

/** chant unlock */
export async function runUnlock(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const gate = gateOf(ctx);
  if (typeof gate !== "string") return fail(gate.error);
  if (args.unlockRun !== undefined) {
    if (args.pr !== undefined || targetsOf(ctx).length > 0) return fail("--run frees the rows of one run; drop --pr and the targets");
    const { clearRunLockRows } = await import("../../lifecycle/resource-lock");
    let cleared;
    try {
      cleared = await clearRunLockRows(gate, args.unlockRun);
    } catch (err) {
      return fail(`could not clear run ${args.unlockRun} from ${gate}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (args.json) {
      console.log(JSON.stringify({ gate, run: args.unlockRun, released: cleared.released, waited: cleared.waited, pushed: cleared.pushed }, null, 2));
      return 0;
    }
    if (cleared.released.length === 0 && !cleared.waited) console.error(formatInfo(`run ${args.unlockRun} holds no row and waits for none on ${gate}`));
    else console.error(formatSuccess(`freed ${cleared.released.length > 0 ? cleared.released.join(", ") : "no row"}${cleared.waited ? " and took run " + args.unlockRun + " out of the queue" : ""} on ${gate}`));
    return 0;
  }
  if (args.pr === undefined) return fail("chant unlock needs the pull or merge request whose locks it releases: --pr <n>, or the run whose rows it frees: --run <id>");
  const targets = targetsOf(ctx);
  let result;
  try {
    result = await releaseTargetLocks(gate, args.pr, targets.length > 0 ? { targets } : {});
  } catch (err) {
    return fail(`could not release the locks of ${gate}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (args.json) {
    console.log(JSON.stringify({ gate, pr: args.pr, released: result.released, pushed: result.pushed }, null, 2));
    return 0;
  }
  if (result.released.length === 0) console.error(formatInfo(`pull request ${args.pr} holds no lock${targets.length > 0 ? ` on ${targets.join(", ")}` : ""} on ${gate}`));
  else console.error(formatSuccess(`released the locks pull request ${args.pr} held on ${result.released.join(", ")}`));
  return 0;
}

/**
 * `chant lock` and `chant unlock` (#4293): take, list and release the target
 * locks a pull request holds (../../lifecycle/target-lock.ts).
 *
 * ```
 * chant lock <target>... --pr <n> [--stage plan|apply|lock] [--head <sha>] [--by <who>] [--gate <name>] [--forge <kind>] [--json]
 * chant lock --from-report <pr-plan.json> --pr <n> [--stage plan] [--forge <kind>] [--json]
 * chant lock --keep --pr <n> [--head <sha>] [--gate <name>] [--forge <kind>] [--json]
 * chant lock --list [--gate <name>] [--json]
 * chant lock --alive <run>
 * chant unlock --pr <n> [<target>...] [--gate <name>] [--json]
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
import { FORGE_KINDS, forgeFromEnv, type ForgeKind, type PrForge } from "../../pr-forge";
import { PR_APPLY_GATE } from "../../pr-loop";
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
    return forgeFromEnv(kind as ForgeKind);
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
    for (const { key, holder } of leased) console.log(`${key}\trun ${holder.run}\t${holder.at}${holder.url ? `\t${holder.url}` : ""}`);
    return 0;
  }

  if (args.pr === undefined) return fail("chant lock needs the pull or merge request that holds the locks: --pr <n>", "chant lock --list prints the locks held now.");
  const stage = (args.lockStage ?? "lock") as TargetLockStage;
  if (!(TARGET_LOCK_STAGES as readonly string[]).includes(stage)) return fail(`--stage ${args.lockStage} is not one of ${TARGET_LOCK_STAGES.join(", ")}`);

  let targets = targetsOf(ctx);
  let head = args.head;
  if (args.keepLocks) {
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
  const by = args.by ?? process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown";
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

/** chant unlock */
export async function runUnlock(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const gate = gateOf(ctx);
  if (typeof gate !== "string") return fail(gate.error);
  if (args.pr === undefined) return fail("chant unlock needs the pull or merge request whose locks it releases: --pr <n>");
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

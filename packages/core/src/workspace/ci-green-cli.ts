/**
 * `chant ci` (#3573, ws-103): which commits passed CI.
 *
 *   ci last-green [--json] [--from <rev>] the newest commit on the branch with a green tag and no revoked tag
 *   ci list [--json] [--limit <n>] [--since <rev>] [--forge github] [--source checks|runs]
 *                                        the branch's commits within the window, each with its state and phase results
 *   ci tick [--dry-run] [--forge github] [--source checks|runs] [--key <runner key.pem>]
 *                                        tag the commits that turned green, revoke the ones that turned red
 *   ci workflow [--workflow <name>]... [--output <file>] [--chant <command>] [--install <command>]
 *               [--token-secret <NAME> | --app-id-var <VAR> --app-key-secret <NAME>] [--runner-key-secret <NAME>]
 *                                        write the root CI file that runs the tick, and the triggers and
 *                                        concurrency of the workflows holding a phase that sets build (#4169)
 *
 * The tick signs its tags with a runner key (#4031) from `--key <file>` or
 * the PEM in `CHANT_RUNNER_KEY`, which the generated workflow sets from the
 * secret `--runner-key-secret` names.
 *
 * `--source runs` (or `ci.green.source: "runs"`) reads phase results from
 * chant's own signed Op runs on `chant/lifecycle` in place of the forge's
 * check runs (#4044); a tick from runs needs no forge token.
 *
 * `last-green --json` prints `ci-last-green.schema.json` and `list --json` prints
 * `ci-list.schema.json`. The tick and the
 * workflow print text.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { findWorkspaceRoot } from "../project-root";
import { ciList, ciTick, CiGreenError, formatList, formatTick, lastGreen, RUNNER_KEY_ENV } from "./ci-green";
import { ciForgeFromEnv } from "./ci-green-forge";
import { ACTIONS_NAME, buildTriggerEdits, CI_GREEN_WORKFLOW_FILE, ciGreenHeader, type PushToken, readWorkflowSources, renderCiGreenWorkflow, workflowsHolding, writeWorkflowFile } from "./ci-green-workflow";
import { readDeclaration, readerVersion, WorkspaceReadError, type CiSource } from "./declaration";
import { recordGeneratedFiles, resolveMemberContext, shellArg } from "./member-pipeline";
import { gitTop, workingTree } from "./tree";

const USAGE =
  "chant ci last-green [--json] [--from <rev>] | ci list [--json] [--limit <n>] [--since <rev>] [--forge github] [--source checks|runs] | ci tick [--dry-run] [--forge github] [--source checks|runs] [--key <runner key.pem>] | " +
  "ci workflow [--workflow <name>]... [--output <file>] [--chant <command>] [--install <command>] [--token-secret <NAME> | --app-id-var <VAR> --app-key-secret <NAME>] [--runner-key-secret <NAME>]";

export { RUNNER_KEY_ENV };

/** `--source`, checked (#4044): `checks` or `runs`, or undefined to follow `ci.green.source`. */
function sourceOf(args: CommandContext["args"]): CiSource | undefined {
  const v = args.source;
  if (v === undefined) return undefined;
  if (v !== "checks" && v !== "runs") throw new Error(`--source takes checks (the forge's check runs) or runs (chant's own Op runs), not ${JSON.stringify(v)}`);
  return v;
}

/** Each ignored tag as a warning line for stderr (#4031). */
function warnIgnored(ignored: readonly { tag: string; status: string; reason: string }[]): void {
  for (const t of ignored) console.error(`warning: ignored ${t.tag} (${t.status}): ${t.reason}`);
}

export async function runCiLastGreen(ctx: CommandContext): Promise<number> {
  const doc = lastGreen({ cwd: process.cwd(), ...(ctx.args.migrateFrom !== undefined ? { from: ctx.args.migrateFrom } : {}) });
  if (ctx.args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: doc.error.message, hint: USAGE }));
    return 1;
  }
  warnIgnored(doc.ignored);
  if (!doc.commit) {
    console.error(`No first-parent commit of ${doc.ref} has a ci/green tag without a ci/revoked one. Fetch the tags first: git fetch origin --tags`);
    return 1;
  }
  console.log(doc.commit.sha);
  return 0;
}

export async function runCiList(ctx: CommandContext): Promise<number> {
  try {
    const limit = ctx.args.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit takes a whole number of commits, 1 or more");
    // Only an explicit --forge reaches the network; without it the list reads local refs and tags.
    const forge = ctx.args.forge !== undefined ? ciForgeFromEnv(ctx.args.forge) : undefined;
    const source = sourceOf(ctx.args);
    const doc = await ciList({ cwd: process.cwd(), limit, since: ctx.args.since, forge, ...(source ? { source } : {}) });
    if (ctx.args.json) {
      console.log(JSON.stringify(doc, null, 2));
      return "error" in doc ? 1 : 0;
    }
    if ("error" in doc) {
      console.error(formatError({ message: doc.error.message, hint: USAGE }));
      return 1;
    }
    console.log(formatList(doc));
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci list: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}

const describe = (err: unknown) => (err instanceof WorkspaceReadError ? err.describe() : err instanceof Error ? err.message : String(err));

export async function runCiTick(ctx: CommandContext): Promise<number> {
  try {
    const source = sourceOf(ctx.args);
    // The forge is made only when the source is check runs, so a tick from chant runs needs no forge token.
    const forge = () => ciForgeFromEnv(ctx.args.forge ?? "github");
    const runnerKey = ctx.args.key !== undefined ? readFileSync(resolve(ctx.args.key), "utf-8") : process.env[RUNNER_KEY_ENV] || undefined;
    // #4168: under who-ran-it every tag the tick makes is signed, so a tick without a key makes none.
    if (runnerKey === undefined && ctx.args.dryRun !== true) {
      const { securityGroupsAt } = await import("./security");
      if (securityGroupsAt(process.cwd()).has("who-ran-it")) {
        throw new Error(`the workspace opts into who-ran-it, so the tick signs every tag it makes and needs a runner key; pass --key <runner key.pem> or set ${RUNNER_KEY_ENV}`);
      }
    }
    const result = await ciTick({ cwd: process.cwd(), forge, dryRun: ctx.args.dryRun === true, ...(source ? { source } : {}), ...(runnerKey !== undefined ? { runnerKey } : {}) });
    console.log(formatTick(result, ctx.args.dryRun === true));
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci tick: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}

/** The push token the flags ask for, or none for the Actions token. Throws on a half-given or clashing pair. */
function pushToken(args: CommandContext["args"]): PushToken | undefined {
  const { ciTokenSecret: secret, ciAppIdVar: appIdVar, ciAppKeySecret: appKeySecret } = args;
  for (const [flag, name] of [["--token-secret", secret], ["--app-id-var", appIdVar], ["--app-key-secret", appKeySecret], ["--runner-key-secret", args.ciRunnerKeySecret]] as const) {
    if (name !== undefined && !ACTIONS_NAME.test(name)) throw new Error(`${flag} takes a secret or variable name, letters, digits and underscores, not ${JSON.stringify(name)}`);
  }
  if (secret !== undefined && (appIdVar !== undefined || appKeySecret !== undefined)) throw new Error("--token-secret and --app-id-var/--app-key-secret each name the push token; pass one or the other");
  if ((appIdVar === undefined) !== (appKeySecret === undefined)) throw new Error("a GitHub App token needs both the App's id and its key: --app-id-var <VAR> --app-key-secret <NAME>");
  if (secret !== undefined) return { secret };
  if (appIdVar !== undefined && appKeySecret !== undefined) return { appIdVar, appKeySecret };
  return undefined;
}

export async function runCiWorkflow(ctx: CommandContext): Promise<number> {
  const cwd = process.cwd();
  try {
    const push = pushToken(ctx.args);
    const found = findWorkspaceRoot(cwd);
    if (!found) throw new WorkspaceReadError("declaration-missing", "no chant.workspace.json or .jsonc between this directory and the git root");
    const declaration = readDeclaration(workingTree(found.dir));
    const green = declaration.ci?.green;
    if (!green) throw new CiGreenError("ci-green-undeclared", `${declaration.file} declares no ci.green, so there is nothing for the workflow to run`);
    // git reports its top with symlinks resolved (/private/var on macOS), so resolve the root too.
    const root = realpathSync(found.dir);
    const repoRoot = gitTop(root) ?? root;
    const member = resolveMemberContext(cwd, found);
    const target = ctx.args.output ? resolve(realpathSync(cwd), ctx.args.output) : join(repoRoot, CI_GREEN_WORKFLOW_FILE);
    const fromRepo = relative(repoRoot, target).split(sep).join("/");

    const sources = readWorkflowSources(repoRoot, fromRepo);
    const scan = workflowsHolding(green, sources);
    // #4169: the triggers and concurrency of the workflows holding a phase that sets build. Refused before anything is written.
    const edits = buildTriggerEdits(green, sources);
    const extra = ctx.args.ciWorkflows ?? [];
    const workflows = [...new Set([...scan.workflows, ...extra])].sort();
    for (const f of scan.unreadable) console.error(`warning: ${f} is not valid YAML, so its jobs were not read`);
    for (const u of scan.unmatched) console.error(`warning: no job in .github/workflows/ reports a check run matching ${JSON.stringify(u.pattern)} (phase ${u.phase}); pass --workflow <name> for the workflow that does`);
    if (workflows.length === 0) {
      throw new Error("no workflow in .github/workflows/ holds a check run of a required phase, so nothing would trigger the tick but its schedule; name one with --workflow <name>");
    }

    const base = member ? member.memberRoot : root;
    const parts = ["chant", "ci", "workflow", ...extra.flatMap((w) => ["--workflow", w])];
    if (ctx.args.output) parts.push("--output", relative(base, target).split(sep).join("/"));
    if (ctx.args.ciChant) parts.push("--chant", ctx.args.ciChant);
    if (ctx.args.ciInstall) parts.push("--install", ctx.args.ciInstall);
    if (push && "secret" in push) parts.push("--token-secret", push.secret);
    if (push && "appIdVar" in push) parts.push("--app-id-var", push.appIdVar, "--app-key-secret", push.appKeySecret);
    const runnerKeySecret = ctx.args.ciRunnerKeySecret;
    if (runnerKeySecret) parts.push("--runner-key-secret", runnerKeySecret);
    const { securityGroupsAt } = await import("./security");
    if ((green.signedSince || securityGroupsAt(root).has("who-ran-it")) && !runnerKeySecret) {
      console.error(`warning: ci.green.signedSince is set or the workspace opts into who-ran-it, so the tick needs a runner key; pass --runner-key-secret <NAME> naming the repository secret that holds it, or every tick will fail`);
    }
    const command = parts.map(shellArg).join(" ");
    const workspaceRoot = relative(repoRoot, root).split(sep).join("/") || ".";
    // The install runs in the workspace root, so its lockfile there keys setup-node's npm cache.
    const npmLock = ctx.args.ciInstall && existsSync(join(root, "package-lock.json")) ? (workspaceRoot === "." ? "package-lock.json" : `${workspaceRoot}/package-lock.json`) : undefined;
    const yaml = renderCiGreenWorkflow({ green, workflows, chantVersion: readerVersion(), workspaceRoot, chant: ctx.args.ciChant, install: ctx.args.ciInstall, npmLock, push, ...(runnerKeySecret ? { runnerKeySecret } : {}) });
    const written = writeWorkflowFile(target, ciGreenHeader(command, member ? "member" : "root") + yaml);
    if (member) recordGeneratedFiles(member.memberRoot, [{ path: fromRepo, command }]);
    console.log(`Wrote ${written}: ticks when ${workflows.join(", ")} complete${workflows.length === 1 ? "s" : ""} on ${green.branch}, and every 15 minutes.`);
    for (const e of edits) {
      if (!e.changed) continue;
      const path = writeWorkflowFile(join(repoRoot, e.path), e.text);
      console.log(
        e.build === "newest"
          ? `Wrote ${path}'s triggers and concurrency: ${e.phases.join(", ")} build${e.phases.length === 1 ? "s" : ""} the newest commit on ${green.branch} when a run ends, and a ci/build/<sha> tag by hand.`
          : `Wrote ${path}'s concurrency: ${e.phases.join(", ")} build${e.phases.length === 1 ? "s" : ""} every commit on ${green.branch}, none cancelled.`,
      );
    }
    return 0;
  } catch (err) {
    console.error(formatError({ message: `chant ci workflow: ${describe(err)}`, hint: USAGE }));
    return 1;
  }
}

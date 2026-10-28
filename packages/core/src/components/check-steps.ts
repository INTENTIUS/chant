/**
 * Engine check steps in the check stage (#4633). A lexicon gives the check
 * stage steps of its own for the workspace members of its kinds
 * (`LexiconPlugin.checkSteps`): the pulumi lexicon's `pulumi install`, a
 * stack config check and `pulumi about --json` for each pulumi member. They
 * run after the `ci.hooks.check` hooks (`./check-hooks.ts`), in the same
 * check job, with the same environment: no forge token, no OIDC request
 * variables, no cloud credentials ({@link checkHookEnv}).
 *
 * The steps are the lexicon's, so a product's check (`plywood check`,
 * `terragucci check`) gets them through `chant ci check` with no change of
 * its own. Each step's outcome goes in the check report beside the hooks',
 * and a failed step fails the check with chant's `failed` code, naming the
 * member and, where it has one, the stack.
 *
 * The members are read from the working tree's declaration. The hooks are
 * read at base so a change cannot drop a required check; a step is part of
 * the lexicon, so there is nothing for a change to remove.
 */
import { writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readDeclaration } from "../workspace/declaration";
import { locateWorkspace } from "../workspace/which-chant";
import { CHECK_HOOKS_DIR, CHECK_HOOKS_REPORT_FILE, checkHookEnv, runCheckHooks, type CheckHooksReport, type RunCheckHooksOptions } from "./check-hooks";

/** A workspace member a lexicon's check steps run for. */
export interface CheckStageMember {
  name: string;
  /** The member's directory, absolute. */
  dir: string;
  kind: string;
  /** The values the declaration sets for the kind's fields, or null. */
  fields: Record<string, unknown> | null;
}

/** One check step's run, as the check report lists it. */
export interface CheckStepOutcome {
  /** The lexicon that gave the step. */
  lexicon: string;
  /** The step's name, such as `pulumi-install`. */
  step: string;
  member: string;
  /** The stack, for a step that runs per stack. */
  stack?: string;
  /** The engine's exit status, or 0 for a step that runs no command; 1 for a failure that ran none. */
  exit: number;
  outcome: "passed" | "failed" | "skipped";
  /** Why it failed or was skipped, naming the member and stack. */
  reason?: string;
  /** What the step read, for the report (the engine, plugins and backend for `pulumi about`). */
  detail?: unknown;
}

export interface CheckStepsContext {
  /** The members of the adapter's kinds the check covers. */
  members: CheckStageMember[];
  /** The check job's working directory. */
  cwd: string;
  /** The environment a step runs with: {@link checkHookEnv} of the job's. */
  env: Record<string, string>;
  log: (line: string) => void;
}

/** What a lexicon gives the check stage. */
export interface CheckStepsAdapter {
  /** The lexicon's name, for the report. */
  lexicon: string;
  /** The member kinds it has steps for. */
  kinds: readonly string[];
  /** Run the steps for each member, in order, and return every outcome. A step that fails does not stop another member's. */
  run(ctx: CheckStepsContext): Promise<CheckStepOutcome[]>;
}

/**
 * The working tree's members a check covers: every member with a directory
 * (a `repo` member has none), or those a target names by member name or
 * directory when there are targets. Empty when there is no declaration.
 */
export function checkStageMembers(cwd: string, targets: readonly string[] = []): CheckStageMember[] {
  let located: ReturnType<typeof locateWorkspace>;
  let members: ReturnType<typeof readDeclaration>["members"];
  try {
    located = locateWorkspace(cwd);
    members = readDeclaration(located.tree).members;
  } catch {
    return [];
  }
  const wanted = new Set(targets.map((t) => t.replace(/^\.\//, "").replace(/\/+$/, "")));
  return members
    .filter((m) => m.kind !== "repo")
    .filter((m) => wanted.size === 0 || wanted.has(m.name) || wanted.has(m.dir.replace(/^\.\//, "").replace(/\/+$/, "")))
    .map((m) => ({ name: m.name, dir: resolve(located.rootOnDisk, m.dir), kind: m.kind, fields: m.fields }));
}

export interface RunCheckStepsOptions {
  adapters: readonly CheckStepsAdapter[];
  /** Default {@link checkStageMembers} of `cwd` and `targets`. */
  members?: CheckStageMember[];
  targets?: readonly string[];
  cwd?: string;
  /** Default {@link checkHookEnv} of the process's environment. */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

/** Run every adapter's steps for the members of its kinds, adapter by adapter. */
export async function runCheckSteps(options: RunCheckStepsOptions): Promise<CheckStepOutcome[]> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.error(line));
  const members = options.members ?? checkStageMembers(cwd, options.targets);
  const env = options.env ?? checkHookEnv();
  const out: CheckStepOutcome[] = [];
  for (const adapter of options.adapters) {
    const mine = members.filter((m) => adapter.kinds.includes(m.kind));
    if (mine.length === 0) continue;
    try {
      out.push(...(await adapter.run({ members: mine, cwd, env, log })));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      for (const m of mine) out.push({ lexicon: adapter.lexicon, step: "check", member: m.name, exit: 1, outcome: "failed", reason: `the ${adapter.lexicon} check steps for ${m.name} could not run: ${why}` });
    }
  }
  return out;
}

/** The line a failed step gives the report's `failed`. */
function failedLine(steps: CheckStepOutcome[]): string | undefined {
  const failed = steps.filter((s) => s.outcome === "failed");
  if (failed.length === 0) return undefined;
  return `a check step failed: ${failed.map((s) => s.reason ?? `${s.step} for ${s.member}${s.stack ? ` (stack ${s.stack})` : ""}`).join("; ")}`;
}

/**
 * The check stage (#4556, #4633): the `ci.hooks.check` hooks at base, then,
 * unless a hook failed, the lexicons' check steps. Writes one report with
 * both under `dir` and returns it; `status` is `none` only when no hook is
 * declared and no step ran.
 */
export async function runCheckStage(options: RunCheckHooksOptions & { adapters: readonly CheckStepsAdapter[]; members?: CheckStageMember[] }): Promise<CheckHooksReport> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.error(line));
  const hooks = runCheckHooks(options);
  if (hooks.status === "failed" || options.adapters.length === 0) return hooks;
  const steps = await runCheckSteps({
    adapters: options.adapters,
    ...(options.members ? { members: options.members } : {}),
    targets: options.targets ?? [],
    cwd,
    env: { ...checkHookEnv(), ...options.env },
    log,
  });
  if (steps.length === 0) return hooks;
  const failed = failedLine(steps);
  const report: CheckHooksReport = { ...hooks, status: failed ? "failed" : "passed", steps, ...(failed ? { failed } : {}) };
  const dir = relative(cwd, resolve(cwd, options.dir ?? CHECK_HOOKS_DIR)) || ".";
  writeFileSync(join(cwd, dir, CHECK_HOOKS_REPORT_FILE), JSON.stringify(report, null, 2) + "\n");
  return report;
}

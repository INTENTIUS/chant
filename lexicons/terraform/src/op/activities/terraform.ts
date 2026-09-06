/**
 * terraform Op activities (#2086) — init, plan, apply and show against a root
 * module named in the project's `terraform.roots` config namespace (#2083).
 *
 * Shaped after `lexicons/k3s/src/op/activities/k3s.ts`: `promisify(exec)` with
 * the caller's `AbortSignal` forwarded so a local timeout or Ctrl-C kills the
 * child, `safeHeartbeat` on an interval around the long calls, and every
 * command and environment string produced by a pure exported function so a
 * test can assert on it without running terraform.
 *
 * Two invariants hold for every call:
 *
 *   - `TF_IN_AUTOMATION=1` is in the environment, which is what tells terraform
 *     it is not talking to a person.
 *   - `-input=false` is on every command that accepts it, so a missing variable
 *     fails the step instead of blocking on a prompt nobody will answer.
 *     `terraform show` is the one command that does not accept the flag
 *     (terraform answers `flag provided but not defined: -input`), so it
 *     carries the environment variable alone.
 *
 * `terraformApply` takes a saved plan file and nothing else. A bare apply
 * re-plans at apply time, which is exactly the gap an approval gate exists to
 * close, so it is refused rather than offered.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { safeHeartbeat } from "@intentius/chant/op";
import { loadChantConfigUpward } from "@intentius/chant/config";
import type { TerraformConfig, TerraformRootConfig } from "../../config";

const execAsync = promisify(exec);

/**
 * `terraform show -json` on a large estate runs to megabytes, well past
 * `exec`'s 1 MiB default, and the failure mode there is a truncated buffer
 * rather than a clear error.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Heartbeat cadence for the long calls, matching k3s's installer loop. */
const HEARTBEAT_MS = 15_000;

/** Plan file written into the root directory when a step names none. */
export const DEFAULT_PLAN_FILE = "chant.tfplan";

/** Binary used when the `terraform` namespace records no preference. */
export const DEFAULT_TERRAFORM_BINARY = "terraform";

// ── Args and results ────────────────────────────────────────────────────────

/** Fields every activity here takes: which root, and where the project is. */
export interface TerraformRootArgs {
  /**
   * Key into `terraform.roots`. Not a directory — the directory, workspace,
   * var files and backend config all come from the named entry, so an Op step
   * cannot drift from what the project declared.
   */
  root: string;
  /**
   * Directory to start the `chant.config.*` search from. Default:
   * `process.cwd()`, which is the project root under `chant run`.
   */
  cwd?: string;
}

export interface TerraformInitArgs extends TerraformRootArgs {
  /** `-upgrade`: re-resolve provider and module versions within constraints. */
  upgrade?: boolean;
  /** `-reconfigure`: ignore any existing backend state and configure afresh. */
  reconfigure?: boolean;
}

export interface TerraformPlanArgs extends TerraformRootArgs {
  /** Plan file to write, relative to the root directory. Default: {@link DEFAULT_PLAN_FILE}. */
  planFile?: string;
  /** `-destroy`: plan the removal of everything the root manages. */
  destroy?: boolean;
}

export interface TerraformApplyArgs extends TerraformRootArgs {
  /**
   * The saved plan file to apply, relative to the root directory — normally
   * `plan.out.planFile`, the Plan step's own output. Required: this activity
   * has no bare-apply mode.
   */
  planFile: string;
}

export interface TerraformShowArgs extends TerraformRootArgs {
  /** Show this saved plan file. Omitted, the activity shows current state. */
  planFile?: string;
}

/** What {@link terraformInit} resolved. */
export interface TerraformInitResult {
  /** Absolute path of the root module directory that was initialized. */
  dir: string;
  /** Workspace the run selected via `TF_WORKSPACE`, when the root names one. */
  workspace?: string;
}

/** Counts projected out of a plan's `resource_changes`. */
export interface PlanChangeCounts {
  /** Resources to create. A replace counts here and in `destroys`, as terraform's own summary does. */
  adds: number;
  /** Resources to update in place. */
  changes: number;
  /** Resources to destroy. This is the number an approval gate exists for. */
  destroys: number;
}

/** What {@link terraformPlan} resolved. Carries the plan itself, so no later step re-plans. */
export interface TerraformPlanResult extends PlanChangeCounts {
  /** `true` when terraform reported exit 2 under `-detailed-exitcode`: the plan proposes changes. */
  changed: boolean;
  /** The written plan file, relative to `dir` — hand this straight to {@link terraformApply}. */
  planFile: string;
  /** Absolute path of the root module directory. */
  dir: string;
  /** `terraform show -json <planFile>`, parsed. */
  json: unknown;
  /** `terraform show -no-color <planFile>` — the human-readable plan. */
  text: string;
}

/** What {@link terraformApply} resolved. */
export interface TerraformApplyResult {
  /** The plan file that was applied. */
  planFile: string;
  /** Absolute path of the root module directory. */
  dir: string;
  /** Always `true` on success; the activity throws otherwise. */
  applied: boolean;
}

/** What {@link terraformShow} resolved. */
export interface TerraformShowResult extends PlanChangeCounts {
  /** Whether the output describes a saved plan or current state. */
  source: "plan" | "state";
  /** The `-json` output, parsed. */
  json: unknown;
  /** The `-no-color` output. */
  text: string;
  /** Absolute path of the root module directory. */
  dir: string;
  /** Present when `source` is `"plan"`. */
  planFile?: string;
}

// ── Pure command and environment builders ───────────────────────────────────

/**
 * Quote a command-line argument for the shell `exec` runs it through, leaving
 * ordinary paths and `key=value` pairs untouched so command strings stay
 * readable in logs and in tests.
 */
export function quoteArg(value: string): string {
  return /^[A-Za-z0-9._/:=@,+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Which CLI drives the roots: `terraform.binary`, defaulting to `terraform`. */
export function terraformBinary(config?: TerraformConfig): string {
  return config?.binary ?? DEFAULT_TERRAFORM_BINARY;
}

/**
 * Environment for every invocation. `TF_IN_AUTOMATION` suppresses the
 * "run terraform apply next" hand-holding and is terraform's own signal that
 * no human is watching; `TF_WORKSPACE` is how a workspace gets selected
 * without a separate `terraform workspace select` round-trip.
 */
export function terraformEnvironment(root?: Pick<TerraformRootConfig, "workspace">): Record<string, string> {
  return {
    TF_IN_AUTOMATION: "1",
    ...(root?.workspace ? { TF_WORKSPACE: root.workspace } : {}),
  };
}

/** `terraform init`, with the root's `backendConfig` as `-backend-config=k=v` flags. */
export function terraformInitCommand(opts: {
  binary: string;
  backendConfig?: Record<string, string>;
  upgrade?: boolean;
  reconfigure?: boolean;
}): string {
  const parts = [opts.binary, "init", "-input=false"];
  if (opts.upgrade) parts.push("-upgrade");
  if (opts.reconfigure) parts.push("-reconfigure");
  for (const [key, value] of Object.entries(opts.backendConfig ?? {})) {
    parts.push(`-backend-config=${quoteArg(`${key}=${value}`)}`);
  }
  return parts.join(" ");
}

/**
 * `terraform plan`. `-detailed-exitcode` is what makes the run answerable:
 * 0 means no changes, 2 means changes, and anything else is a failure. See
 * {@link terraformPlan}.
 */
export function terraformPlanCommand(opts: {
  binary: string;
  planFile: string;
  varFiles?: string[];
  destroy?: boolean;
}): string {
  const parts = [opts.binary, "plan", "-input=false", "-detailed-exitcode"];
  if (opts.destroy) parts.push("-destroy");
  for (const varFile of opts.varFiles ?? []) parts.push(`-var-file=${quoteArg(varFile)}`);
  parts.push(`-out=${quoteArg(opts.planFile)}`);
  return parts.join(" ");
}

/** `terraform apply <planFile>` — a saved plan, never a bare apply. */
export function terraformApplyCommand(opts: { binary: string; planFile: string }): string {
  return `${opts.binary} apply -input=false ${quoteArg(opts.planFile)}`;
}

/**
 * `terraform show`. The one command here that takes no `-input` flag
 * (terraform answers `flag provided but not defined: -input`), so automation
 * rests on `TF_IN_AUTOMATION` alone. Show reads an artifact and prompts for
 * nothing in the first place.
 */
export function terraformShowCommand(opts: { binary: string; json: boolean; planFile?: string }): string {
  const parts = [opts.binary, "show", opts.json ? "-json" : "-no-color"];
  if (opts.planFile) parts.push(quoteArg(opts.planFile));
  return parts.join(" ");
}

/**
 * Project a plan's `resource_changes` into add/change/destroy counts, the same
 * three terraform prints at the end of a plan. A replace (`["delete","create"]`)
 * counts as one add and one destroy, exactly as terraform reports it.
 */
export function countPlanChanges(planJson: unknown): PlanChangeCounts {
  const counts: PlanChangeCounts = { adds: 0, changes: 0, destroys: 0 };
  const changes = (planJson as { resource_changes?: unknown } | null | undefined)?.resource_changes;
  if (!Array.isArray(changes)) return counts;
  for (const entry of changes) {
    const actions = (entry as { change?: { actions?: unknown } } | null | undefined)?.change?.actions;
    if (!Array.isArray(actions)) continue;
    if (actions.includes("create")) counts.adds++;
    if (actions.includes("update")) counts.changes++;
    if (actions.includes("delete")) counts.destroys++;
  }
  return counts;
}

// ── Root resolution ─────────────────────────────────────────────────────────

/** A root entry resolved against the project config, ready to run in. */
interface ResolvedRoot {
  binary: string;
  root: TerraformRootConfig;
  /** Absolute path of `root.dir`, resolved against the project root. */
  dir: string;
}

/**
 * Read `terraform.roots` out of the project config and resolve one entry.
 * The walk is {@link loadChantConfigUpward}, so a step invoked from a
 * subdirectory still finds the project's `chant.config.*`, and `dir` resolves
 * against the directory that config lives in rather than against the cwd.
 */
async function resolveRoot(args: TerraformRootArgs): Promise<ResolvedRoot> {
  const start = resolve(args.cwd ?? process.cwd());
  const { config, configPath } = await loadChantConfigUpward(start);
  const projectRoot = configPath ? dirname(configPath) : start;
  const namespace = (config as { terraform?: TerraformConfig }).terraform;
  const roots = namespace?.roots ?? {};
  const root = roots[args.root];
  if (!root) {
    const known = Object.keys(roots).sort();
    throw new Error(
      `terraform: no root named "${args.root}" in terraform.roots` +
        `${configPath ? ` (${configPath})` : ""} — ` +
        (known.length > 0 ? `known roots: ${known.join(", ")}` : "the namespace declares no roots"),
    );
  }
  return { binary: terraformBinary(namespace), root, dir: resolve(projectRoot, root.dir) };
}

/** The shape `promisify(exec)` rejects with: an Error carrying the child's exit code and output. */
interface ExecFailure {
  code?: unknown;
  stdout?: string;
  stderr?: string;
}

/** Run `cmd` in `dir`, forwarding the signal so an abort kills the child. */
async function run(
  cmd: string,
  dir: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { cwd: dir, env: { ...process.env, ...env }, signal, maxBuffer: MAX_BUFFER });
}

/** Run `body` with a heartbeat ticking, so a long terraform call is not read as a hung one. */
async function withHeartbeat<T>(details: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => safeHeartbeat(details), HEARTBEAT_MS);
  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
}

function report(stdout: string, stderr: string): void {
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

// ── Activities ──────────────────────────────────────────────────────────────

/**
 * `terraform init` in the named root, with the root's `backendConfig` supplied
 * as `-backend-config` flags. Uses the longInfra profile: init downloads
 * providers and modules, a network call of unpredictable size.
 */
export async function terraformInit(
  args: TerraformInitArgs,
  signal?: AbortSignal,
): Promise<TerraformInitResult> {
  const { binary, root, dir } = await resolveRoot(args);
  const cmd = terraformInitCommand({
    binary,
    ...(root.backendConfig ? { backendConfig: root.backendConfig } : {}),
    ...(args.upgrade ? { upgrade: true } : {}),
    ...(args.reconfigure ? { reconfigure: true } : {}),
  });

  const { stdout, stderr } = await withHeartbeat({ step: "terraform init", root: args.root, dir }, () =>
    run(cmd, dir, terraformEnvironment(root), signal),
  );
  report(stdout, stderr);

  return { dir, ...(root.workspace ? { workspace: root.workspace } : {}) };
}

/**
 * `terraform plan -detailed-exitcode -out=<planFile>` in the named root, then
 * `terraform show` over the written plan in both `-json` and `-no-color` form.
 *
 * The exit code is the answer, not an error condition: 0 is a plan with no
 * changes, 2 is a plan with changes, and anything else, 1 included, is a
 * failure thrown with terraform's own stderr attached. Both `show` renders
 * come back with the result, so a gate, a report or an apply downstream reads
 * the plan that ran instead of planning again against a moved world.
 *
 * Uses the longInfra profile: plan refreshes every resource against its
 * provider.
 */
export async function terraformPlan(
  args: TerraformPlanArgs,
  signal?: AbortSignal,
): Promise<TerraformPlanResult> {
  const { binary, root, dir } = await resolveRoot(args);
  const planFile = args.planFile ?? DEFAULT_PLAN_FILE;
  const env = terraformEnvironment(root);
  const cmd = terraformPlanCommand({
    binary,
    planFile,
    ...(root.varFiles ? { varFiles: root.varFiles } : {}),
    ...(args.destroy ? { destroy: true } : {}),
  });

  const changed = await withHeartbeat({ step: "terraform plan", root: args.root, dir }, async () => {
    try {
      const { stdout, stderr } = await run(cmd, dir, env, signal);
      report(stdout, stderr);
      return false;
    } catch (err) {
      // An abort or a spawn failure carries no numeric exit code. That is not
      // terraform answering, so it propagates untouched.
      const failure = err as ExecFailure;
      if (typeof failure.code !== "number") throw err;
      if (failure.code !== 2) {
        const detail = (failure.stderr ?? "").trim() || (failure.stdout ?? "").trim();
        throw new Error(
          `${binary} plan failed in ${dir} (exit ${failure.code})${detail ? `\n${detail}` : ""}`,
        );
      }
      report(failure.stdout ?? "", failure.stderr ?? "");
      return true;
    }
  });

  const jsonRun = await run(terraformShowCommand({ binary, json: true, planFile }), dir, env, signal);
  const textRun = await run(terraformShowCommand({ binary, json: false, planFile }), dir, env, signal);
  const json: unknown = JSON.parse(jsonRun.stdout);

  return { changed, planFile, dir, json, text: textRun.stdout, ...countPlanChanges(json) };
}

/**
 * `terraform apply <planFile>` in the named root. A saved plan only: without
 * one, apply re-plans at apply time and acts on something no gate ever saw,
 * so a missing `planFile` is refused here rather than quietly widened into a
 * bare apply.
 *
 * Uses the longInfra profile.
 */
export async function terraformApply(
  args: TerraformApplyArgs,
  signal?: AbortSignal,
): Promise<TerraformApplyResult> {
  if (typeof args.planFile !== "string" || args.planFile.trim() === "") {
    throw new Error(
      "terraformApply: planFile is required — this activity applies a saved plan and has no bare-apply mode. " +
        "Pass the Plan step's own output (`plan.out.planFile`).",
    );
  }

  const { binary, root, dir } = await resolveRoot(args);
  const cmd = terraformApplyCommand({ binary, planFile: args.planFile });

  const { stdout, stderr } = await withHeartbeat(
    { step: "terraform apply", root: args.root, dir, planFile: args.planFile },
    () => run(cmd, dir, terraformEnvironment(root), signal),
  );
  report(stdout, stderr);

  return { planFile: args.planFile, dir, applied: true };
}

/**
 * `terraform show` over current state, or over a saved plan when `planFile` is
 * given. Returns the parsed `-json` output and the `-no-color` render, plus
 * the add/change/destroy counts when the subject is a plan. State has no
 * change set, so for state the three counts are zero.
 *
 * Uses the fastIdempotent profile: show reads an artifact and calls no
 * provider.
 */
export async function terraformShow(
  args: TerraformShowArgs,
  signal?: AbortSignal,
): Promise<TerraformShowResult> {
  const { binary, root, dir } = await resolveRoot(args);
  const env = terraformEnvironment(root);
  const planFile = args.planFile;

  const jsonRun = await run(
    terraformShowCommand({ binary, json: true, ...(planFile ? { planFile } : {}) }),
    dir,
    env,
    signal,
  );
  const textRun = await run(
    terraformShowCommand({ binary, json: false, ...(planFile ? { planFile } : {}) }),
    dir,
    env,
    signal,
  );
  const json: unknown = JSON.parse(jsonRun.stdout);

  return {
    source: planFile ? "plan" : "state",
    json,
    text: textRun.stdout,
    dir,
    ...(planFile ? { planFile } : {}),
    ...(planFile ? countPlanChanges(json) : { adds: 0, changes: 0, destroys: 0 }),
  };
}

/**
 * The check moment (#4556): `ci.hooks.check` in the workspace declaration,
 * run by a product's check job, terragucci's and plywood's alike, with the
 * runner the other moments use (`runStageHooks`). Nothing here knows an
 * engine: a hook is the user's own tool (tflint, checkov, trivy,
 * pre-commit), and the product switches it on with a preset.
 *
 * - The hooks are read from the declaration at the base the check measures
 *   the change from, never from the change itself, so a change cannot remove
 *   a required check. The top level's run first, then the member's.
 * - A hook runs once for the check, or once per target with `perRun`;
 *   `{target}` and `CHANT_TARGET` name it, and `targets` match the targets'
 *   names. There is no `{plan}`, and `onFailure` is `fail`.
 * - A hook runs with no forge token, no OIDC request variables and no cloud
 *   credentials in its environment ({@link checkHookEnv}).
 *
 * {@link writeCiHook} is the writer a product's `init` calls to add a hook to
 * `ci.hooks`, keeping the declaration's formatting.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CHECK_HOOK_MOMENT, assertCheckHooks, type CiHooks, type OpWaveHook } from "../op/op-waves";
import { runStageHooks, type OpWaveExec, type OpWaveHookRun } from "../op/stage-hooks";
import { FORGE_TOKEN_VARS } from "../ci-handover";
import { OIDC_REQUEST_VARS, TRADED_VARS } from "../ci-identity";
import { DECLARATION_FILES, readDeclaration, WorkspaceReadError, type Declaration } from "../workspace/declaration";
import { setProperty, valueAt } from "../workspace/json-edit";
import { parseJsonText } from "../workspace/jsonc";
import { memberAtCwd } from "../workspace/security";
import { locateWorkspace } from "../workspace/which-chant";
import type { CheckStepOutcome } from "./check-steps";

export { CI_CHECK_HOOK_FLOOR } from "../op/op-waves";

/** The check hooks a job runs, and where they were read. */
export interface CheckHooksRead {
  hooks: OpWaveHook[];
  /** The commit they were read at. */
  base: string;
  /** A line for the log when none run because the base has no declaration, or could not be read. */
  note?: string;
}

/** The check hooks `declaration` gives a job run in a member (or at the top, `null`): the top level's, then the member's. */
export function checkHooksOf(declaration: Pick<Declaration, "ci" | "members">, member: string | null): OpWaveHook[] {
  const own = member === null ? null : (declaration.members.find((m) => m.name === member)?.ciHooks ?? null);
  return [...(declaration.ci?.hooks?.check ?? []), ...(own?.check ?? [])];
}

/** Whether the working tree's declaration names any check hook. */
function checkoutNamesCheckHooks(cwd: string): boolean {
  try {
    const located = locateWorkspace(cwd);
    const d = readDeclaration(located.tree);
    return checkHooksOf(d, memberAtCwd({ declaration: d, rootOnDisk: located.rootOnDisk }, cwd)).length > 0;
  } catch {
    return false;
  }
}

/**
 * The check hooks a job in `cwd` runs, read from the workspace declaration at
 * `base`. Throws when the declaration at base cannot be read and the working
 * tree's names check hooks, as the pull-request jobs do for their hooks.
 */
export function checkHooksAt(cwd: string, base: string): CheckHooksRead {
  let declaration: Declaration;
  let rootOnDisk: string;
  try {
    const located = locateWorkspace(cwd, base);
    declaration = readDeclaration(located.tree);
    rootOnDisk = located.rootOnDisk;
  } catch (err) {
    const missing = err instanceof WorkspaceReadError && (err.code === "declaration-missing" || err.code === "not-a-git-repository");
    const why = err instanceof Error ? err.message : String(err);
    if (checkoutNamesCheckHooks(cwd)) {
      if (missing) return { hooks: [], base, note: `ci.hooks.check: the base ${base.slice(0, 12)} has no workspace declaration, so the check hooks this change declares do not run until it merges` };
      throw new Error(`ci.hooks.check is read from the workspace declaration at ${base.slice(0, 12)}, and it could not be read (${why}), so no check hook can be trusted to run`);
    }
    return missing ? { hooks: [], base } : { hooks: [], base, note: `ci.hooks.check: the declaration at ${base.slice(0, 12)} could not be read (${why}); this checkout names no check hooks, so none run` };
  }
  return { hooks: checkHooksOf(declaration, memberAtCwd({ declaration, rootOnDisk }, cwd)), base };
}

/** Variables that hold cloud credentials beyond the ones chant's own trade sets. */
const CLOUD_CREDENTIAL_VARS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_PROFILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "AZURE_CLIENT_SECRET", "AZURE_CLIENT_CERTIFICATE_PATH", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_ACCESS_TOKEN", "ARM_CLIENT_SECRET", "ARM_CLIENT_CERTIFICATE_PATH", "ARM_OIDC_TOKEN", "ARM_OIDC_TOKEN_FILE_PATH", "ARM_ACCESS_KEY", "ARM_SAS_TOKEN",
  "PULUMI_ACCESS_TOKEN", "PULUMI_CONFIG_PASSPHRASE", "TFE_TOKEN", "TF_TOKEN_app_terraform_io",
];

/**
 * The environment a check hook runs with (#4556): `env` without a forge
 * token, the OIDC request variables, or cloud credentials, and without any
 * `TF_TOKEN_<host>` registry token. A check reads the change and nothing
 * else.
 */
export function checkHookEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const drop = new Set<string>([...FORGE_TOKEN_VARS, ...OIDC_REQUEST_VARS, ...Object.values(TRADED_VARS).flat(), ...CLOUD_CREDENTIAL_VARS]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || drop.has(name) || name.startsWith("TF_TOKEN_")) continue;
    out[name] = value;
  }
  return out;
}

/** {@link OpWaveExec} with {@link checkHookEnv} in place of the job's environment. */
export const checkHookExec: OpWaveExec = (argv, cwd, env) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit", env: { ...checkHookEnv(), ...env } });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** One check hook's run, as the check report lists it. */
export interface CheckHookOutcome {
  name: string;
  /** The target, for a `perRun` hook. */
  target?: string;
  exit: number;
  outcome: "passed" | "failed" | "skipped";
  reason?: string;
}

/** What the check hooks came to, for the product's check report. */
export interface CheckHooksReport {
  version: 1;
  moment: typeof CHECK_HOOK_MOMENT;
  /** The commit the hooks were read at. */
  base: string;
  targets: string[];
  /** `none`: no check hook is declared at base. */
  status: "passed" | "failed" | "none";
  hooks: CheckHookOutcome[];
  /** The lexicons' check steps (#4633, `./check-steps.ts`), when any ran. */
  steps?: CheckStepOutcome[];
  /** The first hook that failed, and why; the hooks after it did not run. Or the check steps that failed. */
  failed?: string;
  note?: string;
}

/** Where {@link runCheckHooks} writes its runs file and report unless told: `.chant/check`. */
export const CHECK_HOOKS_DIR = ".chant/check";

/** The report file under the directory. */
export const CHECK_HOOKS_REPORT_FILE = "check-hooks.json";

export interface RunCheckHooksOptions {
  /** The commit to read `ci.hooks.check` at: the base the change is measured from. */
  base: string;
  /** The targets the change touches (roots, stacks or components), for `perRun` hooks and `targets`. */
  targets?: readonly string[];
  /** Default the working directory. */
  cwd?: string;
  /** Where the runs file and the report go, relative to `cwd`. Default {@link CHECK_HOOKS_DIR}. */
  dir?: string;
  /** The hooks, when the caller read them itself. Default {@link checkHooksAt} `base`. */
  read?: CheckHooksRead;
  /** Added to every hook's environment, after {@link checkHookEnv}. */
  env?: Record<string, string>;
  /** Default {@link checkHookExec}. */
  exec?: OpWaveExec;
  log?: (line: string) => void;
}

/**
 * Run the check hooks (#4556): each once, or once per target with
 * `perRun`, in order, stopping at the first that fails. Writes the runs file
 * (`{runs}`, `CHANT_RUNS`) and the report under `dir`, and returns the
 * report.
 */
export function runCheckHooks(options: RunCheckHooksOptions): CheckHooksReport {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((line: string) => console.error(line));
  const read = options.read ?? checkHooksAt(cwd, options.base);
  if (read.note) log(read.note);
  const targets = [...(options.targets ?? [])];
  const dir = relative(cwd, resolve(cwd, options.dir ?? CHECK_HOOKS_DIR)) || ".";
  mkdirSync(join(cwd, dir), { recursive: true });
  const report = (r: Omit<CheckHooksReport, "version" | "moment" | "base" | "targets">): CheckHooksReport => {
    const doc: CheckHooksReport = { version: 1, moment: CHECK_HOOK_MOMENT, base: read.base, targets, ...r, ...(read.note ? { note: read.note } : {}) };
    writeFileSync(join(cwd, dir, CHECK_HOOKS_REPORT_FILE), JSON.stringify(doc, null, 2) + "\n");
    return doc;
  };
  if (read.hooks.length === 0) return report({ status: "none", hooks: [] });
  assertCheckHooks("ci.hooks at base", read.hooks);
  const op = "check";
  const runs: OpWaveHookRun[] = targets.map((target) => ({ target, op }));
  const runsFile = join(dir, "runs.json");
  writeFileSync(join(cwd, runsFile), JSON.stringify({ version: 1, op, stage: "check", base: read.base, hook: CHECK_HOOK_MOMENT, runs }, null, 2) + "\n");
  const ran = runStageHooks(CHECK_HOOK_MOMENT, read.hooks, {
    name: op,
    op,
    wave: op,
    runs,
    runsFile,
    holdFile: join(dir, "hold.json"),
    env: { CHANT_CHECK: "1", CHANT_HOOKS_BASE: read.base, ...options.env },
    cwd,
    exec: options.exec ?? checkHookExec,
    log,
  });
  const hooks = ran.outcomes.map((o): CheckHookOutcome => ({
    name: o.name,
    ...(o.target ? { target: o.target } : {}),
    exit: o.exit,
    outcome: o.outcome === "skipped" ? "skipped" : o.outcome === "passed" ? "passed" : "failed",
    ...(o.reason ? { reason: o.reason } : {}),
  }));
  const failed = ran.failed ?? (hooks.some((h) => h.outcome === "failed") ? `a check hook failed: ${hooks.filter((h) => h.outcome === "failed").map((h) => h.name).join(", ")}` : undefined);
  return report({ status: failed ? "failed" : "passed", hooks, ...(failed ? { failed } : {}) });
}

/**
 * Add `hook` to `ci.hooks.<moment>` of the workspace declaration at `root`
 * (#4556), the top level's or `member`'s, keeping the file's formatting. A
 * hook of the same `name` at that moment is replaced, so a product's `init`
 * can run again. Refuses a check hook the check job could not run. Returns
 * the declaration file it wrote.
 */
export function writeCiHook(
  root: string,
  moment: "check",
  hook: OpWaveHook,
  opts: { member?: string } = {},
): { file: string; replaced: boolean } {
  assertCheckHooks(`ci.hooks.${moment}`, [hook]);
  const file = DECLARATION_FILES.map((f) => join(root, f)).find((f) => existsSync(f));
  if (!file) throw new Error(`no workspace declaration at ${root}; create one before adding ci.hooks`);
  const jsonc = file.endsWith(".jsonc");
  const text = readFileSync(file, "utf-8");
  const parsed = parseJsonText(text, { jsonc });
  if (!parsed.ok) throw new Error(`${file} is not valid JSON${jsonc ? "C" : ""}: ${parsed.message}`);
  const doc = parsed.value as { members?: Array<{ name?: string }> };
  let owner = "";
  if (opts.member !== undefined) {
    const index = (doc.members ?? []).findIndex((m) => m?.name === opts.member);
    if (index < 0) throw new Error(`the workspace declaration names no member ${JSON.stringify(opts.member)}`);
    owner = `/members/${index}`;
  }
  const ci = valueAt(doc, `${owner}/ci`) as { hooks?: CiHooks } | undefined;
  const current: OpWaveHook[] = ci?.hooks?.[moment] ?? [];
  const name = hook.name ?? hook.command.join(" ");
  const at = current.findIndex((h) => (h.name ?? h.command.join(" ")) === name);
  const next = at < 0 ? [...current, hook] : current.map((h, i) => (i === at ? hook : h));
  const written =
    ci === undefined ? setProperty(text, jsonc, owner, "ci", { hooks: { [moment]: next } })
    : ci.hooks === undefined ? setProperty(text, jsonc, `${owner}/ci`, "hooks", { [moment]: next })
    : setProperty(text, jsonc, `${owner}/ci/hooks`, moment, next);
  writeFileSync(file, written);
  return { file, replaced: at >= 0 };
}

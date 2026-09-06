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
 * `terraformApply` takes a saved plan file and nothing else on a stock root,
 * since a bare apply re-plans at apply time, which is exactly the gap an
 * approval gate exists to close, so it is refused rather than offered. On a
 * live root (#2103, `terraform.binary: "choudoufu"` plus a declared estate)
 * it is the opposite: choudoufu refuses a plan file by design, so
 * `terraformApply` refuses one there and runs a bare `apply -auto-approve`
 * instead.
 *
 * `choudoufuLivePlan`, `choudoufuLiveLs` and `choudoufuLiveCheck` (#2103) are
 * choudoufu-only activities living in this same module for the same reason
 * the four above do: pure command builders, the `promisify(exec)` shape, and
 * no dependency on the lexicon's HCL parse. `./live-detect.ts` is a
 * deliberately separate, cheap regex-based read of "does this root declare a
 * live estate," used only to decide `terraformApply`'s branch and to
 * auto-detect `-estate` for the two live-only reads that need it; the
 * accurate, AST-based version lives in `../../hcl/parse.ts` and stays out of
 * this module's dependency graph. `choudoufu version` is checked once per
 * module load (`ensureChoudoufuVersion`) and refuses a binary older than
 * {@link MIN_CHOUDOUFU_VERSION}.
 */

import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolve, dirname, join } from "node:path";
import { safeHeartbeat } from "@intentius/chant/op";
import { loadChantConfigUpward } from "@intentius/chant/config";
import type { TerraformConfig, TerraformRootConfig } from "../../config";
import { detectLiveEstate } from "./live-detect";
import {
  parseAdoptionCommands,
  readAdoptionLedger,
  renderAdoptionLedger,
  type AdoptionCandidate,
} from "../adoption";

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

/** Where {@link choudoufuLivePlan} writes GitHub issue #788's JSON document, relative to the root directory. */
export const DEFAULT_LIVE_PLAN_DOCUMENT_FILE = "chant.live-plan.json";

/** choudoufu below this refuses (#2103): `live-plan -json`, `live-ls` and `live-check -json` all need v0.12.0. */
export const MIN_CHOUDOUFU_VERSION = "0.12.0";

/** choudoufu's own refusal text for applying a saved plan file on a live root (`internal/command/live_mode.go`). */
export const CHOUDOUFU_PLAN_FILE_REFUSAL =
  "Applying a saved plan file is not available under live resource markers";

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
   * The saved plan file to apply, relative to the root directory, normally
   * `plan.out.planFile`, the Plan step's own output.
   *
   * Required on a stock root: this activity has no bare-apply mode there.
   * Optional, and refused if given, on a live root (#2103): choudoufu
   * refuses both `-out` and `apply <planfile>` by design (apply always
   * re-plans live), so a live apply runs `apply -auto-approve` with no plan
   * file at all.
   */
  planFile?: string;
}

export interface TerraformShowArgs extends TerraformRootArgs {
  /** Show this saved plan file. Omitted, the activity shows current state. */
  planFile?: string;
}

export interface ChoudoufuLivePlanArgs extends TerraformRootArgs {
  /**
   * The estate whose ownership markers this run looks for (`-estate`).
   * Omitted, it is auto-detected from the root's `live` block or
   * `estate.chdf.hcl` sidecar, the same estate the root's own configuration
   * declares, which is what a live root's every other activity assumes too.
   */
  estate?: string;
  /**
   * Render the human half as choudoufu's adoption ledger (`-adoption-only`)
   * instead of the ordinary plan (#2105).
   *
   * This activity already makes two live reads, one for the `-json` document
   * and one for the human render, because the document carries no rendering of
   * the plan itself. This flag changes only the second of them, which is what
   * makes it possible at all: choudoufu refuses `-adoption-only` and `-json` on
   * one invocation ("this run cannot produce both reports at once"), so the two
   * reports have to come from two runs whether or not chant wants both. The
   * cost is that the second read asks the estate-wide sweep the account-bounded
   * question ("which live resources carry no ownership marker at all"), so it
   * is slower than the ordinary render, not faster.
   */
  adoptionOnly?: boolean;
}

export interface ChoudoufuLiveLsArgs extends TerraformRootArgs {
  /** The estate to list (`-estate`). Omitted, auto-detected the same way {@link ChoudoufuLivePlanArgs.estate} is. */
  estate?: string;
  /** `-consistent`: poll past the Resource Groups Tagging API's eventual-consistency window. */
  consistent?: boolean;
}

export type ChoudoufuLiveCheckArgs = TerraformRootArgs;

export interface ChoudoufuAdoptArgs extends TerraformRootArgs {
  /**
   * The adoptable matches to claim, normally `ledger.out.adoptions` from a
   * {@link choudoufuLivePlan} step run with `adoptionOnly`. Each carries the
   * two marker values and, where choudoufu printed one, the tagging command
   * that writes them.
   */
  adoptions: AdoptionCandidate[];
  /**
   * The contested candidates the same ledger refused, normally
   * `ledger.out.contested`. Passed in so the Op's result names what was not
   * adopted and why, beside what was; nothing here is ever written.
   */
  contested?: AdoptionCandidate[];
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
  /** The plan file that was applied. Absent on a live root: a live apply runs with no plan file. */
  planFile?: string;
  /** Absolute path of the root module directory. */
  dir: string;
  /** Always `true` on success; the activity throws otherwise. */
  applied: boolean;
}

/** Counts projected out of `live-plan -json`'s `unowned` section. */
export interface LivePlanUnownedCounts {
  /** Live resources at a declared identity carrying no ownership marker for this estate. */
  unowned: number;
  /** Of those, how many an exact content match makes adoptable. */
  adoptable: number;
}

/** What {@link choudoufuLivePlan} resolved. */
export interface ChoudoufuLivePlanResult extends LivePlanUnownedCounts {
  /** `true` when `-detailed-exitcode` reported exit 2: the live plan proposes changes. */
  drift: boolean;
  /** GitHub issue #788's JSON document (`bound`, `omissions`, `unowned`), captured whole. */
  json: unknown;
  /**
   * The human-readable plan, from a second `live-plan` run without `-json`
   * (the document carries no render of it) — or, under
   * {@link ChoudoufuLivePlanArgs.adoptionOnly}, choudoufu's own adoption ledger.
   */
  text: string;
  /**
   * chant's rendering of the adoption ledger over the `-json` document
   * (#2105): one line per adoptable match with its address, its live identity
   * and the two marker values, then any contested address, listed and never
   * offered. Present on every run, `-adoption-only` or not, since it is a
   * projection of the document rather than a second report.
   */
  ledger: string;
  /**
   * What a finding mode posts: {@link ChoudoufuLivePlanResult.text} and then
   * {@link ChoudoufuLivePlanResult.ledger}. The one field an issue or PR body
   * references, so that the JSON document has no path into a body at all.
   */
  finding: string;
  /** Adoptable matches: exactly one live resource at the declared address, with the marker pair that claims it. */
  adoptions: AdoptionCandidate[];
  /** Every candidate at a declared address more than one live resource sits at. Never adoptable. */
  contested: AdoptionCandidate[];
  /** How many declared addresses are contested — the count `contested` above spells out. */
  ambiguous: number;
  /** Absolute path of the root module directory. */
  dir: string;
  /** Where the JSON document was written, relative to `dir`; {@link DEFAULT_LIVE_PLAN_DOCUMENT_FILE} unless overridden. */
  documentPath: string;
  /** The estate this plan ran against. */
  estate: string;
}

/** What {@link choudoufuLiveLs} resolved. */
export interface ChoudoufuLiveLsResult {
  /** The `-json` listing, parsed: every resource the account holds under the estate. */
  json: unknown;
  /** Absolute path of the root module directory (`live-ls` needs no configuration, but this activity still runs in it). */
  dir: string;
  /** The estate that was listed. */
  estate: string;
}

/** One adoption {@link choudoufuAdopt} declined, with the reason an operator acts on. */
export interface AdoptionRefusal {
  /** The declared instance address that was not claimed. */
  addr: string;
  /** The live resource's identity, when the refusal is about a particular one. */
  identity: string;
  /** Why, in a sentence, always naming the two marker values a hand-write would need. */
  reason: string;
}

/** What {@link choudoufuAdopt} resolved. */
export interface ChoudoufuAdoptResult {
  /**
   * How the markers were written. Only `"tag-write"` today; the field exists
   * because #2105 weighed a second mechanism (choudoufu's `adopt` policy verb)
   * and a later run of this activity should say which one it used rather than
   * leave a reader to infer it from the absence of a field. See the activity's
   * own doc for why the policy verb is not reachable from outside the
   * configuration.
   */
  mechanism: "tag-write";
  /** The declared addresses whose live resources now carry this estate's markers. */
  adopted: string[];
  /** `adopted.length`, as a scalar a search attribute can carry. */
  adoptedCount: number;
  /** Every candidate this run declined, contested addresses included, with the reason. */
  refused: AdoptionRefusal[];
  /** How many declared addresses were contested — never adopted, always reported. */
  ambiguous: number;
  /** Absolute path of the root module directory. */
  dir: string;
}

/** What {@link choudoufuLiveCheck} resolved. */
export interface ChoudoufuLiveCheckResult {
  /** `true` when the configuration is refused under live resource markers (a non-zero exit). */
  refused: boolean;
  /** GitHub issue #790's declared roster, parsed, when the output could be parsed as JSON. */
  json: unknown;
  /** The raw `-json` output. */
  text: string;
  /** Absolute path of the root module directory. */
  dir: string;
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
 * `choudoufu apply -auto-approve` on a live root: no plan file, since
 * choudoufu refuses `-out` and `apply <planfile>` by design (apply always
 * re-plans live). `-auto-approve` is what lets an automated run skip the
 * confirmation prompt an interactive `apply` would otherwise print.
 */
export function choudoufuLiveApplyCommand(opts: { binary: string }): string {
  return `${opts.binary} apply -input=false -auto-approve`;
}

/**
 * `live-plan -detailed-exitcode -json -estate=<estate>`. `-json` is what
 * prints GitHub issue #788's document instead of the plan; the human render
 * needs a second invocation without it (see {@link choudoufuLivePlan}).
 *
 * `adoptionOnly` makes that second invocation print the adoption ledger and
 * nothing else (GitHub issue #587). It is refused here alongside `json`
 * because choudoufu refuses the pair itself, and a builder that emitted a
 * command the binary rejects would move the error to the far side of a
 * process spawn for no gain.
 */
export function choudoufuLivePlanCommand(opts: {
  binary: string;
  estate: string;
  json: boolean;
  adoptionOnly?: boolean;
  noColor?: boolean;
}): string {
  if (opts.json && opts.adoptionOnly) {
    throw new Error(
      "choudoufuLivePlanCommand: -adoption-only and -json cannot be combined. choudoufu refuses the pair " +
        "(-adoption-only asks for the adoption ledger and -json asks for the bound/omissions/unowned " +
        "document), so the two reports come from two runs.",
    );
  }
  const parts = [opts.binary, "live-plan", "-detailed-exitcode"];
  if (opts.json) parts.push("-json");
  if (opts.adoptionOnly) parts.push("-adoption-only");
  if (opts.noColor) parts.push("-no-color");
  parts.push(`-estate=${quoteArg(opts.estate)}`);
  return parts.join(" ");
}

/** `live-ls -estate=<estate> -json [-consistent]`. */
export function choudoufuLiveLsCommand(opts: { binary: string; estate: string; consistent?: boolean }): string {
  const parts = [opts.binary, "live-ls", `-estate=${quoteArg(opts.estate)}`, "-json"];
  if (opts.consistent) parts.push("-consistent");
  return parts.join(" ");
}

/**
 * `live-check -json`. No `DIR` argument: the activity already runs in the
 * root directory (`cwd`), so `-json` alone checks it, since DIR defaults to
 * `.`. Makes no cloud calls; a non-zero exit is a refusal, not a failure this
 * builder's caller need distinguish from one.
 */
export function choudoufuLiveCheckCommand(opts: { binary: string }): string {
  return `${opts.binary} live-check -json`;
}

/**
 * Project `live-plan -json`'s `unowned` section into counts: how many live
 * resources at a declared identity carry no ownership marker for this
 * estate, and of those, how many an exact content match makes adoptable
 * (`adopt_tofu_estate`/`adopt_tofu_address` present).
 */
export function countLivePlanUnowned(document: unknown): LivePlanUnownedCounts {
  const unowned = (document as { unowned?: unknown } | null | undefined)?.unowned;
  if (!Array.isArray(unowned)) return { unowned: 0, adoptable: 0 };
  let adoptable = 0;
  for (const entry of unowned) {
    const e = entry as { adopt_tofu_estate?: unknown; adopt_tofu_address?: unknown } | null | undefined;
    if (e?.adopt_tofu_estate || e?.adopt_tofu_address) adoptable++;
  }
  return { unowned: unowned.length, adoptable };
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

// ── choudoufu version check ─────────────────────────────────────────────────

/**
 * Parse a semver-ish string's leading `major.minor.patch`, ignoring anything
 * after (a `-dev`/`-rc1` suffix, say). Unparseable input reads as `0.0.0`,
 * which sorts as "older than everything" rather than crashing, since a
 * version string this check cannot make sense of should not be quietly trusted.
 */
function parseVersionCore(version: string): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `version` is strictly older than `min`, comparing `major.minor.patch` numerically. */
export function isOlderVersion(version: string, min: string): boolean {
  const a = parseVersionCore(version);
  const b = parseVersionCore(min);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Extract the release version from `choudoufu version`'s human-readable
 * output: `"choudoufu v0.12.0 (based on OpenTofu v1.13.0)\non darwin_arm64"`.
 * `choudoufu version -json`'s `terraform_version` field is the wrong number
 * here: it names the upstream OpenTofu base this build forked from, not the
 * choudoufu release itself (`internal/command/views/version.go`), so this
 * reads the human form's `choudoufu vX.Y.Z` prefix instead. A dev build with
 * no release tag baked in (`version.Fork` unset) prints only the upstream
 * line and carries no choudoufu version to check at all: `undefined` here,
 * same as an output this cannot parse.
 */
export function parseChoudoufuVersion(versionOutput: string): string | undefined {
  const m = /^choudoufu\s+v?(\d+\.\d+\.\d+)/m.exec(versionOutput);
  return m?.[1];
}

/** Cached per activity-module load (#2103): `choudoufu version` runs at most once per process. */
let choudoufuVersionCheck: Promise<void> | undefined;

/**
 * Refuse a choudoufu binary older than {@link MIN_CHOUDOUFU_VERSION}. Runs
 * `choudoufu version` (never `-json`; see {@link parseChoudoufuVersion}) at
 * most once per module load, cached across every activity call regardless of
 * which one triggered it. A no-op for `terraform`/`tofu`, and a no-op when
 * the version cannot be determined at all (a dev build): this refuses a
 * known-old binary, not an unknown one.
 */
async function ensureChoudoufuVersion(binary: string, signal?: AbortSignal): Promise<void> {
  if (binary !== "choudoufu") return;
  choudoufuVersionCheck ??= (async () => {
    const { stdout } = await execAsync(`${binary} version`, { env: process.env, signal });
    const version = parseChoudoufuVersion(stdout);
    if (version === undefined) return;
    if (isOlderVersion(version, MIN_CHOUDOUFU_VERSION)) {
      throw new Error(
        `choudoufu ${version} is older than the minimum supported version v${MIN_CHOUDOUFU_VERSION} ` +
          "(needed for live-plan -json, live-ls and live-check -json). Upgrade choudoufu.",
      );
    }
  })();
  return choudoufuVersionCheck;
}

/** Test-only: clear the cached version check so a test can simulate a fresh module load. */
export function __resetChoudoufuVersionCheckForTests(): void {
  choudoufuVersionCheck = undefined;
}

// ── Root resolution ─────────────────────────────────────────────────────────

/** A root entry resolved against the project config, ready to run in. */
interface ResolvedRoot {
  binary: string;
  root: TerraformRootConfig;
  /** Absolute path of `root.dir`, resolved against the project root. */
  dir: string;
  /** The declared estate, when `binary` is `"choudoufu"` and one is detected. */
  estate?: string;
  /** `true` exactly when this root is live: `binary` is `"choudoufu"` and `estate` is set. */
  live: boolean;
}

/**
 * Read `terraform.roots` out of the project config and resolve one entry.
 * The walk is {@link loadChantConfigUpward}, so a step invoked from a
 * subdirectory still finds the project's `chant.config.*`, and `dir` resolves
 * against the directory that config lives in rather than against the cwd.
 *
 * Also runs {@link ensureChoudoufuVersion} and, on a choudoufu root,
 * {@link detectLiveEstate}, so every activity answers "is this root live"
 * the same way without repeating either check itself.
 */
async function resolveRoot(args: TerraformRootArgs, signal?: AbortSignal): Promise<ResolvedRoot> {
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
  const binary = terraformBinary(namespace);
  const dir = resolve(projectRoot, root.dir);
  await ensureChoudoufuVersion(binary, signal);
  const estate = binary === "choudoufu" ? detectLiveEstate(dir) : undefined;
  return { binary, root, dir, ...(estate !== undefined ? { estate } : {}), live: estate !== undefined };
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
  const { binary, root, dir } = await resolveRoot(args, signal);
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
  const { binary, root, dir } = await resolveRoot(args, signal);
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
 * `terraform apply <planFile>` in the named root, or, on a live root,
 * `apply -auto-approve` with no plan file at all.
 *
 * A stock root has no bare-apply mode: without a saved `planFile`, apply
 * re-plans at apply time and acts on something no gate ever saw, so a
 * missing one is refused. A live root is the opposite: choudoufu refuses
 * `-out` and `apply <planfile>` by design (apply always re-plans against the
 * live system), so a `planFile` there is refused instead, quoting
 * choudoufu's own reason.
 *
 * Uses the longInfra profile.
 */
export async function terraformApply(
  args: TerraformApplyArgs,
  signal?: AbortSignal,
): Promise<TerraformApplyResult> {
  const { binary, root, dir, live } = await resolveRoot(args, signal);
  const hasPlanFile = typeof args.planFile === "string" && args.planFile.trim() !== "";

  if (live) {
    if (hasPlanFile) {
      throw new Error(
        `terraformApply: a plan file is refused on a live root. choudoufu: "${CHOUDOUFU_PLAN_FILE_REFUSAL}". ` +
          "Call terraformApply with no planFile; a live apply always re-plans against the live system.",
      );
    }
    const cmd = choudoufuLiveApplyCommand({ binary });
    const { stdout, stderr } = await withHeartbeat({ step: "choudoufu apply", root: args.root, dir }, () =>
      run(cmd, dir, terraformEnvironment(root), signal),
    );
    report(stdout, stderr);
    return { dir, applied: true };
  }

  if (!hasPlanFile) {
    throw new Error(
      "terraformApply: planFile is required — this activity applies a saved plan and has no bare-apply mode. " +
        "Pass the Plan step's own output (`plan.out.planFile`).",
    );
  }

  const cmd = terraformApplyCommand({ binary, planFile: args.planFile! });
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
  const { binary, root, dir } = await resolveRoot(args, signal);
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

/**
 * The estate a choudoufu-only activity runs against: `args.estate` when
 * given, else the one {@link resolveRoot} auto-detected from the root's
 * `live` block or `estate.chdf.hcl` sidecar. Throws when neither names one,
 * since `live-plan`/`live-ls` need an estate to filter on, unlike a stock command.
 */
function resolveEstate(args: { estate?: string }, resolved: ResolvedRoot, activity: string): string {
  const estate = args.estate ?? resolved.estate;
  if (!estate) {
    throw new Error(
      `${activity}: no estate to run against. Declare one in the root's \`live\` block or ` +
        "`estate.chdf.hcl` sidecar, or pass `estate` explicitly.",
    );
  }
  return estate;
}

/**
 * `choudoufu live-plan -detailed-exitcode -json -estate=<estate>`, plus a
 * second `live-plan` without `-json` for the human-readable render. GitHub
 * issue #788's JSON document carries no render of the plan itself
 * (`views.LivePlanDocument` has no such field), so unlike `terraformPlan`'s
 * single saved artifact this genuinely needs two live reads.
 *
 * The exit code is the answer, exactly as `terraformPlan`'s is: 0 is no
 * drift, 2 is drift, and anything else is a failure thrown with choudoufu's
 * own stderr attached. The JSON document is written to `documentPath` (under
 * `dir`) for a later step or reviewer to open directly.
 *
 * Uses the longInfra profile: like `terraformPlan`, this reads the live
 * system in full (the estate-wide sweep).
 */
/**
 * The JSON document within a `live-plan -json` stdout: everything from the
 * first line that is a bare `{` to the end. Stock keeps stdout to the
 * document; choudoufu's `-estate` path precedes it with refresh progress
 * lines (choudoufu #894). Returns the input unchanged when no such line
 * exists, so a clean stdout parses as before and a broken one fails in
 * `JSON.parse` with the real text in the error.
 */
export function liveDocumentFrom(stdout: string): string {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.trim() === "{");
  return start === -1 ? stdout : lines.slice(start).join("\n");
}

export async function choudoufuLivePlan(
  args: ChoudoufuLivePlanArgs & { documentPath?: string },
  signal?: AbortSignal,
): Promise<ChoudoufuLivePlanResult> {
  const resolved = await resolveRoot(args, signal);
  const { binary, dir } = resolved;
  const estate = resolveEstate(args, resolved, "choudoufuLivePlan");
  const env = terraformEnvironment(resolved.root);
  const documentPath = args.documentPath ?? DEFAULT_LIVE_PLAN_DOCUMENT_FILE;

  const { drift, stdout: jsonStdout } = await withHeartbeat(
    { step: "choudoufu live-plan", root: args.root, dir, estate },
    async () => {
      const cmd = choudoufuLivePlanCommand({ binary, estate, json: true });
      try {
        const { stdout, stderr } = await run(cmd, dir, env, signal);
        report(stdout, stderr);
        return { drift: false, stdout };
      } catch (err) {
        const failure = err as ExecFailure;
        if (typeof failure.code !== "number") throw err;
        if (failure.code !== 2) {
          const detail = (failure.stderr ?? "").trim() || (failure.stdout ?? "").trim();
          throw new Error(
            `${binary} live-plan failed in ${dir} (exit ${failure.code})${detail ? `\n${detail}` : ""}`,
          );
        }
        report(failure.stdout ?? "", failure.stderr ?? "");
        return { drift: true, stdout: failure.stdout ?? "" };
      }
    },
  );

  // On the `-estate` path choudoufu prints refresh progress to stdout ahead of
  // the document (choudoufu #894), so parse from the first line that opens it.
  const document = liveDocumentFrom(jsonStdout);
  const json: unknown = JSON.parse(document);
  // #788's document carries no render of the human plan itself
  // (`views.LivePlanDocument` has no such field), so the human text needs a
  // second live read rather than a field on the same response. `-adoption-only`
  // (#2105) changes which report that second read prints, never whether there
  // is one: choudoufu refuses the flag alongside `-json`, so the two reports
  // were always going to be two runs.
  const textRun = await run(
    choudoufuLivePlanCommand({
      binary,
      estate,
      json: false,
      noColor: true,
      ...(args.adoptionOnly ? { adoptionOnly: true } : {}),
    }),
    dir,
    env,
    signal,
  );
  const text = textRun.stdout;

  writeFileSync(join(dir, documentPath), document);

  // The adoption commands only exist in the `-adoption-only` render, so a
  // candidate off an ordinary run carries the two marker values and no
  // command — which is the whole ownership contract either way.
  const ledger = readAdoptionLedger(json, args.adoptionOnly ? parseAdoptionCommands(text) : undefined);
  const ledgerText = renderAdoptionLedger(ledger, estate);

  return {
    drift,
    json,
    text,
    ledger: ledgerText,
    finding: `${text.trimEnd()}\n\n${ledgerText}\n`,
    adoptions: ledger.adoptions,
    contested: ledger.contested,
    ambiguous: ledger.ambiguous,
    dir,
    documentPath,
    estate,
    ...countLivePlanUnowned(json),
  };
}

/**
 * `choudoufu live-ls -estate=<estate> -json [-consistent]`: every resource
 * the account holds under the estate, read straight from the Resource Groups
 * Tagging API. No configuration, state or record store is read.
 *
 * Uses the fastIdempotent profile: like `terraformShow`, this reads an
 * artifact-shaped answer and does not plan.
 */
export async function choudoufuLiveLs(
  args: ChoudoufuLiveLsArgs,
  signal?: AbortSignal,
): Promise<ChoudoufuLiveLsResult> {
  const resolved = await resolveRoot(args, signal);
  const { binary, dir } = resolved;
  const estate = resolveEstate(args, resolved, "choudoufuLiveLs");
  const env = terraformEnvironment(resolved.root);

  const cmd = choudoufuLiveLsCommand({ binary, estate, ...(args.consistent ? { consistent: true } : {}) });
  const { stdout, stderr } = await withHeartbeat({ step: "choudoufu live-ls", root: args.root, dir, estate }, () =>
    run(cmd, dir, env, signal),
  );
  report(stdout, stderr);

  return { json: JSON.parse(stdout), dir, estate };
}

/**
 * Claim the adoptable matches an adoption ledger found, by writing the two
 * ownership markers onto each live resource (#2105).
 *
 * ## Why a tag write and not a policy verb
 *
 * choudoufu's `policy` block has an `adopt` verb for exactly this cell
 * (`declared_untagged`), and `site/content/docs/use/migrate.md` names
 * `policy { declared_untagged = "adopt" }` as the way to adopt a whole estate
 * at once instead of one resource at a time. That would have been the smaller
 * write: one apply, no tagging calls of chant's own. It is not reachable from
 * outside the configuration, and #2105 checked both ways in:
 *
 *   - a `live` block in a terraform override file is dropped in silence.
 *     `Module.mergeFile` (choudoufu's `internal/configs/module.go`) merges
 *     backends, cloud blocks, providers and resources from an override file
 *     and has no `Lives` case at all, so an `override.tf` carrying
 *     `terraform { live { policy { declared_untagged = "adopt" } } }` changes
 *     nothing. Measured, not inferred: a policy block with a deliberately
 *     invalid verb in an override file passes `live-check` clean, and the same
 *     block in a primary file is refused by name.
 *   - a second primary file carrying one is refused outright: "A module may
 *     have only one 'live' block." So is a sidecar beside an in-block form.
 *
 * Which leaves editing the root's own checked-in live configuration, running
 * an apply, and putting it back — a mutation of a reviewed file, with a
 * failure mode (a run that dies between the two edits) that leaves the estate
 * declaring "adopt everything declared and unmarked" for every later apply.
 * chant does not do that to a repository it does not own.
 *
 * So the mechanism is the tag write, which choudoufu's own migration guide
 * calls the whole contract: "There is no `choudoufu adopt` command and no need
 * for one. Two tags is the whole contract (`live/MARKERS.md`), so any tool
 * that writes two tags can adopt a resource." The command each write runs is
 * the paste-ready one choudoufu printed under `live-plan -adoption-only`,
 * carried on the candidate — built from choudoufu's own provider
 * configuration, so it lands on the region and endpoint the plan just read
 * rather than wherever an operator's AWS CLI profile points, and shell-quoted
 * by choudoufu for exactly this use.
 *
 * ## What it refuses
 *
 * A candidate with no printed command (a service whose tagging call this fork
 * does not spell out: IAM, Route53, S3) is refused with its two marker values
 * named, not guessed at. A contested address — more than one live resource at
 * one declared identity — is refused because no single tag write claims it;
 * `contested` is passed in so the Op's own result names what was refused
 * beside what was written, and nothing in this function can adopt one, since
 * `readAdoptionLedger` never puts a contested candidate in `adoptions`.
 *
 * Uses the longInfra profile: one tagging round trip per resource, against the
 * cloud.
 */
export async function choudoufuAdopt(
  args: ChoudoufuAdoptArgs,
  signal?: AbortSignal,
): Promise<ChoudoufuAdoptResult> {
  const resolved = await resolveRoot(args, signal);
  const { dir } = resolved;
  const env = terraformEnvironment(resolved.root);
  const adoptions = args.adoptions ?? [];
  const contested = args.contested ?? [];

  const adopted: string[] = [];
  const refused: AdoptionRefusal[] = [];

  for (const candidate of contested) {
    refused.push({
      addr: candidate.addr,
      identity: candidate.identity,
      reason:
        "more than one live resource sits at this declared identity, so no single tag write claims it. " +
        `Delete the duplicate, or write tofu-estate=${candidate.markerEstate} ` +
        `tofu-address=${candidate.markerAddress} onto the one you mean.`,
    });
  }

  await withHeartbeat({ step: "choudoufu adopt", root: args.root, dir }, async () => {
    for (const candidate of adoptions) {
      if (!candidate.command) {
        refused.push({
          addr: candidate.addr,
          identity: candidate.identity,
          reason:
            `${candidate.type} is tagged through its own service call, which choudoufu does not print a ` +
            `command for. Write tofu-estate=${candidate.markerEstate} ` +
            `tofu-address=${candidate.markerAddress} onto it with that call.`,
        });
        continue;
      }
      const { stdout, stderr } = await run(candidate.command, dir, env, signal);
      report(stdout, stderr);
      adopted.push(candidate.addr);
    }
  });

  return {
    mechanism: "tag-write",
    adopted,
    adoptedCount: adopted.length,
    refused,
    ambiguous: new Set(contested.map((c) => c.addr)).size,
    dir,
  };
}

/**
 * `choudoufu live-check -json`: whether the configuration in this root can
 * move under live resource markers, and what stops it if it cannot. Makes no
 * cloud calls and needs no `live` block at all, since the check this activity
 * runs works on any configuration, which is why it needs no `estate`.
 *
 * A non-zero exit is a refusal choudoufu reports, not a failure of this
 * activity: `refused: true` carries it back rather than throwing. An abort
 * or a spawn failure (no numeric exit code) still throws.
 *
 * Uses the fastIdempotent profile: no cloud calls, no state.
 */
export async function choudoufuLiveCheck(
  args: ChoudoufuLiveCheckArgs,
  signal?: AbortSignal,
): Promise<ChoudoufuLiveCheckResult> {
  const { binary, root, dir } = await resolveRoot(args, signal);
  const env = terraformEnvironment(root);
  const cmd = choudoufuLiveCheckCommand({ binary });

  return withHeartbeat({ step: "choudoufu live-check", root: args.root, dir }, async () => {
    const parseOrUndefined = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    try {
      const { stdout, stderr } = await run(cmd, dir, env, signal);
      report(stdout, stderr);
      return { refused: false, json: parseOrUndefined(stdout), text: stdout, dir };
    } catch (err) {
      const failure = err as ExecFailure;
      if (typeof failure.code !== "number") throw err;
      const stdout = failure.stdout ?? "";
      report(stdout, failure.stderr ?? "");
      return { refused: true, json: parseOrUndefined(stdout), text: stdout, dir };
    }
  });
}

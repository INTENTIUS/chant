/**
 * Running `pulumi` for a Pulumi member (#4453). The ruling on #4450 let
 * chant run `pulumi preview` and `pulumi refresh --preview-only` for a
 * Pulumi member; both read the provider and change no stack. The ruling on
 * #4476 (2026-10-25) widened it to the list main ships, and that list is the
 * whole of what chant runs:
 *
 * - `pulumi preview` (with `--json`),
 * - `pulumi refresh --preview-only` (with `--json`, and `--target <urn>`),
 * - `pulumi stack output --json`, with `--show-secrets` absent or
 *   `--show-secrets=false` (#4455): the member's applied outputs. It reads
 *   the backend's last deployment, calls no provider, and with secrets shown
 *   it is refused;
 * - for a member on plunge, `plunge preview`, the same blind
 *   `plunge stack output --json`, and `plunge drift --resource <urn> --stream`;
 * - `pulumi stack export --stack <stack>` (`plunge stack export` on plunge),
 *   exactly that, for the export the `pulumi-up` capability writes to the
 *   index store after an apply (#4546, `./stack-export-snapshot.ts`). The
 *   default export keeps secret ciphertext, which is stripped before the
 *   store sees it; `--show-secrets`, `--file` and `--version` are refused;
 * - for a stack being adopted onto plunge (#4562), `plunge stack adopt
 *   --json --stack <stack> [--file <file>]`, which classifies and writes
 *   nothing; the `--yes` form is {@link runAdoptPlunge}'s alone;
 * - plunge's resource move plan (#4578, INTENTIUS/plunge#56), `plunge stack
 *   move --stack <s> --dest <d> <urn>... --json`, which writes nothing; the
 *   writes of the gated stack operations are {@link runGatedPulumi}'s and
 *   {@link runGatedPlunge}'s alone;
 * - for a review stack alone (`pr-<n>`, INTENTIUS/plywood#15), `stack
 *   init`, `destroy --yes` and `stack rm --yes`, through
 *   {@link runReviewStackPulumi} and {@link runReviewStackPlunge} only;
 * - for the check stage (#4633, `./check-step.ts`), `pulumi install` and
 *   `pulumi about --json [--stack <stack>]`, or the same under `plunge`,
 *   through {@link runCheckPulumi} alone. The install fetches the program's
 *   dependencies and plugins; `about` reads the engine, plugins and backend.
 *   Neither writes a stack, and both run with no forge token or cloud
 *   credential in their environment;
 * - for a member on plunge, its engine graph (#4529, ruled on #4520), as
 *   exactly one of `plunge graph --json`, `plunge graph --json --stack
 *   <stack>`, `plunge graph --json --versions` and `plunge graph --json
 *   --stack <stack> --versions` ({@link PLUNGE_GRAPH_COMMANDS}). plunge
 *   reads the stack's records and calls no provider. An outputs or secrets
 *   flag on it is refused, like any other argv off the list.
 *
 * Each of these may carry `--stack <name>` (#4496 for the drift read, #4514
 * for the preview and `stack output`). That stays inside #4476's ruling: it
 * picks which stack the same read reads and changes no stack, so it adds no
 * command. The allow-list was extended for that flag alone: a `--stack` must
 * be followed by a name that is not itself a flag, and an argv where it is
 * not is refused like any other. The stack is the member's declared one,
 * else the one the checked-in export's URNs name ({@link memberStack}).
 *
 * {@link PULUMI_ALLOWED_COMMANDS} is the pulumi half, and
 * {@link runAllowedPulumi} and {@link runAllowedPlunge} refuse any argv
 * outside the list before it reaches the runner, so no read path can make
 * this module apply. A preview is also refused with `--show-secrets` or
 * `--import-file` (#4541), which write files chant never wants written.
 *
 * ## Applies (#4541)
 *
 * Ruling 1 on INTENTIUS/plywood#1 widened #4450 and #4476: the `pulumi-up`
 * capability (`./pulumi-up.ts`) applies a stack, from an apply job holding
 * the apply identity only. It does so through two separate entry points,
 * {@link runApplyPulumi} and {@link runApplyPlunge}, each checking the argv
 * against one fixed form in {@link PULUMI_APPLY_COMMANDS}. Nothing but that
 * capability's `run` calls them, and the read entry points above still
 * refuse `up`.
 *
 * A workspace that wants nothing run for applied outputs
 * sets `CHANT_PULUMI_APPLIED_OUTPUTS=export` (or `applied: "export"` on the
 * source), and they are read from the checked-in `stack-export.json`.
 *
 * - {@link previewPulumiMember}: `pulumi preview --json` in the member's
 *   directory, as the member's change-set part (`./change-set.ts`), with the
 *   checked-in `stack-export.json` as the last deployment, so what the
 *   preview cannot list is `mayAppear` rather than left out.
 * - {@link refreshPulumiMember}: `pulumi refresh --preview-only --json
 *   --target <urn>` once per resource, as drift records
 *   (`./drift-record.ts`). The URNs default to the export's resources. With
 *   no export, one untargeted refresh. A member on plunge reads each
 *   resource with `plunge drift --resource <urn> --stream` instead.
 * - {@link pulumiMemberStackOutputs}: `pulumi stack output --json
 *   --show-secrets=false`, the member's applied outputs (#4455).
 * - {@link plungeMemberGraph}: `plunge graph --json --stack <stack>`, a
 *   member on plunge's engine graph, for the lexicon's `describeResources`
 *   (`./describe-resources.ts`, #4529). A stock member has no such read.
 *
 * Each passes `--stack` when {@link memberStack} names one; without it
 * the CLI reads whatever stack is selected, and a checked-in member has none.
 *
 * A member on plunge runs the same argv under `plunge` (a fork of the
 * pulumi CLI) for its preview and stack outputs; {@link runAllowedPlunge}
 * lets those, `plunge drift --resource <urn> --stream` and the four
 * `plunge graph` argv through.
 *
 * ## Which members run on plunge
 *
 * {@link pulumiMemberEngine} decides, first rule that answers:
 *
 * 1. the member's config says `engine: "pulumi"` or `"plunge"`;
 * 2. the nearest `plywood.yml` (the member's directory up to the repo
 *    root) says `engine:`, or names a `backend:` URL starting with `plunge`;
 * 3. `PULUMI_BACKEND_URL` in the job environment starts with `plunge`;
 * 4. `Pulumi.yaml` names a backend whose URL starts with `plunge`
 *    (`backend: { url: "plunge+file:///..." }`, `plunge://...`), plunge's
 *    backend scheme;
 * 5. otherwise `pulumi`.
 *
 * The result carries `source`, the rule that answered, for the plan output.
 * Rule 3 reads the job's environment, so a machine that logs in to a plunge
 * backend by variable gets plunge, as the CLI does; the checked-in files
 * (rules 2 and 4) give the same answer wherever the member is checked out.
 *
 * The runner is injectable, so the tests run no binary.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { DriftAdapterBase, DriftRecord } from "@intentius/chant/drift-record";
import type { SnapshotStore } from "@intentius/chant/lifecycle/snapshot-store";
import type { UnobservedReason } from "@intentius/chant/observation";
import { isPulumiNodeless, parsePulumiUrn } from "@intentius/chant/pulumi-urn";
import { pulumiExportResources, pulumiPreviewPart } from "./change-set";
import { pulumiRefreshArgs, pulumiRefreshDocumentRecords, pulumiRefreshDriftRecords, type PulumiRefreshRead } from "./drift-record";
import { plungeDriftArgs, plungeDriftStreamRecords, type PlungeDriftRead } from "./drift-record";
import { pulumiMemberEngine, type PulumiMemberEngine } from "./member-engine";
import { PULUMI_EXPORT_FILE } from "./workspace-member";

const execFileAsync = promisify(execFile);

/**
 * Runs the pulumi binary with these arguments in `cwd`. Injectable so tests
 * need no binary. `env` holds variables added to the engine's environment
 * ({@link engineEnv}) for this run only, such as
 * `PULUMI_ENABLE_STREAMING_JSON_PREVIEW` for the pulumi-up preview (#4541).
 */
export type PulumiRunner = (args: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<{ stdout: string }>;

/**
 * The engine's environment: no update check, and no PULUMI_SKIP_CONFIRMATIONS, which stands for `--yes` and
 * makes `refresh --preview-only` refuse ("--yes and --preview-only cannot be used together", recorded, #4475).
 */
export function engineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, PULUMI_SKIP_UPDATE_CHECK: "true" };
  delete out.PULUMI_SKIP_CONFIRMATIONS;
  return out;
}

export const defaultPulumiRunner: PulumiRunner = (args, opts) =>
  execFileAsync("pulumi", args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, env: engineEnv({ ...process.env, ...opts.env }) });

/**
 * The only `pulumi` commands chant runs (ruling on #4450, widened by the
 * ruling on #4476 to keep #4455's `stack output`): each argv must start
 * with one of these. Any of them may name its stack with `--stack <name>`
 * (#4496, #4514), which {@link wellFormedStack} checks.
 */
export const PULUMI_ALLOWED_COMMANDS: readonly (readonly string[])[] = [["preview"], ["refresh", "--preview-only"], ["stack", "output"], ["stack", "export"]];

/**
 * Exactly `stack export --stack <stack>` (#4546): the export printed to
 * stdout with secrets encrypted. `--file` writes the working tree,
 * `--show-secrets` prints plaintext and `--version` reads another update, so
 * none is allowed.
 */
function allowedStackExport(args: string[]): boolean {
  return args.length === 4 && args[0] === "stack" && args[1] === "export" && args[2] === "--stack" && wellFormedStack(args);
}

/**
 * A `stack output` argv that prints no secret: `--json`, and
 * `--show-secrets` only as `--show-secrets=false`.
 */
function blindStackOutput(args: string[]): boolean {
  return args.includes("--json") && args.every((a) => !a.startsWith("--show-secrets") || a === "--show-secrets=false");
}

/**
 * Every `--stack` in the argv is followed by a stack name, not by another
 * flag or nothing (#4514). The one allow-list extension for `--stack`: it
 * selects the stack an allowed read reads, inside #4476's ruling, and a
 * dash-led "name" would smuggle a flag past the list.
 */
function wellFormedStack(args: string[]): boolean {
  return args.every((a, i) => a !== "--stack" || (typeof args[i + 1] === "string" && args[i + 1].length > 0 && !args[i + 1].startsWith("-")));
}

/**
 * A preview flag that writes what chant must not have written (#4541): any
 * form of `--show-secrets`, which with `--save-plan` puts plaintext secrets
 * in the plan file (plunge `preview.go:723-726`), and `--import-file`, which
 * writes a file chant never reads.
 */
const PREVIEW_REFUSED_FLAGS = ["--show-secrets", "--import-file"];

function refusedPreviewFlag(args: string[]): boolean {
  return args.some((a) => PREVIEW_REFUSED_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
}

function allowedRead(args: string[]): boolean {
  if (!wellFormedStack(args)) return false;
  if (!PULUMI_ALLOWED_COMMANDS.some((prefix) => prefix.every((a, i) => args[i] === a))) return false;
  if (args[0] === "refresh") return args.includes("--preview-only");
  if (args[0] === "stack" && args[1] === "export") return allowedStackExport(args);
  if (args[0] === "stack") return blindStackOutput(args);
  if (args[0] === "preview") return !refusedPreviewFlag(args);
  return true;
}

/** Run `args` through `run`, refusing any argv that is not an allowed read. `env` is added to the engine's environment. */
export async function runAllowedPulumi(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedRead(args)) {
    throw new Error(
      `chant runs only pulumi preview and pulumi refresh --preview-only, pulumi stack output --json --show-secrets=false and pulumi stack export --stack <stack>, for a Pulumi member, not pulumi ${args.join(" ")}`,
    );
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * The four `plunge graph` argv chant runs (#4529, ruled on #4520 Q4 and Q6),
 * in this order of flags and no other. `<stack>` stands for a stack name.
 */
export const PLUNGE_GRAPH_COMMANDS: readonly string[] = [
  "plunge graph --json",
  "plunge graph --json --stack <stack>",
  "plunge graph --json --versions",
  "plunge graph --json --stack <stack> --versions",
];

/**
 * The argv chant runs for a plunge member's engine graph (#4529): `--stack`
 * when {@link memberStack} names one, `--versions` only when asked, since it
 * costs one version listing per record.
 */
export function plungeGraphArgs(opts: { stack?: string; versions?: boolean } = {}): string[] {
  return ["graph", "--json", ...(opts.stack ? ["--stack", opts.stack] : []), ...(opts.versions ? ["--versions"] : [])];
}

/**
 * Exactly one of {@link PLUNGE_GRAPH_COMMANDS}. Nothing else gets through:
 * no other flag, no repeated flag, no other order. An outputs or secrets
 * flag (`--show-secrets`, `--outputs`) is refused with the rest, since chant
 * never asks plunge for an output value. The stack name follows
 * {@link wellFormedStack}'s rule (#4514).
 */
function allowedPlungeGraph(args: string[]): boolean {
  if (args[0] !== "graph" || args[1] !== "--json") return false;
  let rest = args.slice(2);
  if (rest[0] === "--stack") {
    if (!wellFormedStack(rest)) return false;
    rest = rest.slice(2);
  }
  if (rest[0] === "--versions") rest = rest.slice(1);
  return rest.length === 0;
}

/**
 * The plunge commands chant runs: a single resource's drift stream, the
 * same preview and blind stack output it runs under `pulumi`, and the
 * stack's engine graph from its records (#4529). None writes.
 */
export async function runAllowedPlunge(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  const drift = args[0] === "drift" && args.includes("--resource") && args.includes("--stream") && wellFormedStack(args);
  const allowed =
    drift ||
    ((args[0] === "preview" || args[0] === "stack") && allowedRead(args)) ||
    allowedPlungeGraph(args) ||
    allowedPlungeAdopt(args, false) ||
    allowedPlungeMove(args, false);
  if (!allowed) {
    throw new Error(
      `chant runs only plunge drift --resource <urn> --stream, plunge preview, plunge stack output --json --show-secrets=false, plunge stack export --stack <stack>, ${PLUNGE_ADOPT_COMMANDS[0]}, ${PLUNGE_GATED_COMMANDS[0]} and ${PLUNGE_GRAPH_COMMANDS.join(", ")} for a Pulumi member, not plunge ${args.join(" ")}`,
    );
  }
  return run(args, env ? { cwd, env } : { cwd });
}

export const defaultPlungeRunner: PulumiRunner = (args, opts) =>
  execFileAsync("plunge", args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, env: engineEnv({ ...process.env, ...opts.env }) });

/**
 * A runner for the engine binary at `bin`, an absolute path (#4592): a
 * stack pinned to its own release runs the binary its install line wrote
 * (`ciEngineDir` in ./ci-setup.ts) rather than whichever is on PATH. Only
 * the binary changes; the argv still goes through the same allowlists
 * (`runAllowedPulumi`, `runAllowedPlunge`, the apply checks) before it runs.
 */
export function engineRunnerAt(bin: string): PulumiRunner {
  if (!bin.startsWith("/")) throw new Error(`an engine binary is an absolute path, not ${JSON.stringify(bin)}`);
  return (args, opts) => execFileAsync(bin, args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, env: engineEnv({ ...process.env, ...opts.env }) });
}

/**
 * The two `up` argv chant runs, for the `pulumi-up` capability's `run` alone
 * (#4541; ruling 1 on INTENTIUS/plywood#1 widened #4450 and #4476 so the
 * capability applies, from an apply job holding the apply identity only).
 * The order is fixed and nothing else gets through. `<…>` stands for a value
 * that is not empty and does not start with `-`; `[…]` is optional; `…`
 * repeats.
 *
 * `up` is refused with `--skip-preview`, `--show-secrets`, `--replace`,
 * `--target-replace`, `--exclude`, `--remote`, `--continue-on-error`,
 * `--config` and any flag not here, since none of them is in the list.
 * `--refresh` and `--target-dependents` (#4627) come in the tail's order,
 * `--target-dependents` only after a `--target`. plunge's `up --plan`
 * applies a saved plan whose preview did the refresh, so it takes no
 * `--refresh`.
 */
export const PULUMI_APPLY_COMMANDS: readonly string[] = [
  "plunge up --plan <file> --yes --json --stack <stack> [--config-file <file>] [--target <urn>... [--target-dependents]] [--policy-pack <dir> [--policy-pack-config <file>]]...",
  "pulumi up --yes --json --stack <stack> [--config-file <file>] [--refresh] [--target <urn>... [--target-dependents]] [--policy-pack <dir> [--policy-pack-config <file>]]...",
];

/** A CrossGuard pack the preview and `up` run (ruling 7: in the preview job, feeding chant's gate). */
export interface PulumiPolicyPack {
  /** The pack's directory. */
  dir: string;
  /** Its `--policy-pack-config` file. */
  config?: string;
}

/** What the apply argv carry after the stack. */
export interface PulumiApplyTail {
  /** A scratch copy of the stack's config file, passed as `--config-file` (#4541): never `--config`, which writes the working tree's file. */
  configFile?: string;
  targets?: readonly string[];
  /** `--refresh` (#4627): refresh the stack's state before the preview or `pulumi up`. */
  refresh?: boolean;
  /** `--target-dependents` (#4627): with `targets`, their dependents too. */
  targetDependents?: boolean;
  policyPacks?: readonly PulumiPolicyPack[];
}

function tailArgs(t: PulumiApplyTail): string[] {
  const targets = t.targets ?? [];
  return [
    ...(t.configFile ? ["--config-file", t.configFile] : []),
    ...(t.refresh ? ["--refresh"] : []),
    ...targets.flatMap((u) => ["--target", u]),
    ...(t.targetDependents && targets.length > 0 ? ["--target-dependents"] : []),
    ...(t.policyPacks ?? []).flatMap((p) => ["--policy-pack", p.dir, ...(p.config ? ["--policy-pack-config", p.config] : [])]),
  ];
}

/**
 * The preview the `pulumi-up` capability runs (#4541): the member's preview
 * argv, with `--save-plan <file>` on plunge, then the apply tail. It goes
 * through {@link runAllowedPulumi} or {@link runAllowedPlunge} like every
 * other preview.
 */
export function pulumiUpPreviewArgs(opts: { stack: string; savePlan?: string } & PulumiApplyTail): string[] {
  return ["preview", "--json", "--show-sames", "--stack", opts.stack, ...(opts.savePlan ? ["--save-plan", opts.savePlan] : []), ...tailArgs(opts)];
}

/** `plunge up --plan <file> --yes --json --stack <stack>` and the tail: the first of {@link PULUMI_APPLY_COMMANDS}. */
export function plungeUpArgs(opts: { plan: string; stack: string } & PulumiApplyTail): string[] {
  return ["up", "--plan", opts.plan, "--yes", "--json", "--stack", opts.stack, ...tailArgs(opts)];
}

/** `pulumi up --yes --json --stack <stack>` and the tail: the second of {@link PULUMI_APPLY_COMMANDS}. */
export function pulumiUpArgs(opts: { stack: string } & PulumiApplyTail): string[] {
  return ["up", "--yes", "--json", "--stack", opts.stack, ...tailArgs(opts)];
}

const isValue = (v: string | undefined): v is string => typeof v === "string" && v.length > 0 && !v.startsWith("-");

/** Whether `rest` is exactly an apply tail, in its order; `refresh` says whether `--refresh` may stand in it (#4627). */
function wellFormedTail(rest: string[], refresh = true): boolean {
  let i = 0;
  if (rest[i] === "--config-file") {
    if (!isValue(rest[i + 1])) return false;
    i += 2;
  }
  if (refresh && rest[i] === "--refresh") i += 1;
  let targets = 0;
  while (rest[i] === "--target") {
    if (!isValue(rest[i + 1])) return false;
    i += 2;
    targets++;
  }
  if (targets > 0 && rest[i] === "--target-dependents") i += 1;
  while (rest[i] === "--policy-pack") {
    if (!isValue(rest[i + 1])) return false;
    i += 2;
    if (rest[i] === "--policy-pack-config") {
      if (!isValue(rest[i + 1])) return false;
      i += 2;
    }
  }
  return i === rest.length;
}

/** Exactly `plunge up --plan <file> --yes --json --stack <stack>` and a tail. */
function allowedPlungeUp(args: string[]): boolean {
  return (
    args[0] === "up" &&
    args[1] === "--plan" &&
    isValue(args[2]) &&
    args[3] === "--yes" &&
    args[4] === "--json" &&
    args[5] === "--stack" &&
    isValue(args[6]) &&
    wellFormedTail(args.slice(7), false)
  );
}

/** Exactly `pulumi up --yes --json --stack <stack>` and a tail. */
function allowedPulumiUp(args: string[]): boolean {
  return args[0] === "up" && args[1] === "--yes" && args[2] === "--json" && args[3] === "--stack" && isValue(args[4]) && wellFormedTail(args.slice(5));
}

/**
 * Run `pulumi up` for the `pulumi-up` capability (#4541), refusing any argv
 * but the stock form in {@link PULUMI_APPLY_COMMANDS}. Only the capability's
 * `run` calls this; no read path reaches it, and {@link runAllowedPulumi}
 * still refuses `up`.
 */
export async function runApplyPulumi(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedPulumiUp(args)) {
    throw new Error(`chant applies a Pulumi stack only as ${PULUMI_APPLY_COMMANDS[1]}, not pulumi ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * Run `plunge up --plan` for the `pulumi-up` capability (#4541), refusing
 * any argv but the plunge form in {@link PULUMI_APPLY_COMMANDS}. plunge
 * refuses a saved plan whose records moved, or one with no stamp, before
 * anything changes (exit 40).
 */
export async function runApplyPlunge(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedPlungeUp(args)) {
    throw new Error(`chant applies a plunge stack only as ${PULUMI_APPLY_COMMANDS[0]}, not plunge ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * The two `plunge stack adopt` argv chant runs (#4562), for
 * `PulumiAdoptOp`'s activities alone. The first classifies and writes
 * nothing (plunge's `--json` without `--yes`), so it passes through
 * {@link runAllowedPlunge} like any read. The second writes the records and
 * goes through {@link runAdoptPlunge} only, after the Op's gate. `--adopt`
 * and `--index-store` (an adoption file over an index version) are refused,
 * as is any other flag.
 */
export const PLUNGE_ADOPT_COMMANDS: readonly string[] = [
  "plunge stack adopt --json --stack <stack> [--file <file>]",
  "plunge stack adopt --json --yes --stack <stack> [--file <file>]",
];

/** `stack adopt --json [--yes] --stack <stack> [--file <file>]`, in that order. */
export function plungeAdoptArgs(opts: { stack: string; file?: string; yes?: boolean }): string[] {
  return ["stack", "adopt", "--json", ...(opts.yes ? ["--yes"] : []), "--stack", opts.stack, ...(opts.file ? ["--file", opts.file] : [])];
}

function allowedPlungeAdopt(args: string[], yes: boolean): boolean {
  if (args[0] !== "stack" || args[1] !== "adopt" || args[2] !== "--json") return false;
  let i = 3;
  if (yes) {
    if (args[i] !== "--yes") return false;
    i++;
  }
  if (args[i] !== "--stack" || !isValue(args[i + 1])) return false;
  i += 2;
  if (args[i] === "--file") {
    if (!isValue(args[i + 1])) return false;
    i += 2;
  }
  return i === args.length;
}

/**
 * Run `plunge stack adopt --json --yes` for `PulumiAdoptOp`'s Adopt step
 * (#4562), refusing any argv but the second form in
 * {@link PLUNGE_ADOPT_COMMANDS}. It writes plunge's records and touches no
 * cloud object.
 */
export async function runAdoptPlunge(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedPlungeAdopt(args, true)) {
    throw new Error(`chant adopts a stack onto plunge only as ${PLUNGE_ADOPT_COMMANDS[1]}, not plunge ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * The gated stack operations' writes (#4578), for `./stack-ops.ts` alone,
 * each run only after its gated request (#4551) is approved and spent on the
 * ledger. Fixed forms; any other flag, order or value is refused:
 *
 * - `pulumi cancel --yes --stack <stack>`: releases a stuck update's lock;
 * - `pulumi state move --source <stack> --dest <stack> --yes <urn>...`: moves
 *   resources between stock stacks, never `--include-parents`.
 */
export const PULUMI_GATED_COMMANDS: readonly string[] = [
  "pulumi cancel --yes --stack <stack>",
  "pulumi state move --source <stack> --dest <stack> --yes <urn>...",
];

/**
 * plunge's resource move (INTENTIUS/plunge#56) in its two forms. The first
 * prints the plan and writes nothing, so it passes {@link runAllowedPlunge};
 * the second moves and passes {@link runGatedPlunge} only.
 */
export const PLUNGE_GATED_COMMANDS: readonly string[] = [
  "plunge stack move --stack <stack> --dest <stack> <urn>... --json",
  "plunge stack move --stack <stack> --dest <stack> <urn>... --json --yes",
];

const isUrn = (v: string | undefined): v is string => typeof v === "string" && v.startsWith("urn:pulumi:");

/** `cancel --yes --stack <stack>`. */
export function pulumiCancelArgs(opts: { stack: string }): string[] {
  return ["cancel", "--yes", "--stack", opts.stack];
}

/** `state move --source <s> --dest <d> --yes <urn>...`. */
export function pulumiStateMoveArgs(opts: { source: string; dest: string; urns: readonly string[] }): string[] {
  return ["state", "move", "--source", opts.source, "--dest", opts.dest, "--yes", ...opts.urns];
}

/** `stack move --stack <s> --dest <d> <urn>... --json [--yes]`. */
export function plungeMoveArgs(opts: { source: string; dest: string; urns: readonly string[]; yes?: boolean }): string[] {
  return ["stack", "move", "--stack", opts.source, "--dest", opts.dest, ...opts.urns, "--json", ...(opts.yes ? ["--yes"] : [])];
}

function allowedPlungeMove(args: string[], yes: boolean): boolean {
  if (args[0] !== "stack" || args[1] !== "move" || args[2] !== "--stack" || !isValue(args[3]) || args[4] !== "--dest" || !isValue(args[5])) return false;
  const tail = yes ? ["--json", "--yes"] : ["--json"];
  const urns = args.slice(6, args.length - tail.length);
  return urns.length > 0 && urns.every(isUrn) && tail.every((t, i) => args[args.length - tail.length + i] === t);
}

function allowedGatedPulumi(args: string[]): boolean {
  if (args[0] === "cancel") return args.length === 4 && args[1] === "--yes" && args[2] === "--stack" && isValue(args[3]);
  if (args[0] === "state" && args[1] === "move") {
    const urns = args.slice(7);
    return args[2] === "--source" && isValue(args[3]) && args[4] === "--dest" && isValue(args[5]) && args[6] === "--yes" && urns.length > 0 && urns.every(isUrn);
  }
  return false;
}

/** Run one of {@link PULUMI_GATED_COMMANDS}, refusing any other argv. Only `./stack-ops.ts` calls it, after the request is spent. */
export async function runGatedPulumi(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedGatedPulumi(args)) {
    throw new Error(`chant runs a gated Pulumi stack operation only as ${PULUMI_GATED_COMMANDS.join(" or ")}, not pulumi ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/** Run the moving form of {@link PLUNGE_GATED_COMMANDS}, refusing any other argv. Only `./stack-ops.ts` calls it, after the request is spent. */
export async function runGatedPlunge(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedPlungeMove(args, true)) {
    throw new Error(`chant moves plunge resources only as ${PLUNGE_GATED_COMMANDS[1]}, not plunge ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * Review stacks (#4541's deferral, INTENTIUS/plywood#15): a stack per open
 * pull request, made from a template stack's config and removed when the
 * pull request closes or its TTL passes. Fixed forms, for a review stack
 * name only ({@link isReviewStackName}), so no path here can create,
 * destroy or remove any other stack:
 *
 * - `stack init <pr-stack> --no-select [--copy-config-from <stack>]`: the
 *   review stack, with the template's config. It selects nothing, so the
 *   checkout's selected stack stays as it was;
 * - `destroy --yes --json --stack <pr-stack>`: deletes the review stack's
 *   resources, never `--target`, `--exclude` or `--remove`;
 * - `stack rm --yes --stack <pr-stack>`: removes the emptied stack, never
 *   `--force`, so a stack that still holds resources is refused by the
 *   engine itself.
 *
 * The same three run under `plunge` for a member on plunge.
 * {@link runReviewStackPulumi} and {@link runReviewStackPlunge} refuse any
 * other argv; the read entry points above refuse all three.
 */
export const PULUMI_REVIEW_STACK_COMMANDS: readonly string[] = [
  "pulumi stack init <pr-stack> --no-select [--copy-config-from <stack>]",
  "pulumi destroy --yes --json --stack <pr-stack>",
  "pulumi stack rm --yes --stack <pr-stack>",
];

/** A review stack's own name: `pr-<n>`, or `pr-<n>-<suffix>` in lowercase letters, digits and `-`. */
export const REVIEW_STACK_NAME = /^pr-[0-9]+(?:-[a-z0-9][a-z0-9-]*)?$/;

/**
 * Whether `stack` names a review stack: its last segment matches
 * {@link REVIEW_STACK_NAME}, after at most an organization and a project
 * (`acme/shop/pr-12`).
 */
export function isReviewStackName(stack: string | undefined): stack is string {
  if (typeof stack !== "string") return false;
  const parts = stack.split("/");
  return parts.length <= 3 && parts.slice(0, -1).every((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) && REVIEW_STACK_NAME.test(parts[parts.length - 1]!);
}

/** `stack init <pr-stack> --no-select [--copy-config-from <stack>]`. */
export function reviewStackInitArgs(opts: { stack: string; copyConfigFrom?: string }): string[] {
  return ["stack", "init", opts.stack, "--no-select", ...(opts.copyConfigFrom ? ["--copy-config-from", opts.copyConfigFrom] : [])];
}

/** `destroy --yes --json --stack <pr-stack>`. */
export function reviewStackDestroyArgs(opts: { stack: string }): string[] {
  return ["destroy", "--yes", "--json", "--stack", opts.stack];
}

/** `stack rm --yes --stack <pr-stack>`. */
export function reviewStackRmArgs(opts: { stack: string }): string[] {
  return ["stack", "rm", "--yes", "--stack", opts.stack];
}

/** Exactly one of {@link PULUMI_REVIEW_STACK_COMMANDS}, on a review stack. */
export function allowedReviewStack(args: readonly string[]): boolean {
  if (args[0] === "stack" && args[1] === "init") {
    if (!isReviewStackName(args[2]) || args[3] !== "--no-select") return false;
    if (args.length === 4) return true;
    return args.length === 6 && args[4] === "--copy-config-from" && isValue(args[5]) && args[5] !== args[2];
  }
  if (args[0] === "destroy") return args.length === 5 && args[1] === "--yes" && args[2] === "--json" && args[3] === "--stack" && isReviewStackName(args[4]);
  if (args[0] === "stack" && args[1] === "rm") return args.length === 5 && args[2] === "--yes" && args[3] === "--stack" && isReviewStackName(args[4]);
  return false;
}

function reviewStackRefusal(engine: "pulumi" | "plunge", args: readonly string[]): Error {
  return new Error(
    `chant creates, destroys and removes only review stacks (pr-<n>), as ${PULUMI_REVIEW_STACK_COMMANDS.map((c) => c.replace(/^pulumi/, engine)).join(", ")}; not ${engine} ${args.join(" ")}`,
  );
}

/** Run one of {@link PULUMI_REVIEW_STACK_COMMANDS} under `pulumi`, refusing any other argv or stack. */
export async function runReviewStackPulumi(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedReviewStack(args)) throw reviewStackRefusal("pulumi", args);
  return run(args, env ? { cwd, env } : { cwd });
}

/** The same forms under `plunge`, for a member on plunge. */
export async function runReviewStackPlunge(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedReviewStack(args)) throw reviewStackRefusal("plunge", args);
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * The install chant runs in a release's recorded copy of a program (#4542),
 * for `./release-copy.ts` alone: exactly `pulumi install` or `plunge
 * install`, no flag. The cut records tracked files only, so the copy has no
 * `node_modules` or virtualenv; the CLI's install follows `Pulumi.yaml`'s
 * runtime options and the recorded lockfile.
 */
export const PULUMI_INSTALL_COMMANDS: readonly string[] = ["pulumi install", "plunge install"];

/** Run `install` with no flag in a release copy, refusing any other argv. The runner picks the binary. */
export async function runReleaseInstall(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (args.length !== 1 || args[0] !== "install") {
    throw new Error(`chant installs a release copy's dependencies only as ${PULUMI_INSTALL_COMMANDS.join(" or ")}, not ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

/**
 * The two argv the check stage runs for a member (#4633, `./check-step.ts`):
 * `install` with no flag, and `about --json`, optionally with `--stack
 * <stack>`. Under `pulumi` or `plunge`; the runner picks the binary.
 */
export const PULUMI_CHECK_COMMANDS: readonly string[] = ["pulumi install", "pulumi about --json [--stack <stack>]", "plunge install", "plunge about --json [--stack <stack>]"];

/** Whether `args` is one of {@link PULUMI_CHECK_COMMANDS}' argv. */
export function allowedCheck(args: readonly string[]): boolean {
  if (args.length === 1) return args[0] === "install";
  if (args[0] !== "about" || args[1] !== "--json") return false;
  if (args.length === 2) return true;
  return args.length === 4 && args[2] === "--stack" && isValue(args[3]);
}

/** Run a check-stage argv, refusing any other. The runner picks the binary. */
export async function runCheckPulumi(run: PulumiRunner, args: string[], cwd: string, env?: Record<string, string>): Promise<{ stdout: string }> {
  if (!allowedCheck(args)) {
    throw new Error(`the check stage runs only ${PULUMI_CHECK_COMMANDS.join(", ")} for a Pulumi member, not ${args.join(" ")}`);
  }
  return run(args, env ? { cwd, env } : { cwd });
}

export { pulumiMemberEngine, readPlywoodEngine, type PulumiMemberEngine, type PulumiMemberEngineSource, type PulumiMemberEngineOptions } from "./member-engine";

/** The argv chant runs for a member's applied outputs, after `pulumi` (#4455). Secrets stay blinded. */
export function pulumiStackOutputArgs(opts: { stack?: string } = {}): string[] {
  return ["stack", "output", "--json", "--show-secrets=false", ...(opts.stack ? ["--stack", opts.stack] : [])];
}

/** The argv chant runs for a member's preview, after `pulumi`. */
export function pulumiPreviewArgs(opts: { stack?: string; targets?: readonly string[] } = {}): string[] {
  // --show-sames: without it `preview --json` lists no unchanged resource but the stack (recorded, #4475), and the
  // change-set adapter reads a resource the export holds and the preview never lists as one an apply() may register.
  return ["preview", "--json", "--show-sames", ...(opts.stack ? ["--stack", opts.stack] : []), ...(opts.targets ?? []).flatMap((t) => ["--target", t])];
}

/**
 * The stack a `pulumi stack export` names in its URNs
 * (`urn:pulumi:<stack>::<project>::...`, #4496), or undefined when it holds
 * no URN that parses or its URNs name more than one stack.
 */
export function pulumiExportStack(exported: unknown): string | undefined {
  return soleStack(pulumiExportResources(exported).map((r) => r.urn));
}

/** The one stack a list of URNs names, or undefined when none parses or they disagree. */
function soleStack(urns: readonly string[]): string | undefined {
  const stacks = new Set(urns.map((u) => parsePulumiUrn(u)?.stack).filter((s): s is string => typeof s === "string" && s.length > 0));
  return stacks.size === 1 ? [...stacks][0] : undefined;
}

/**
 * The stack a member's reads pass as `--stack` (#4496, #4514): the declared
 * one, else the one the checked-in export's URNs name, else the one the
 * given URNs name. Undefined when none says, and the CLI reads the selected
 * stack.
 */
export function memberStack(opts: { declared?: string; exported?: unknown; urns?: readonly string[] }): string | undefined {
  return opts.declared || pulumiExportStack(opts.exported) || (opts.urns?.length ? soleStack(opts.urns) : undefined);
}

/**
 * The checked-in `pulumi stack export`, parsed, or undefined when there is
 * none or it does not read. The member's reads below take the index store's
 * export first ({@link memberExportOf}, #4546) and come here when it has none.
 */
export function readMemberExport(dir: string): unknown {
  const file = join(dir, PULUMI_EXPORT_FILE);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The member's export for a read (#4546): the one the `pulumi-up` capability
 * wrote to the index store after the stack's last apply through chant, else
 * the checked-in {@link PULUMI_EXPORT_FILE}. `store: null` skips the store.
 * Loaded lazily, since `./stack-export-snapshot.ts` imports this module.
 */
export async function memberExportOf(dir: string, opts: { stack?: string; store?: SnapshotStore | null } = {}): Promise<unknown> {
  if (opts.store === null) return readMemberExport(dir);
  const { readMemberExportStored } = await import("./stack-export-snapshot");
  return (await readMemberExportStored(dir, { ...(opts.stack ? { stack: opts.stack } : {}), ...(opts.store !== undefined ? { store: opts.store } : {}) }))?.doc;
}

/** What a failed engine run left: its output, its exit status when it ran, and whether the binary was missing. */
export interface PulumiRunFailure {
  stdout?: string;
  stderr?: string;
  message: string;
  missingBinary: boolean;
  /** The process's exit status, when it ran and exited (`execFile`'s numeric `code`). */
  exitCode?: number;
}

type RunFailure = PulumiRunFailure;

/** A runner's thrown error read as a {@link PulumiRunFailure}. */
export function pulumiRunFailure(err: unknown): PulumiRunFailure {
  const e = err as (Omit<NodeJS.ErrnoException, "code"> & { code?: unknown; stdout?: unknown; stderr?: unknown }) | undefined;
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...(typeof e?.stdout === "string" ? { stdout: e.stdout } : {}),
    ...(typeof e?.stderr === "string" ? { stderr: e.stderr } : {}),
    message,
    missingBinary: e?.code === "ENOENT" || /ENOENT|command not found/.test(message),
    ...(typeof e?.code === "number" ? { exitCode: e.code } : {}),
  };
}

const failureOf = pulumiRunFailure;

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The first error diagnostic a preview printed, if any. */
function diagnosticError(doc: unknown): string | undefined {
  const diagnostics = (doc as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  const d = diagnostics.find((x) => (x as { severity?: unknown })?.severity === "error") as { message?: unknown } | undefined;
  return typeof d?.message === "string" ? d.message.trim() : undefined;
}

export interface PreviewPulumiMemberOptions {
  member: string;
  /** The member's directory, where Pulumi.yaml is. */
  dir: string;
  /**
   * The stack to preview, passed as `--stack` (#4514): the member's declared
   * stack. Without it, the stack the checked-in export's URNs name, then the
   * one the targets name ({@link memberStack}).
   */
  stack?: string;
  /** Narrow the preview to these URNs. A narrowed preview does not mark what it leaves out. */
  targets?: readonly string[];
  /** The member's configured engine; see {@link pulumiMemberEngine}. A member on plunge previews with `plunge preview`. */
  engine?: PulumiMemberEngine;
  run?: PulumiRunner;
  /** Runs plunge, for a member on plunge. */
  plunge?: PulumiRunner;
  /** The index store the member's export is read from first (#4546). Default: the project's; `null` reads the checked-in file only. */
  exportStore?: SnapshotStore | null;
}

/** A member's preview: its change-set part, and the preview document it was read from (`{}` when none printed). */
export interface PulumiMemberPreview {
  part: ChangeSetPart;
  preview: unknown;
  /** The binary that ran. */
  engine: PulumiMemberEngine;
}

/**
 * The member's preview, kept beside its part, so a reader of the stack's
 * planned outputs (`./stack-outputs.ts`, #4455) and the change set read the
 * same run. Never throws for a run that failed: the part is failed.
 */
export async function previewPulumiMemberRead(opts: PreviewPulumiMemberOptions): Promise<PulumiMemberPreview> {
  const engine = pulumiMemberEngine(opts.dir, opts.engine).engine;
  const prior = await memberExportOf(opts.dir, { ...(opts.stack ? { stack: opts.stack } : {}), ...(opts.exportStore !== undefined ? { store: opts.exportStore } : {}) });
  const stack = memberStack({ declared: opts.stack, exported: prior, urns: opts.targets });
  const args = pulumiPreviewArgs({ stack, targets: opts.targets });
  const common = { member: opts.member, ...(stack ? { stack } : {}), ...(prior !== undefined ? { prior } : {}), ...(opts.targets?.length ? { targeted: true } : {}) };
  try {
    const { stdout } =
      engine === "plunge"
        ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, opts.dir)
        : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, opts.dir);
    const preview = parseJson(stdout);
    if (preview === undefined) return { part: pulumiPreviewPart({ ...common, preview: {}, error: `${engine} preview --json printed no JSON` }), preview: {}, engine };
    return { part: pulumiPreviewPart({ ...common, preview }), preview, engine };
  } catch (err) {
    const f = failureOf(err);
    const preview = parseJson(f.stdout) ?? {};
    const error = f.missingBinary
      ? `the ${engine} binary was not found on PATH; install ${engine} to plan this member`
      : diagnosticError(preview) ?? (f.stderr?.trim() || f.message);
    return { part: pulumiPreviewPart({ ...common, preview, error }), preview, engine };
  }
}

/**
 * The member's change-set part from `pulumi preview --json`. A preview that
 * fails is a failed member, keeping what steps it printed; a missing binary
 * is a failed member that says so. Never throws for a run that failed.
 */
export async function previewPulumiMember(opts: PreviewPulumiMemberOptions): Promise<ChangeSetPart> {
  return (await previewPulumiMemberRead(opts)).part;
}

export interface PulumiMemberStackOutputsOptions {
  /** The member's directory, where Pulumi.yaml is. */
  dir: string;
  /**
   * The stack to read, passed as `--stack` (#4514): the member's declared
   * stack. Without it, the stack the checked-in export's URNs name
   * ({@link memberStack}).
   */
  stack?: string;
  /** The member's configured engine; see {@link pulumiMemberEngine}. */
  engine?: PulumiMemberEngine;
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  /** The index store the member's export is read from first (#4546). Default: the project's; `null` reads the checked-in file only. */
  exportStore?: SnapshotStore | null;
}

/**
 * `pulumi stack output --json --show-secrets=false` in the member's
 * directory (`plunge stack output ...` for a member on plunge), parsed: the
 * stack's applied outputs by name, a secret printed as `[secret]`. Throws
 * when the command fails or prints no JSON object, naming the command.
 */
export async function pulumiMemberStackOutputs(opts: PulumiMemberStackOutputsOptions): Promise<Record<string, unknown>> {
  const engine = pulumiMemberEngine(opts.dir, opts.engine).engine;
  const exported = opts.stack ? undefined : await memberExportOf(opts.dir, opts.exportStore !== undefined ? { store: opts.exportStore } : {});
  const args = pulumiStackOutputArgs({ stack: memberStack({ declared: opts.stack, exported }) });
  const command = `${engine} ${args.join(" ")}`;
  let stdout: string;
  try {
    ({ stdout } =
      engine === "plunge"
        ? await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, opts.dir)
        : await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, opts.dir));
  } catch (err) {
    const f = failureOf(err);
    const why = f.missingBinary ? `the ${engine} binary was not found on PATH` : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
    throw new Error(`${command} in ${opts.dir} failed: ${why}`);
  }
  const doc = parseJson(stdout);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${command} in ${opts.dir} printed no JSON object`);
  return doc as Record<string, unknown>;
}

export interface RefreshPulumiMemberOptions extends DriftAdapterBase {
  dir: string;
  /**
   * The stack to read, passed as `--stack` (#4496): the member's declared
   * `pulumi.member.stack`. Without it, the stack the checked-in export's
   * URNs name, then the one the URNs asked for name. A member with no
   * selected stack can still be refreshed that way.
   */
  stack?: string;
  /** The URNs to read. Default: the checked-in export's resources, providers and the stack left out. */
  urns?: readonly string[];
  /** The member's configured engine; see {@link pulumiMemberEngine}. */
  engine?: PulumiMemberEngine;
  run?: PulumiRunner;
  /** Runs plunge, for a member on plunge. */
  plunge?: PulumiRunner;
  /** The index store the member's export is read from first (#4546). Default: the project's; `null` reads the checked-in file only. */
  exportStore?: SnapshotStore | null;
}

function unobservedFor(f: RunFailure): { reason: UnobservedReason; detail: string } {
  if (f.missingBinary) return { reason: "read-failed", detail: "the pulumi binary was not found on PATH" };
  const text = `${f.stderr ?? ""}\n${f.message}`;
  if (/credential|PULUMI_ACCESS_TOKEN|pulumi login|NoCredentialProviders|could not find default credentials/i.test(text)) {
    return { reason: "no-credentials", detail: (f.stderr?.trim() || f.message).slice(0, 2000) };
  }
  return { reason: "read-failed", detail: (diagnosticError(parseJson(f.stdout)) ?? (f.stderr?.trim() || f.message)).slice(0, 2000) };
}

/**
 * The member's drift records, one `--target`ed `pulumi refresh
 * --preview-only --json` per URN, run one after another. A run that fails
 * makes its URN's record not-observed and the others still read. With no
 * URNs given and no export to take them from (the store's or the checked-in one), one untargeted refresh, which
 * throws when it fails, since no record names a resource to hang it on.
 */
export async function refreshPulumiMember(opts: RefreshPulumiMemberOptions): Promise<DriftRecord[]> {
  const run = opts.run ?? defaultPulumiRunner;
  const exported = await memberExportOf(opts.dir, { ...(opts.stack ? { stack: opts.stack } : {}), ...(opts.exportStore !== undefined ? { store: opts.exportStore } : {}) });
  const urns =
    opts.urns ??
    (exported === undefined ? undefined : pulumiExportResources(exported).filter((r) => !isPulumiNodeless(r.type)).map((r) => r.urn));
  // `--stack` (#4496): the declared stack, else the export's, else the URNs'.
  // Without one the CLI reads the selected stack, and a checked-in member
  // has none selected.
  const stack = memberStack({ declared: opts.stack, exported, urns });
  const base: DriftAdapterBase & { stack?: string } = {
    member: opts.member,
    observedAt: opts.observedAt,
    ...(opts.graph !== undefined ? { graph: opts.graph } : {}),
    ...(opts.fellBackFrom !== undefined ? { fellBackFrom: opts.fellBackFrom } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(stack ? { stack } : {}),
  };

  if (pulumiMemberEngine(opts.dir, opts.engine).engine === "plunge") {
    // plunge drift reads one resource at a time, so it needs the URNs.
    if (urns === undefined) throw new Error(`member ${opts.member} runs on plunge, whose drift reads one resource at a time, and has no ${PULUMI_EXPORT_FILE} to take the URNs from`);
    const plunge = opts.plunge ?? defaultPlungeRunner;
    const reads: PlungeDriftRead[] = [];
    for (const urn of urns) {
      try {
        const { stdout } = await runAllowedPlunge(plunge, plungeDriftArgs({ urn, stack, member: opts.member }), opts.dir);
        reads.push({ urn, stream: stdout });
      } catch (err) {
        const f = failureOf(err);
        reads.push(f.stdout && !f.missingBinary ? { urn, stream: f.stdout } : { urn, failed: f.missingBinary ? { reason: "read-failed", detail: "the plunge binary was not found on PATH" } : unobservedFor(f) });
      }
    }
    return plungeDriftStreamRecords({ ...base, reads });
  }

  if (urns === undefined) {
    try {
      const { stdout } = await runAllowedPulumi(run, pulumiRefreshArgs({ stack }), opts.dir);
      return pulumiRefreshDocumentRecords({ ...base, refresh: parseJson(stdout) ?? {} });
    } catch (err) {
      // Nothing names the resources, so the failure has no record to sit on.
      const why = unobservedFor(failureOf(err));
      throw new Error(`pulumi refresh --preview-only for member ${opts.member} failed (${why.reason}): ${why.detail}`);
    }
  }

  const reads: PulumiRefreshRead[] = [];
  for (const urn of urns) {
    try {
      const { stdout } = await runAllowedPulumi(run, pulumiRefreshArgs({ urn, stack }), opts.dir);
      reads.push({ urn, refresh: parseJson(stdout) });
    } catch (err) {
      const f = failureOf(err);
      // A refresh that failed may still have printed the step for its target.
      const printed = parseJson(f.stdout);
      reads.push(printed !== undefined && !f.missingBinary ? { urn, refresh: printed } : { urn, failed: unobservedFor(f) });
    }
  }
  return pulumiRefreshDriftRecords({ ...base, reads });
}

export interface PlungeMemberGraphOptions {
  /** The member's directory, where Pulumi.yaml is. */
  dir: string;
  /**
   * The stack to read, passed as `--stack`: the member's declared stack.
   * Without it, the stack the checked-in export's URNs name
   * ({@link memberStack}), as for every other read.
   */
  stack?: string;
  /** Pass `--versions`: each node lists its record's versions, one version listing per record (#4520 Q6). Off by default. */
  versions?: boolean;
  plunge?: PulumiRunner;
  /** The index store the member's export is read from first (#4546). Default: the project's; `null` reads the checked-in file only. */
  exportStore?: SnapshotStore | null;
}

/** What one `plunge graph` run gave: the parsed document, or why there is none. */
export type PlungeMemberGraphRead =
  | { ok: true; doc: unknown; command: string; stack?: string }
  | { ok: false; command: string; stack?: string; reason: UnobservedReason; detail: string };

/**
 * `plunge graph --json [--stack <stack>] [--versions]` in the member's
 * directory (#4529): the stack's engine graph from its records, in
 * chant#4520's document. plunge makes no provider call for it and prints no
 * output value. Never throws for a run that failed: the read says why. A
 * plunge older than the command (INTENTIUS/plunge#40) fails it with cobra's
 * unknown-command error, and the read says that plunge has no `graph`.
 *
 * Only a member on plunge runs it. The caller decides that with
 * {@link pulumiMemberEngine}; nothing here runs stock `pulumi`.
 */
export async function plungeMemberGraph(opts: PlungeMemberGraphOptions): Promise<PlungeMemberGraphRead> {
  const exported = opts.stack ? undefined : await memberExportOf(opts.dir, opts.exportStore !== undefined ? { store: opts.exportStore } : {});
  const stack = memberStack({ declared: opts.stack, exported });
  const args = plungeGraphArgs({ stack, ...(opts.versions ? { versions: true } : {}) });
  const command = `plunge ${args.join(" ")}`;
  const at = { command, ...(stack ? { stack } : {}) };
  try {
    const { stdout } = await runAllowedPlunge(opts.plunge ?? defaultPlungeRunner, args, opts.dir);
    const doc = parseJson(stdout);
    if (doc === undefined) return { ok: false, ...at, reason: "read-failed", detail: `${command} printed no JSON` };
    return { ok: true, doc, ...at };
  } catch (err) {
    const f = failureOf(err);
    if (f.missingBinary) return { ok: false, ...at, reason: "read-failed", detail: "the plunge binary was not found on PATH" };
    if (/unknown command "graph"/.test(`${f.stderr ?? ""}\n${f.message}`)) {
      return { ok: false, ...at, reason: "read-failed", detail: "this plunge has no `plunge graph` (INTENTIUS/plunge#40); a plunge that has it gives the member's engine facts" };
    }
    return { ok: false, ...at, ...unobservedFor(f) };
  }
}

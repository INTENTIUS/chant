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
 *   `plunge stack output --json`, and `plunge drift --resource <urn> --stream`.
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
 * outside the list before it reaches the runner, so no later caller can make
 * this module apply. A workspace that wants nothing run for applied outputs
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
 *
 * All three pass `--stack` when {@link memberStack} names one; without it
 * the CLI reads whatever stack is selected, and a checked-in member has none.
 *
 * A member on plunge runs the same argv under `plunge` (a fork of the
 * pulumi CLI) for its preview and stack outputs; {@link runAllowedPlunge}
 * lets those and `plunge drift --resource <urn> --stream` through.
 *
 * ## Which members run on plunge
 *
 * {@link pulumiMemberEngine} decides, first rule that answers:
 *
 * 1. the member's config says `engine: "pulumi"` or `"plunge"`;
 * 2. `Pulumi.yaml` names a backend whose URL starts with `plunge`
 *    (`backend: { url: "plunge+file:///..." }`, `plunge://...`), plunge's
 *    backend scheme;
 * 3. otherwise `pulumi`.
 *
 * Only `Pulumi.yaml` is read, never `PULUMI_BACKEND_URL` or the CLI's
 * login state, so the answer is the same on every machine that checks the
 * member out.
 *
 * The runner is injectable, so the tests run no binary.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import type { DriftAdapterBase, DriftRecord } from "@intentius/chant/drift-record";
import type { UnobservedReason } from "@intentius/chant/observation";
import { isPulumiNodeless, parsePulumiUrn } from "@intentius/chant/pulumi-urn";
import { pulumiExportResources, pulumiPreviewPart } from "./change-set";
import { pulumiRefreshArgs, pulumiRefreshDocumentRecords, pulumiRefreshDriftRecords, type PulumiRefreshRead } from "./drift-record";
import { parseYAML } from "@intentius/chant/yaml";
import { plungeDriftArgs, plungeDriftStreamRecords, type PlungeDriftRead } from "./drift-record";
import { PULUMI_EXPORT_FILE } from "./workspace-member";

const execFileAsync = promisify(execFile);

/** Runs the pulumi binary with these arguments in `cwd`. Injectable so tests need no binary. */
export type PulumiRunner = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

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
  execFileAsync("pulumi", args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, env: engineEnv() });

/**
 * The only `pulumi` commands chant runs (ruling on #4450, widened by the
 * ruling on #4476 to keep #4455's `stack output`): each argv must start
 * with one of these. Any of them may name its stack with `--stack <name>`
 * (#4496, #4514), which {@link wellFormedStack} checks.
 */
export const PULUMI_ALLOWED_COMMANDS: readonly (readonly string[])[] = [["preview"], ["refresh", "--preview-only"], ["stack", "output"]];

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

function allowedRead(args: string[]): boolean {
  if (!wellFormedStack(args)) return false;
  if (!PULUMI_ALLOWED_COMMANDS.some((prefix) => prefix.every((a, i) => args[i] === a))) return false;
  if (args[0] === "refresh") return args.includes("--preview-only");
  if (args[0] === "stack") return blindStackOutput(args);
  return true;
}

/** Run `args` through `run`, refusing any argv that is not an allowed read. */
export async function runAllowedPulumi(run: PulumiRunner, args: string[], cwd: string): Promise<{ stdout: string }> {
  if (!allowedRead(args)) {
    throw new Error(`chant runs only pulumi preview and pulumi refresh --preview-only, and pulumi stack output --json --show-secrets=false, for a Pulumi member, not pulumi ${args.join(" ")}`);
  }
  return run(args, { cwd });
}

/**
 * The plunge commands chant runs: a single resource's drift stream, and the
 * same preview and blind stack output it runs under `pulumi`. None writes.
 */
export async function runAllowedPlunge(run: PulumiRunner, args: string[], cwd: string): Promise<{ stdout: string }> {
  const drift = args[0] === "drift" && args.includes("--resource") && args.includes("--stream") && wellFormedStack(args);
  const allowed = drift || ((args[0] === "preview" || args[0] === "stack") && allowedRead(args));
  if (!allowed) {
    throw new Error(`chant runs only plunge drift --resource <urn> --stream, plunge preview and plunge stack output --json --show-secrets=false for a Pulumi member, not plunge ${args.join(" ")}`);
  }
  return run(args, { cwd });
}

export const defaultPlungeRunner: PulumiRunner = (args, opts) => execFileAsync("plunge", args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, env: engineEnv() });

/** What runs a Pulumi member's stack. */
export type PulumiMemberEngine = "pulumi" | "plunge";

/** Which engine runs the member, and the rule that said so (see the module comment). */
export function pulumiMemberEngine(dir: string, configured?: PulumiMemberEngine): { engine: PulumiMemberEngine; because: string } {
  if (configured) return { engine: configured, because: `the member's config says engine: ${configured}` };
  const file = join(dir, "Pulumi.yaml");
  if (existsSync(file)) {
    try {
      const doc = parseYAML(readFileSync(file, "utf-8"));
      const backend = doc.backend as { url?: unknown } | undefined;
      const url = typeof backend?.url === "string" ? backend.url : undefined;
      if (url && /^plunge[+:]/.test(url)) return { engine: "plunge", because: `Pulumi.yaml names the plunge backend ${url}` };
    } catch {
      // An unreadable Pulumi.yaml fails the member file check; here it just names no backend.
    }
  }
  return { engine: "pulumi", because: "nothing names plunge" };
}

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

/** The checked-in `pulumi stack export`, parsed, or undefined when there is none or it does not read. */
export function readMemberExport(dir: string): unknown {
  const file = join(dir, PULUMI_EXPORT_FILE);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

interface RunFailure {
  stdout?: string;
  stderr?: string;
  message: string;
  missingBinary: boolean;
}

function failureOf(err: unknown): RunFailure {
  const e = err as (NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown }) | undefined;
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...(typeof e?.stdout === "string" ? { stdout: e.stdout } : {}),
    ...(typeof e?.stderr === "string" ? { stderr: e.stderr } : {}),
    message,
    missingBinary: e?.code === "ENOENT" || /ENOENT|command not found/.test(message),
  };
}

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
  const prior = readMemberExport(opts.dir);
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
}

/**
 * `pulumi stack output --json --show-secrets=false` in the member's
 * directory (`plunge stack output ...` for a member on plunge), parsed: the
 * stack's applied outputs by name, a secret printed as `[secret]`. Throws
 * when the command fails or prints no JSON object, naming the command.
 */
export async function pulumiMemberStackOutputs(opts: PulumiMemberStackOutputsOptions): Promise<Record<string, unknown>> {
  const engine = pulumiMemberEngine(opts.dir, opts.engine).engine;
  const args = pulumiStackOutputArgs({ stack: memberStack({ declared: opts.stack, exported: readMemberExport(opts.dir) }) });
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
 * URNs given and no export to take them from, one untargeted refresh, which
 * throws when it fails, since no record names a resource to hang it on.
 */
export async function refreshPulumiMember(opts: RefreshPulumiMemberOptions): Promise<DriftRecord[]> {
  const run = opts.run ?? defaultPulumiRunner;
  const exported = readMemberExport(opts.dir);
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

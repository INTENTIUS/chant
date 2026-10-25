/**
 * Running `pulumi` for a Pulumi member (#4453), under the ruling on #4450:
 * chant may run `pulumi preview` and `pulumi refresh --preview-only` for a
 * Pulumi member, and nothing else. Both read the provider and change no
 * stack. {@link PULUMI_ALLOWED_COMMANDS} is that list, and
 * {@link runAllowedPulumi} refuses any argv outside it before it reaches the
 * runner, so no later caller can make this module apply.
 *
 * - {@link previewPulumiMember}: `pulumi preview --json` in the member's
 *   directory, as the member's change-set part (`./change-set.ts`), with the
 *   checked-in `stack-export.json` as the last deployment, so what the
 *   preview cannot list is `mayAppear` rather than left out.
 * - {@link refreshPulumiMember}: `pulumi refresh --preview-only --json
 *   --target <urn>` once per resource, as drift records
 *   (`./drift-record.ts`). The URNs default to the export's resources. With
 *   no export, one untargeted refresh. A member on plunge reads each
 *   resource with `plunge drift --resource <urn> --stream` instead, the one
 *   plunge command {@link runAllowedPlunge} lets through.
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
import { isPulumiNodeless } from "@intentius/chant/pulumi-urn";
import { pulumiExportResources, pulumiPreviewPart } from "./change-set";
import { pulumiRefreshArgs, pulumiRefreshDocumentRecords, pulumiRefreshDriftRecords, type PulumiRefreshRead } from "./drift-record";
import { parseYAML } from "@intentius/chant/yaml";
import { plungeDriftArgs, plungeDriftStreamRecords, type PlungeDriftRead } from "./drift-record";
import { PULUMI_EXPORT_FILE } from "./workspace-member";

const execFileAsync = promisify(execFile);

/** Runs the pulumi binary with these arguments in `cwd`. Injectable so tests need no binary. */
export type PulumiRunner = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string }>;

export const defaultPulumiRunner: PulumiRunner = (args, opts) =>
  execFileAsync("pulumi", args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PULUMI_SKIP_UPDATE_CHECK: "true" } });

/** The only `pulumi` commands chant runs (ruling on #4450): each argv must start with one of these. */
export const PULUMI_ALLOWED_COMMANDS: readonly (readonly string[])[] = [["preview"], ["refresh", "--preview-only"]];

/** Run `args` through `run`, refusing any argv that is not an allowed read. */
export async function runAllowedPulumi(run: PulumiRunner, args: string[], cwd: string): Promise<{ stdout: string }> {
  const allowed = PULUMI_ALLOWED_COMMANDS.some((prefix) => prefix.every((a, i) => args[i] === a)) && (args[0] !== "refresh" || args.includes("--preview-only"));
  if (!allowed) throw new Error(`chant runs only pulumi preview and pulumi refresh --preview-only for a Pulumi member, not pulumi ${args.join(" ")}`);
  return run(args, { cwd });
}

/** The one plunge command chant runs: a single resource's drift stream, which writes nothing. */
export async function runAllowedPlunge(run: PulumiRunner, args: string[], cwd: string): Promise<{ stdout: string }> {
  const allowed = args[0] === "drift" && args.includes("--resource") && args.includes("--stream");
  if (!allowed) throw new Error(`chant runs only plunge drift --resource <urn> --stream for a Pulumi member, not plunge ${args.join(" ")}`);
  return run(args, { cwd });
}

export const defaultPlungeRunner: PulumiRunner = (args, opts) => execFileAsync("plunge", args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024 });

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

/** The argv chant runs for a member's preview, after `pulumi`. */
export function pulumiPreviewArgs(opts: { stack?: string; targets?: readonly string[] } = {}): string[] {
  return ["preview", "--json", ...(opts.stack ? ["--stack", opts.stack] : []), ...(opts.targets ?? []).flatMap((t) => ["--target", t])];
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
  stack?: string;
  /** Narrow the preview to these URNs. A narrowed preview does not mark what it leaves out. */
  targets?: readonly string[];
  run?: PulumiRunner;
}

/**
 * The member's change-set part from `pulumi preview --json`. A preview that
 * fails is a failed member, keeping what steps it printed; a missing binary
 * is a failed member that says so. Never throws for a run that failed.
 */
export async function previewPulumiMember(opts: PreviewPulumiMemberOptions): Promise<ChangeSetPart> {
  const args = pulumiPreviewArgs({ stack: opts.stack, targets: opts.targets });
  const prior = readMemberExport(opts.dir);
  const common = { member: opts.member, ...(opts.stack ? { stack: opts.stack } : {}), ...(prior !== undefined ? { prior } : {}), ...(opts.targets?.length ? { targeted: true } : {}) };
  try {
    const { stdout } = await runAllowedPulumi(opts.run ?? defaultPulumiRunner, args, opts.dir);
    const preview = parseJson(stdout);
    if (preview === undefined) return pulumiPreviewPart({ ...common, preview: {}, error: "pulumi preview --json printed no JSON" });
    return pulumiPreviewPart({ ...common, preview });
  } catch (err) {
    const f = failureOf(err);
    const preview = parseJson(f.stdout) ?? {};
    const error = f.missingBinary
      ? "the pulumi binary was not found on PATH; install pulumi to plan this member"
      : diagnosticError(preview) ?? (f.stderr?.trim() || f.message);
    return pulumiPreviewPart({ ...common, preview, error });
  }
}

export interface RefreshPulumiMemberOptions extends DriftAdapterBase {
  dir: string;
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
  const urns =
    opts.urns ??
    (() => {
      const exported = readMemberExport(opts.dir);
      return exported === undefined ? undefined : pulumiExportResources(exported).filter((r) => !isPulumiNodeless(r.type)).map((r) => r.urn);
    })();
  const base: DriftAdapterBase & { stack?: string } = {
    member: opts.member,
    observedAt: opts.observedAt,
    ...(opts.graph !== undefined ? { graph: opts.graph } : {}),
    ...(opts.fellBackFrom !== undefined ? { fellBackFrom: opts.fellBackFrom } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
    ...(opts.stack ? { stack: opts.stack } : {}),
  };

  if (pulumiMemberEngine(opts.dir, opts.engine).engine === "plunge") {
    // plunge drift reads one resource at a time, so it needs the URNs.
    if (urns === undefined) throw new Error(`member ${opts.member} runs on plunge, whose drift reads one resource at a time, and has no ${PULUMI_EXPORT_FILE} to take the URNs from`);
    const plunge = opts.plunge ?? defaultPlungeRunner;
    const reads: PlungeDriftRead[] = [];
    for (const urn of urns) {
      try {
        const { stdout } = await runAllowedPlunge(plunge, plungeDriftArgs({ urn, stack: opts.stack, member: opts.member }), opts.dir);
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
      const { stdout } = await runAllowedPulumi(run, pulumiRefreshArgs({ stack: opts.stack }), opts.dir);
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
      const { stdout } = await runAllowedPulumi(run, pulumiRefreshArgs({ urn, stack: opts.stack }), opts.dir);
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

/**
 * `PulumiAdoptOp`'s activities (#4562): check the bucket, export the stock
 * checkpoint, preview the adoption, adopt. The composite
 * (`../../composites/pulumi-adopt-op.ts`) puts its gate between the preview
 * and the adoption, bound to the preview's `planDigest`.
 *
 * - `pulumiAdoptCheck`: the shared bucket check (#4558, `@intentius/chant/bucket-check`)
 *   on the bucket the stack's backend URL names. A failing setting that is
 *   not waived (`allow_insecure` on the URL, `PLUNGE_ALLOW_INSECURE`, or the
 *   step's `allowInsecure`) refuses the stack by name with its fix, before
 *   anything is exported. A `file://` backend has no bucket and is skipped.
 * - `pulumiAdoptExport`: stock `pulumi stack export --stack <s>`, through the
 *   read allowlist (#4546), against the stack's stock backend at the same
 *   root (the backend URL without `plunge+`) or the step's `from.backend`
 *   (Pulumi Cloud, for the `--file` route). The export is kept in a scratch
 *   file under the OS temp dir, mode 600, since it holds secret ciphertext:
 *   it is the back-out copy, and on the `--file` route the document plunge
 *   adopts. `from.file` names an export taken by hand instead, and nothing
 *   runs. The result gives the file, its SHA-256 and its counts.
 * - `pulumiAdoptPreview`: `plunge stack adopt --json --stack <s> [--file f]`,
 *   which classifies and writes nothing. A refused adoption fails the step,
 *   naming each refusal. Its `planDigest` (`../../adopt.ts`'s
 *   `pulumiAdoptDigest`) is what the gate binds.
 * - `pulumiAdopt`: `plunge stack adopt --json --yes --stack <s> [--file f]`
 *   through `runAdoptPlunge`, the one entry point allowed to write. It
 *   reports whether what plunge adopted digests as the approved preview did.
 *
 * None of them calls a cloud API but the bucket check's reads: adoption
 * writes plunge's records only, and the next `plunge up` writes the
 * markers.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { BucketReport, BucketTarget, CheckBucketOptions } from "@intentius/chant/bucket-check";
import {
  adoptBucketTarget,
  adoptFates,
  parsePlungeAdoptView,
  pulumiAdoptDigest,
  pulumiStackBackend,
  stockBackendUrl,
  type PlungeAdoptRefusal,
  type PlungeAdoptStatus,
  type PlungeAdoptView,
} from "../../adopt";
import { pulumiExportResources } from "../../change-set";
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  plungeAdoptArgs,
  pulumiRunFailure,
  runAdoptPlunge,
  runAllowedPlunge,
  runAllowedPulumi,
  type PulumiRunner,
} from "../../run";
import { isObject } from "../../values";

/** The fields every adopt activity takes. */
export interface PulumiAdoptStackArgs {
  /** The member's name. */
  member: string;
  /** The stack's directory, where `Pulumi.yaml` is. Relative paths resolve against `cwd`. */
  dir: string;
  cwd?: string;
  /** The stack to adopt. */
  stack: string;
}

export interface PulumiAdoptCheckArgs extends PulumiAdoptStackArgs {
  /** The plunge backend URL (`plunge+s3://...`). Default: `plywood.yml`'s, `PULUMI_BACKEND_URL`, `Pulumi.yaml`'s. */
  backend?: string;
  /** The bucket to check, when the URL does not say enough (azblob), as `@intentius/chant/bucket-check` takes it. */
  bucket?: Record<string, unknown>;
  /** Key prefixes a lifecycle rule must cover. Default: the URL's path. */
  namespaces?: string[];
  /** Settings waived on top of the URL's `allow_insecure` and `PLUNGE_ALLOW_INSECURE`. An unwaivable one stays refused. */
  allowInsecure?: string[];
}

export interface PulumiAdoptCheckResult {
  member: string;
  stack: string;
  /** False when there was no bucket to check. */
  checked: boolean;
  /** Why the check did not run. */
  skipped?: string;
  store?: string;
  bucket?: string;
  correct: boolean;
  /** Settings that failed and were waived. */
  waived: string[];
}

export interface PulumiAdoptExportArgs extends PulumiAdoptStackArgs {
  /** The plunge backend URL; its stock form is where the export is read. */
  backend?: string;
  /** Where the checkpoint comes from instead: another backend (Pulumi Cloud, `https://api.pulumi.com`), or an export already taken. */
  from?: { backend?: string; file?: string };
}

export interface PulumiAdoptExportResult {
  member: string;
  stack: string;
  /** The export, a scratch file (mode 600) or `from.file`. */
  file: string;
  sha256: string;
  resources: number;
  pendingOperations: number;
  /** The backend it was read from, or `file`. */
  source: string;
  /** True when plunge adopts this file (`--file`), on the route from another backend or a given file. */
  adoptFromFile: boolean;
}

export interface PulumiAdoptPreviewArgs extends PulumiAdoptStackArgs {
  /** `--file`: the export to adopt, from the Export step when `adoptFromFile`. */
  file?: string;
}

export interface PulumiAdoptPreviewResult {
  member: string;
  stack: string;
  status: PlungeAdoptStatus;
  /** What the gate binds. */
  planDigest: string;
  checkpointDigest: string | null;
  resources: number;
  /** Resources by fate: marker, record, pending, already-adopted. */
  fates: Record<string, number>;
  /** False when the stack is already adopted from this checkpoint. */
  changed: boolean;
}

export interface PulumiAdoptArgs extends PulumiAdoptPreviewArgs {
  /** The approved preview's digest, to report whether the adoption matched it. */
  planDigest?: string;
}

export interface PulumiAdoptResult extends PulumiAdoptPreviewResult {
  /** Whether what plunge adopted digests as the approved preview. Absent when no digest was handed in. */
  matchesApproved?: boolean;
}

/** Runners and seams, injectable so the tests run no binary and read no bucket. */
export interface PulumiAdoptDeps {
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  env?: Record<string, string | undefined>;
  tmp?: string;
  checkBucket?: (target: BucketTarget, options: CheckBucketOptions) => Promise<BucketReport>;
}

function stackDir(a: PulumiAdoptStackArgs): string {
  return isAbsolute(a.dir) ? a.dir : resolve(a.cwd ?? process.cwd(), a.dir);
}

function requireStack(a: PulumiAdoptStackArgs, what: string): void {
  if (typeof a?.dir !== "string" || a.dir === "") throw new Error(`${what}: the step needs "dir", the directory holding Pulumi.yaml`);
  if (typeof a.stack !== "string" || a.stack === "" || a.stack.startsWith("-")) throw new Error(`${what}: the step needs "stack", the stack to adopt`);
}

function refusalText(refusals: readonly PlungeAdoptRefusal[]): string {
  return refusals.map((r) => `${r.code}${r.urn ? ` (${r.urn})` : ""}: ${r.reason}`).join("; ");
}

/** The shared bucket check on the stack's backend bucket; throws when a setting fails unwaived. */
export async function adoptCheck(a: PulumiAdoptCheckArgs, deps: PulumiAdoptDeps = {}): Promise<PulumiAdoptCheckResult> {
  requireStack(a, "pulumiAdoptCheck");
  const env = deps.env ?? process.env;
  const dir = stackDir(a);
  const base = { member: a.member, stack: a.stack };
  let target: BucketTarget;
  let namespaces: string[];
  let waived: string[];
  if (a.bucket) {
    target = a.bucket as unknown as BucketTarget;
    namespaces = a.namespaces ?? [];
    waived = [...(env.PLUNGE_ALLOW_INSECURE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  } else {
    const backend = pulumiStackBackend(dir, { ...(a.backend ? { configured: a.backend } : {}), env });
    if (!backend) {
      throw new Error(`pulumiAdoptCheck: "${a.member}/${a.stack}" names no backend (the step's backend, plywood.yml, PULUMI_BACKEND_URL or Pulumi.yaml), so its bucket cannot be checked before adoption`);
    }
    const found = adoptBucketTarget(backend.url, env);
    if ("skip" in found) return { ...base, checked: false, skipped: found.skip, correct: true, waived: [] };
    if ("refuse" in found) throw new Error(`pulumiAdoptCheck: refusing to adopt "${a.member}/${a.stack}": ${found.refuse}`);
    target = found.target;
    namespaces = a.namespaces ?? found.namespaces;
    waived = found.waived;
  }
  waived = [...new Set([...waived, ...(a.allowInsecure ?? [])])];
  const check =
    deps.checkBucket ??
    (async (t: BucketTarget, o: CheckBucketOptions) => {
      const mod = await import("@intentius/chant/bucket-check");
      return mod.checkBucket(t, o);
    });
  const report = await check(target, { namespaces });
  const failing = report.settings.filter((f) => f.verdict !== "ok");
  const refused = failing.filter((f) => f.unwaivable || !waived.includes(f.setting));
  if (refused.length > 0) {
    const lines = refused.map((f) => `${f.setting} (${f.verdict}): ${f.found}${f.fix ? `; fix: ${f.fix}` : ""}${f.unwaivable ? "; no waiver reaches it" : ""}`);
    throw new Error(`pulumiAdoptCheck: refusing to adopt "${a.member}/${a.stack}": the ${report.store} bucket ${report.bucket} fails the shared check: ${lines.join(" | ")}`);
  }
  return { ...base, checked: true, store: report.store, bucket: report.bucket, correct: report.correct, waived: failing.map((f) => f.setting) };
}

/** The stock checkpoint as a scratch file, or the given one. */
export async function adoptExport(a: PulumiAdoptExportArgs, deps: PulumiAdoptDeps = {}): Promise<PulumiAdoptExportResult> {
  requireStack(a, "pulumiAdoptExport");
  const env = deps.env ?? process.env;
  const dir = stackDir(a);
  const base = { member: a.member, stack: a.stack };
  const summarize = (text: string, file: string, source: string, adoptFromFile: boolean): PulumiAdoptExportResult => {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error(`pulumiAdoptExport: the export of "${a.member}/${a.stack}" from ${source} is not JSON`);
    }
    const deployment = isObject(doc) && isObject(doc.deployment) ? doc.deployment : undefined;
    const pending = deployment && Array.isArray(deployment.pending_operations) ? deployment.pending_operations.length : 0;
    return {
      ...base,
      file,
      sha256: createHash("sha256").update(text).digest("hex"),
      resources: pulumiExportResources(doc).length,
      pendingOperations: pending,
      source,
      adoptFromFile,
    };
  };

  if (a.from?.file) {
    const file = isAbsolute(a.from.file) ? a.from.file : resolve(dir, a.from.file);
    if (!existsSync(file)) throw new Error(`pulumiAdoptExport: the export ${file} for "${a.member}/${a.stack}" does not exist`);
    return summarize(readFileSync(file, "utf-8"), file, "file", true);
  }

  let source: string | undefined;
  if (a.from?.backend) {
    source = a.from.backend;
  } else {
    const backend = pulumiStackBackend(dir, { ...(a.backend ? { configured: a.backend } : {}), env });
    source = backend ? stockBackendUrl(backend.url) : undefined;
  }
  const args = ["stack", "export", "--stack", a.stack];
  let stdout: string;
  try {
    ({ stdout } = await runAllowedPulumi(deps.run ?? defaultPulumiRunner, args, dir, source ? { PULUMI_BACKEND_URL: source } : undefined));
  } catch (err) {
    const f = pulumiRunFailure(err);
    const why = f.missingBinary ? "the pulumi binary was not found on PATH" : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
    throw new Error(`pulumiAdoptExport: pulumi ${args.join(" ")} for "${a.member}/${a.stack}"${source ? ` against ${source}` : ""} failed: ${why}`);
  }
  const scratch = mkdtempSync(join(deps.tmp ?? tmpdir(), "chant-pulumi-adopt-"));
  const file = join(scratch, `${a.stack.replace(/[^A-Za-z0-9._-]+/g, "_")}.export.json`);
  writeFileSync(file, stdout, { mode: 0o600 });
  return summarize(stdout, file, source ?? "the selected backend", a.from?.backend !== undefined);
}

/** The adopt document from a run, its failure's stdout included; throws when there is none. */
async function adoptView(run: () => Promise<{ stdout: string }>, what: string, command: string): Promise<PlungeAdoptView> {
  try {
    const { stdout } = await run();
    const view = parsePlungeAdoptView(stdout);
    if (!view) throw new Error(`${what}: ${command} printed no adopt document`);
    return view;
  } catch (err) {
    const f = pulumiRunFailure(err);
    const view = parsePlungeAdoptView(f.stdout);
    if (view) return view;
    if (err instanceof Error && err.message.startsWith(`${what}:`)) throw err;
    const why = f.missingBinary ? "the plunge binary was not found on PATH" : (f.stderr?.trim() || f.message).split("\n").slice(-3).join("\n");
    throw new Error(`${what}: ${command} failed: ${why}`);
  }
}

function summary(a: PulumiAdoptStackArgs, view: PlungeAdoptView): PulumiAdoptPreviewResult {
  return {
    member: a.member,
    stack: a.stack,
    status: view.status,
    planDigest: pulumiAdoptDigest(view),
    checkpointDigest: view.checkpoint.digest ?? null,
    resources: view.resources.length,
    fates: adoptFates(view),
    changed: view.status !== "already-adopted",
  };
}

/** `plunge stack adopt --json`: the classification, written nowhere. A refusal fails the step. */
export async function adoptPreview(a: PulumiAdoptPreviewArgs, deps: PulumiAdoptDeps = {}): Promise<PulumiAdoptPreviewResult> {
  requireStack(a, "pulumiAdoptPreview");
  const dir = stackDir(a);
  const args = plungeAdoptArgs({ stack: a.stack, ...(a.file ? { file: a.file } : {}) });
  const view = await adoptView(() => runAllowedPlunge(deps.plunge ?? defaultPlungeRunner, args, dir), "pulumiAdoptPreview", `plunge ${args.join(" ")}`);
  if (view.status === "refused") {
    throw new Error(`pulumiAdoptPreview: plunge refuses to adopt "${a.member}/${a.stack}": ${refusalText(view.refusals)}. Nothing was written.`);
  }
  return summary(a, view);
}

/** `plunge stack adopt --json --yes`: writes the records. A refusal fails the step; plunge wrote nothing then. */
export async function adoptStack(a: PulumiAdoptArgs, deps: PulumiAdoptDeps = {}): Promise<PulumiAdoptResult> {
  requireStack(a, "pulumiAdopt");
  const dir = stackDir(a);
  const args = plungeAdoptArgs({ stack: a.stack, yes: true, ...(a.file ? { file: a.file } : {}) });
  const view = await adoptView(() => runAdoptPlunge(deps.plunge ?? defaultPlungeRunner, args, dir), "pulumiAdopt", `plunge ${args.join(" ")}`);
  if (view.status === "refused") {
    throw new Error(`pulumiAdopt: plunge refused to adopt "${a.member}/${a.stack}": ${refusalText(view.refusals)}. Nothing was written.`);
  }
  const out = summary(a, view);
  return { ...out, ...(a.planDigest ? { matchesApproved: out.planDigest === a.planDigest } : {}) };
}

export async function pulumiAdoptCheck(args: Record<string, unknown>): Promise<PulumiAdoptCheckResult> {
  return adoptCheck(args as unknown as PulumiAdoptCheckArgs);
}

export async function pulumiAdoptExport(args: Record<string, unknown>): Promise<PulumiAdoptExportResult> {
  return adoptExport(args as unknown as PulumiAdoptExportArgs);
}

export async function pulumiAdoptPreview(args: Record<string, unknown>): Promise<PulumiAdoptPreviewResult> {
  return adoptPreview(args as unknown as PulumiAdoptPreviewArgs);
}

export async function pulumiAdopt(args: Record<string, unknown>): Promise<PulumiAdoptResult> {
  return adoptStack(args as unknown as PulumiAdoptArgs);
}

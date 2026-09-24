/**
 * `chant workspace check [--at <rev>] [--json] [--format stylish|json|sarif] [--generated] [--kind <kind file>]`:
 * the lineage checks (#2550, D9), and the declaration checks (#2535, D16)
 * when a declaration sits between the current directory and the git root.
 *
 * D9 says open manual steps fail `check`. So far, `check` checks the
 * lineage lock only: the lock must be readable, and no scope may have an open
 * manual step. It needs no `chant.workspace.json`, the way `chant workspace
 * lineage` needs none, and a directory without a lock passes with nothing to
 * check. The declaration checks report `WSP` findings through lint's
 * reporters (`./checks.ts`), and cover member ledgers (#2538), recorded
 * pipelines (#2542) and generated files (#2541) as well as the declaration
 * itself (#2641). `--generated` runs each declared generator too. `--kind`
 * reads a record kind's records and reports the files they pin by hash that
 * have changed since (#2549).
 *
 * `chant workspace upgrade` runs the same checks in its staging worktree
 * before it reaches its gate.
 */

import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { formatError, formatSuccess } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import type { LintDiagnostic, LintRule } from "../lint/rule";
import { findWorkspaceRoot } from "../project-root";
import type { DeclarationCheckReport } from "./checks";
import type { RecordFacts } from "./checks/records";
import { LOCK_FILE, LockError, parseLock, readLock } from "./lineage-lock";
import type { ReasonCode } from "./reason-codes";
import type { WorkspaceTree } from "./tree";

/** Closed: a reader may switch on it. */
export const CHECK_CODES = ["lock-invalid", "manual-step-open"] as const satisfies readonly ReasonCode[];
export type CheckCode = (typeof CHECK_CODES)[number];

export interface CheckFinding {
  code: CheckCode;
  /** The scope the finding is in, or null for the lock as a whole. */
  scope: string | null;
  /** The file, relative to the lock's directory, when the finding is about one. */
  path?: string;
  message: string;
}

export interface CheckReport {
  lock: string | null;
  ok: boolean;
  findings: CheckFinding[];
}

/**
 * Run the lineage checks over the lock at `root`. Never throws a
 * {@link LockError}. `lockText` is the lock's text when it comes from
 * somewhere other than the disk, such as a revision (`--at`), with null
 * for no lock.
 */
export function checkLineage(root: string, lockText?: string | null): CheckReport {
  let lock;
  try {
    lock = lockText === undefined ? readLock(root) : lockText === null ? null : parseLock(lockText);
  } catch (err) {
    if (!(err instanceof LockError)) throw err;
    return { lock: LOCK_FILE, ok: false, findings: [{ code: "lock-invalid", scope: null, path: LOCK_FILE, message: err.message }] };
  }
  if (!lock) return { lock: null, ok: true, findings: [] };
  const findings: CheckFinding[] = [];
  for (const [scope, lineage] of Object.entries(lock.scopes)) {
    for (const step of lineage.manualSteps) {
      const path = scope === "." ? step.path : `${scope}/${step.path}`;
      findings.push({
        code: "manual-step-open",
        scope,
        path,
        message: `manual step open (${step.reason}): merge by hand, then \`chant workspace lineage resolve ${path}\``,
      });
    }
  }
  return { lock: LOCK_FILE, ok: findings.length === 0, findings };
}

/** A finding's identity, for comparing two reports. */
export function findingKey(f: CheckFinding): string {
  return `${f.code}\0${f.scope ?? ""}\0${f.path ?? ""}`;
}

const USAGE = "chant workspace check [--at <rev>] [--json] [--format stylish|json|sarif] [--generated] [--kind <kind file>]";
const FORMATS = ["stylish", "json", "sarif"] as const;

/** A lock finding as a lint diagnostic, for `--format json` and `--format sarif`. */
function lockDiagnostic(f: CheckFinding): LintDiagnostic {
  return { file: f.path ?? LOCK_FILE, line: 1, column: 1, ruleId: f.code, severity: "error", message: f.message };
}

const LOCK_RULES: LintRule[] = [
  { id: "lock-invalid", severity: "error", category: "correctness", description: "The lineage lock can be read.", helpUri: "https://intentius.io/chant/cli/workspace-check/", check: () => [] },
  {
    id: "manual-step-open",
    severity: "error",
    category: "correctness",
    description: "No scope in the lineage lock has an open manual step.",
    helpUri: "https://intentius.io/chant/cli/workspace-check/",
    check: () => [],
  },
];

/** SARIF says `inSource` for a comment in the code; a declaration's `suppress` is `external`. */
function markExternalSuppressions(sarif: string): string {
  const doc = JSON.parse(sarif) as { runs: { results: { suppressions?: { kind: string }[] }[] }[] };
  for (const run of doc.runs) for (const r of run.results) for (const s of r.suppressions ?? []) s.kind = "external";
  return JSON.stringify(doc, null, 2);
}

/** The path from tree directory `from` to tree directory `to`, both relative to the git root. */
function posixRelative(from: string, to: string): string {
  return relative(`/${from}`, `/${to}`) || ".";
}

/** The version of the `check` document this chant writes. */
export const CHECK_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the `--format json` output, shipped beside this file. */
export const CHECK_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/check/v1/check.schema.json";

/** Why `check` could not run at all: only the `--at` codes. A declaration that can't be read is a WSP001 finding instead. */
export const CHECK_ERROR_CODES = ["not-a-git-repository", "revision-unknown"] as const satisfies readonly ReasonCode[];
export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

/** What `check --format json` prints (#2536). `check.schema.json` describes it. */
export type CheckDocument =
  | (CheckReport & {
      $schema: string;
      contract: number;
      chant: string;
      at: string | null;
      /** The declaration's workspace, or null when there is none; `name` is null when it can't be read. */
      workspace: { name: string | null; root: string } | null;
      declaration?: DeclarationCheckReport;
    })
  | { $schema: string; contract: number; chant: string; error: { code: CheckErrorCode; message: string; location: null } };

/**
 * Run every check from `cwd`, in the working tree or at revision `at`, and
 * build the document the JSON formats print. Paths in findings are relative
 * to `cwd`. `runGenerators` is `--generated`; with `at` it does nothing,
 * since the member facts describe the working tree, not the revision.
 */
export async function runChecks(cwd: string, at?: string, options: { runGenerators?: boolean; kind?: string } = {}): Promise<CheckDocument> {
  // Loaded here, not at the top: `workspace upgrade` imports this module for checkLineage alone.
  const [{ findDeclarationDir, readDeclaration, readerVersion }, { gitTop, gitTree, resolveCommit, workingTree }] = await Promise.all([
    import("./declaration"),
    import("./tree"),
  ]);
  const head = { $schema: CHECK_OUTPUT_SCHEMA_ID, contract: CHECK_CONTRACT_VERSION, chant: readerVersion() };
  let report: CheckReport;
  /** The declaration's directory on disk, its root relative to the git root, and the files to check. */
  let found: { dir: string; root: string; tree: WorkspaceTree } | undefined;
  let commit: string | null = null;
  if (at === undefined) {
    report = checkLineage(cwd);
    // Declaration checks run when a declaration sits between here and the git
    // root (#2535). Without one the command stays a lock check.
    const f = findWorkspaceRoot(cwd);
    if (f) {
      const top = gitTop(f.dir);
      const rel = top ? relative(top, realpathSync(f.dir)).split(sep).join("/") : f.dir;
      found = { dir: f.dir, root: rel === "" ? "." : rel, tree: workingTree(f.dir) };
    }
  } else {
    const top = gitTop(cwd);
    if (!top) return { ...head, error: { code: "not-a-git-repository", message: "--at reads git objects, and this directory is not in a git repository", location: null } };
    const c = resolveCommit(top, at);
    if (!c) return { ...head, error: { code: "revision-unknown", message: `--at ${at} names no commit in this repository`, location: null } };
    commit = c;
    const rel = relative(top, realpathSync(resolve(cwd))).split(sep).join("/");
    const start = rel.startsWith("..") ? "" : rel;
    const whole = gitTree(top, c);
    const lockAt = start ? `${start}/${LOCK_FILE}` : LOCK_FILE;
    report = checkLineage(cwd, whole.stat(lockAt) === "file" ? whole.read(lockAt) : null);
    const dir = findDeclarationDir(whole, start);
    // The root on disk is reached from cwd, so paths print relative to cwd as it was given.
    if (dir !== undefined) found = { dir: resolve(cwd, posixRelative(start, dir)), root: dir === "" ? "." : dir, tree: dir === "" ? whole : gitTree(top, c, dir) };
  }

  let declaration: DeclarationCheckReport | undefined;
  let workspace: { name: string | null; root: string } | null = null;
  if (found) {
    const { runDeclarationChecks } = await import("./checks");
    const { dir, tree } = found;
    const records = options.kind !== undefined ? await readRecordFacts(options.kind, cwd, commit) : undefined;
    declaration = await runDeclarationChecks(dir, (file) => relative(cwd, join(dir, file)).split(sep).join("/"), {
      runGenerators: options.runGenerators === true,
      ...(commit !== null ? { tree } : {}),
      ...(records ? { records } : {}),
    });
    let name: string | null = null;
    try {
      name = readDeclaration(tree, "", { rootChant: true }).name;
    } catch {
      // The WSP001 finding already says why.
    }
    workspace = { name, root: found.root };
  }
  const ok = report.ok && (declaration?.ok ?? true);
  return { ...head, at: commit, workspace, ...report, ok, ...(declaration ? { declaration } : {}) };
}

/** The records of the kind file `kind` for the record checks (#2549), at `commit` or in the working tree. */
async function readRecordFacts(kind: string, cwd: string, commit: string | null): Promise<RecordFacts> {
  const [{ readRecordsFor }, { RecordReadError }] = await Promise.all([import("./records-cli"), import("./records")]);
  try {
    const read = await readRecordsFor({ kind, cwd, ...(commit !== null ? { at: commit } : {}) });
    return { kind, records: read.result.records.map((r) => ({ ...r, file: join(read.root, ...r.path.split("/")) })) };
  } catch (err) {
    if (!(err instanceof RecordReadError)) throw err;
    return { kind, error: { code: err.code, message: err.message } };
  }
}

export async function runWorkspaceCheck(ctx: CommandContext): Promise<number> {
  const root = process.cwd();
  if (ctx.args.extraPositional) {
    console.error(formatError({ message: `chant workspace check takes no argument (got ${ctx.args.extraPositional})`, hint: USAGE }));
    return 1;
  }
  const format = (ctx.args.format || "stylish") as (typeof FORMATS)[number];
  if (!FORMATS.includes(format)) {
    console.error(formatError({ message: `--format ${format} is not a check format; use stylish, json or sarif`, hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021). Only a workspace with a
  // declaration loads this.
  if (ctx.args.at !== undefined || findWorkspaceRoot(root)) {
    const { handToRootChant } = await import("./which-chant");
    const handed = await handToRootChant(root, ctx.args.at);
    if (handed !== undefined) return handed;
  }
  const doc = await runChecks(root, ctx.args.at, { runGenerators: ctx.args.generated === true, ...(ctx.args.kind !== undefined ? { kind: ctx.args.kind } : {}) });
  if ("error" in doc) {
    if (ctx.args.json || format === "json") console.log(JSON.stringify(doc, null, 2));
    else console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  const { declaration, ok } = doc;
  const report = { lock: doc.lock, findings: doc.findings };

  // --format json is the read contract's document. --json keeps the shape it
  // had before the contract, the lineage report with `declaration` beside it.
  if (format === "json") {
    console.log(JSON.stringify(doc, null, 2));
    return ok ? 0 : 1;
  }
  if (ctx.args.json) {
    console.log(JSON.stringify({ lock: doc.lock, ok, findings: doc.findings, ...(declaration ? { declaration } : {}) }, null, 2));
    return ok ? 0 : 1;
  }
  // The reporters load only when there is something to report through them,
  // so a plain lock check loads what it did before.
  if (format === "sarif") {
    const { formatSarif } = await import("../cli/reporters/stylish");
    const diagnostics = [...report.findings.map(lockDiagnostic), ...(declaration?.diagnostics ?? [])];
    const suppressed = declaration?.suppressed ?? [];
    const { workspaceCheckRules } = await import("./checks");
    console.log(markExternalSuppressions(formatSarif(diagnostics, [...LOCK_RULES, ...workspaceCheckRules()], suppressed, doc.chant)));
    return ok ? 0 : 1;
  }

  if (!report.lock) {
    if (!declaration) console.error(formatSuccess(`no ${LOCK_FILE}: nothing to check`));
  } else if (report.findings.length === 0) {
    console.error(formatSuccess(`${LOCK_FILE}: no open manual steps`));
  } else {
    for (const f of report.findings) console.error(`  ${f.path ?? f.scope ?? ""}: ${f.message}`);
    console.error(formatError({ message: `${report.findings.length} check(s) failed` }));
  }
  if (declaration) {
    const { formatStylish } = await import("../cli/reporters/stylish");
    console.log(formatStylish(declaration.diagnostics, declaration.suppressed));
  }
  return ok ? 0 : 1;
}

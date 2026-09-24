/**
 * `chant workspace check [--json] [--format stylish|json|sarif] [--generated]`:
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
 * itself (#2641). `--generated` runs each declared generator too.
 *
 * `chant workspace upgrade` runs the same checks in its staging worktree
 * before it reaches its gate.
 */

import { join, relative, sep } from "node:path";
import { formatError, formatSuccess } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import type { LintDiagnostic, LintRule } from "../lint/rule";
import { findWorkspaceRoot } from "../project-root";
import type { DeclarationCheckReport } from "./checks";
import { LOCK_FILE, LockError, readLock } from "./lineage-lock";

/** Closed: a reader may switch on it. */
export const CHECK_CODES = ["lock-invalid", "manual-step-open"] as const;
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

/** Run the lineage checks over the lock at `root`. Never throws a {@link LockError}. */
export function checkLineage(root: string): CheckReport {
  let lock;
  try {
    lock = readLock(root);
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

const USAGE = "chant workspace check [--json] [--format stylish|json|sarif] [--generated]";
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
  const report = checkLineage(root);
  // Declaration checks run when a declaration sits between here and the git
  // root (#2535). Without one the command stays what it was, a lock check,
  // and loads nothing more.
  const found = findWorkspaceRoot(root);
  let declaration: DeclarationCheckReport | undefined;
  if (found) {
    const { runDeclarationChecks } = await import("./checks");
    declaration = await runDeclarationChecks(found.dir, (file) => relative(root, join(found.dir, file)).split(sep).join("/"), {
      runGenerators: ctx.args.generated === true,
    });
  }
  const ok = report.ok && (declaration?.ok ?? true);

  if (ctx.args.json) {
    console.log(JSON.stringify({ ...report, ok, ...(declaration ? { declaration } : {}) }, null, 2));
    return ok ? 0 : 1;
  }
  // The reporters load only when there is something to report through them,
  // so a plain lock check loads what it did before.
  if (format !== "stylish") {
    const { formatJson, formatSarif } = await import("../cli/reporters/stylish");
    const diagnostics = [...report.findings.map(lockDiagnostic), ...(declaration?.diagnostics ?? [])];
    const suppressed = declaration?.suppressed ?? [];
    if (format === "json") {
      console.log(formatJson(diagnostics));
    } else {
      const { workspaceCheckRules } = await import("./checks");
      const { readerVersion } = await import("./declaration");
      console.log(markExternalSuppressions(formatSarif(diagnostics, [...LOCK_RULES, ...workspaceCheckRules()], suppressed, readerVersion())));
    }
    return ok ? 0 : 1;
  }

  if (!report.lock) {
    if (!declaration) console.error(formatSuccess(`no ${LOCK_FILE}: nothing to check`));
  } else if (report.ok) {
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

/**
 * `chant workspace check [--json]`: the lineage checks (#2550, D9).
 *
 * D9 says open manual steps fail `check`. So far, `check` checks the
 * lineage lock only: the lock must be readable, and no scope may have an open
 * manual step. It needs no `chant.workspace.json`, the way `chant workspace
 * lineage` needs none, and a directory without a lock passes with nothing to
 * check. The generated-file drift checks of D14 (#2541) and the per-member
 * checks (#2537) add their findings to the same list.
 *
 * `chant workspace upgrade` runs the same checks in its staging worktree
 * before it reaches its gate.
 */

import { formatError, formatSuccess } from "../cli/format";
import type { CommandContext } from "../cli/registry";
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

export async function runWorkspaceCheck(ctx: CommandContext): Promise<number> {
  const root = process.cwd();
  if (ctx.args.extraPositional) {
    console.error(formatError({ message: `chant workspace check takes no argument (got ${ctx.args.extraPositional})`, hint: "chant workspace check [--json]" }));
    return 1;
  }
  const report = checkLineage(root);
  if (ctx.args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!report.lock) {
    console.error(formatSuccess(`no ${LOCK_FILE}: nothing to check`));
  } else if (report.ok) {
    console.error(formatSuccess(`${LOCK_FILE}: no open manual steps`));
  } else {
    for (const f of report.findings) console.error(`  ${f.path ?? f.scope ?? ""}: ${f.message}`);
    console.error(formatError({ message: `${report.findings.length} check(s) failed` }));
  }
  return report.ok ? 0 : 1;
}

/**
 * `chant workspace lineage [--json]` and
 * `chant workspace lineage resolve <path>` (#2540).
 *
 * The first shows each scope in `.chant/workspace.lock.json`: where it came
 * from, which files the project has edited since, and which manual steps are
 * open. The second closes a manual step once the file has been merged by
 * hand. Neither needs a `chant.workspace.json`: lineage works for a plain
 * project (#2525 rule 4).
 */

import { formatError, formatSuccess } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { LOCK_FILE, LockError, readLock, resolveManualStep, scopeStatus, writeLock, type ManualStep } from "./lineage-lock";

const USAGE = "chant workspace lineage [--json] | chant workspace lineage resolve <path>";

export interface LineageScopeView {
  scope: string;
  kind: "template" | "vendor";
  name?: string;
  template: string;
  ref?: string;
  address: Record<string, unknown> | null;
  files: number;
  edited: string[];
  missing: string[];
  manualSteps: ManualStep[];
}

/** The lock as `--json` prints it: one view per scope, with its state in the tree. */
export function lineageView(root: string): { lock: string; scopes: LineageScopeView[] } | null {
  const lock = readLock(root);
  if (!lock) return null;
  const scopes = Object.entries(lock.scopes).map(([scope, lineage]) => {
    const st = scopeStatus(root, scope, lineage);
    return {
      scope,
      kind: lineage.kind,
      ...(lineage.name !== undefined ? { name: lineage.name } : {}),
      template: lineage.template,
      ...(lineage.ref !== undefined ? { ref: lineage.ref } : {}),
      address: lineage.address,
      files: Object.keys(lineage.files).length,
      edited: st.customised,
      missing: st.missing,
      manualSteps: lineage.manualSteps,
    };
  });
  return { lock: LOCK_FILE, scopes };
}

export async function runWorkspaceLineage(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const root = process.cwd();
  try {
    if (args.extraPositional === "resolve") return resolve(root, args.extraPositional2);
    if (args.extraPositional) {
      console.error(formatError({ message: `Unknown lineage subcommand: ${args.extraPositional}`, hint: USAGE }));
      return 1;
    }
    const view = lineageView(root);
    if (!view) {
      console.error(formatError({ message: `no ${LOCK_FILE} in ${root}`, hint: "chant init --from or --template writes one; so does chant vendor migrate" }));
      return 1;
    }
    if (args.json) {
      console.log(JSON.stringify(view, null, 2));
      return 0;
    }
    const lines: string[] = [];
    for (const s of view.scopes) {
      const pin = s.ref ? `@${s.ref}` : "";
      const at = typeof s.address?.commit === "string" ? ` (${s.address.commit.slice(0, 12)})` : "";
      lines.push(`${s.scope}  ${s.kind}${s.name ? ` ${s.name}` : ""}  ${s.template}${pin}${at}`);
      lines.push(`  ${s.files} file(s), ${s.edited.length} edited, ${s.missing.length} deleted`);
      for (const m of s.manualSteps) lines.push(`  manual step: ${s.scope === "." ? "" : `${s.scope}/`}${m.path} (${m.reason})`);
    }
    const open = view.scopes.reduce((n, s) => n + s.manualSteps.length, 0);
    lines.push(`${view.scopes.length} scope(s), ${open} manual step(s) open`);
    console.log(lines.join("\n"));
    return 0;
  } catch (err) {
    if (!(err instanceof LockError)) throw err;
    console.error(formatError({ message: err.message }));
    return 1;
  }
}

function resolve(root: string, path: string | undefined): number {
  if (!path) {
    console.error(formatError({ message: "resolve needs the path of a file with an open manual step", hint: USAGE }));
    return 1;
  }
  const lock = readLock(root);
  if (!lock) {
    console.error(formatError({ message: `no ${LOCK_FILE} in ${root}` }));
    return 1;
  }
  const closed = resolveManualStep(lock, path);
  if (!closed) {
    console.error(formatError({ message: `no open manual step for ${path}`, hint: "chant workspace lineage lists them" }));
    return 1;
  }
  writeLock(root, lock);
  console.error(
    formatSuccess(
      closed.step.upstream === null
        ? `${path}: the source removed this file; it is now the project's own`
        : `${path}: resolved; the file as it stands is kept, and the source's version is its new merge base`,
    ),
  );
  return 0;
}

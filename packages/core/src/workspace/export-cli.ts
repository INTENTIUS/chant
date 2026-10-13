/**
 * `chant workspace export [<member>...] [--to <member>] [--param name=value] [--dry-run] [--json]`,
 * `chant workspace import [<dir>] [--remove] [--dry-run] [--json]` and
 * `chant workspace admit <return id> [--note <text>] [--dry-run] [--json]` (#2552).
 *
 * See ./export.ts, ./import.ts and ./returns.ts.
 */

import { join } from "node:path";
import { formatError, formatInfo, formatSuccess, formatWarning } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { findWorkspaceRoot } from "../project-root";
import { WorkspaceReadError } from "./declaration";
import { LockError } from "./lineage-lock";
import { parseParamArgs } from "./template-manifest";

const EXPORT_USAGE = "chant workspace export [<member>[,<member>...]] [--to <export member>] [--param name=value] [--dry-run] [--json]";
const IMPORT_USAGE = "chant workspace import [<dir>] [--remove] [--dry-run] [--json]";
const ADMIT_USAGE = "chant workspace admit <return id> [--note <text>] [--dry-run] [--json]";

function workspaceRoot(usage: string): string | undefined {
  const found = findWorkspaceRoot(process.cwd());
  if (!found) {
    console.error(formatError({ message: "no chant.workspace.json here or above", hint: usage }));
    return undefined;
  }
  return found.dir;
}

function fail(err: unknown, usage: string): number {
  if (err instanceof WorkspaceReadError) {
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: usage }));
    return 1;
  }
  if (err instanceof LockError) {
    console.error(formatError({ message: err.message, hint: usage }));
    return 1;
  }
  throw err;
}

export async function runWorkspaceExport(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const root = workspaceRoot(EXPORT_USAGE);
  if (!root) return 1;
  const members = [args.extraPositional, args.extraPositional2]
    .filter((x): x is string => x !== undefined)
    .flatMap((x) => x.split(","))
    .map((x) => x.trim())
    .filter(Boolean);
  try {
    const { exportWorkspace } = await import("./export");
    const r = await exportWorkspace({
      root,
      members,
      to: args.migrateTo,
      params: args.param?.length ? parseParamArgs(args.param) : undefined,
      dryRun: args.dryRun,
    });
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    const m = r.manifest;
    console.log(`${m.id}  ${m.whole ? "workspace" : "members"} ${m.members.join(", ")} -> ${r.member} (${r.dir})`);
    console.log(`  ${Object.keys(m.files).length} file(s), ${Object.keys(m.locks).length} lock(s)${m.dirs.length ? `, record directories ${m.dirs.join(", ")}` : ""}`);
    if (r.switched.length > 0) console.log(`  host values switched in: ${r.switched.join(", ")}`);
    const d = m.dropped;
    const left = [
      ...d.links.map((l) => `link ${l.member} -> ${l.to}`),
      ...d.agents.map((a) => `agent ${a}`),
      ...d.pins.map((p) => `pin ${p}`),
      ...d.records.map((k) => `record kind ${k}`),
      ...d.diagrams.map((x) => `diagram ${x}`),
    ];
    if (left.length > 0) console.log(`  left out of the export's declaration: ${left.join("; ")}`);
    if (m.from.dirty) console.error(formatWarning({ message: "exported paths have uncommitted changes; the export records HEAD, which does not hold them" }));
    if (r.written) console.error(formatSuccess(`wrote the export into ${r.dir}. It is a workspace of its own; copy it where it goes, and bring it back with chant workspace import.`));
    else console.error(formatInfo("--dry-run: nothing written"));
    return 0;
  } catch (err) {
    return fail(err, EXPORT_USAGE);
  }
}

export async function runWorkspaceImport(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional2) {
    console.error(formatError({ message: `unexpected argument: ${args.extraPositional2}`, hint: IMPORT_USAGE }));
    return 1;
  }
  const root = workspaceRoot(IMPORT_USAGE);
  if (!root) return 1;
  try {
    const { importWorkspace } = await import("./import");
    const r = await importWorkspace({ root, from: args.extraPositional ? join(process.cwd(), args.extraPositional) : undefined, remove: args.remove, dryRun: args.dryRun });
    const refused = r.outside.length > 0 || r.conflicts.length > 0;
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
      return refused ? 1 : 0;
    }
    console.log(`${r.export} from ${r.from}`);
    for (const p of r.written) console.log(`  write   ${p}${r.hostValues.includes(p) ? " (host values back)" : ""}`);
    for (const p of r.removed) console.log(`  remove  ${p}`);
    for (const p of r.locks) console.log(`  lock    ${p}`);
    for (const c of r.conflicts) console.log(`  conflict ${c.path}: ${c.reason}`);
    for (const p of r.outside) console.log(`  outside ${p}`);
    if (r.outside.length > 0) {
      console.error(formatError({ message: `the copy holds ${r.outside.length} file(s) outside the members that went with the export; import never writes into another member, so nothing was written` }));
      return 1;
    }
    if (r.conflicts.length > 0) {
      console.error(formatError({ message: `${r.conflicts.length} conflict(s): nothing was written. Resolve them in the copy or here, then import again` }));
      return 1;
    }
    if (r.return) {
      const proved = Object.values(r.return.paths).filter((p) => p.origin).length;
      console.log(`  return  ${r.return.id}: ${proved} file(s) carry the commit they were made in${r.return.signers.length ? `, signed by ${r.return.signers.map((s) => `${s.principal} (${s.fingerprint || "key"})`).join(", ")}` : ""}`);
    }
    if (!r.applied) {
      console.error(formatInfo("--dry-run: nothing written"));
      return 0;
    }
    if (!r.return) console.error(formatInfo("the copy holds no change since the export"));
    if (r.member) console.log(`  member  ${r.member.name} ${r.member.action}${r.member.note ? `: ${r.member.note}` : ""}`);
    if (r.returnRecord) {
      console.error(
        formatSuccess(
          `imported, and recorded the return in ${r.returnRecord}. Review and commit it. Work signed by keys the policy at base does not list reads as attested-unverifiable-here until an admin runs chant workspace admit ${r.return!.id} and merges that change.`,
        ),
      );
    }
    return 0;
  } catch (err) {
    return fail(err, IMPORT_USAGE);
  }
}

export async function runWorkspaceAdmit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const id = args.extraPositional;
  if (!id || args.extraPositional2) {
    console.error(formatError({ message: "admit takes one return id, such as ret-0123456789ab", hint: ADMIT_USAGE }));
    return 1;
  }
  const root = workspaceRoot(ADMIT_USAGE);
  if (!root) return 1;
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { RETURNS_DIR, admitReturn, parseReturn } = await import("./returns");
    const { gitTopOf } = await import("./export");
    const file = join(root, RETURNS_DIR, `${id}.json`);
    if (!/^ret-[0-9a-f]{12}$/.test(id) || !existsSync(file)) throw new LockError(`no return ${id} in ${RETURNS_DIR}`);
    const ret = parseReturn(readFileSync(file, "utf-8"), file);
    const repo = gitTopOf(root);
    if (!repo) throw new LockError("admit writes .chant/trust.json at the repository root, and this workspace is not in a git repository");
    const r = admitReturn(repo, ret, { note: args.note, dryRun: args.dryRun });
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    if (r.added.length === 0) {
      console.error(formatInfo(`every signer of ${id} is already admitted in ${r.path}`));
      return 0;
    }
    for (const s of r.added) console.log(`  admit ${s.principal}  ${s.key.slice(0, 40)}...`);
    if (!r.written) {
      console.error(formatInfo("--dry-run: nothing written"));
      return 0;
    }
    console.error(
      formatSuccess(
        `added ${r.added.length} signer(s) for ${id} to ${r.path}. Check each principal, then commit it signed: the file is policy, so the admission counts once an admin's signed commit is merged to the base branch.`,
      ),
    );
    return 0;
  } catch (err) {
    return fail(err, ADMIT_USAGE);
  }
}

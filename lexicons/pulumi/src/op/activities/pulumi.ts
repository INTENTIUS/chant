/**
 * The pulumi lexicon's Op activities (#4494): the member's preview and its
 * drift, as steps an Op can run.
 *
 * Both call what `chant workspace plan` and `chant workspace drift` already
 * call (`../../run.ts`), so they run nothing the #4476 command list does not
 * already allow: `pulumi preview --json` (or `plunge preview --json`) and
 * `pulumi refresh --preview-only --json --target <urn>` (or `plunge drift
 * --resource <urn> --stream`). Neither changes the stack. There is no apply
 * activity, because chant never runs `pulumi up`.
 *
 * `dir` is the member's directory, where `Pulumi.yaml` is, resolved against
 * `cwd` (default: the process's working directory, the project root on a
 * `chant run`).
 */
import { isAbsolute, resolve } from "node:path";
import type { ChangeSetAction } from "@intentius/chant/change-set";
import type { DriftStatus } from "@intentius/chant/drift-record";
import { previewPulumiMemberRead, refreshPulumiMember, type PulumiMemberEngine } from "../../run";

/** The fields every activity here takes. */
export interface PulumiMemberArgs {
  /** The member's name, as the change set and the drift records name it. */
  member: string;
  /** The member's directory, where `Pulumi.yaml` is. Relative paths resolve against `cwd`. */
  dir: string;
  /** Where a relative `dir` resolves from. Default: the process's working directory. */
  cwd?: string;
  /** The stack to read. Default: the stack the member's directory has selected. */
  stack?: string;
  /** `pulumi` or `plunge`. Default: what `Pulumi.yaml`'s backend URL says (`pulumiMemberEngine`). */
  engine?: PulumiMemberEngine;
}

export type PulumiPreviewArgs = PulumiMemberArgs;

export interface PulumiPreviewResult {
  member: string;
  /** The binary that ran. */
  engine: PulumiMemberEngine;
  status: "planned" | "failed";
  error?: string;
  /** What a gate on this member's preview binds. `null` when the preview failed. */
  planDigest: string | null;
  /** True when the preview plans any create, update, replace, delete or forget. */
  changed: boolean;
  creates: number;
  updates: number;
  replaces: number;
  deletes: number;
  /** Entries for resources the preview could not list (registered inside an `apply()`), which may appear on apply. */
  mayAppear: number;
}

export interface PulumiDriftArgs extends PulumiMemberArgs {
  /** The URNs to read. Default: the checked-in `stack-export.json`'s resources. */
  urns?: string[];
}

export interface PulumiDriftResult {
  member: string;
  /** One count per status the records hold. */
  counts: Partial<Record<DriftStatus, number>>;
  /** Records that are `drifted` or `missing`: what changed outside the program. */
  drifted: number;
  /** Records the read could not answer for (`not-observed`). */
  notObserved: number;
  records: number;
}

const CHANGING: ReadonlySet<ChangeSetAction> = new Set(["create", "update", "replace", "delete", "forget"]);

function memberDir(args: PulumiMemberArgs): string {
  return isAbsolute(args.dir) ? args.dir : resolve(args.cwd ?? process.cwd(), args.dir);
}

/**
 * `pulumi preview --json` in the member's directory, as counts an Op can
 * publish. A preview that fails is `status: "failed"` with the error, and the
 * step fails with it, so a run never reports "no changes" off a preview that
 * did not run.
 */
export async function pulumiPreview(args: Record<string, unknown>): Promise<PulumiPreviewResult> {
  const a = args as unknown as PulumiPreviewArgs;
  const read = await previewPulumiMemberRead({
    member: a.member,
    dir: memberDir(a),
    ...(a.stack ? { stack: a.stack } : {}),
    ...(a.engine ? { engine: a.engine } : {}),
  });
  const { member, entries } = read.part;
  if (member.status === "failed") {
    throw new Error(`${read.engine} preview for member ${a.member} failed: ${member.error ?? "no error printed"}`);
  }
  const count = (action: ChangeSetAction) => entries.filter((e) => e.action === action && !e.mayAppear).length;
  return {
    member: a.member,
    engine: read.engine,
    status: member.status,
    planDigest: member.planDigest,
    changed: entries.some((e) => CHANGING.has(e.action) || e.mayAppear === true),
    creates: count("create"),
    updates: count("update"),
    replaces: count("replace"),
    deletes: count("delete"),
    mayAppear: entries.filter((e) => e.mayAppear === true).length,
  };
}

/**
 * The member's drift records, one targeted `pulumi refresh --preview-only`
 * per resource (or `plunge drift --resource <urn> --stream` on plunge),
 * summarised as counts. A resource the read could not reach is counted as
 * not-observed and the others still read.
 */
export async function pulumiDrift(args: Record<string, unknown>): Promise<PulumiDriftResult> {
  const a = args as unknown as PulumiDriftArgs;
  const records = await refreshPulumiMember({
    member: a.member,
    dir: memberDir(a),
    observedAt: new Date().toISOString(),
    ...(a.stack ? { stack: a.stack } : {}),
    ...(a.engine ? { engine: a.engine } : {}),
    ...(a.urns ? { urns: a.urns } : {}),
  });
  const counts: Partial<Record<DriftStatus, number>> = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    member: a.member,
    counts,
    drifted: (counts.drifted ?? 0) + (counts.missing ?? 0),
    notObserved: counts["not-observed"] ?? 0,
    records: records.length,
  };
}

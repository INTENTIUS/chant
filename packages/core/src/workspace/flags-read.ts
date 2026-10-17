/**
 * Reading a workspace's feature flags (#4024): every flag of the declared
 * flag kinds, and the flags of one member by parameter. Kept apart from
 * `./flags.ts`, which `records.ts` loads, since reading goes through
 * `records-cli.ts`.
 */

import { join, relative, resolve, sep } from "node:path";
import { loadRecordKind } from "./records";
import type { FlagValue, WorkspaceFlags } from "./flags";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A flag value as the record writes it, or undefined for one a build-time parameter can't hold. */
function flagValue(v: unknown): FlagValue | undefined {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
}

/**
 * Every flag of every flag kind the declaration at `root` names, read in the
 * working tree. A kind without a flag block is skipped without reading its
 * records. Throws a `RecordReadError` when a flag kind or its records can't
 * be read, and a `WorkspaceReadError` when the declaration can't.
 */
export async function readWorkspaceFlags(root: string): Promise<WorkspaceFlags> {
  const { readDeclaration, declaredRecordKinds } = await import("./declaration");
  const { workingTree } = await import("./tree");
  const declaration = readDeclaration(workingTree(root));
  const out: WorkspaceFlags = { flags: [], invalid: [] };
  const declared = declaredRecordKinds(declaration);
  if (declared.length === 0) return out;
  const { readRecordsFor } = await import("./records-cli");
  for (const d of declared) {
    const file = join(root, ...d.path.split("/"));
    const loaded = await loadRecordKind(file, root);
    const flag = loaded.kind.flag;
    if (!flag) continue;
    const { result, root: repo } = await readRecordsFor({ kind: file, cwd: root, current: true });
    for (const r of result.records) {
      const path = relative(root, join(repo, ...r.path.split("/"))).split(sep).join("/");
      const member = r.data ? str(r.data[flag.member]) : null;
      if (!r.valid || r.id === null || r.data === null) {
        out.invalid.push({ kind: d.path, path, member, message: r.reasons.map((x) => `${x.code}: ${x.message}`).join("; ") || "the record can't be read" });
        continue;
      }
      const values: Record<string, FlagValue> = {};
      const raw = r.data[flag.values];
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [env, v] of Object.entries(raw as Record<string, unknown>)) {
          const value = flagValue(v);
          if (value !== undefined) values[env] = value;
        }
      }
      out.flags.push({
        id: r.id,
        kind: d.path,
        path,
        member: member ?? "",
        param: str(r.data[flag.param]) ?? "",
        owner: str(r.data[flag.owner]) ?? "",
        values,
        work: r.flag?.work ?? null,
        implements: r.flag?.implements ?? [],
        stale: r.flag?.stale ?? false,
      });
    }
  }
  return out;
}

/** One flag-backed parameter, as a build in one environment reads it. */
export interface FlagBinding {
  /** The flag's name. */
  flag: string;
  /** The flag's value in the environment, or undefined when the record gives it none. */
  value: FlagValue | undefined;
}

/** The flags that back the parameters of the member holding a directory. */
export interface MemberFlagBindings {
  /** The member's name in the declaration. */
  member: string;
  /** Each flag-backed parameter by name. */
  byParam: Record<string, FlagBinding>;
  /** Why a flag of this member can't be trusted: an invalid record that names it, or two flags for one parameter. */
  errors: string[];
}

/**
 * The flags that back parameters of the member holding `projectDir`, in the
 * workspace whose declaration is in `root`, with each flag's value for `env`.
 * Null when no member holds the directory, since only a member has flags.
 */
export async function memberFlagBindings(root: string, projectDir: string, env: string): Promise<MemberFlagBindings | null> {
  const { readDeclaration, resolveGroups, ownerOf } = await import("./declaration");
  const { workingTree } = await import("./tree");
  const tree = workingTree(root);
  const declaration = readDeclaration(tree);
  const rel = relative(root, resolve(projectDir)).split(sep).join("/");
  const owner = ownerOf(declaration, resolveGroups(declaration, tree), rel === "" ? "" : rel);
  if (!owner || !("member" in owner)) return null;
  const member = owner.member.name;
  const read = await readWorkspaceFlags(root);
  const errors: string[] = [];
  for (const bad of read.invalid) {
    if (bad.member === member || bad.member === null) errors.push(`flag record ${bad.path} is not valid, so no build reads it: ${bad.message}`);
  }
  const byParam: Record<string, FlagBinding> = {};
  const seen = new Map<string, string>();
  for (const f of read.flags) {
    if (f.member !== member) continue;
    const other = seen.get(f.param);
    if (other !== undefined) {
      errors.push(`flags ${other} and ${f.id} both set build parameter "${f.param}" of member ${member}; one flag backs one parameter`);
      continue;
    }
    seen.set(f.param, f.id);
    byParam[f.param] = { flag: f.id, value: f.values[env] };
  }
  return { member, byParam, errors };
}

/**
 * `chant workspace ls [dir] [--at <rev>] [--json]` (#2534): list a workspace's
 * members and example groups from its declaration.
 *
 * A member that can't be read is still listed, with a reason code, and the
 * command still exits 0 (#2524 D15, ws-020). Failing on it is the job of
 * `chant workspace check`. Only a declaration that can't be read exits 1.
 *
 * The `--json` output is part of the read contract, versioned like
 * `workspace records` and described by `ls.schema.json` beside this file.
 *
 * The record kinds the declaration names are listed too, the workspace's own
 * and each member's, with each kind file's own name when it loads (#2680).
 * Loading one imports it, so {@link listWorkspace} lists them unloaded and
 * {@link listWorkspaceWithKinds}, which the command runs, loads them.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import {
  readDeclaration,
  readerVersion,
  resolveGroups,
  WorkspaceReadError,
  type Declaration,
  type ErrorLocation,
  type Member,
  type WorkspaceErrorCode,
} from "./declaration";
import type { ReasonCode } from "./reason-codes";
import { loadKindRegistry, probeKind, type KindRegistry } from "./kinds";
import type { WorkspaceTree } from "./tree";
import { handToRootChant, locateWorkspace } from "./which-chant";
import type { DeclaredKindReasonCode } from "./declared-kinds";

/** The version of the `ls` output this chant writes. */
export const LS_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the `--json` output, shipped beside this file. */
export const LS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ls/v1/ls.schema.json";

const USAGE = "chant workspace ls [dir] [--at <rev>] [--json]";

/**
 * Why one member can't be read. Closed, like the error codes: a new code is a
 * contract change.
 */
export const MEMBER_REASON_CODES = [
  /** The member's directory does not exist. */
  "dir-missing",
  /** No built-in kind or pinned package supplies the member's kind. */
  "unknown-kind",
  /** The directory is not what its kind reads, such as a `chant` member with no chant config. */
  "kind-probe-failed",
] as const satisfies readonly ReasonCode[];
export type MemberReasonCode = (typeof MEMBER_REASON_CODES)[number];

/** Why a group lists nothing. */
export const GROUP_REASON_CODES = [
  /** No directory the globs match holds a chant project. */
  "no-matches",
] as const satisfies readonly ReasonCode[];
export type GroupReasonCode = (typeof GROUP_REASON_CODES)[number];

/** A record kind the declaration names (#2680). */
export interface LsRecordKind {
  /** The name the declaration gives it, else the kind file's own, else null when the file wasn't loaded. */
  name: string | null;
  /** The kind file from the workspace root. */
  path: string;
  /** The kind file's `recordKind.name`, or null when it wasn't loaded. */
  kind: string | null;
  /** Why the kind file can't be loaded, or null. */
  reason: { code: DeclaredKindReasonCode; message: string } | null;
}

export interface LsMember {
  name: string;
  dir: string;
  kind: string;
  roles: { name: string; path: string | null }[];
  upstream: string | null;
  because: string | null;
  readable: boolean;
  reason: { code: MemberReasonCode; message: string } | null;
  /** The record kinds the member declares, in file order (#2680). */
  records: LsRecordKind[];
}

export interface LsGroup {
  name: string;
  kind: "examples";
  glob: string[];
  matches: string[];
  skipped: string[];
  reason: { code: GroupReasonCode; message: string } | null;
}

export type LsDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      at: string | null;
      workspace: {
        name: string;
        /** The workspace root relative to the git root, `"."` for the git root itself. Absolute outside git. */
        root: string;
        file: string;
        schema: number;
        minReader: string | null;
        pins: Declaration["pins"];
        /** The workspace's own record kinds, from the top-level `records` (#2680). */
        records: LsRecordKind[];
      };
      members: LsMember[];
      groups: LsGroup[];
      summary: { members: number; unreadable: number; groups: number; matches: number };
    }
  | {
      $schema: string;
      contract: number;
      chant: string;
      error: { code: WorkspaceErrorCode; message: string; location: ErrorLocation | null };
    };

export interface LsQuery {
  /** Where the walk up to the declaration starts. */
  cwd: string;
  at?: string;
  kinds?: KindRegistry;
}

/** A member's reason code, or null when its kind can read it. */
export function memberReason(member: Member, tree: WorkspaceTree, kinds: KindRegistry): LsMember["reason"] {
  if (tree.stat(member.dir === "." ? "" : member.dir) !== "dir") {
    return { code: "dir-missing", message: `${member.dir} is not a directory${tree.label}` };
  }
  const kind = kinds.get(member.kind);
  if (!kind) {
    return { code: "unknown-kind", message: `no built-in kind or pinned package supplies kind ${member.kind}; known kinds: ${kinds.names().join(", ")}` };
  }
  if (!probeKind(kind, tree, member.dir === "." ? "" : member.dir)) {
    return { code: "kind-probe-failed", message: `${member.dir} is not ${kind.description}` };
  }
  return null;
}

/**
 * Find the workspace, read it and build the document `--json` prints, with
 * the declared record kinds unloaded: `kind` null and no reason. Never throws
 * a {@link WorkspaceReadError}.
 */
export function listWorkspace(query: LsQuery): LsDocument {
  return readListing(query).doc;
}

/** {@link listWorkspace}, with each declared record kind loaded for its name, or the reason it can't be (#2680). */
export async function listWorkspaceWithKinds(query: LsQuery): Promise<LsDocument> {
  const { doc, declaration, tree, rootOnDisk } = readListing(query);
  if (!declaration || "error" in doc) return doc;
  const { loadDeclaredKinds } = await import("./declared-kinds");
  const loaded = await loadDeclaredKinds(declaration, tree!, rootOnDisk!);
  const byPath = new Map(loaded.map((k) => [k.declared.path, k]));
  const fill = (r: LsRecordKind): LsRecordKind => {
    const k = byPath.get(r.path)!;
    return { ...r, name: r.name ?? k.kind, kind: k.kind, reason: k.reason };
  };
  return {
    ...doc,
    workspace: { ...doc.workspace, records: doc.workspace.records.map(fill) },
    members: doc.members.map((m) => ({ ...m, records: m.records.map(fill) })),
  };
}

const unloaded = (records: Declaration["records"]): LsRecordKind[] => records.map((r) => ({ name: r.name, path: r.path, kind: null, reason: null }));

function readListing(query: LsQuery): { doc: LsDocument; declaration?: Declaration; tree?: WorkspaceTree; rootOnDisk?: string } {
  const chant = readerVersion();
  const head = { $schema: LS_OUTPUT_SCHEMA_ID, contract: LS_CONTRACT_VERSION, chant };
  try {
    const located = locateWorkspace(query.cwd, query.at);
    const { tree, rootOnDisk, at } = located;
    const declaration = readDeclaration(tree, "", { rootChant: true });
    // Kinds come from the pinned packages installed in the working tree, also
    // for --at: they are read as data, never run (#2535).
    const kinds = query.kinds ?? loadKindRegistry(declaration.pins, rootOnDisk).registry;
    const groups = resolveGroups(declaration, tree);
    const members: LsMember[] = declaration.members.map((m) => {
      const reason = memberReason(m, tree, kinds);
      return {
        name: m.name,
        dir: m.dir,
        kind: m.kind,
        roles: m.roles,
        upstream: m.upstream,
        because: m.because,
        readable: reason === null,
        reason,
        records: unloaded(m.records),
      };
    });
    const lsGroups: LsGroup[] = groups.map((g) => ({
      name: g.group.name,
      kind: "examples",
      glob: g.group.globs,
      matches: g.matches,
      skipped: g.skipped,
      reason:
        g.matches.length === 0
          ? { code: "no-matches", message: `no directory ${g.group.globs.join(" or ")} matches${tree.label} holds a chant project` }
          : null,
    }));
    const doc: LsDocument = {
      ...head,
      at,
      workspace: {
        name: declaration.name,
        root: located.root,
        file: declaration.file,
        schema: declaration.schema,
        minReader: declaration.minReader,
        pins: declaration.pins,
        records: unloaded(declaration.records),
      },
      members,
      groups: lsGroups,
      summary: {
        members: members.length,
        unreadable: members.filter((m) => !m.readable).length,
        groups: lsGroups.length,
        matches: lsGroups.reduce((n, g) => n + g.matches.length, 0),
      },
    };
    return { doc, declaration, tree, rootOnDisk };
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    return { doc: { ...head, error: { code: err.code, message: err.message, location: err.location ?? null } } };
  }
}

export async function runWorkspaceLs(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(args.extraPositional ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021).
  const handed = await handToRootChant(cwd, args.at);
  if (handed !== undefined) return handed;
  const doc = await listWorkspaceWithKinds({ cwd, at: args.at });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else if ("error" in doc) {
    const l = doc.error.location;
    const where = l ? `${l.file}:${l.line}:${l.column}: ` : "";
    console.error(formatError({ message: `${doc.error.code}: ${where}${doc.error.message}`, hint: USAGE }));
  } else {
    console.log(formatLs(doc));
  }
  return "error" in doc ? 1 : 0;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]))).join("  ").trimEnd());
}

function formatLs(doc: Extract<LsDocument, { members: unknown }>): string {
  const lines: string[] = [];
  const w = doc.workspace;
  lines.push(`${w.name}  (${w.root === "." ? w.file : `${w.root}/${w.file}`}${doc.at ? ` at ${doc.at.slice(0, 8)}` : ""})`);
  if (doc.members.length > 0) {
    lines.push("");
    const rows = [["MEMBER", "KIND", "DIR", "ROLES"]];
    for (const m of doc.members) {
      rows.push([m.name, m.kind, m.dir, m.roles.map((r) => (r.path ? `${r.name}:${r.path}` : r.name)).join(",")]);
    }
    const rendered = table(rows);
    lines.push(rendered[0]);
    doc.members.forEach((m, i) => {
      lines.push(rendered[i + 1]);
      if (m.reason) lines.push(`  ${m.reason.code}: ${m.reason.message}`);
    });
  }
  const kinds = [...w.records.map((r) => ({ owner: "(workspace)", r })), ...doc.members.flatMap((m) => m.records.map((r) => ({ owner: m.name, r })))];
  if (kinds.length > 0) {
    lines.push("");
    const rows = [["RECORDS", "KIND", "MEMBER", "FILE"]];
    for (const { owner, r } of kinds) rows.push([r.name ?? "-", r.kind ?? "-", owner, r.path]);
    const rendered = table(rows);
    lines.push(rendered[0]);
    kinds.forEach(({ r }, i) => {
      lines.push(rendered[i + 1]);
      if (r.reason) lines.push(`  ${r.reason.code}: ${r.reason.message}`);
    });
  }
  if (doc.groups.length > 0) {
    lines.push("");
    const rows = [["GROUP", "KIND", "GLOB", "PROJECTS"]];
    for (const g of doc.groups) rows.push([g.name, g.kind, g.glob.join(" "), String(g.matches.length)]);
    const rendered = table(rows);
    lines.push(rendered[0]);
    doc.groups.forEach((g, i) => {
      lines.push(rendered[i + 1]);
      if (g.reason) lines.push(`  ${g.reason.code}: ${g.reason.message}`);
    });
  }
  const s = doc.summary;
  lines.push("");
  lines.push(
    `${s.members} member${s.members === 1 ? "" : "s"}, ${s.unreadable} unreadable; ` +
      `${s.groups} example group${s.groups === 1 ? "" : "s"} with ${s.matches} project${s.matches === 1 ? "" : "s"}`,
  );
  return lines.join("\n");
}

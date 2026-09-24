/**
 * `chant workspace records --kind <path> [--current] [--at <rev>] [--base <rev>]
 * [--require attested] [--json]`, the first-test slice of the records query
 * (#2546, #2536), with each record's provenance level (#2547).
 *
 * It reads every record the kind file locates and prints them, with reason
 * codes for any that are invalid. An invalid record never fails the command:
 * the exit code is 0 whenever the read itself worked. Only a kind, schema or
 * revision that cannot be read exits 1.
 *
 * It needs no `chant.workspace.json`. The kind is passed explicitly, or,
 * without `--kind`, it is every record kind the declaration names (#2680), so
 * nothing is inferred (#2525 rule 1). Several kinds print one document per
 * kind, in the declaration's order, inside one set.
 *
 * With `--since <rev>` it prints what changed between two revisions instead,
 * through `records-since.ts` (#2673).
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { findWorkspaceRoot } from "../project-root";
import { fileDigest, isWorkspacePath } from "./record-assets";
import { gitRevisionSource, gitRoot, resolveRevision, workingTreeSource } from "./record-source";
import { declaredRecordKinds, readDeclaration, WorkspaceReadError, type RecordKindDeclaration } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { locateWorkspace } from "./which-chant";
import {
  computeQuorum,
  DEFAULT_QUORUM,
  loadRecordKind,
  normalisePrincipal,
  readRecords,
  RecordReadError,
  type LoadedRecordKind,
  type Quorum,
  type ReadErrorCode,
  type ReadRecordsResult,
  type RecordEntry,
  type RecordFormat,
  type RecordHistory,
} from "./records";
import { gitTree, workingTree, type WorkspaceTree } from "./tree";
import type { DecisionWork } from "./work";
import { activeAttestors, type ProvenanceLevel } from "./trust/attestor";
import { policyAtBase, recordProvenance, resolveBase, type BaseSource, type RecordProvenance } from "./trust/provenance";

/** The version of the `records` output this chant writes. */
export const RECORDS_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the `--json` output, shipped beside this file. */
export const RECORDS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/records/v1/records.schema.json";

const USAGE =
  "chant workspace records [--kind <kind file>] [--current] [--at <rev>] [--base <rev>] [--require attested] [--json] | chant workspace records [--kind <kind file>] --since <rev> [--at <rev>] [--json] | chant workspace records pin <path> | chant workspace records new|amend|review (#2670)";

/** Exit code when the read worked and a record falls below `--require`. */
export const EXIT_BELOW_REQUIRED = 2;

export interface RecordsQuery {
  kind: string;
  current?: boolean;
  at?: string;
  /** The revision the trust policy is read at (#2547). Defaults to the target branch tip. */
  base?: string;
  /** Where `kind` is resolved from and the repository is found. */
  cwd: string;
}

/**
 * A record as the output carries it: the entry plus its provenance (#2547),
 * and its quorum when the kind has a reviews list (#2671).
 */
export type RecordView = RecordEntry & { provenance: RecordProvenance; quorum?: Quorum | null };

/** The role in the trust policy whose holders' verdicts the quorum does not count (#2671). */
export const AGENT_ROLE = "agent";

/** Where provenance was judged from (#2547). */
export interface TrustView {
  /** The full commit id the policy was read at, or null when there is no base. */
  base: string | null;
  baseFrom: BaseSource | null;
  /** Whether a signers file exists at base. False means every record is `unattested`. */
  active: boolean;
  signersPath: string;
  problems: string[];
}

/** The `records` output: a result, or a failure with one error code. */
export type RecordsDocument =
  | {
      $schema: string;
      contract: number;
      kind: { name: string; schema: string; file: string; format: RecordFormat };
      at: string | null;
      /** The directory pinned paths resolve in, from the repository root: the workspace holding the kind file, or the repository root (#2549). */
      workspaceRoot: string;
      current: boolean;
      trust: TrustView;
      records: RecordView[];
      summary: { total: number; valid: number; invalid: number; superseded: number };
      /** For a work kind (#2683): each decision its decision kind reads, with the work records implementing it. */
      decisions?: DecisionWork[];
    }
  | { $schema: string; contract: number; error: { code: ReadErrorCode; message: string } };

/** Where a document in a {@link RecordsSetDocument} comes from: the declaration's entry for its kind (#2680). */
export interface DeclaredKindView {
  /** The member that declares the kind, or null for the workspace's own. */
  member: string | null;
  /** The kind file from the workspace root. */
  path: string;
  /** The name the declaration gives the kind, or null. */
  name: string | null;
}

/**
 * The `records` output without `--kind` when the declaration names record
 * kinds (#2680): one {@link RecordsDocument} per kind, in the declaration's
 * order, each with the entry that declares it.
 */
export interface RecordsSetDocument {
  $schema: string;
  contract: number;
  kinds: (RecordsDocument & { declared: DeclaredKindView })[];
}

/**
 * The record kinds the declaration nearest above `cwd` names, in the tree
 * `at` reads, with each kind file on disk. Empty when there is no declaration.
 * Throws a {@link WorkspaceReadError} for one that can't be read.
 */
export function declaredKindFiles(cwd: string, at?: string): { declared: RecordKindDeclaration; file: string }[] {
  let located;
  try {
    located = locateWorkspace(cwd, at);
  } catch (err) {
    if (err instanceof WorkspaceReadError && err.code === "declaration-missing") return [];
    throw err;
  }
  return declaredRecordKinds(readDeclaration(located.tree)).map((declared) => ({ declared, file: declaredKindFile(declared, located.rootOnDisk) }));
}

/** Read every declared kind in `kinds`, as {@link queryRecords} reads one. */
export async function queryDeclaredRecords(kinds: { declared: RecordKindDeclaration; file: string }[], query: Omit<RecordsQuery, "kind">): Promise<RecordsSetDocument> {
  const out: RecordsSetDocument["kinds"] = [];
  for (const k of kinds) {
    const doc = await queryRecords({ ...query, kind: k.file });
    out.push({ ...doc, declared: { member: k.declared.member, path: k.declared.path, name: k.declared.name } });
  }
  return { $schema: RECORDS_OUTPUT_SCHEMA_ID, contract: RECORDS_CONTRACT_VERSION, kinds: out };
}

/** A records read, before provenance. */
export interface RecordsRead {
  loaded: LoadedRecordKind;
  /** The repository root, or the working directory outside git. Record paths are relative to it. */
  root: string;
  /** The git top, or undefined outside git. */
  top: string | undefined;
  at: string | null;
  /** Where pinned paths resolve, relative to `root` ("." for the root itself). */
  workspaceRoot: string;
  /** The workspace root's tree, as read: the working tree, or the revision under `--at`. */
  tree: WorkspaceTree;
  result: ReadRecordsResult;
}

/**
 * The quorum the workspace declares: the declaration at the workspace root
 * of the tree read, or the default when there is none, or when it can't be
 * read (#2671). Records need no declaration, so neither does this.
 */
function declaredQuorum(tree: WorkspaceTree): { need: number; needFrom: "declaration" | "default" } {
  try {
    const q = readDeclaration(tree).quorum;
    if (q !== null) return { need: q, needFrom: "declaration" };
  } catch {
    // No declaration, or one this read can't use: the default applies.
  }
  return { need: DEFAULT_QUORUM, needFrom: "default" };
}

/**
 * Where a kind's pinned paths resolve: the workspace whose declaration sits
 * nearest above the kind file, when it is inside the repository, or else the
 * repository root. Relative to `root`, with / separators.
 */
export function pinRoot(kindFile: string, root: string): string {
  const found = findWorkspaceRoot(dirname(kindFile));
  if (!found) return ".";
  const rel = relative(root, realpathOr(found.dir)).split(sep).join("/");
  return rel === "" || rel.startsWith("..") ? "." : rel;
}

/**
 * Commit times from the history of `rev` in the repository at `top`, asked
 * only for a pin that might be stale. `prefix` is the workspace root from the
 * repository root.
 */
function gitHistory(top: string, rev: string, prefix: string): RecordHistory {
  const times = (args: string[]): number[] => {
    try {
      const out = execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return out.split("\n").filter(Boolean).map(Number);
    } catch {
      // No commits yet, or a path git doesn't know.
      return [];
    }
  };
  return {
    fileChanged: (path) => times(["log", "-1", "--format=%ct", rev, "--", prefix === "." ? path : `${prefix}/${path}`])[0] ?? null,
    // The latest commit that added the file: a record deleted and written again counts from the second time.
    recorded: (path) => times(["log", "--diff-filter=A", "--format=%ct", rev, "--", path])[0] ?? null,
  };
}

/**
 * Load the kind and read its records, in the working tree or at `query.at`,
 * with each pin checked in the same tree. Throws a {@link RecordReadError}.
 * `chant workspace graph` and `check` read records through this too.
 */
export async function readRecordsFor(query: Omit<RecordsQuery, "base">): Promise<RecordsRead> {
  // git reports its top through symlinks resolved (/var is /private/var on
  // macOS), so the directory has to be too, or record paths leave the repository.
  const cwd = realpathOr(query.cwd);
  const top = gitRoot(cwd);
  const root = top ?? cwd;
  const loaded = await loadRecordKind(query.kind, cwd);
  const workspaceRoot = pinRoot(loaded.file, root);
  let at: string | null = null;
  let source = workingTreeSource(root);
  let assets = workingTree(workspaceRoot === "." ? root : join(root, ...workspaceRoot.split("/")));
  if (query.at !== undefined) {
    if (!top) throw new RecordReadError("not-a-git-repository", "--at reads git objects, and this directory is not in a git repository");
    at = resolveRevision(top, query.at);
    source = gitRevisionSource(top, at);
    assets = gitTree(top, at, workspaceRoot === "." ? "" : workspaceRoot);
  }
  const history = top ? gitHistory(top, at ?? "HEAD", workspaceRoot) : undefined;
  // A session kind's verdicts name records of another kind, read from the same tree (#2673).
  let subjects: { records: RecordEntry[]; reviews: string } | undefined;
  if (loaded.kind.session) {
    const subjectKind = await loadRecordKind(resolve(dirname(loaded.file), loaded.kind.session.subjects.kind), cwd);
    subjects = { records: (await readRecords(subjectKind, { root, source })).records, reviews: subjectKind.kind.reviews?.field ?? "reviews" };
  }
  const result = await readRecords(loaded, { root, source, current: !!query.current, assets, workspaceRoot, ...(history ? { history } : {}), ...(subjects ? { subjects } : {}) });
  return { loaded, root, top, at, workspaceRoot, tree: assets, result };
}

/** Run the query and build the document `--json` prints. Never throws a {@link RecordReadError}. */
export async function queryRecords(query: RecordsQuery): Promise<RecordsDocument> {
  try {
    const { loaded, root, top, at, workspaceRoot, tree, result } = await readRecordsFor(query);
    // Provenance, judged by the policy at base and never by the tree read (#2547).
    const base = top ? resolveBase(top, query.base) : { commit: null, from: null };
    const policy = top ? policyAtBase(top, base) : policyAtBase(root, base);
    const provenance = recordProvenance({
      repo: top,
      policy,
      at,
      paths: result.records.map((r) => r.path),
      attestors: policy.active ? await activeAttestors() : [],
    });
    // The quorum: the need from the declaration in the tree read, agents and
    // whether verdicts need a seal from the policy at base (#2671).
    const quorumOptions = loaded.kind.reviews
      ? {
          ...declaredQuorum(tree),
          agents: new Set((policy.roles[AGENT_ROLE] ?? []).map(normalisePrincipal)),
          attestation: policy.active,
        }
      : undefined;
    return {
      $schema: RECORDS_OUTPUT_SCHEMA_ID,
      contract: RECORDS_CONTRACT_VERSION,
      kind: {
        name: loaded.kind.name,
        schema: loaded.kind.schema.id,
        file: relative(root, loaded.file).split("\\").join("/"),
        format: loaded.kind.format,
      },
      at,
      workspaceRoot,
      current: !!query.current,
      trust: { base: base.commit, baseFrom: base.from, active: policy.active, signersPath: policy.signersPath, problems: policy.problems },
      records: result.records.map((r) => ({
        ...r,
        provenance: provenance.get(r.path)!,
        ...(quorumOptions ? { quorum: computeQuorum(loaded.kind, r, quorumOptions) } : {}),
      })),
      summary: result.summary,
      ...(result.decisions ? { decisions: result.decisions } : {}),
    };
  } catch (err) {
    if (!(err instanceof RecordReadError)) throw err;
    return { $schema: RECORDS_OUTPUT_SCHEMA_ID, contract: RECORDS_CONTRACT_VERSION, error: { code: err.code, message: err.message } };
  }
}

/**
 * `chant workspace records pin <path>`: the `{path, sha256}` a decision's
 * evidence entry holds for a file, with the path from the workspace root
 * (the nearest declaration above the file, or the repository root).
 */
export function pinFile(file: string, cwd: string): { path: string; sha256: string } | { error: string } {
  const abs = realpathOr(resolve(cwd, file));
  const top = gitRoot(dirname(abs));
  const ws = findWorkspaceRoot(dirname(abs));
  const base = ws ? realpathOr(ws.dir) : top ? realpathOr(top) : realpathOr(cwd);
  const path = relative(base, abs).split(sep).join("/");
  if (path.startsWith("..") || !isWorkspacePath(path)) return { error: `${file} is not a file path inside the workspace at ${base}` };
  const sha256 = fileDigest(workingTree(base), path);
  if (sha256 === undefined) return { error: `${file} is not a file` };
  return { path, sha256 };
}

export async function runWorkspaceRecords(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (args.extraPositional === "new" || args.extraPositional === "amend" || args.extraPositional === "review") {
    return (await import("./records-write")).runRecordsWrite(ctx);
  }
  if (args.extraPositional === "pin") {
    if (!args.extraPositional2) {
      console.error(formatError({ message: "pin needs the path of a file", hint: USAGE }));
      return 1;
    }
    const pin = pinFile(args.extraPositional2, process.cwd());
    if ("error" in pin) {
      console.error(formatError({ message: pin.error, hint: USAGE }));
      return 1;
    }
    console.log(JSON.stringify(pin, null, 2));
    return 0;
  }
  if (args.extraPositional) {
    console.error(formatError({ message: `chant workspace records takes no argument but pin, new, amend or review (got ${args.extraPositional})`, hint: USAGE }));
    return 1;
  }
  if (!args.kind) return runDeclaredRecords(args);
  if (args.require !== undefined && args.require !== "attested") {
    console.error(formatError({ message: `--require takes one level, attested, not ${JSON.stringify(args.require)}`, hint: USAGE }));
    return 1;
  }
  if (args.since !== undefined) {
    if (args.current || args.require !== undefined || args.base !== undefined) {
      console.error(formatError({ message: "--since compares two revisions and takes no --current, --require or --base", hint: USAGE }));
      return 1;
    }
    // Loaded here, so a plain records read never loads it (#2673).
    const { formatSince, queryRecordsSince } = await import("./records-since");
    const since = await queryRecordsSince({ kind: args.kind, since: args.since, at: args.at, cwd: process.cwd() });
    if (args.json) console.log(JSON.stringify(since, null, 2));
    else if ("error" in since) console.error(formatError({ message: `${since.error.code}: ${since.error.message}`, hint: USAGE }));
    else console.log(formatSince(since));
    return "error" in since ? 1 : 0;
  }
  const doc = await queryRecords({ kind: args.kind, current: args.current, at: args.at, base: args.base, cwd: process.cwd() });
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  } else {
    console.log(formatRecords(doc.records, doc.summary, doc.at));
  }
  if ("error" in doc) return 1;
  if (args.require) {
    const below = belowRequired(doc.records, args.require);
    if (below.length > 0) {
      console.error(
        formatError({
          message: `${below.length} of ${doc.records.length} records are not ${args.require}: ${below
            .slice(0, 5)
            .map((r) => `${r.path} (${r.provenance.level})`)
            .join(", ")}${below.length > 5 ? ", ..." : ""}`,
          hint: doc.trust.active ? "run with --json to see each record's reason" : `there is no signers file (${doc.trust.signersPath}) at base`,
        }),
      );
      return EXIT_BELOW_REQUIRED;
    }
  }
  return 0;
}

/**
 * `records` without `--kind` (#2680): every record kind the declaration
 * names, or, when it names none or there is no declaration, the error it has
 * always been. A kind whose read fails is listed with its error, the others
 * are still read, and the exit code is 1.
 */
async function runDeclaredRecords(args: CommandContext["args"]): Promise<number> {
  if (args.require !== undefined && args.require !== "attested") {
    console.error(formatError({ message: `--require takes one level, attested, not ${JSON.stringify(args.require)}`, hint: USAGE }));
    return 1;
  }
  let declared: { declared: RecordKindDeclaration; file: string }[];
  try {
    declared = declaredKindFiles(process.cwd(), args.at);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    console.error(formatError({ message: `${err.code}: ${err.describe()}; without --kind, the declaration names the record kinds`, hint: USAGE }));
    return 1;
  }
  if (declared.length === 0) {
    console.error(formatError({ message: "--kind <kind file> is required", hint: USAGE }));
    return 1;
  }
  if (args.since !== undefined) return runDeclaredSince(declared, args);
  const set = await queryDeclaredRecords(declared, { current: args.current, at: args.at, base: args.base, cwd: process.cwd() });
  if (args.json) console.log(JSON.stringify(set, null, 2));
  for (const doc of args.json ? [] : set.kinds) {
    if ("error" in doc) {
      console.error(formatError({ message: `${doc.declared.path}: ${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
      continue;
    }
    console.log(`${doc.declared.name ?? doc.kind.name} (${doc.declared.path})`);
    console.log(formatRecords(doc.records, doc.summary, doc.at));
  }
  if (set.kinds.some((d) => "error" in d)) return 1;
  if (args.require) {
    const results = set.kinds.filter((d): d is Extract<typeof d, { records: unknown }> => !("error" in d));
    const all = results.flatMap((d) => d.records);
    const below = belowRequired(all, args.require);
    if (below.length > 0) {
      const inactive = results.find((d) => !d.trust.active);
      console.error(
        formatError({
          message: `${below.length} of ${all.length} records are not ${args.require}: ${below
            .slice(0, 5)
            .map((r) => `${r.path} (${r.provenance.level})`)
            .join(", ")}${below.length > 5 ? ", ..." : ""}`,
          hint: inactive ? `there is no signers file (${inactive.trust.signersPath}) at base` : "run with --json to see each record's reason",
        }),
      );
      return EXIT_BELOW_REQUIRED;
    }
  }
  return 0;
}

/**
 * `records --since` without `--kind` (#2680): what changed in every declared
 * kind, one `records-since` document per kind inside one set, in the
 * declaration's order. A kind whose read fails is listed with its error, and
 * the exit code is 1.
 */
async function runDeclaredSince(declared: { declared: RecordKindDeclaration; file: string }[], args: CommandContext["args"]): Promise<number> {
  if (args.current || args.require !== undefined || args.base !== undefined) {
    console.error(formatError({ message: "--since compares two revisions and takes no --current, --require or --base", hint: USAGE }));
    return 1;
  }
  const { formatSince, queryRecordsSince, RECORDS_SINCE_OUTPUT_SCHEMA_ID } = await import("./records-since");
  const kinds = [];
  for (const k of declared) {
    const doc = await queryRecordsSince({ kind: k.file, since: args.since!, at: args.at, cwd: process.cwd() });
    kinds.push({ ...doc, declared: { member: k.declared.member, path: k.declared.path, name: k.declared.name } });
  }
  if (args.json) console.log(JSON.stringify({ $schema: RECORDS_SINCE_OUTPUT_SCHEMA_ID, contract: RECORDS_CONTRACT_VERSION, kinds }, null, 2));
  for (const doc of args.json ? [] : kinds) {
    if ("error" in doc) {
      console.error(formatError({ message: `${doc.declared.path}: ${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
      continue;
    }
    console.log(`${doc.declared.name ?? doc.kind.name} (${doc.declared.path})`);
    console.log(formatSince(doc));
  }
  return kinds.some((d) => "error" in d) ? 1 : 0;
}

export function realpathOr(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Records whose provenance falls below `required`. Only `attested` can be required. */
export function belowRequired(records: RecordView[], required: ProvenanceLevel): RecordView[] {
  return records.filter((r) => r.provenance.level !== required);
}

function formatRecords(records: RecordView[], summary: { total: number; valid: number; invalid: number; superseded: number }, at: string | null): string {
  const lines: string[] = [];
  const idWidth = Math.max(2, ...records.map((r) => (r.id ?? "-").length));
  const stateWidth = Math.max(5, ...records.map((r) => (r.state ?? "-").length));
  for (const r of records) {
    const title = typeof r.data?.title === "string" ? r.data.title : r.path;
    const flag = r.valid ? "" : "  INVALID";
    const superseded = r.supersededBy ? `  superseded by ${r.supersededBy}` : "";
    const attested = r.provenance.level === "attested" ? `  attested by ${r.provenance.principal}` : "";
    lines.push(`${(r.id ?? "-").padEnd(idWidth)}  ${(r.state ?? "-").padEnd(stateWidth)}  ${title}${superseded}${attested}${flag}`);
    if (r.ready !== undefined) {
      const blocked = (r.blockedBy ?? []).map((b) => `${b.id} (${b.state ?? "unknown"})`).join(", ");
      const implemented = (r.implements ?? []).map((d) => `${d.id} (${d.state ?? "unknown"})`).join(", ");
      const status = [r.ready ? "ready" : blocked ? `blocked by ${blocked}` : "", implemented ? `implements ${implemented}` : ""].filter(Boolean).join("; ");
      if (status) lines.push(`${" ".repeat(idWidth + 2)}${status}`);
    }
    for (const reason of r.reasons) lines.push(`${" ".repeat(idWidth + 2)}${reason.code}: ${reason.message} (${r.path})`);
    for (const warning of r.warnings) lines.push(`${" ".repeat(idWidth + 2)}warning ${warning.code}: ${warning.message} (${r.path})`);
    const q = r.quorum;
    if (q && q.counted.length + q.notCounted.length > 0) {
      const verdict = q.metWithObjections ? "met with objections" : q.met ? "met" : "not met";
      const concerns = q.openConcerns.length > 0 ? `, ${q.openConcerns.length} open ${q.openConcerns.length === 1 ? "concern" : "concerns"}` : "";
      lines.push(`${" ".repeat(idWidth + 2)}quorum ${q.agreed} of ${q.need} agreed, ${verdict}; ${q.notCounted.length} not counted${concerns}`);
    }
  }
  lines.push(
    `${summary.total} records${at ? ` at ${at.slice(0, 8)}` : ""}: ${summary.valid} valid, ${summary.invalid} invalid, ${summary.superseded} superseded`,
  );
  return lines.join("\n");
}

/** `chant workspace <anything else>`. */
export async function runWorkspaceUnknown(ctx: CommandContext): Promise<number> {
  const sub = ctx.args.path && ctx.args.path !== "." ? ctx.args.path : "";
  console.error(
    formatError({
      message: sub ? `Unknown workspace subcommand: ${sub}` : "chant workspace needs a subcommand",
      hint: `Workspace subcommands: audit, build, check, graph, init, lineage, lint, ls, records, status, upgrade, verify. Run "chant --help" for their options.`,
    }),
  );
  return 1;
}

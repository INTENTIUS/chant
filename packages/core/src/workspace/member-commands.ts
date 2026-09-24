/**
 * `chant workspace build|lint|audit|graph [dir]` (#2537, #2524 D3, D8, D12,
 * D16): run a level-0 command in every member, each under the member's own
 * chant, and put the answers together.
 *
 * What runs:
 *
 * - Members of kind `chant`, the root member `.` included when it is one.
 *   Members of kind `other` are never read, and a nested `workspace` member
 *   runs its own workspace commands, so both are listed as skipped with the
 *   reason code `kind-not-run`.
 * - For `build` and `lint` only, every project an example group matches
 *   (ws-051): groups are built and linted, and have no ledger, audit or place
 *   in the graph. On a large repository this is most of the run, so
 *   `--member <name>` narrows it to the named members and groups.
 *
 * Which chant runs a member (its toolchain): the `node_modules/.bin/chant`
 * found by walking up from the member's directory to the workspace root,
 * followed to its real path. A member with none uses the root's, and when
 * the root has none either, the chant running this command. Members are
 * grouped by that real path, and each group gets one process: the chant's
 * `workspace member-run`, handed every member's command line on stdin (see
 * `member-run.ts`). A chant too old to have `member-run` gets one level-0
 * process per member instead, from inside the member's directory.
 *
 * Member `.` is the root project minus every other member, so its run leaves
 * the member directories and group matches out of discovery, as
 * `chant build --root-only` does.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatError } from "../cli/format";
import type { CommandContext, ParsedArgs } from "../cli/registry";
import { findWorkspaceRoot } from "../project-root";
import type { ComposedMember, MemberReason } from "./compose-graph";
import { mergeAudit, mergeSarif, type MemberOutput } from "./compose-reports";
import { readDeclaration, resolveGroups, rootExclusions, WorkspaceReadError, type Declaration } from "./declaration";
import { builtinKindRegistry, type KindRegistry } from "./kinds";
import { memberReason } from "./ls";
import { MEMBER_RUN_PROTOCOL, PROTOCOL_PREFIX, type MemberRunLine, type MemberRunRequest } from "./member-run";
import { workingTree, type WorkspaceTree } from "./tree";

export type WorkspaceVerb = "build" | "lint" | "audit" | "graph";

/** One project a workspace command runs: a member, or one match of an example group. */
export interface RunUnit {
  /** The member's name, or `<group>:<dir>` for a group match. */
  id: string;
  /** The member or group name. */
  member: string;
  kind: string;
  group: boolean;
  /** Relative to the workspace root, `"."` for the root member. */
  dir: string;
  abs: string;
  /** Directories (relative to `dir`) left out of discovery; set for member `.`. */
  exclude: string[];
}

export interface SkippedEntry {
  name: string;
  dir: string | null;
  kind: string;
  reason: MemberReason;
}

/** How a toolchain was found. */
export type ToolchainSource = "member" | "root" | "reader";

export interface Toolchain {
  /** The command that starts this chant: the executable, then any arguments that come before chant's own. */
  command: string[];
  /** The real path of its `bin/chant`: members with the same one share a process. */
  identity: string;
  source: ToolchainSource;
}

export interface ToolchainGroup {
  toolchain: Toolchain;
  units: RunUnit[];
}

export interface MemberPlan {
  verb: WorkspaceVerb;
  workspace: { name: string; root: string; file: string };
  groups: ToolchainGroup[];
  /** Chant members that can't be run, such as one whose directory is missing. They fail the run. */
  unreadable: SkippedEntry[];
  /** Members and groups the command does not run. */
  skipped: SkippedEntry[];
}

/** The `bin/chant` of the chant this module belongs to. */
export function readerBin(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "chant");
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * How to start the chant running this command. When this process is chant's
 * own CLI, it is started again the same way (node, its loader flags and
 * `main.ts`), which works from any directory. `bin/chant` looks for tsx
 * relative to an installed package, and from a source checkout it can only
 * fall back to `npx tsx` in the current directory.
 */
export function readerToolchain(): Toolchain {
  const main = process.argv[1] ?? "";
  const command = /[\\/]cli[\\/]main\.(ts|js|mjs)$/.test(main) ? [process.execPath, ...process.execArgv, main] : [readerBin()];
  return { command, identity: real(readerBin()), source: "reader" };
}

/**
 * The chant a directory resolves: the first `node_modules/.bin/chant` from
 * `dir` up to `root` (both absolute, `dir` inside `root`), else `reader`.
 * A bin that is the reader's own chant is started the way the reader is.
 */
export function resolveToolchain(dir: string, root: string, reader: Toolchain = readerToolchain()): Toolchain {
  for (let at = dir; ; at = dirname(at)) {
    const bin = join(at, "node_modules", ".bin", "chant");
    if (existsSync(bin)) {
      const identity = real(bin);
      const source: ToolchainSource = at === root ? "root" : "member";
      return identity === reader.identity ? { ...reader, source } : { command: [bin], identity, source };
    }
    if (at === root || dirname(at) === at) break;
  }
  return reader;
}

export interface PlanOptions {
  /** Only these member or group names. */
  only?: string[];
  kinds?: KindRegistry;
  /** The chant to use when neither a member nor the root has one. Defaults to {@link readerToolchain}. */
  reader?: Toolchain;
  /** The files to plan from, such as a revision's (`--at`); the working tree under `root` by default. */
  tree?: WorkspaceTree;
}

/** Work out which projects run and under which chant. Throws a {@link WorkspaceReadError} for an unreadable declaration or an unknown `--member` name. */
export function planMembers(verb: WorkspaceVerb, root: string, options: PlanOptions = {}): MemberPlan {
  const tree = options.tree ?? workingTree(root);
  const declaration: Declaration = readDeclaration(tree);
  const resolvedGroups = resolveGroups(declaration, tree);
  const kinds = options.kinds ?? builtinKindRegistry();

  const only = options.only?.length ? new Set(options.only) : undefined;
  if (only) {
    const known = new Set(declaration.entries.map((e) => e.name));
    const unknown = [...only].filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new WorkspaceReadError(
        "declaration-invalid",
        `--member names ${unknown.join(", ")}, which the declaration does not declare; it declares ${[...known].join(", ")}`,
      );
    }
  }

  const units: RunUnit[] = [];
  const skipped: SkippedEntry[] = [];
  const unreadable: SkippedEntry[] = [];
  const groupsRun = verb === "build" || verb === "lint";

  for (const entry of declaration.entries) {
    if (only && !only.has(entry.name)) continue;
    if (entry.type === "group") {
      const g = resolvedGroups.find((r) => r.group === entry)!;
      if (!groupsRun) {
        skipped.push({
          name: entry.name,
          dir: null,
          kind: entry.kind,
          reason: { code: "kind-not-run", message: `example groups are built and linted only; chant workspace ${verb} leaves them out` },
        });
        continue;
      }
      for (const dir of g.matches) {
        units.push({ id: `${entry.name}:${dir}`, member: entry.name, kind: entry.kind, group: true, dir, abs: join(root, dir), exclude: [] });
      }
      continue;
    }
    if (entry.kind !== "chant") {
      const why =
        entry.kind === "workspace"
          ? "a nested workspace runs its own chant workspace commands"
          : `chant workspace ${verb} runs members of kind chant, and this one is kind ${entry.kind}`;
      skipped.push({ name: entry.name, dir: entry.dir, kind: entry.kind, reason: { code: "kind-not-run", message: why } });
      continue;
    }
    const reason = memberReason(entry, tree, kinds);
    if (reason) {
      unreadable.push({ name: entry.name, dir: entry.dir, kind: entry.kind, reason });
      continue;
    }
    units.push({
      id: entry.name,
      member: entry.name,
      kind: entry.kind,
      group: false,
      dir: entry.dir,
      abs: entry.dir === "." ? root : join(root, entry.dir),
      exclude: entry.dir === "." ? rootExclusions(declaration, resolvedGroups).map((e) => e.dir) : [],
    });
  }

  const reader = options.reader ?? readerToolchain();
  const byIdentity = new Map<string, ToolchainGroup>();
  for (const unit of units) {
    // The walk reaches the root's chant before it gives up, so a member with
    // none of its own runs under the root's, and under this chant only when
    // the root has none either.
    const tc = resolveToolchain(unit.abs, root, reader);
    const group = byIdentity.get(tc.identity) ?? { toolchain: tc, units: [] };
    group.units.push(unit);
    byIdentity.set(tc.identity, group);
  }

  return {
    verb,
    workspace: { name: declaration.name, root, file: declaration.file },
    groups: [...byIdentity.values()],
    unreadable,
    skipped,
  };
}

// ── Command lines ────────────────────────────────────────────────────────────

/** What each member's run prints, for the verb and the workspace command's own flags. */
export function memberFormat(verb: WorkspaceVerb, args: Pick<ParsedArgs, "format" | "json">): string {
  if (verb === "graph") return "ir";
  // Audit always reads JSON, so member `.` can leave other members' findings to them.
  if (verb === "audit") return "json";
  if (verb === "lint") return args.format === "sarif" || args.format === "json" ? args.format : "stylish";
  return args.format === "yaml" ? "yaml" : "json";
}

/** The level-0 command line one member runs. */
export function memberArgv(verb: WorkspaceVerb, unit: RunUnit, args: ParsedArgs): string[] {
  // A build keeps its own default format unless one was asked for.
  const argv = verb === "build" && !args.format ? [verb, "."] : [verb, ".", "--format", memberFormat(verb, args)];
  const params = () => {
    for (const p of args.param ?? []) argv.push("--param", p);
    if (args.paramsFile) argv.push("--params-file", resolve(args.paramsFile));
  };
  if (verb === "build") {
    if (args.env) argv.push("--env", args.env);
    params();
    if (args.lexicon) argv.push("--lexicon", args.lexicon);
    if (args.output) argv.push("--output", buildOutputPath(args.output, unit, memberFormat(verb, args)));
  } else if (verb === "lint") {
    params();
    if (args.fix) argv.push("--fix");
  } else if (verb === "audit") {
    if (args.tier) argv.push("--tier", args.tier);
    if (args.failOn) argv.push("--fail-on", args.failOn);
    if (args.maxFiles !== undefined) argv.push("--max-files", String(args.maxFiles));
  } else if (args.env) {
    argv.push("--env", args.env);
  }
  return argv;
}

/** `workspace build -o <dir>` writes `<dir>/<member>.<ext>`, and `<dir>/<group>/<match dir>.<ext>` for a group match. */
export function buildOutputPath(outDir: string, unit: RunUnit, format: string): string {
  const ext = format === "yaml" ? "yaml" : "json";
  return `${resolve(outDir, unit.group ? join(unit.member, unit.dir) : unit.member)}.${ext}`;
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface UnitResult extends MemberOutput {
  unit: RunUnit;
  toolchain: Toolchain;
  /** The chant version the member-run header named; null when the per-member fallback ran. */
  chant: string | null;
  /** How the member ran: inside its toolchain's shared process, or in a level-0 process of its own. */
  mode: "member-run" | "per-member";
}

interface Spawned {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(command: string[], argv: string[], cwd: string, input?: string): Promise<Spawned> {
  const [bin, ...pre] = command;
  return new Promise((done) => {
    const child = spawn(bin, [...pre, ...argv], { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => done({ exitCode: 127, stdout: "", stderr: `could not start ${bin}: ${e.message}\n` }));
    child.on("close", (code) => done({ exitCode: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.on("error", () => {
      // A chant that never reads stdin closes it early; its answer says why.
    });
    child.stdin.end(input ?? "");
  });
}

/** Parse a member-run answer. `undefined` when there is no header: the chant has no member-run. */
export function parseMemberRunOutput(stdout: string): { chant: string; results: Map<string, Extract<MemberRunLine, { type: "result" }>>; stray: string } | undefined {
  let header: Extract<MemberRunLine, { type: "header" }> | undefined;
  const results = new Map<string, Extract<MemberRunLine, { type: "result" }>>();
  const stray: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PROTOCOL_PREFIX)) {
      if (line.trim()) stray.push(line);
      continue;
    }
    let parsed: MemberRunLine;
    try {
      parsed = JSON.parse(line.slice(PROTOCOL_PREFIX.length)) as MemberRunLine;
    } catch {
      continue;
    }
    if (parsed.type === "header" && !header) header = parsed;
    else if (parsed.type === "result" && header) results.set(parsed.id, parsed);
  }
  return header ? { chant: header.chant, results, stray: stray.join("\n") } : undefined;
}

/** A command line to run in each member instead of the verb's own, such as `graph --components` (#2662). */
export type MemberArgv = (unit: RunUnit) => string[];

async function runGroup(verb: WorkspaceVerb, group: ToolchainGroup, root: string, args: ParsedArgs, argvFor?: MemberArgv): Promise<UnitResult[]> {
  const { toolchain, units } = group;
  const argvs = new Map(units.map((u) => [u.id, argvFor ? argvFor(u) : memberArgv(verb, u, args)]));
  for (const u of units) {
    const o = argvs.get(u.id)!;
    const i = o.indexOf("--output");
    if (i >= 0) mkdirSync(dirname(o[i + 1]), { recursive: true });
  }
  const request: MemberRunRequest = {
    protocol: MEMBER_RUN_PROTOCOL,
    units: units.map((u) => ({ id: u.id, dir: u.abs, argv: argvs.get(u.id)!, ...(u.exclude.length ? { exclude: u.exclude } : {}) })),
  };
  const answer = await run(toolchain.command, ["workspace", "member-run"], root, JSON.stringify(request));
  const parsed = parseMemberRunOutput(answer.stdout);
  if (parsed) {
    if (parsed.stray) process.stderr.write(`${parsed.stray}\n`);
    return units.map((unit) => {
      const r = parsed.results.get(unit.id);
      const base = { unit, toolchain, chant: parsed.chant, mode: "member-run" as const, id: unit.id, member: unit.member, dir: unit.dir, exclude: unit.exclude };
      if (r) return { ...base, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      return { ...base, exitCode: answer.exitCode || 1, stdout: "", stderr: `the member-run process for ${toolchain.identity} ended before running this member\n${answer.stderr}` };
    });
  }
  // No header: a chant older than member-run. One level-0 process per member.
  const out: UnitResult[] = [];
  for (const unit of units) {
    const r = await run(toolchain.command, argvs.get(unit.id)!, unit.abs);
    out.push({ unit, toolchain, chant: null, mode: "per-member", id: unit.id, member: unit.member, dir: unit.dir, exclude: unit.exclude, ...r });
  }
  return out;
}

/**
 * Run every group of the plan, one process per toolchain at a time each, and
 * return the results in plan order. `argvFor` replaces the verb's command line.
 */
export async function executePlan(plan: MemberPlan, args: ParsedArgs, argvFor?: MemberArgv): Promise<UnitResult[]> {
  const perGroup = await Promise.all(plan.groups.map((g) => runGroup(plan.verb, g, plan.workspace.root, args, argvFor)));
  const byId = new Map(perGroup.flat().map((r) => [r.id, r]));
  const order = plan.groups.flatMap((g) => g.units);
  return order.map((u) => byId.get(u.id)!);
}

// ── The command ──────────────────────────────────────────────────────────────

const USAGE: Record<WorkspaceVerb, string> = {
  build: "chant workspace build [dir] [--member <name>] [-o <dir>] [--format json|yaml] [--env <env>] [--param k=v] [--dry-run]",
  lint: "chant workspace lint [dir] [--member <name>] [--format stylish|json|sarif] [-o <file>] [--fix] [--dry-run]",
  audit: "chant workspace audit [dir] [--member <name>] [--format stylish|json] [-o <file>] [--tier <tier>] [--fail-on <level>] [--dry-run]",
  graph: "chant workspace graph [dir] [--member <name>] [--kind <kind file>] [-o <file>] [--env <env>] [--dry-run]",
};

export function describePlan(plan: MemberPlan): string {
  const lines = [`chant workspace ${plan.verb} in ${plan.workspace.name} (${plan.workspace.root})`];
  for (const g of plan.groups) {
    lines.push("", `${g.toolchain.identity}  (${g.toolchain.source}, ${g.units.length} project${g.units.length === 1 ? "" : "s"}, one process)`);
    for (const u of g.units) lines.push(`  ${u.id}${u.group ? "" : `  ${u.dir}`}`);
  }
  for (const s of plan.unreadable) lines.push("", `unreadable ${s.name}: ${s.reason.code}: ${s.reason.message}`);
  if (plan.skipped.length) {
    lines.push("", "skipped:");
    for (const s of plan.skipped) lines.push(`  ${s.name}  ${s.reason.code}: ${s.reason.message}`);
  }
  return lines.join("\n");
}

export function planJson(plan: MemberPlan): unknown {
  return {
    verb: plan.verb,
    workspace: plan.workspace,
    toolchains: plan.groups.map((g) => ({ ...g.toolchain, units: g.units.map((u) => ({ id: u.id, member: u.member, dir: u.dir, group: u.group })) })),
    unreadable: plan.unreadable,
    skipped: plan.skipped,
  };
}

export function emitDocument(doc: unknown, output: string | undefined): void {
  const text = JSON.stringify(doc, null, 2);
  if (output) {
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(resolve(output), `${text}\n`);
  } else {
    console.log(text);
  }
}

function summaryLine(plan: MemberPlan, results: UnitResult[]): string {
  const failed = results.filter((r) => r.exitCode !== 0).length + plan.unreadable.length;
  const n = results.length + plan.unreadable.length;
  const processes = plan.groups.length;
  return (
    `chant workspace ${plan.verb}: ${n} project${n === 1 ? "" : "s"}, ${n - failed} passed, ${failed} failed; ` +
    `${plan.skipped.length} skipped; ${processes} toolchain${processes === 1 ? "" : "s"}`
  );
}

function printSections(plan: MemberPlan, results: UnitResult[], showStdout: boolean): void {
  for (const r of results) {
    const via = r.chant ? `chant ${r.chant}` : r.toolchain.identity;
    console.log(`── ${r.id}  ${r.dir}  (${via}, exit ${r.exitCode})`);
    if (showStdout && r.stdout.trim()) console.log(r.stdout.replace(/\n$/, ""));
    if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
  }
  for (const s of plan.unreadable) console.log(`── ${s.name}  ${s.dir}  (${s.reason.code}: ${s.reason.message})`);
  console.error(summaryLine(plan, results));
}

/** The text form of `workspace audit`: each member's findings under a heading, one line each. */
function formatAuditText(doc: ReturnType<typeof mergeAudit>, plan: MemberPlan): string {
  const lines: string[] = [];
  for (const m of doc.members) {
    const own = doc.findings.filter((f) => f.member === m.member);
    lines.push(`── ${m.member}  ${m.dir}  (${m.status === "failed" ? `failed: ${m.error}` : m.note ?? `${own.length} finding${own.length === 1 ? "" : "s"}`})`);
    for (const f of own) {
      const at = `${String(f.file)}${f.line !== undefined ? `:${String(f.line)}` : ""}`;
      lines.push(`  ${at}  ${String(f.severity)}  ${String(f.checkId)}  ${String(f.message)}`);
    }
  }
  for (const s of plan.unreadable) lines.push(`── ${s.name}  ${s.dir}  (${s.reason.code}: ${s.reason.message})`);
  const errors = doc.findings.filter((f) => f.severity === "error").length;
  lines.push("", `${doc.findings.length} finding${doc.findings.length === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}`);
  return lines.join("\n");
}

export function memberStatus(name: string, dir: string, kind: string, status: ComposedMember["status"], reason: MemberReason | null, chant: string | null): ComposedMember {
  return { name, dir, kind, status, reason, chant, irVersion: null };
}

export async function runWorkspaceMembers(ctx: CommandContext, verb: WorkspaceVerb): Promise<number> {
  // graph is part of the read contract, with --at and its own document (#2536).
  if (verb === "graph") return (await import("./graph-cli")).runWorkspaceGraph(ctx);
  const { args } = ctx;
  const start = resolve(args.extraPositional ?? ".");
  const found = existsSync(start) ? findWorkspaceRoot(start) : undefined;
  if (!found) {
    console.error(formatError({ message: `declaration-missing: no chant.workspace.json or .jsonc between ${start} and the git root; chant workspace init proposes one`, hint: USAGE[verb] }));
    return 1;
  }
  let plan: MemberPlan;
  try {
    plan = planMembers(verb, found.dir, { only: args.members });
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE[verb] }));
    return 1;
  }

  if (args.dryRun) {
    if (args.json) console.log(JSON.stringify(planJson(plan), null, 2));
    else console.log(describePlan(plan));
    return 0;
  }

  const results = await executePlan(plan, args);
  const anyFailed = results.some((r) => r.exitCode !== 0) || plan.unreadable.length > 0;
  const workspace = { name: plan.workspace.name, root: plan.workspace.root };

  if (verb === "lint" && args.format === "sarif") {
    for (const r of results) if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    const unreadable: MemberOutput[] = plan.unreadable.map((s) => ({ id: s.name, member: s.name, dir: s.dir ?? ".", exitCode: 1, stdout: "", stderr: `${s.reason.code}: ${s.reason.message}` }));
    emitDocument(mergeSarif([...results, ...unreadable], plan.workspace.root), args.output);
    console.error(summaryLine(plan, results));
    return anyFailed ? 1 : 0;
  }

  if (verb === "audit" && !(args.json || args.format === "json")) {
    for (const r of results) if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    const merged = mergeAudit(results, workspace);
    console.log(formatAuditText(merged, plan));
    console.error(summaryLine(plan, results));
    return anyFailed ? 1 : 0;
  }

  if ((verb === "lint" && args.format === "json") || verb === "audit") {
    for (const r of results) if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    let doc: unknown;
    if (verb === "audit") {
      const merged = mergeAudit(results, workspace);
      for (const s of plan.unreadable) merged.members.push({ member: s.name, dir: s.dir ?? ".", exitCode: 1, status: "failed", summary: null, error: `${s.reason.code}: ${s.reason.message}` });
      doc = { ...merged, skipped: plan.skipped };
    } else {
      doc = {
        workspace,
        members: [
          ...results.map((r) => {
            let diagnostics: unknown = null;
            try {
              diagnostics = JSON.parse(r.stdout);
            } catch {
              // A member whose lint printed no JSON keeps null, with its exit code saying why.
            }
            return { member: r.id, dir: r.dir, exitCode: r.exitCode, diagnostics };
          }),
          ...plan.unreadable.map((s) => ({ member: s.name, dir: s.dir, exitCode: 1, diagnostics: null, reason: s.reason })),
        ],
        skipped: plan.skipped,
      };
    }
    emitDocument(doc, args.output);
    console.error(summaryLine(plan, results));
    return anyFailed ? 1 : 0;
  }

  // Text: each member's own output under a heading. A build without -o prints
  // no templates, since several members' templates can't share one stdout.
  printSections(plan, results, verb !== "build" || args.output !== undefined);
  return anyFailed ? 1 : 0;
}

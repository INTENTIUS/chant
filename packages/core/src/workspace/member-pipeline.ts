/**
 * Per-member CI pipelines (#2542; #2524 D19, ws-041 and ws-042).
 *
 * When `chant build --components --generate` or `chant run --generate` runs
 * for a project inside a workspace member, the generator is told which
 * member it is generating for ({@link PipelineMember}). The generated
 * pipeline is then filtered to the member's paths, its jobs run in the
 * member's directory, and its file is named after the member so two members
 * never write the same file.
 *
 * Forges read CI files from fixed paths at the repository root, outside any
 * member's directory. The member whose command generates such a file owns
 * it (ws-042), and records it in its list of generated files. That list
 * belongs in the member's `generated` entry in `chant.workspace.json` once
 * #2541 lands. Until then it is `.chant/generated.json` in the member's
 * directory ({@link GENERATED_RECORD_FILE}), which `WSP081` reads to allow
 * one declarer per file (./checks/pipelines.ts).
 *
 * The command handlers import this module only after `findWorkspaceRoot`
 * has found a declaration, so a project outside any workspace never loads it.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GENERATED_MARKER } from "../discovery/files";
import type { PipelineMember } from "../lexicon";
import type { WorkspaceRootSearch } from "../project-root";
import { ownerOf, readDeclaration, resolveGroups, rootExclusions, WorkspaceReadError, type Declaration, type Member } from "./declaration";
import { gitTop, workingTree } from "./tree";

/**
 * TODO(#2541): the interim home of a member's generated-file list, relative
 * to the member's directory. #2541 moves the list into the member's entry in
 * the declaration, and this file goes away.
 */
export const GENERATED_RECORD_FILE = ".chant/generated.json";

/** One generated file a member owns. */
export interface GeneratedFileEntry {
  /** The file, relative to the repository root, with `/` separators. */
  path: string;
  /** The command that regenerates it, run in the member's directory. */
  command: string;
  /** The environment the pipeline deploys, for a component pipeline. */
  env?: string;
}

export interface GeneratedRecord {
  schema: 1;
  files: GeneratedFileEntry[];
}

/** The member a project belongs to, and where it sits. */
export interface MemberContext {
  declaration: Declaration;
  member: Member;
  /** Absolute path of the workspace root. */
  workspaceRoot: string;
  /** Absolute path of the repository root: the git top, or the workspace root outside git. */
  repoRoot: string;
  /** Absolute path of the member's directory. */
  memberRoot: string;
  /** What the generators read: name, repository-relative directory and exclusions. */
  pipeline: PipelineMember;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `path` relative to `from`, `/`-separated, `"."` for `from` itself. */
function relPath(from: string, path: string): string {
  const rel = relative(from, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

function joinRel(prefix: string, dir: string): string {
  if (prefix === ".") return dir;
  return dir === "." ? prefix : `${prefix}/${dir}`;
}

/**
 * The member that owns `projectDir`, given the declaration `findWorkspaceRoot`
 * found. Undefined when no member owns it: the directory sits in an example
 * group's match, or outside every member of a workspace with no root member.
 * Throws `WorkspaceReadError` when the declaration can't be read.
 */
export function resolveMemberContext(projectDir: string, found: WorkspaceRootSearch): MemberContext | undefined {
  const workspaceRoot = real(found.dir);
  const tree = workingTree(workspaceRoot);
  const declaration = readDeclaration(tree);
  const groups = resolveGroups(declaration, tree);
  const at = relPath(workspaceRoot, real(projectDir));
  if (at.startsWith("..")) return undefined;
  const owner = ownerOf(declaration, groups, at);
  if (!owner || !("member" in owner)) return undefined;
  const member = owner.member;

  const repoRoot = real(gitTop(workspaceRoot) ?? workspaceRoot);
  const prefix = relPath(repoRoot, workspaceRoot);
  const pipeline: PipelineMember = { name: member.name, dir: joinRel(prefix, member.dir) };
  if (member.dir === ".") {
    const exclude = rootExclusions(declaration, groups).map((e) => joinRel(prefix, e.dir));
    if (exclude.length > 0) pipeline.exclude = exclude;
  }
  return {
    declaration,
    member,
    workspaceRoot,
    repoRoot,
    memberRoot: member.dir === "." ? workspaceRoot : join(workspaceRoot, member.dir),
    pipeline,
  };
}

/** Where each forge reads a member's component pipeline from, relative to the repository root. */
const PIPELINE_DIRS: Record<string, string> = {
  github: ".github/workflows",
  forgejo: ".forgejo/workflows",
  // GitLab reads only .gitlab-ci.yml, which includes these (`include: local: .gitlab/ci/*.gitlab-ci.yml`).
  gitlab: ".gitlab/ci",
};

/** The directory a forge's generated files go in for a member, relative to the repository root, or undefined for a forge chant doesn't know. */
export function memberPipelineDir(provider: string): string | undefined {
  return PIPELINE_DIRS[provider];
}

/**
 * The default path of a member's component pipeline for one environment,
 * relative to the repository root: `chant-<member>-<env>.yml` in the forge's
 * workflow directory, or `.gitlab/ci/chant-<member>-<env>.gitlab-ci.yml`.
 */
export function memberPipelineFile(provider: string, member: string, env: string): string | undefined {
  const dir = PIPELINE_DIRS[provider];
  if (dir === undefined) return undefined;
  return `${dir}/chant-${member}-${env}${provider === "gitlab" ? ".gitlab-ci.yml" : ".yml"}`;
}

/** A repository-relative path for an absolute one. */
export function repoRelative(ctx: MemberContext, absolute: string): string {
  return relPath(ctx.repoRoot, resolve(absolute));
}

/** Read a member's generated-file record, or an empty one. */
export function readGeneratedRecord(memberRoot: string): GeneratedRecord {
  const file = join(memberRoot, GENERATED_RECORD_FILE);
  if (!existsSync(file)) return { schema: 1, files: [] };
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<GeneratedRecord>;
  return { schema: 1, files: Array.isArray(parsed.files) ? parsed.files : [] };
}

/**
 * Add or replace entries in a member's generated-file record, keyed by path,
 * and write it back sorted, so regenerating the same files leaves it
 * byte-identical.
 */
export function recordGeneratedFiles(memberRoot: string, entries: GeneratedFileEntry[]): string {
  const record = readGeneratedRecord(memberRoot);
  const byPath = new Map(record.files.map((f) => [f.path, f]));
  for (const e of entries) byPath.set(e.path, e);
  const files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const file = join(memberRoot, GENERATED_RECORD_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: 1, files }, null, 2) + "\n");
  return file;
}

/** Quote one argument for a recorded command line when it needs it. */
export function shellArg(arg: string): string {
  return /^[A-Za-z0-9._\/=:@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The first line of a member's generated pipeline, naming the command that regenerates it. */
export function generatedHeader(command: string): string {
  return `# ${GENERATED_MARKER}. Regenerate with: ${command} (in the member's directory)\n`;
}

/** What `chant build --components --generate` needs to write a member's pipeline. */
export interface MemberComponentPlan {
  ctx: MemberContext;
  /** Passed to the generator as `options.member`. */
  member: PipelineMember;
  /** The pipeline file, relative to the repository root. */
  file: string;
  /** The pipeline file's absolute path. */
  target: string;
  /** The command that regenerates it, run in the member's directory. */
  command: string;
  env: string;
}

export interface ComponentPlanInput {
  projectDir: string;
  found: WorkspaceRootSearch;
  lexicon: string;
  /** `--env`, or undefined for the generator's default. */
  env?: string;
  promoteTo?: string;
  /** `--output`, relative to the current directory. */
  output?: string;
  params?: string[];
  paramsFile?: string;
}

/** The generators' own default environment when `--env` is not given. */
const DEFAULT_ENV = "production";

/**
 * Plan a member's component pipeline: which member, which file and which
 * command. Undefined when the project belongs to no member. Throws with a
 * readable message when there is no default file for the forge and no
 * `--output`.
 */
export function planMemberComponentPipeline(input: ComponentPlanInput): MemberComponentPlan | undefined {
  const ctx = resolveMemberContext(input.projectDir, input.found);
  if (!ctx) return undefined;
  const env = input.env ?? DEFAULT_ENV;
  let target: string;
  if (input.output) {
    target = resolve(input.output);
  } else {
    const file = memberPipelineFile(input.lexicon, ctx.member.name, env);
    if (file === undefined) {
      throw new Error(`there is no default pipeline path for ${input.lexicon} in a workspace member; pass --output <file>`);
    }
    target = join(ctx.repoRoot, file);
  }
  const file = repoRelative(ctx, target);

  const parts = ["chant", "build", "--components", "--generate", input.lexicon, "--env", env];
  if (input.promoteTo) parts.push("--promote-to", input.promoteTo);
  for (const p of input.params ?? []) parts.push("--param", p);
  if (input.paramsFile) parts.push("--params-file", relPath(ctx.memberRoot, resolve(input.paramsFile)));
  if (input.output) parts.push("--output", relPath(ctx.memberRoot, target));

  return {
    ctx,
    member: { ...ctx.pipeline, file },
    file,
    target,
    command: parts.map(shellArg).join(" "),
    env,
  };
}

/** Write a member's pipeline with its header and record it as the member's generated file. */
export function writeMemberComponentPipeline(plan: MemberComponentPlan, yaml: string): void {
  mkdirSync(dirname(plan.target), { recursive: true });
  writeFileSync(plan.target, generatedHeader(plan.command) + yaml);
  recordGeneratedFiles(plan.ctx.memberRoot, [{ path: plan.file, command: plan.command, env: plan.env }]);
}

/** What `chant run --generate` needs to write a member's Op pipelines. */
export interface MemberOpPlan {
  ctx: MemberContext;
  member: PipelineMember;
  /** Absolute directory the files are written to. */
  outDir: string;
  command: string;
}

/** Plan a member's Op pipelines. Undefined when the directory belongs to no member. */
export function planMemberOpPipelines(input: {
  projectDir: string;
  found: WorkspaceRootSearch;
  provider: string;
  output?: string;
  specFile?: string;
}): MemberOpPlan | undefined {
  const ctx = resolveMemberContext(input.projectDir, input.found);
  if (!ctx) return undefined;
  let outDir: string;
  if (input.output) {
    outDir = resolve(input.output);
  } else {
    const dir = memberPipelineDir(input.provider);
    if (dir === undefined) {
      throw new Error(`there is no default pipeline directory for ${input.provider} in a workspace member; pass --output <dir>`);
    }
    outDir = join(ctx.repoRoot, dir);
  }
  const parts = ["chant", "run", "--generate", input.provider];
  if (input.specFile) parts.push("--spec", relPath(ctx.memberRoot, resolve(input.specFile)));
  if (input.output) parts.push("--output", relPath(ctx.memberRoot, outDir));
  return {
    ctx,
    member: { ...ctx.pipeline, fileDir: repoRelative(ctx, outDir) },
    outDir,
    command: parts.map(shellArg).join(" "),
  };
}

/** Write a member's Op pipeline files with their header and record them. Returns the paths written, relative to the current directory. */
export function writeMemberOpPipelines(plan: MemberOpPlan, files: { name: string; yaml: string }[]): string[] {
  const written: string[] = [];
  const entries: GeneratedFileEntry[] = [];
  for (const f of files) {
    const target = join(plan.outDir, f.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, generatedHeader(plan.command) + f.yaml);
    entries.push({ path: repoRelative(plan.ctx, target), command: plan.command });
    written.push(relative(process.cwd(), target) || target);
  }
  recordGeneratedFiles(plan.ctx.memberRoot, entries);
  return written;
}

/** A message for an error from planning: a declaration error with its file and line, or the error's own message. */
export function describeError(err: unknown): string {
  if (err instanceof WorkspaceReadError) return err.describe();
  return err instanceof Error ? err.message : String(err);
}

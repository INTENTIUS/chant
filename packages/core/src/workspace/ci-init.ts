/**
 * `chant ci init --workflow <name> [--forge <forge>] [--security <group>]...
 * [--yes]` (#4168 step 6, section 9): set a workspace up for a prescribed
 * delivery workflow (../ci-workflow.ts).
 *
 * It proposes, prints the proposal as a diff, and writes only on `--yes` or a
 * yes at the prompt. What it proposes comes from what `workspace check`'s
 * WSP151 reports for the workspace as it would be with `ci.workflow` set, so
 * a second run proposes only what is still missing, and nothing once the
 * workspace has it all.
 *
 * - The declaration gains `ci.workflow`, a `ci.green` block when it has none
 *   (one phase per GitHub workflow, its jobs as the check runs, and the
 *   workflows a pull request runs as `preMerge`), and `preMerge` when the
 *   block has none. `--security` adds groups to the top-level `security`;
 *   without it no group is turned on, and the groups are listed.
 * - A member that builds with chant and declares no component gets a
 *   `<member>.component.ts` stub with a gate and a TODO line, which WSP151
 *   keeps reporting until someone fills the stub in. A `chant.config.ts`
 *   that declares no environments gains `environments: ["staging", "prod"]`
 *   when its default export is a plain object literal.
 * - The generated files are written by the generators that own them, run
 *   after the edits: `chant build --components --generate <forge> --pr-loop`
 *   in each member, `chant ci workflow` for the tick, and `chant release
 *   workflow` for the publish job. Each is named in the proposal before it
 *   runs.
 *
 * It never edits a file the diff did not show, and never overwrites a file
 * it proposed to create that appeared in the meantime.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandContext } from "../cli/registry";
import { formatError, formatSuccess } from "../cli/format";
import { parseYAMLDocument } from "../yaml";
import { CI_WORKFLOW_CHECKS } from "./checks/ci-workflow";
import type { WorkspaceDiagnostic } from "./checks";
import { CI_WORKFLOWS, STUB_MARKER, appliesBeforeMerge, appliesOnMerge } from "./ci-workflow";

export { STUB_MARKER };
import { CI_GREEN_WORKFLOW_FILE, jobCheckRuns, readWorkflowSources, workflowsHolding } from "./ci-green-workflow";
import { findWorkspaceRoot } from "../project-root";
import { parseDeclaration, readDeclaration, WorkspaceReadError, type CiWorkflow, type Declaration } from "./declaration";
import { staticPromotionOrder } from "./promotion-order";
import { SECURITY_GROUPS, type SecurityGroup } from "./security";
import { gitTop, workingTree, type WorkspaceTree } from "./tree";
import { RELEASE_WORKFLOW_FORGES, type ReleaseWorkflowForge } from "./release-workflow";

const USAGE = "chant ci init --workflow trunk-curated|trunk-curated+apply-on-merge|apply-before-merge [--forge github|gitlab|forgejo] [--security <group>]... [--yes]";


/** The environments a config with none is given. */
export const DEFAULT_ENVIRONMENTS = ["staging", "prod"] as const;

/** One file the proposal writes: created when `before` is null. */
export interface ProposedFile {
  path: string;
  before: string | null;
  after: string;
}

/** A generator the proposal runs after the edits, in `cwd` (relative to the workspace root). */
export interface ProposedCommand {
  cwd: string;
  args: string[];
  why: string;
}

export interface CiInitProposal {
  files: ProposedFile[];
  commands: ProposedCommand[];
  /** What the proposal leaves to a person, such as a component with no gate. */
  notes: string[];
  /** The WSP151 findings the proposal answers. */
  findings: WorkspaceDiagnostic[];
}

export interface CiInitOptions {
  workflow: CiWorkflow;
  forge?: ReleaseWorkflowForge;
  security?: readonly SecurityGroup[];
}

const memberDir = (dir: string) => (dir === "." ? "" : dir);
const join2 = (dir: string, file: string) => (dir === "" ? file : `${dir}/${file}`);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The forge whose pipeline files the repository has, or null. */
export function inferForge(repoRoot: string): ReleaseWorkflowForge | null {
  if (existsSync(join(repoRoot, ".github", "workflows"))) return "github";
  if (existsSync(join(repoRoot, ".forgejo", "workflows"))) return "forgejo";
  if (existsSync(join(repoRoot, ".gitlab-ci.yml"))) return "gitlab";
  return null;
}

/** The branch `origin/HEAD` names, else `main`. */
export function inferTrunk(repoRoot: string): string {
  const r = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoRoot, encoding: "utf-8" });
  const ref = r.status === 0 ? r.stdout.trim() : "";
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : "main";
}

/** Whether a workflow document runs on a pull request. */
function onPullRequest(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  const on = doc.on ?? (doc as Record<string, unknown>)["true"];
  if (typeof on === "string") return on === "pull_request" || on === "pull_request_target";
  if (Array.isArray(on)) return on.includes("pull_request") || on.includes("pull_request_target");
  return isObject(on) && ("pull_request" in on || "pull_request_target" in on);
}

/**
 * A `ci.green` block from the repository's GitHub workflows: a phase per
 * workflow holding its jobs' check runs, all required, and those a pull
 * request runs as `preMerge`. chant's own generated workflows are left out.
 */
export function inferGreen(repoRoot: string): { branch: string; phases: Record<string, string[]>; require: string[]; preMerge: string[] } {
  const phases: Record<string, string[]> = {};
  const preMerge: string[] = [];
  for (const s of readWorkflowSources(repoRoot, "")) {
    if (/\/chant-[^/]*\.ya?ml$/.test(s.path)) continue;
    let doc: unknown;
    try {
      doc = parseYAMLDocument(s.text);
    } catch {
      continue;
    }
    const runs = jobCheckRuns(doc);
    if (runs.length === 0) continue;
    const name = basename(s.path).replace(/\.ya?ml$/, "").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64) || "check";
    phases[name] = runs;
    if (onPullRequest(doc)) preMerge.push(name);
  }
  if (Object.keys(phases).length === 0) {
    phases.check = ["check"];
    preMerge.push("check");
  }
  return { branch: inferTrunk(repoRoot), phases, require: Object.keys(phases), preMerge: preMerge.length > 0 ? preMerge : [Object.keys(phases)[0]!] };
}

/**
 * The declaration's text with `next`'s top-level keys. A key the file lacks
 * is added as text before the closing brace, so the rest keeps its layout; a
 * key it has whose value changes rewrites the file, two-space indented.
 */
export function editDeclarationText(text: string, raw: Record<string, unknown>, next: Record<string, unknown>): string {
  const whole = `${JSON.stringify(next, null, 2)}\n`;
  const changed = Object.keys(next).filter((k) => JSON.stringify(raw[k]) !== JSON.stringify(next[k]));
  if (changed.length === 0) return text;
  if (changed.some((k) => k in raw)) return whole;
  const close = text.lastIndexOf("}");
  if (close < 0) return whole;
  const head = text.slice(0, close).replace(/\s*$/, "");
  const added = changed.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(next[k], null, 2).replace(/\n/g, "\n  ")}`).join(",\n");
  const out = `${head}${head.endsWith("{") ? "" : ","}\n${added}\n${text.slice(close)}`;
  try {
    return JSON.stringify(JSON.parse(out)) === JSON.stringify(next) ? out : whole;
  } catch {
    return whole;
  }
}

/** An identifier for a member's stub export. */
function exportName(member: string): string {
  const parts = member.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const id = parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1))).join("");
  return /^[A-Za-z_]/.test(id) ? id : `component${id}`;
}

/** The component stub for a member that declares none: a gate and a TODO, so WSP151 keeps asking until it is filled in. */
export function componentStub(member: string, lastEnvironment: string): string {
  return [
    `// ${STUB_MARKER}: say how ${member} is built and deployed, then delete this line.`,
    "// The gate makes a promote wait on an approval; a release gate decides it",
    `// for each environment, ${lastEnvironment} among them.`,
    "// chant-disable COMP004 -- the release gate: the person promoting approves each environment with chant approve",
    'import { gate, phase, type Component } from "@intentius/chant/components/component";',
    "",
    `export const ${exportName(member)}: Component = {`,
    `  name: ${JSON.stringify(member)},`,
    "  deploy: [",
    `    phase("Release", [gate("release", { description: "Approve the release for ${lastEnvironment}." })]),`,
    "  ],",
    "};",
    "",
  ].join("\n");
}

/** The config with `environments` added after `export default {`, or null when its default export is not a plain object literal. */
export function withEnvironments(config: string, environments: readonly string[] = DEFAULT_ENVIRONMENTS): string | null {
  const m = /export\s+default\s*\{/.exec(config);
  if (!m) return null;
  const at = m.index + m[0].length;
  return `${config.slice(0, at)}\n  environments: ${JSON.stringify(environments).replace(/,/g, ", ")},${config.slice(at)}`;
}

function read(tree: WorkspaceTree, path: string): string | null {
  if (tree.stat(path) !== "file") return null;
  try {
    return tree.read(path);
  } catch {
    return null;
  }
}

/** Run WSP151 over `declaration` and the tree as it is. */
function check(declaration: Declaration, tree: WorkspaceTree): WorkspaceDiagnostic[] {
  return CI_WORKFLOW_CHECKS.flatMap((c) => c.check({ declaration, tree, groups: [], kinds: new Map() as never, kindProblems: [] }));
}

/**
 * What `chant ci init` would write for the workspace at `root`, and the
 * generators it would run. Reads only; {@link applyCiInit} writes.
 */
export function proposeCiInit(root: string, options: CiInitOptions): CiInitProposal {
  const tree = workingTree(root);
  const current = readDeclaration(tree);
  if (current.file.endsWith(".jsonc")) {
    throw new WorkspaceReadError("declaration-invalid", `${current.file} is JSONC, which chant ci init does not rewrite, since its comments would be lost; add ci.workflow by hand, then rerun chant ci init for the rest`);
  }
  const repoRoot = gitTop(root) ?? root;
  const text = readFileSync(join(root, current.file), "utf-8");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const ci = isObject(raw.ci) ? { ...raw.ci } : {};
  ci.workflow = options.workflow;
  if (!isObject(ci.green)) ci.green = inferGreen(repoRoot);
  else if (!Array.isArray(ci.green.preMerge) || ci.green.preMerge.length === 0) {
    const inferred = inferGreen(repoRoot).preMerge;
    const declared = Object.keys((ci.green.phases as Record<string, unknown> | undefined) ?? {});
    const pick = inferred.filter((p) => declared.includes(p));
    ci.green = { ...ci.green, preMerge: pick.length > 0 ? pick : declared.slice(0, 1) };
  }
  const next: Record<string, unknown> = { ...raw, ci };
  const security = [...new Set([...((raw.security as SecurityGroup[] | undefined) ?? []), ...(options.security ?? [])])];
  if (security.length > 0) next.security = security;
  const after = editDeclarationText(text, raw, next);
  const proposed = parseDeclaration(after, current.file);

  const files: ProposedFile[] = [];
  if (after !== text) files.push({ path: current.file, before: text, after });
  const notes: string[] = [];
  const findings = check(proposed, tree);
  const reported = (code: string, entity?: string) => findings.some((f) => f.code === code && (entity === undefined || f.entity === entity));

  const forge = options.forge ?? inferForge(repoRoot);
  const releasing = proposed.members.filter((m) => (m.ciWorkflow ?? proposed.ci?.workflow) && (m.ciWorkflow !== null || tree.stat(join2(memberDir(m.dir), "chant.config.ts")) === "file"));
  const firstEnv = new Map<string, string>();
  for (const m of releasing) {
    const dir = memberDir(m.dir);
    const configPath = join2(dir, "chant.config.ts");
    const config = read(tree, configPath);
    let order = config === null ? [] : (staticPromotionOrder(config) ?? null);
    if (reported("ci-workflow-no-environments", m.name) && config !== null) {
      const edited = withEnvironments(config);
      if (edited) {
        files.push({ path: configPath, before: config, after: edited });
        order = DEFAULT_ENVIRONMENTS.map((name) => ({ name, canary: false }));
        notes.push(`${configPath}: ${DEFAULT_ENVIRONMENTS.join(", ")} is a guess at the promotion order; edit it if yours differs.`);
      } else {
        notes.push(`${configPath}: add environments, the promotion order; its default export is not a plain object, so chant ci init leaves it alone.`);
      }
    }
    const names = (order ?? []).map((s) => s.name);
    if (names.length > 0) firstEnv.set(m.name, names[0]!);
    if (reported("ci-workflow-no-components", m.name)) {
      const stubPath = join2(dir, `${m.name}.component.ts`);
      if (!tree.stat(stubPath)) files.push({ path: stubPath, before: null, after: componentStub(m.name, names[names.length - 1] ?? "the last environment") });
    }
    for (const f of findings.filter((f) => f.code === "ci-workflow-ungated-env" && f.entity === m.name)) {
      notes.push(`${f.treeFile}: add a gate() step, so a promote to the last environment waits on an approval; chant ci init does not edit a component you wrote.`);
    }
  }

  const commands: ProposedCommand[] = [];
  if (forge === null && (reported("ci-workflow-pipeline-missing") || reported("ci-workflow-pipeline-differs") || reported("ci-workflow-publish-missing"))) {
    notes.push("No .github/workflows, .forgejo/workflows or .gitlab-ci.yml was found, so no pipeline is generated; rerun with --forge github|gitlab|forgejo.");
  } else if (forge !== null) {
    if (reported("ci-workflow-pipeline-missing") || reported("ci-workflow-pipeline-differs")) {
      for (const m of releasing) {
        const env = firstEnv.get(m.name);
        const workflow = m.ciWorkflow ?? proposed.ci!.workflow!;
        commands.push({
          cwd: memberDir(m.dir) || ".",
          // The root member builds alone: at a workspace root, chant build refuses without --root-only (WSP000).
          args: ["build", "--components", "--generate", forge, "--pr-loop", ...(m.dir === "." ? ["--root-only"] : []), ...(env ? ["--env", env] : []), ...(appliesOnMerge(workflow) ? ["--apply-on-merge"] : []), ...(appliesBeforeMerge(workflow) ? ["--apply-before-merge"] : [])],
          why: `the pull-request pipeline for ${m.name}: plan on a pull request, ${appliesBeforeMerge(workflow) ? "apply on request before merge, record" : appliesOnMerge(workflow) ? "apply" : "record"} on merge`,
        });
      }
      if (forge === "github") {
        // ci workflow refuses when no workflow holds a required phase's check run, so say so instead of running it.
        const green = proposed.ci?.green;
        const holding = green ? workflowsHolding(green, readWorkflowSources(repoRoot, CI_GREEN_WORKFLOW_FILE)).workflows : [];
        if (holding.length > 0) commands.push({ cwd: ".", args: ["ci", "workflow"], why: "the tick that tags green commits" });
        else notes.push("No workflow in .github/workflows runs a job of a required ci.green phase on the branch yet, so the tick is not generated; add your CI, name its jobs in ci.green.phases, then rerun chant ci init.");
      }
      else notes.push(`${forge} has no check runs for ci tick to read; set ci.green.source to runs and run chant ci tick from a scheduled job (see the green-commits guide).`);
    }
    if (reported("ci-workflow-publish-missing")) commands.push({ cwd: ".", args: ["release", "workflow", "--forge", forge], why: "the publish job for release/** tags" });
  }
  return { files, commands, notes, findings };
}

/** A unified-style diff of two texts, for the proposal. Line-based, from their longest common subsequence. */
export function lineDiff(path: string, before: string | null, after: string): string {
  const a = before === null ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  // Keep three lines of context around each change.
  const keep = new Set<number>();
  out.forEach((l, k) => {
    if (k < 2 || l.startsWith("+ ") || l.startsWith("- ")) for (let d = -3; d <= 3; d++) keep.add(k + d);
  });
  const shown: string[] = [];
  let skipped = false;
  out.forEach((l, k) => {
    if (keep.has(k)) {
      shown.push(l);
      skipped = false;
    } else if (!skipped) {
      shown.push("  ...");
      skipped = true;
    }
  });
  return shown.join("\n");
}

/** Write the proposal's files. A file it would create that now exists is refused, and nothing is written. */
export function applyCiInit(root: string, proposal: CiInitProposal): string[] {
  for (const f of proposal.files) {
    if (f.before === null && existsSync(join(root, f.path))) throw new Error(`${f.path} appeared after the proposal was made; nothing written`);
    if (f.before !== null && readFileSync(join(root, f.path), "utf-8") !== f.before) throw new Error(`${f.path} changed after the proposal was made; nothing written`);
  }
  for (const f of proposal.files) writeFileSync(join(root, f.path), f.after, f.before === null ? { flag: "wx" } : {});
  return proposal.files.map((f) => f.path);
}

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    rl.question(question, (answer) => {
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
      rl.close();
    });
    rl.on("close", () => resolveAnswer(false));
  });
}

/** Run a chant command the way this process was run, so `npx chant` and a source checkout both work. */
function runChant(cwd: string, args: string[]): number {
  const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, ...args], { cwd, stdio: "inherit" });
  return r.status ?? 1;
}

export async function runCiInit(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const workflow = (args.ciWorkflows ?? [])[0];
  if (!workflow || !(CI_WORKFLOWS as readonly string[]).includes(workflow) || (args.ciWorkflows ?? []).length > 1) {
    console.error(formatError({ message: `--workflow names one of ${CI_WORKFLOWS.join(", ")}`, hint: USAGE }));
    return 1;
  }
  if (args.forge !== undefined && !(RELEASE_WORKFLOW_FORGES as readonly string[]).includes(args.forge)) {
    console.error(formatError({ message: `--forge ${JSON.stringify(args.forge)} is not one of ${RELEASE_WORKFLOW_FORGES.join(", ")}`, hint: USAGE }));
    return 1;
  }
  const security = args.securityGroups ?? [];
  const unknown = security.filter((g) => !(SECURITY_GROUPS as readonly string[]).includes(g));
  if (unknown.length > 0) {
    console.error(formatError({ message: `--security ${unknown.join(", ")} is not a group; the groups are ${SECURITY_GROUPS.join(", ")}`, hint: USAGE }));
    return 1;
  }
  const found = findWorkspaceRoot(process.cwd());
  if (!found) {
    console.error(formatError({ message: "no chant.workspace.json between this directory and the git root", hint: "Run chant workspace init first, then chant ci init." }));
    return 1;
  }
  const root = realpathSync(found.dir);
  let proposal: CiInitProposal;
  try {
    proposal = proposeCiInit(root, { workflow: workflow as CiWorkflow, ...(args.forge ? { forge: args.forge as ReleaseWorkflowForge } : {}), security: security as SecurityGroup[] });
  } catch (err) {
    console.error(formatError({ message: `chant ci init: ${err instanceof WorkspaceReadError ? err.describe() : (err as Error).message}`, hint: USAGE }));
    return 1;
  }
  if (proposal.files.length === 0 && proposal.commands.length === 0) {
    for (const n of proposal.notes) console.log(n);
    console.log(formatSuccess(`The workspace has what ${workflow} needs; chant workspace check reports anything left.`));
    return 0;
  }
  for (const f of proposal.files) {
    console.log(lineDiff(f.path, f.before, f.after));
    console.log("");
  }
  if (proposal.commands.length > 0) {
    console.log("Then runs:");
    for (const c of proposal.commands) console.log(`  (in ${c.cwd}) chant ${c.args.join(" ")}    # ${c.why}`);
    console.log("");
  }
  for (const n of proposal.notes) console.log(`Note: ${n}`);
  if (security.length === 0) console.log(`No security group is turned on. Add one later with chant ci init --workflow ${workflow} --security <group>: ${SECURITY_GROUPS.join(", ")}.`);
  console.log("");

  let write = !!args.yes;
  if (!write) {
    if (!process.stdin.isTTY) {
      console.log("Nothing written. Re-run with --yes to write it.");
      return 0;
    }
    write = await confirm("Write these files and run the generators? [y/N] ");
  }
  if (!write) {
    console.log("Nothing written.");
    return 0;
  }
  try {
    for (const path of applyCiInit(root, proposal)) console.log(`Wrote ${path}`);
  } catch (err) {
    console.error(formatError({ message: `chant ci init: ${(err as Error).message}`, hint: "Rerun chant ci init to see a fresh proposal." }));
    return 1;
  }
  for (const c of proposal.commands) {
    const status = runChant(join(root, c.cwd), c.args);
    if (status !== 0) {
      console.error(formatError({ message: `chant ${c.args.join(" ")} failed in ${c.cwd}`, hint: "Fix what it reports and rerun chant ci init; it proposes only what is still missing." }));
      return 1;
    }
  }
  console.log(formatSuccess("Done. chant workspace check reports what the workflow still lacks, such as the component stubs to fill in."));
  return 0;
}

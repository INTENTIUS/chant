/**
 * `chant workspace exit` (#3177): leave a member, or the workspace, in one
 * step, and prove on every commit that leaving still works.
 *
 * Per member kind:
 *
 * - `chant`: build once per lexicon and commit the native output under
 *   `native/`, rewrite the member's CI files to call the platform's own CLI,
 *   drop the chant dependencies and `chant.config.*`, and set the member to
 *   `other` with its outputs listed. Where an Op's `op.json` sits in the
 *   member and the Op is linear (shell steps only), a plain CI job is written
 *   beside it. The `op.json` stays.
 * - `choudoufu`: the roundtrip in choudoufu's `live/MIGRATE.md`. It needs
 *   stock OpenTofu and the estate's state, so the exit lists its steps and
 *   changes no file.
 * - every other kind (`other`, records, ledgers, `workspace`, `repo`): kept
 *   as files.
 *
 * The functions here work on a plain directory, so the same code runs in the
 * staging worktree (`exit-cli.ts`) and in the drill's scratch copy.
 * {@link runExitDrill} runs the exit on a scratch copy of a workspace and
 * checks the result statically: it proves each member holds what a stock
 * tool needs and nothing that needs chant. It never installs chant or calls
 * a cloud, so it is a unit-level check CI can run on every commit.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { readDeclaration, type Member } from "./declaration";
import { setProperty } from "./json-edit";
import type { ReasonCode } from "./reason-codes";
import { workingTree } from "./tree";

/** Runs `chant build` in a directory. The same shape as `ChantRunner` in lineage-upgrade.ts. */
export type ExitBuildRunner = (command: "build", cwd: string, args: readonly string[]) => Promise<{ exitCode: number; output: string }>;

// ── Native targets ───────────────────────────────────────────────────────────

export interface NativeTarget {
  /** What the output is. */
  describes: string;
  /** The file under the member's `native/` directory, or a path from the member's directory when `inMember`. */
  file: string;
  /** The file is written at this path from the member's directory rather than under `native/`. */
  inMember?: boolean;
  /** The stock command that deploys it, given the committed file's path from the member's directory and the member name. Null when there is nothing to deploy (CI files, collector config). */
  deploy: ((file: string, member: string) => string) | null;
}

/** The lexicons `workspace exit` knows a native target for. */
export const NATIVE_TARGETS: Record<string, NativeTarget> = {
  aws: {
    describes: "CloudFormation template",
    file: "template.json",
    deploy: (f, m) => `aws cloudformation deploy --template-file ${f} --stack-name ${m} --capabilities CAPABILITY_NAMED_IAM`,
  },
  azure: {
    describes: "ARM template",
    file: "azuredeploy.json",
    deploy: (f, m) => `az deployment group create --resource-group ${m} --template-file ${f}`,
  },
  gcp: { describes: "Config Connector objects", file: "config-connector.yaml", deploy: (f) => `kubectl apply -f ${f}` },
  k8s: { describes: "Kubernetes YAML", file: "k8s.yaml", deploy: (f) => `kubectl apply -f ${f}` },
  docker: { describes: "Compose file", file: "docker-compose.yml", deploy: (f) => `docker compose -f ${f} up -d` },
  otel: { describes: "OpenTelemetry collector config", file: "otel-collector.yaml", deploy: null },
  github: { describes: "GitHub Actions workflow", file: ".github/workflows/chant-exit.yml", inMember: true, deploy: null },
  gitlab: { describes: "GitLab CI file", file: ".gitlab-ci.yml", inMember: true, deploy: null },
};

/** The lexicons a member's `chant.config.*` or `package.json` names, in order. */
export function memberLexicons(dir: string): string[] {
  for (const name of ["chant.config.ts", "chant.config.js", "chant.config.mjs"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const m = /lexicons\s*:\s*\[([^\]]*)\]/.exec(readFileSync(file, "utf-8"));
    if (m) return [...m[1]!.matchAll(/["'`]([\w-]+)["'`]/g)].map((x) => x[1]!);
  }
  const pkg = readJson(join(dir, "package.json"));
  const found: string[] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    for (const dep of Object.keys((pkg?.[section] as Record<string, string> | undefined) ?? {})) {
      const m = /^@intentius\/chant-lexicon-([\w-]+)$/.exec(dep);
      if (m && !found.includes(m[1]!)) found.push(m[1]!);
    }
  }
  return found;
}

// ── The plan ─────────────────────────────────────────────────────────────────

export type ExitAction = "native-build" | "choudoufu-roundtrip" | "keep";

/** Why a chant member cannot be exited. Closed; each is in `reason-codes.ts`. */
export const EXIT_REFUSAL_CODES = ["missing-dir", "no-lexicon", "lexicon-unsupported"] as const satisfies readonly ReasonCode[];
export type ExitRefusalCode = (typeof EXIT_REFUSAL_CODES)[number];

export interface MemberPlan {
  name: string;
  dir: string;
  kind: string;
  action: ExitAction;
  lexicons: string[];
  /** Set when the member cannot be exited, with the reason code. */
  refused?: { code: ExitRefusalCode; message: string };
}

export interface ExitPlan {
  root: string;
  members: MemberPlan[];
}

export class ExitError extends Error {}

/** What exiting `names` (every exitable member when none are named) does, read from the declaration. */
export function planExit(root: string, names: readonly string[] = []): ExitPlan {
  const dec = readDeclaration(workingTree(root));
  const real = dec.members.filter((m) => m.type === "member");
  for (const n of names) {
    if (!real.some((m) => m.name === n)) throw new ExitError(`no member named "${n}" (members: ${real.map((m) => m.name).join(", ") || "none"})`);
  }
  const chosen = names.length > 0 ? real.filter((m) => names.includes(m.name)) : real;
  return { root, members: chosen.map((m) => planMember(root, m)) };
}

function planMember(root: string, m: Member): MemberPlan {
  const base = { name: m.name, dir: m.dir, kind: m.kind };
  if (m.kind === "choudoufu") return { ...base, action: "choudoufu-roundtrip", lexicons: [] };
  if (m.kind !== "chant") return { ...base, action: "keep", lexicons: [] };
  const abs = resolve(root, m.dir);
  if (!existsSync(abs)) return { ...base, action: "native-build", lexicons: [], refused: { code: "missing-dir", message: `${m.dir} does not exist` } };
  const lexicons = memberLexicons(abs);
  if (lexicons.length === 0) {
    return { ...base, action: "native-build", lexicons, refused: { code: "no-lexicon", message: "no lexicon is named in chant.config.* or package.json, so there is nothing to build" } };
  }
  const unknown = lexicons.filter((l) => !NATIVE_TARGETS[l]);
  if (unknown.length > 0) {
    return {
      ...base,
      action: "native-build",
      lexicons,
      refused: { code: "lexicon-unsupported", message: `no native target for lexicon ${unknown.join(", ")} (supported: ${Object.keys(NATIVE_TARGETS).join(", ")})` },
    };
  }
  return { ...base, action: "native-build", lexicons };
}

// ── Doing the exit in a directory ────────────────────────────────────────────

export interface MemberResult {
  name: string;
  dir: string;
  kind: string;
  status: "exited" | "kept" | "manual" | "refused" | "failed";
  /** Why the member was refused; set only with status `refused`. */
  code?: ExitRefusalCode;
  /** Native files written, relative to the workspace root. */
  native: string[];
  /** The stock command for each native file, relative to the member's directory. */
  deploy: string[];
  /** CI files rewritten or written, relative to the workspace root. */
  ci: string[];
  /** `op.json` files left in place, relative to the workspace root. */
  ops: string[];
  /** Steps a person runs, for a member the exit cannot do alone. */
  steps: string[];
  detail?: string;
}

export interface ExitResult {
  members: MemberResult[];
}

const CHANT_FILES = ["chant.config.ts", "chant.config.js", "chant.config.mjs", "chant.config.json"];
const CI_GLOBS = [".github/workflows", "ci", ".circleci"];
const CI_ROOT_FILES = [".gitlab-ci.yml", ".gitlab-ci.yaml"];

/** The choudoufu roundtrip, in order (`live/MIGRATE.md`). Run with stock OpenTofu. */
export function choudoufuSteps(member: string, dir: string): string[] {
  return [
    `cd ${dir}`,
    "copy the cache to terraform.tfstate",
    "remove the live block from the estate",
    `CHOUDOUFU_UNMIGRATE=${member} tofu plan   # stock's first plan removes the two marker tags`,
    "tofu apply",
  ];
}

/**
 * Exit the planned members in the tree at `plan.root`, editing it in place.
 * Builds through `runBuild`, so a test can supply output without chant.
 */
export async function exitInDir(plan: ExitPlan, runBuild: ExitBuildRunner): Promise<ExitResult> {
  const results: MemberResult[] = [];
  for (const m of plan.members) {
    const result: MemberResult = { name: m.name, dir: m.dir, kind: m.kind, status: "kept", native: [], deploy: [], ci: [], ops: [], steps: [] };
    results.push(result);
    if (m.refused) {
      result.status = "refused";
      result.code = m.refused.code;
      result.detail = `${m.refused.code}: ${m.refused.message}`;
      continue;
    }
    if (m.action === "choudoufu-roundtrip") {
      result.status = "manual";
      result.steps = choudoufuSteps(m.name, m.dir);
      result.detail = "needs stock OpenTofu and the estate's state; the exit changes no file";
      continue;
    }
    if (m.action === "keep") continue;
    const abs = resolve(plan.root, m.dir);
    const outputs: string[] = [];
    for (const lexicon of m.lexicons) {
      const target = NATIVE_TARGETS[lexicon]!;
      const rel = target.inMember ? target.file : `native/${target.file}`;
      const out = join(abs, rel);
      mkdirSync(dirname(out), { recursive: true });
      const run = await runBuild("build", abs, [".", "--lexicon", lexicon, "--output", out]);
      if (run.exitCode !== 0 || !existsSync(out) || statSync(out).size === 0) {
        result.status = "failed";
        result.detail = `chant build --lexicon ${lexicon} failed${run.output ? `: ${run.output.trim().split("\n").slice(-5).join("\n")}` : ""}`;
        break;
      }
      result.native.push(relPath(plan.root, out));
      if (target.deploy) result.deploy.push(target.deploy(rel, m.name));
      outputs.push(rel);
    }
    if (result.status === "failed") continue;
    result.ci = rewriteCi(plan.root, abs, result.deploy);
    result.ops = collectOps(plan.root, abs);
    for (const op of linearOpJobs(plan.root, abs)) result.ci.push(op);
    dropChant(abs);
    result.status = "exited";
  }
  setKindOther(plan.root, results.filter((r) => r.status === "exited"));
  return { members: results };
}

function relPath(root: string, p: string): string {
  return relative(root, p).split("\\").join("/");
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function walk(dir: string, visit: (file: string) => void): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "native") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, visit);
    else visit(p);
  }
}

function ciFiles(abs: string): string[] {
  const out: string[] = [];
  for (const d of CI_GLOBS) walk(join(abs, d), (f) => /\.ya?ml$/.test(f) && out.push(f));
  for (const f of CI_ROOT_FILES) if (existsSync(join(abs, f))) out.push(join(abs, f));
  return out;
}

const CHANT_CALL = /^(\s*(?:-\s+)?(?:run:\s*)?)(?:npx\s+|pnpm\s+exec\s+|npm\s+exec\s+(?:--\s+)?)?chant\s+(?:build|deploy|apply)\b.*$/;

/**
 * Replace each `chant build|deploy|apply` line of the member's CI files with
 * the stock commands that deploy its native output. A line with no stock
 * command to replace it (CI output, a collector config) is removed.
 */
function rewriteCi(root: string, abs: string, deploy: readonly string[]): string[] {
  const changed: string[] = [];
  for (const file of ciFiles(abs)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    let touched = false;
    const next: string[] = [];
    for (const line of lines) {
      const m = CHANT_CALL.exec(line);
      if (!m) {
        next.push(line);
        continue;
      }
      touched = true;
      const lead = m[1]!;
      if (deploy.length === 0) continue;
      const inline = /run:/.test(lead);
      if (inline) {
        next.push(`${lead}${deploy.join(" && ")}`);
      } else {
        const indent = lead.replace(/-\s+$/, "").replace(/\S.*$/, "");
        deploy.forEach((d, i) => next.push(i === 0 ? `${lead}${d}` : `${indent}${d}`));
      }
    }
    if (touched) {
      writeFileSync(file, next.join("\n"));
      changed.push(relPath(root, file));
    }
  }
  return changed;
}

/** `op.json` files under the member's `dist/ops/<name>/` or anywhere beside generated Ops. They stay. */
function collectOps(root: string, abs: string): string[] {
  const out: string[] = [];
  walk(abs, (f) => f.endsWith(`${"/"}op.json`) && out.push(relPath(root, f)));
  return out.sort();
}

interface OpJson {
  name?: string;
  phases?: { parallel?: boolean; steps?: { kind?: string; fn?: string; args?: { cmd?: unknown } }[] }[];
  onFailure?: unknown[];
}

/** The plain commands of a linear Op, or undefined when the Op is not linear. */
export function linearCommands(op: OpJson): string[] | undefined {
  const cmds: string[] = [];
  for (const phase of op.phases ?? []) {
    if (phase.parallel) return undefined;
    for (const step of phase.steps ?? []) {
      if (step.kind !== "activity" || step.fn !== "shellCmd" || typeof step.args?.cmd !== "string") return undefined;
      cmds.push(step.args.cmd);
    }
  }
  if ((op.onFailure ?? []).length > 0) return undefined;
  return cmds.length > 0 ? cmds : undefined;
}

/** For each linear Op, a plain GitHub Actions job beside its `op.json`. */
function linearOpJobs(root: string, abs: string): string[] {
  const written: string[] = [];
  walk(abs, (f) => {
    if (!f.endsWith("/op.json")) return;
    const op = readJson(f) as OpJson | undefined;
    const cmds = op && linearCommands(op);
    if (!op || !cmds) return;
    const out = join(dirname(f), "job.yml");
    const name = op.name ?? "op";
    writeFileSync(
      out,
      [
        `# Written by chant workspace exit from ${name}'s op.json. The op is linear, so it is one job.`,
        `name: ${name}`,
        "on: workflow_dispatch",
        "jobs:",
        `  ${name.replace(/[^\w-]/g, "-")}:`,
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        ...cmds.map((c, i) => `      - name: step ${i + 1}\n        run: ${JSON.stringify(c)}`),
        "",
      ].join("\n"),
    );
    written.push(relPath(root, out));
  });
  return written;
}

/** Remove chant.config.* and the chant dependencies and scripts from the member's package.json. */
function dropChant(abs: string): void {
  for (const f of CHANT_FILES) rmSync(join(abs, f), { force: true });
  const file = join(abs, "package.json");
  const pkg = readJson(file);
  if (!pkg) return;
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[section] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const d of Object.keys(deps)) if (d === "@intentius/chant" || d.startsWith("@intentius/chant-")) delete deps[d];
    if (Object.keys(deps).length === 0) delete pkg[section];
  }
  const scripts = pkg.scripts as Record<string, string> | undefined;
  if (scripts) {
    for (const [k, v] of Object.entries(scripts)) if (/\bchant\b/.test(v)) delete scripts[k];
    if (Object.keys(scripts).length === 0) delete pkg.scripts;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Set each exited member to kind `other` in the declaration, with `because` and its outputs. */
function setKindOther(root: string, exited: MemberResult[]): void {
  if (exited.length === 0) return;
  const dec = readDeclaration(workingTree(root));
  const file = ["chant.workspace.json", "chant.workspace.jsonc"].find((f) => existsSync(join(root, f)))!;
  const jsonc = file.endsWith("c");
  let text = readFileSync(join(root, file), "utf-8");
  const raw = (JSON.parse(jsonc ? text.replace(/^\s*\/\/.*$/gm, "") : text) as { members: { name?: string }[] }).members;
  for (const r of exited) {
    const i = raw.findIndex((e) => e.name === r.name);
    if (i < 0) continue;
    const ptr = `/members/${i}`;
    const member = dec.members.find((m) => m.type === "member" && m.name === r.name);
    text = setProperty(text, jsonc, ptr, "kind", "other");
    text = setProperty(text, jsonc, ptr, "because", `left chant with chant workspace exit; its native output is committed under ${r.native.map((n) => relPath(join(root, r.dir), join(root, n))).join(", ")}`);
    const outputs = member?.outputs ?? [];
    if (outputs.length > 0) text = setProperty(text, jsonc, ptr, "outputs", outputs);
  }
  writeFileSync(join(root, file), text);
}

// ── The drill ────────────────────────────────────────────────────────────────

/** What the exit drill finds wrong with an exited member. Closed; each is in `reason-codes.ts`. */
export const DRILL_CODES = [
  "native-missing",
  "native-unreadable",
  "chant-dependency",
  "chant-config-left",
  "chant-in-ci",
  "no-deploy-command",
  "declaration-not-other",
  "exit-failed",
  "choudoufu-steps-missing",
] as const satisfies readonly ReasonCode[];
export type DrillCode = (typeof DRILL_CODES)[number];

/** Every code `workspace exit` prints: why a member was refused, and what the drill found. */
export const EXIT_CODES = [...EXIT_REFUSAL_CODES, ...DRILL_CODES] as const;

export interface DrillFinding {
  code: DrillCode;
  message: string;
}

export interface DrillMember {
  name: string;
  kind: string;
  status: "passed" | "failed" | "not-run" | "kept";
  /** Why it is `not-run` or `kept`. */
  note?: string;
  findings: DrillFinding[];
  native: string[];
  deploy: string[];
}

export interface DrillReport {
  /** True when no member failed. A `not-run` member does not fail the drill; it is listed. */
  ok: boolean;
  members: DrillMember[];
}

export interface DrillOptions {
  /** The workspace root to drill. It is copied; the tree is not touched. */
  root: string;
  /** Limit to these members. */
  members?: readonly string[];
  /** Builds a member's native output. */
  runBuild: ExitBuildRunner;
}

/** Copy a workspace, leaving out `node_modules`, `.git` and chant's own scratch. */
export function copyWorkspace(from: string, to: string): void {
  const skip = new Set(["node_modules", ".git", ".chant"]);
  const copy = (src: string, dst: string): void => {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s = join(src, e.name);
      const d = join(dst, e.name);
      if (e.isDirectory()) copy(s, d);
      else if (e.isFile()) copyFileSync(s, d);
    }
  };
  copy(from, to);
}

const CHANT_IN_CI = /\bchant\s+(?:build|lint|deploy|apply|run|workspace|ci)\b|@intentius\/chant\b/;

/**
 * Run the exit on a scratch copy and check each member for what a stock tool
 * needs. Nothing here runs chant or a cloud; the build is the one injected
 * step, and its output is read as text.
 */
export async function runExitDrill(opts: DrillOptions): Promise<DrillReport> {
  const scratch = mkdtempSync(join(tmpdir(), "chant-exit-drill-"));
  try {
    copyWorkspace(opts.root, scratch);
    const plan = planExit(scratch, opts.members ?? []);
    const result = await exitInDir(plan, opts.runBuild);
    return verifyExit(scratch, result);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Check an exited tree at `root` against what {@link exitInDir} reported. */
export function verifyExit(root: string, result: ExitResult): DrillReport {
  const declared = new Map(readDeclaration(workingTree(root)).members.filter((m) => m.type === "member").map((m) => [m.name, m]));
  const members = result.members.map((r) => checkMember(root, r, declared.get(r.name)));
  return { ok: members.every((m) => m.status !== "failed"), members };
}

function checkMember(root: string, r: MemberResult, declared: Member | undefined): DrillMember {
  const base = { name: r.name, kind: r.kind, native: r.native, deploy: r.deploy };
  const findings: DrillFinding[] = [];
  if (r.status === "kept") return { ...base, status: "kept", note: `kind ${r.kind} stays as files`, findings };
  if (r.status === "manual") {
    if (r.steps.length === 0) findings.push({ code: "choudoufu-steps-missing", message: "the roundtrip steps were not listed" });
    return findings.length > 0
      ? { ...base, status: "failed", findings }
      : { ...base, status: "not-run", note: "the stock OpenTofu roundtrip (copy the cache to terraform.tfstate, remove the live block, plan) is not run, needs the maintainer", findings };
  }
  if (r.status !== "exited") {
    return { ...base, status: "failed", findings: [{ code: "exit-failed", message: r.detail ?? `exit ${r.status}` }] };
  }
  const abs = resolve(root, r.dir);
  for (const n of r.native) {
    const p = join(root, n);
    if (!existsSync(p) || statSync(p).size === 0) {
      findings.push({ code: "native-missing", message: `${n} is missing or empty` });
      continue;
    }
    const text = readFileSync(p, "utf-8");
    if (p.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch (e) {
        findings.push({ code: "native-unreadable", message: `${n} is not valid JSON: ${(e as Error).message}` });
      }
    } else if (/^\s*$/.test(text) || /^\s*[{[]?\s*[}\]]?\s*$/.test(text)) {
      findings.push({ code: "native-unreadable", message: `${n} has no content` });
    }
  }
  const deployable = r.native.filter((n) => !/\.github\/|\.gitlab-ci|otel-collector/.test(n));
  if (deployable.length > 0 && r.deploy.length === 0) findings.push({ code: "no-deploy-command", message: "a native file has no stock deploy command" });

  for (const f of CHANT_FILES) if (existsSync(join(abs, f))) findings.push({ code: "chant-config-left", message: `${join(r.dir, f)} is still there` });
  const pkg = readJson(join(abs, "package.json"));
  if (pkg) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const d of Object.keys((pkg[section] as Record<string, string> | undefined) ?? {})) {
        if (d === "@intentius/chant" || d.startsWith("@intentius/chant-")) findings.push({ code: "chant-dependency", message: `package.json ${section} still has ${d}` });
      }
    }
    for (const [k, v] of Object.entries((pkg.scripts as Record<string, string> | undefined) ?? {})) {
      if (/\bchant\b/.test(v)) findings.push({ code: "chant-dependency", message: `package.json script "${k}" still calls chant` });
    }
  }
  for (const f of ciFiles(abs)) {
    const text = readFileSync(f, "utf-8");
    const bad = text.split("\n").find((l) => CHANT_IN_CI.test(l) && !l.trim().startsWith("#"));
    if (bad) findings.push({ code: "chant-in-ci", message: `${relPath(root, f)} still calls chant: ${bad.trim()}` });
  }
  if (declared && declared.kind !== "other") findings.push({ code: "declaration-not-other", message: `the declaration still has kind ${declared.kind}` });
  return { ...base, status: findings.length > 0 ? "failed" : "passed", findings };
}

/** The drill report as lines for a terminal. */
export function describeDrill(report: DrillReport): string[] {
  const lines: string[] = [];
  for (const m of report.members) {
    lines.push(`${m.name}  ${m.kind}  ${m.status}${m.note ? ` (${m.note})` : ""}`);
    for (const f of m.findings) lines.push(`  ${f.code}: ${f.message}`);
  }
  lines.push(report.ok ? "exit drill passed" : "exit drill failed");
  return lines;
}

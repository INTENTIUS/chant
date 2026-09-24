/**
 * The generated-file checks (#2541, #2524 D14).
 *
 * A member lists the files a command writes in its `generated` entries, each
 * with the command line that writes it and the sources it reads. Core adds
 * the files `chant update` rewrites, `skills/*\/SKILL.md`, as implicit entries
 * of every `chant` member (`../generated-files.ts` holds that list, and the
 * lineage lock classes files from the same list).
 *
 * - `WSP101`: a generated file differs from what its generator writes.
 * - `WSP102`: a declared generated file does not exist.
 * - `WSP103`: a generator could not be run, failed, or wrote nothing.
 * - `WSP104` (info): an entry is kept by hand, with the reason it gives.
 * - `WSP105` (info): an entry was not compared, because its generator runs
 *   only on request or its output can't be produced without running code.
 * - `WSP106`: an entry names a source that does not exist.
 *
 * They were WSP081 to WSP086 until #2641 moved them, since the pipeline
 * checks of #2542 hold WSP081 to WSP083.
 *
 * What runs by default is what needs no member code: the file and its
 * sources exist, and each implicit `SKILL.md` matches what the member's
 * lexicons render, with the lexicons read from its config statically.
 * Declared generators are commands that load member code and take seconds
 * each, so they run only when asked ({@link GatherOptions.runGenerators},
 * `chant workspace check --generated`).
 *
 * The checks are a pure function over {@link GeneratedFileFacts};
 * {@link gatherGeneratedFacts} collects those facts from a checkout, and
 * `chant workspace check` gathers them before it runs
 * {@link GENERATED_CHECKS} (#2641).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import type { WorkspaceCheck } from "../checks";
import type { Declaration, Member } from "../declaration";
import { gitTop } from "../tree";

export const WSP_GENERATED_DRIFT = "WSP101";
export const WSP_GENERATED_MISSING = "WSP102";
export const WSP_GENERATOR_FAILED = "WSP103";
export const WSP_GENERATED_HAND_WRITTEN = "WSP104";
export const WSP_GENERATED_NOT_COMPARED = "WSP105";
export const WSP_GENERATED_SOURCE_MISSING = "WSP106";

export type GeneratedCheckId =
  | typeof WSP_GENERATED_DRIFT
  | typeof WSP_GENERATED_MISSING
  | typeof WSP_GENERATOR_FAILED
  | typeof WSP_GENERATED_HAND_WRITTEN
  | typeof WSP_GENERATED_NOT_COMPARED
  | typeof WSP_GENERATED_SOURCE_MISSING;

export interface GeneratedFinding {
  id: GeneratedCheckId;
  severity: "error" | "info";
  member: string;
  /** The file, relative to the workspace root. A glob for an implicit entry that could not be rendered. */
  path: string;
  /** A JSON Pointer into the declaration: the entry, or the member for an implicit file. */
  pointer: string;
  message: string;
}

/** What the generator produced for one file. */
export type GeneratorOutput =
  | { status: "produced"; sha256: string }
  | { status: "failed"; message: string }
  | { status: "not-run"; reason: string };

/** What the checks need to know about one generated file. */
export interface GeneratedFileFacts {
  member: string;
  /** The member's directory, relative to the workspace root. */
  memberDir: string;
  /** The file, relative to the workspace root. */
  path: string;
  pointer: string;
  /** The command line that writes the file. */
  generator: string;
  /** True for a file core registers (`skills/*\/SKILL.md`), false for a declared entry. */
  implicit: boolean;
  /** The reason, when the entry is kept by hand. */
  handWritten: string | null;
  /** Declared sources that do not exist, relative to the workspace root. */
  missingSources: string[];
  /** sha256 hex of the file in the tree, or null when it is missing. */
  current: string | null;
  output: GeneratorOutput;
}

const where = (f: GeneratedFileFacts) => (f.memberDir === "." ? "the workspace root" : f.memberDir);

function finding(f: GeneratedFileFacts, id: GeneratedCheckId, severity: GeneratedFinding["severity"], message: string): GeneratedFinding {
  return { id, severity, member: f.member, path: f.path, pointer: f.pointer, message };
}

/** Every generated-file finding, in the order of the facts. */
export function checkGenerated(facts: readonly GeneratedFileFacts[]): GeneratedFinding[] {
  const out: GeneratedFinding[] = [];
  for (const f of facts) {
    if (f.handWritten !== null) {
      out.push(
        finding(f, WSP_GENERATED_HAND_WRITTEN, "info", `${f.path} is kept by hand, so \`${f.generator}\` is not run for it: ${f.handWritten}`),
      );
      continue;
    }
    for (const s of f.missingSources) {
      out.push(finding(f, WSP_GENERATED_SOURCE_MISSING, "error", `member ${f.member} lists ${s} as a source of ${f.path}, and ${s} does not exist`));
    }
    if (f.current === null && !f.implicit) {
      out.push(finding(f, WSP_GENERATED_MISSING, "error", `${f.path} does not exist; run \`${f.generator}\` in ${where(f)} and commit the file`));
      continue;
    }
    const o = f.output;
    if (o.status === "not-run") {
      out.push(finding(f, WSP_GENERATED_NOT_COMPARED, "info", `${f.path} was not compared with its generator's output: ${o.reason}`));
    } else if (o.status === "failed") {
      out.push(finding(f, WSP_GENERATOR_FAILED, "error", `\`${f.generator}\` could not regenerate ${f.path}: ${o.message}`));
    } else if (f.current !== null && o.sha256 !== f.current) {
      const fix = f.implicit
        ? `run \`chant update\` in ${where(f)}, or list the file in member ${f.member}'s generated entries with handWritten and a reason`
        : `run \`${f.generator}\` in ${where(f)} and commit the result, or mark the entry handWritten with a reason`;
      out.push(finding(f, WSP_GENERATED_DRIFT, "error", `${f.path} differs from what \`${f.generator}\` writes; ${fix}`));
    }
  }
  return out;
}

// ── As workspace checks ──────────────────────────────────────────────────────

function generatedCheck(id: GeneratedCheckId, name: string, severity: GeneratedFinding["severity"], description: string): WorkspaceCheck {
  return {
    id,
    name,
    description,
    severity,
    configurable: true,
    check(ctx) {
      return checkGenerated(ctx.facts?.generated ?? [])
        .filter((f) => f.id === id)
        .map((f) => ({ checkId: id, severity: this.severity, message: f.message, entity: f.member, pointer: f.pointer }));
    },
  };
}

/** The generated-file checks, which read `ctx.facts.generated`. They find nothing when the facts were not gathered. */
export const GENERATED_CHECKS: readonly WorkspaceCheck[] = [
  generatedCheck(WSP_GENERATED_DRIFT, "generated-drift", "error", "A generated file is what its generator writes. Declared generators run only with --generated."),
  generatedCheck(WSP_GENERATED_MISSING, "generated-missing", "error", "Every declared generated file exists."),
  generatedCheck(WSP_GENERATOR_FAILED, "generator-failed", "error", "A declared generator runs, exits 0 and writes the file."),
  generatedCheck(WSP_GENERATED_HAND_WRITTEN, "generated-hand-written", "info", "An entry kept by hand is reported with its reason, and its generator is not run."),
  generatedCheck(WSP_GENERATED_NOT_COMPARED, "generated-not-compared", "info", "An entry not compared with its generator's output is reported with the reason."),
  generatedCheck(WSP_GENERATED_SOURCE_MISSING, "generated-source-missing", "error", "Every source a generated entry names exists."),
];

// ── Facts from a checkout ────────────────────────────────────────────────────

/** The skills a member's lexicons render, keyed by path relative to the member. */
export type SkillRender =
  | { status: "rendered"; files: Map<string, string>; unread?: string }
  | { status: "unknown"; reason: string };

export type RenderSkills = (memberDir: string) => Promise<SkillRender>;

export interface GeneratorRun {
  cwd: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}

export type RunGenerator = (run: GeneratorRun) => { ok: true } | { ok: false; message: string };

export interface GatherOptions {
  /** Run each declared generator and compare its output. Off by default: generators run member code. */
  runGenerators?: boolean;
  /** How implicit skills are rendered. Defaults to {@link renderSkillsStatically}. */
  renderSkills?: RenderSkills;
  /** How a generator runs. Defaults to {@link spawnGenerator}. */
  runGenerator?: RunGenerator;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function hashOf(abs: string): string | null {
  return existsSync(abs) ? sha256(readFileSync(abs)) : null;
}

/**
 * Collect {@link GeneratedFileFacts} for every member of `declaration`, whose
 * workspace root is `root`: its declared entries, then, for a `chant`
 * member, its implicit `SKILL.md` files.
 */
export async function gatherGeneratedFacts(root: string, declaration: Declaration, options: GatherOptions = {}): Promise<GeneratedFileFacts[]> {
  const renderSkills = options.renderSkills ?? renderSkillsStatically;
  const runGenerator = options.runGenerator ?? spawnGenerator;
  const facts: GeneratedFileFacts[] = [];
  for (const m of declaration.members) {
    const memberAbs = join(root, m.dir);
    const rel = (p: string) => (m.dir === "." ? p : `${m.dir}/${p}`);
    const declared = new Set(m.generated.map((g) => g.path));
    for (const g of m.generated) {
      const abs = join(memberAbs, g.path);
      const current = hashOf(abs);
      const base = {
        member: m.name,
        memberDir: m.dir,
        path: rel(g.path),
        pointer: g.pointer,
        generator: g.generator,
        implicit: false,
        handWritten: g.handWritten?.because ?? null,
        missingSources: g.sources.filter((s) => !existsSync(join(root, s))),
        current,
      };
      let output: GeneratorOutput;
      if (g.handWritten || current === null) output = { status: "not-run", reason: "not needed" };
      else if (!options.runGenerators) output = { status: "not-run", reason: `its generator runs only with --generated, since it runs member code` };
      else output = regenerate(root, memberAbs, abs, g.generator, runGenerator);
      facts.push({ ...base, output });
    }
    if (m.kind === "chant") facts.push(...(await skillFacts(m, memberAbs, declared, renderSkills)));
  }
  return facts;
}

async function skillFacts(m: Member, memberAbs: string, declared: Set<string>, renderSkills: RenderSkills): Promise<GeneratedFileFacts[]> {
  const rel = (p: string) => (m.dir === "." ? p : `${m.dir}/${p}`);
  const base = { member: m.name, memberDir: m.dir, pointer: m.pointer, generator: "chant update", implicit: true, handWritten: null, missingSources: [] };
  let render: SkillRender;
  try {
    render = await renderSkills(memberAbs);
  } catch (err) {
    render = { status: "unknown", reason: `the member's lexicons could not be loaded (${err instanceof Error ? err.message : String(err)})` };
  }
  if (render.status === "unknown") {
    return [{ ...base, path: rel("skills/*/SKILL.md"), current: null, output: { status: "not-run", reason: render.reason } }];
  }
  const out: GeneratedFileFacts[] = [];
  for (const [path, content] of [...render.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // A declared entry, hand-written or not, speaks for the file instead.
    if (declared.has(path)) continue;
    const current = hashOf(join(memberAbs, path));
    // A skill chant update has not written (often gitignored) is not drift.
    if (current === null) continue;
    out.push({ ...base, path: rel(path), current, output: { status: "produced", sha256: sha256(content) } });
  }
  if (render.unread) {
    out.push({ ...base, path: rel("skills/*/SKILL.md"), current: null, output: { status: "not-run", reason: render.unread } });
  }
  return out;
}

/**
 * Render the skills `chant update` would write for the member at `memberDir`,
 * in this process. The member's `lexicons` are read from its config
 * statically, never by running it. Lexicons declared by module path are left
 * out, since loading one runs member code.
 */
export async function renderSkillsStatically(memberDir: string): Promise<SkillRender> {
  const { readLexiconDeclarationsStatically } = await import("../../config-static");
  const read = readLexiconDeclarationsStatically(memberDir);
  if (read.status === "no-config") return { status: "rendered", files: new Map() };
  if (read.status === "unknown") return { status: "unknown", reason: `the config's lexicons can't be read without running it (${read.reason})` };
  const packages = read.entries.filter((e): e is string => typeof e === "string");
  const byPath = read.entries.filter((e) => typeof e !== "string").map((e) => (e as { name: string }).name);
  const files = new Map<string, string>();
  if (packages.length > 0) {
    const { loadPlugins } = await import("../../cli/plugins");
    const { skillFilePath } = await import("../../cli/commands/update");
    for (const plugin of await loadPlugins(packages)) {
      for (const skill of plugin.skills?.() ?? []) files.set(skillFilePath(skill.name), skill.content);
    }
  }
  return {
    status: "rendered",
    files,
    ...(byPath.length > 0 ? { unread: `the skills of ${byPath.join(", ")}, declared by module path, would run member code to render` } : {}),
  };
}

// ── Running a generator ──────────────────────────────────────────────────────

/**
 * Split a command line into words, with '...' and "..." quoting and
 * backslash escapes. Returns undefined for anything a shell would interpret:
 * pipes, redirections, `;`, `&`, substitutions. A generator is one command.
 */
export function splitCommandLine(line: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "$" || line[j] === "`") return undefined;
        if (line[j] === "\\" && (line[j + 1] === '"' || line[j + 1] === "\\")) j++;
        word += line[j];
      }
      if (j >= line.length) return undefined;
      inWord = true;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return undefined;
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else if ("|&;<>()$`*?[]{}~#".includes(c) && !(inWord && c === "#")) {
      return undefined;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words.length > 0 ? words : undefined;
}

/** `node_modules/.bin` directories from `dir` up, nearest first, so `chant` is the member's own. */
export function binPath(dir: string): string[] {
  const out: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    const bin = join(d, "node_modules", ".bin");
    if (existsSync(bin)) out.push(bin);
    if (dirname(d) === d) return out;
  }
}

/** Run a generator with no shell, for up to ten minutes. */
export const spawnGenerator: RunGenerator = ({ cwd, argv, env }) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, message: r.error.message };
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-5).join("\n");
    return { ok: false, message: `exited with ${r.status ?? r.signal}${tail ? `:\n${tail}` : ""}` };
  }
  return { ok: true };
};

const OUTPUT_FLAGS = ["-o", "--output"];

/**
 * Produce the file at `target` (absolute) with `generator`, run in
 * `memberAbs`, without leaving anything changed in the tree. When the
 * command passes `-o` or `--output` with the file's path, that flag gets a
 * temporary path instead. Otherwise the generator writes in place, and the
 * git working tree is put back as it was afterwards.
 */
export function regenerate(root: string, memberAbs: string, target: string, generator: string, run: RunGenerator): GeneratorOutput {
  const argv = splitCommandLine(generator);
  if (!argv) return { status: "failed", message: "the generator is not a single command: quoting must balance, and pipes, redirections and shell expansions are not run" };
  const env = { ...process.env, PATH: [...binPath(memberAbs), process.env.PATH ?? ""].join(delimiter) };

  const at = (i: number) => resolve(memberAbs, argv[i]) === target;
  let flag = -1;
  let inline = false;
  for (let i = 0; i < argv.length; i++) {
    if (OUTPUT_FLAGS.includes(argv[i]) && i + 1 < argv.length && at(i + 1)) {
      flag = i + 1;
      break;
    }
    const eq = OUTPUT_FLAGS.map((f) => `${f}=`).find((p) => argv[i].startsWith(p));
    if (eq && resolve(memberAbs, argv[i].slice(eq.length)) === target) {
      flag = i;
      inline = true;
      break;
    }
  }

  if (flag >= 0) {
    const dir = mkdtempSync(join(tmpdir(), "chant-generated-"));
    try {
      const temp = join(dir, basename(target));
      const args = [...argv];
      args[flag] = inline ? `${argv[flag].slice(0, argv[flag].indexOf("=") + 1)}${temp}` : temp;
      const r = run({ cwd: memberAbs, argv: args, env });
      if (!r.ok) return { status: "failed", message: r.message };
      if (!existsSync(temp)) return { status: "failed", message: "it exited 0 and wrote nothing to its output path" };
      return { status: "produced", sha256: sha256(readFileSync(temp)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const top = gitTop(root);
  if (!top) return { status: "failed", message: "it writes in place, and chant runs an in-place generator only in a git checkout, which it can put back afterwards" };
  return withTreeRestored(top, [target], () => {
    const r = run({ cwd: memberAbs, argv, env });
    if (!r.ok) return { status: "failed", message: r.message };
    if (!existsSync(target)) return { status: "failed", message: "it exited 0 and left no file at the entry's path" };
    return { status: "produced", sha256: sha256(readFileSync(target)) };
  });
}

/** Paths git reports as changed or untracked, relative to `top`, with their status. */
function changedPaths(top: string): Map<string, string> {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: top, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  const parts = out.split("\0");
  const map = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    map.set(entry.slice(3), xy);
    // A rename or copy is followed by its original path.
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return map;
}

/**
 * Run `fn`, then put the working tree of the repository at `top` back as it
 * was: files that were clean are checked out from the index again, new
 * untracked files are removed, and files that were already changed get their
 * earlier bytes back. `extra` files (absolute) are restored too, whatever
 * git says about them, which covers a gitignored target. Files a generator
 * writes under ignored paths are otherwise left.
 */
export function withTreeRestored<T>(top: string, extra: string[], fn: () => T): T {
  const before = changedPaths(top);
  const snapshot = new Map<string, Buffer | null>();
  const keep = (rel: string) => {
    const abs = join(top, rel);
    let kind: "file" | "missing" | "other" = "missing";
    try {
      kind = statSync(abs).isFile() ? "file" : "other";
    } catch {
      // Missing: restoring means removing whatever appears there.
    }
    // A directory entry (a submodule) is left to git.
    if (kind !== "other") snapshot.set(rel, kind === "file" ? readFileSync(abs) : null);
  };
  for (const rel of before.keys()) keep(rel);
  for (const abs of extra) keep(relative(top, abs).split(sep).join("/"));
  try {
    return fn();
  } finally {
    const after = changedPaths(top);
    const checkout: string[] = [];
    for (const rel of new Set([...snapshot.keys(), ...after.keys()])) {
      const abs = join(top, rel);
      if (snapshot.has(rel)) {
        const was = snapshot.get(rel)!;
        const now = existsSync(abs) ? readFileSync(abs) : null;
        if (was === null && now !== null) rmSync(abs, { force: true });
        else if (was !== null && (now === null || !now.equals(was))) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, was);
        }
      } else if (after.get(rel) === "??") {
        rmSync(abs, { force: true });
      } else {
        checkout.push(rel);
      }
    }
    for (let i = 0; i < checkout.length; i += 200) {
      execFileSync("git", ["checkout", "--", ...checkout.slice(i, i + 200)], { cwd: top, stdio: "ignore" });
    }
  }
}

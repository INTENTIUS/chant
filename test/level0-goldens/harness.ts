/**
 * chant #2526 — shared machinery for the level-0 goldens.
 *
 * Rule 2 of #2525 says a project with no `chant.workspace.json` gets today's
 * output from `build`, `graph`, `lint`, `audit` and `run list`, byte for byte,
 * apart from the changes on the level-0 exception list. This file runs the
 * real CLI the way a user does, so a test can hold that output against a
 * committed golden.
 *
 * How a command runs:
 *
 * - On a fresh copy of the example, never in the repo tree. `chant build`
 *   writes `dist/ops/*.op.json` into the project it builds, and commands run
 *   concurrently, so every command gets its own copy. Only the files git
 *   tracks under `examples/<name>` are copied, which keeps a local run and a
 *   CI run on the same input whatever build output sits in the checkout.
 * - The copy keeps the example's directory name, because a project with no
 *   `ownership.stack` takes its stack name from its directory.
 * - The copy is its own git repo with one commit made under a pinned author,
 *   committer and date. `chant graph` refuses to run outside a repo, and Op
 *   discovery starts at the git root. `node_modules` is a symlink to the
 *   repo's, listed in `.git/info/exclude`.
 * - The process is `node --import tsx/dist/loader.mjs .../cli/main.ts`, which
 *   is what `packages/core/bin/chant` execs from an installed package.
 * - The environment is built from nothing: PATH and HOME from the caller, a
 *   fresh TMPDIR ({@link childTmp}), and the pinned values in
 *   {@link chantEnv}. Nothing else leaks in, so a CHANT_* variable or a CI
 *   flag on the runner cannot change the output.
 *
 * What is normalised, and nothing else ({@link normaliseStdout} and
 * {@link normaliseStderr}):
 *
 * - The copy's absolute path becomes `<project>`, the scratch directory above
 *   it `<scratch>`, the child TMPDIR `<tmp>`, and the repo checkout
 *   `<repo>`. `lint --format json` prints absolute file paths.
 * - ISO-8601 timestamps become `<timestamp>` (`audit`'s `generatedAt`).
 * - chant's own version, where it is the value of a `"version"` or
 *   `"toolVersion"` key, becomes `<chant-version>`. Otherwise every release
 *   commit would fail the goldens for a change that is not a level-0 change.
 * - On stderr only, durations (`124ms`, `0.1s`) become `<duration>`, and the
 *   counts in the `fold: N files folded, M ran` diagnostic become `<n>`. That
 *   line reports how much of the project the fold optimisation covered, which
 *   moves whenever fold learns a new construct. Stdout keeps durations as
 *   they are, because an Op overview can say "30s timeout" and mean it.
 *
 * Stderr is pinned too, normalised as above. The warnings a build prints are
 * part of what a level-0 user sees, and a golden that ignored them would let
 * a discovery change add or drop warnings unnoticed.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = realpathSync(join(import.meta.dirname, "..", ".."));
export const GOLDENS_DIR = join(import.meta.dirname, "goldens");

/** `UPDATE_GOLDENS=1` rewrites the golden files instead of comparing against them. */
export const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === "1";

export const REGENERATE_HINT =
  "If the change is on the level-0 exception list (docs/src/content/docs/reference/level-0-exceptions.mdx, " +
  "chant #2525), regenerate with `UPDATE_GOLDENS=1 npx vitest run test/level0-goldens` and commit the diff " +
  "with the change. If it is not on the list, level 0 changed and the change needs fixing, or listing and " +
  "warning a release ahead first.";

const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const CLI_MAIN = join(REPO_ROOT, "packages", "core", "src", "cli", "main.ts");
const MODULE_RECORDER = join(import.meta.dirname, "module-recorder.mjs");
const CHANT_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf-8")) as { version: string }
).version;

/** A fixed identity and clock for every commit the fixtures and chant make. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "chant-level0",
  GIT_AUTHOR_EMAIL: "level0@chant.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "chant-level0",
  GIT_COMMITTER_EMAIL: "level0@chant.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  // The caller's own git config (signing, hooks path, default branch) stays out.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * The whole environment a chant process gets. NO_COLOR is what chant's own
 * formatter reads (`cli/format.ts`). FORCE_COLOR is deliberately absent rather
 * than `0`: Node prints a warning on stderr when both are set.
 */
export function chantEnv(moduleLog?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: childTmp(),
    NO_COLOR: "1",
    TERM: "dumb",
    TZ: "UTC",
    LANG: "C.UTF-8",
    ...GIT_IDENTITY,
    ...(moduleLog ? { CHANT_LEVEL0_MODULE_LOG: moduleLog } : {}),
  };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: chantEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

let childTmpDir: string | undefined;

/**
 * The TMPDIR every chant process gets: one fresh directory per test worker.
 * tsx keeps its transform cache under TMPDIR, so a shared one lets another
 * process's cache (or a wedged one: on 2026-09-23 a `tsx-501` cache directory
 * hung every tsx process that touched it in uninterruptible I/O) decide
 * whether this suite runs. The cost is one cold transform per worker.
 */
export function childTmp(): string {
  childTmpDir ??= realpathSync(mkdtempSync(join(tmpdir(), "chant-level0-tmp-")));
  return childTmpDir;
}

/** A scratch directory for one test file, resolved through any symlink (macOS `/var`). */
export function makeScratch(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `chant-level0-${label}-`)));
}

/**
 * Copy the tracked files of `examples/<example>` to `<parent>/<example>`, make
 * it a git repo with one pinned commit, and return its path. `extraFiles` are
 * written before the commit, keyed by path relative to the copy.
 */
export function copyExample(example: string, parent: string, extraFiles: Record<string, string> = {}): string {
  const target = join(parent, example);
  const tracked = execFileSync("git", ["ls-files", "-z", "--", `examples/${example}`], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\0")
    .filter((f) => f.length > 0);
  if (tracked.length === 0) throw new Error(`examples/${example} has no tracked files`);

  for (const file of tracked) {
    const to = join(target, relative(`examples/${example}`, file));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(REPO_ROOT, file), to);
  }
  for (const [file, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), content);
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(target, "node_modules"));
  git(target, ["init", "-q", "-b", "main"]);
  appendFileSync(join(target, ".git", "info", "exclude"), "node_modules\n");
  git(target, ["add", "-A"]);
  git(target, ["commit", "-q", "-m", "level-0 fixture"]);
  return target;
}

export interface ChantRun {
  /** The project copy the command ran in. */
  project: string;
  exit: number | null;
  stdout: string;
  stderr: string;
  /** Files the command left in the project, as `git status --porcelain --ignored` lines. */
  wrote: string[];
  /** Every module URL the process (and its children) loaded, when recording was on. */
  modules: string[];
}

/** Run the real CLI in `cwd`. `timeoutMs` kills a hung process so the test names it. */
export function runChant(
  cwd: string,
  args: string[],
  options: { recordModules?: boolean; timeoutMs?: number } = {},
): Promise<ChantRun> {
  const moduleLog = options.recordModules ? join(dirname(cwd), `modules-${basename(cwd)}.log`) : undefined;
  if (moduleLog) writeFileSync(moduleLog, "");
  const timeoutMs = options.timeoutMs ?? 240_000;

  return new Promise((resolvePromise, reject) => {
    // The recorder goes after tsx, so its hooks are registered last and run
    // first: they see every URL before tsx rewrites or answers it.
    const recorder = moduleLog ? ["--import", pathToFileURL(MODULE_RECORDER).href] : [];
    const child = spawn(process.execPath, ["--import", pathToFileURL(TSX_LOADER).href, ...recorder, CLI_MAIN, ...args], {
      cwd,
      env: chantEnv(moduleLog),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`chant ${args.join(" ")} in ${cwd} did not finish within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const status = git(cwd, ["status", "--porcelain", "--ignored", "--untracked-files=all"]);
      resolvePromise({
        project: cwd,
        exit: code,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        wrote: status
          .split("\n")
          // The symlink the harness itself put there.
          .filter((line) => line.length > 0 && line !== "!! node_modules")
          .sort(),
        modules: moduleLog ? [...new Set(readFileSync(moduleLog, "utf-8").split("\n").filter(Boolean))].sort() : [],
      });
    });
  });
}

/** At most `n` of the returned function's tasks run at once. */
export function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (start) {
      active += 1;
      start();
    }
  };
  return (task) =>
    new Promise((resolvePromise, reject) => {
      queue.push(() => {
        task()
          .then(resolvePromise, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}

// ── Normalisation ────────────────────────────────────────────────────

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const VERSION_VALUE = new RegExp(`("(?:version|toolVersion)":\\s*)"${CHANT_VERSION.replace(/\./g, "\\.")}"`, "g");
const DURATION = /\b\d+(?:\.\d+)?(?:ms|s)\b/g;
const FOLD_SUMMARY = /^fold: \d+ files? folded, \d+ ran/gm;

function replacePaths(text: string, project: string): string {
  let out = text;
  // Longest first, so the project path is not eaten by its own parent.
  for (const [path, token] of [
    [project, "<project>"],
    [dirname(project), "<scratch>"],
    [childTmp(), "<tmp>"],
    [REPO_ROOT, "<repo>"],
  ] as const) {
    out = out.split(path).join(token);
  }
  return out;
}

export function normaliseStdout(text: string, project: string): string {
  return replacePaths(text, project).replace(ISO_TIMESTAMP, "<timestamp>").replace(VERSION_VALUE, '$1"<chant-version>"');
}

export function normaliseStderr(text: string, project: string): string {
  return normaliseStdout(text, project)
    .replace(FOLD_SUMMARY, "fold: <n> files folded, <n> ran")
    .replace(DURATION, "<duration>");
}

// ── Golden files ─────────────────────────────────────────────────────

/** `lint --format json` → `lint-format-json`. */
export function slug(args: string[]): string {
  return args
    .join(" ")
    .replace(/--?/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function section(name: string, body: string): string {
  if (body.length === 0) return `--- ${name} (empty)\n`;
  // Exact bytes: a missing final newline is marked the way diff marks it.
  return body.endsWith("\n") ? `--- ${name}\n${body}` : `--- ${name}\n${body}\n\\ no newline at end of ${name}\n`;
}

/** The text a golden file holds for one run. */
export function renderGolden(example: string, args: string[], run: ChantRun): string {
  return [
    `# chant ${args.join(" ")}`,
    `# on a copy of examples/${example}; see test/level0-goldens/harness.ts for what is normalised`,
    `exit: ${run.exit}\n`,
    section("wrote", run.wrote.map((line) => `${line}\n`).join("")),
    section("stdout", normaliseStdout(run.stdout, run.project)),
    section("stderr", normaliseStderr(run.stderr, run.project)),
  ].join("\n");
}

export function goldenPath(example: string, args: string[]): string {
  return join(GOLDENS_DIR, example, `${slug(args)}.golden`);
}

/**
 * The golden's current text, or undefined when it has none. In update mode
 * the file is (re)written first, so the comparison that follows passes.
 */
export function readOrUpdateGolden(file: string, actual: string): string | undefined {
  if (UPDATE_GOLDENS) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
  }
  return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
}

// ── Workspace modules ────────────────────────────────────────────────

const MODULE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** chant core's workspace directory, in the repo or in an installed package. */
const CORE_WORKSPACE_DIR = /\/(?:packages\/core|node_modules\/@intentius\/chant)\/(?:src|dist)\/workspace\//;
/** An installed chant package: core, or any lexicon. */
const INSTALLED_CHANT = /\/node_modules\/@intentius\/chant(?:-[^/]+)?\//;

/**
 * The workspace modules among `urls`. No workspace code exists yet (#2524),
 * so the rule is written ahead of it, and covers where D0 and D3 say that
 * code will live:
 *
 * - anything under chant core's `src/workspace/` or `dist/workspace/`,
 *   in this repo (`packages/core/...`) or installed (`@intentius/chant/...`);
 * - any module in chant's own code (this repo's `packages/` and `lexicons/`,
 *   or an installed `@intentius/chant*` package) whose file name starts with
 *   `workspace`, which covers a lexicon's `./workspace-kinds` subpath (D3).
 *
 * A project's own files are never matched: an app may well have a
 * `workspace.ts`, and loading it says nothing about chant.
 */
export function workspaceModules(urls: Iterable<string>): string[] {
  const hits = new Set<string>();
  for (const url of urls) {
    if (!url.startsWith("file:")) continue;
    const path = fileURLToPath(url).split(sep).join("/");
    if (!MODULE_FILE.test(path)) continue;
    const repo = REPO_ROOT.split(sep).join("/");
    const chantOwned =
      path.startsWith(`${repo}/packages/`) || path.startsWith(`${repo}/lexicons/`) || INSTALLED_CHANT.test(path);
    if (!chantOwned) continue;
    const inRepoNodeModules = path.startsWith(`${repo}/node_modules/`) && !INSTALLED_CHANT.test(path);
    if (inRepoNodeModules) continue;
    if (CORE_WORKSPACE_DIR.test(path) || /^workspace/.test(basename(path))) hits.add(path);
  }
  return [...hits].sort();
}

/**
 * The agent guard (#4770): a speed bump that keeps a coding agent in a
 * checkout from running what applies, approves or overrides, so the change
 * goes through a pull request and a person's approval. terragucci and
 * plywood each had one; a product now passes its words and rules here.
 *
 * Two layers, both written by {@link installAgentGuard}:
 *
 * - a Claude Code PreToolUse hook on Bash: one Node script that reads the
 *   tool call on stdin and blocks (exit 2, Claude Code's block code) a
 *   command line that would run a refused command;
 * - a wrapper per engine binary, for the agent's shell to put ahead of the
 *   real binary on PATH: it refuses the same commands and runs the next
 *   binary of that name on PATH for everything else.
 *
 * The rule lives once, in {@link makeGuard}. The script carries its source
 * (`makeGuard.toString()`) and its config as JSON, and imports Node's modules
 * only; {@link agentGuard} runs the same function in process, so a product's
 * `guard check` and the hook give the same answers.
 *
 * Two installs: `local` writes the script and wrappers under the checkout's
 * git directory, with absolute paths, and the hook into
 * `.claude/settings.local.json`, listed in `.git/info/exclude`; `project`
 * writes the script to `.claude/hooks/<product>-guard.mjs` and the hook into
 * `.claude/settings.json` as `$CLAUDE_PROJECT_DIR/...`, meant to be
 * committed, and the wrappers to `.<product>/agent-bin`.
 *
 * An agent that calls the real binary by its path, through a script, or with
 * credentials of its own gets past it; the control is the credentials. Roots
 * are written into the script, so the guard is written again after they
 * change.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NEXT_RELEASE } from "./release-floors";

/** The first chant with the shared agent guard (#4770). Products feature-detect on it, or on `installAgentGuard`. */
export const AGENT_GUARD_FLOOR = NEXT_RELEASE;

/** What the guard refuses of one engine binary (tofu, pulumi, terragrunt). Flag names are written with their dashes. */
export interface AgentGuardEngine {
  /** Subcommands refused: `apply`, `up`. */
  refuse: string[];
  /** A subcommand's second words refused: `{ state: ["rm", "mv"] }`. */
  refuseSub?: Record<string, string[]>;
  /** Flags refused with any subcommand, also as `--x=v`: `-auto-approve`. One or two dashes both match. */
  refuseFlags?: string[];
  /** Flags that take the next word as their value, skipped when finding the subcommand: `-C`, `--stack`. */
  valuedFlags?: string[];
  /** Flags whose value is the directory the command runs in, as `-x dir` or `-x=dir`: `-chdir`. One or two dashes both match. */
  dirFlags?: string[];
  /** Flags that run the command in every root under the directory: terragrunt's `--all`. */
  allFlags?: string[];
  /** Leading words dropped before the subcommand, the first match only; `all` as with `allFlags`: terragrunt's `run-all`, `stack run`, `run`. */
  prefixes?: Array<{ words: string[]; all?: boolean }>;
}

/** The product's rules. */
export interface AgentGuardRules {
  /** The engine binaries the guard wraps and checks, by name. */
  engines: Record<string, AgentGuardEngine>;
  /**
   * The product's own commands refused anywhere inside the repo: each is the
   * leading non-flag words (`["stage", "tf-apply"]`, `["approve"]`), and
   * `flagValues` a flag with the value it is refused with, with any command
   * (`["--mode", "apply"]`).
   */
  product?: { commands: string[][]; flagValues?: Array<[string, string]> };
  /** The exit code a wrapper refuses with. Default 3. The hook always exits 2, Claude Code's block code. */
  wrapperExit?: number;
}

/** The product's words. */
export interface AgentGuardWords {
  /** The product's name and bin, as the agent types it: every refusal starts `<product> guard: `. */
  product: string;
  /** The refusal after that prefix, with `{what}` for the refused command (`tofu apply`) and `{where}` for {@link where}, or nothing. */
  refusal: string;
  /** With roots, what `{where}` becomes, with `{root}` for the root, relative to the repo. Default ` in {root}`. */
  where?: string;
}

export interface AgentGuardSpec {
  words: AgentGuardWords;
  rules: AgentGuardRules;
}

/** What the script is given. `repo` or `repoFromScript` (a path from the script's directory) names the checkout. */
export interface AgentGuardConfig extends AgentGuardSpec {
  repo?: string;
  repoFromScript?: string;
  /** Roots relative to the repo, where engine commands are refused; absent refuses them anywhere. */
  roots?: string[];
}

/** A refusal: the binary, the refused command (`apply`, `state rm`, `-auto-approve`, `approve`), the root, and the message. */
export interface AgentGuardVerdict {
  bin: string;
  command: string;
  what: string;
  where?: string;
  message: string;
}

/** The Node functions the rule uses, handed in so {@link makeGuard} stays self-contained. */
export interface AgentGuardDeps {
  realpathSync: (p: string) => string;
  resolve: (...p: string[]) => string;
  basename: (p: string) => string;
  join: (...p: string[]) => string;
  relative: (from: string, to: string) => string;
  sep: string;
  home: string | undefined;
  scriptDir?: string;
}

export interface AgentGuard {
  /** The first refusal a shell command line earns, following `cd` from `cwd`. */
  checkCommand(text: string, cwd: string): AgentGuardVerdict | undefined;
  /** What one engine binary's command line would do that the guard refuses. */
  verdict(bin: string, args: string[], cwd: string): AgentGuardVerdict | undefined;
  /** What the product's own command line would do that the guard refuses, run in `cwd`. */
  productVerdict(args: string[], cwd: string): AgentGuardVerdict | undefined;
  repo: string;
}

/**
 * The rule. It references nothing outside itself: the guard's script carries
 * its source text, so keep it to its parameters and ES2020.
 */
export function makeGuard(config: AgentGuardConfig, deps: AgentGuardDeps): AgentGuard {
  const { realpathSync, resolve, basename, join, relative, sep } = deps;
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const repo = real(config.repo !== undefined ? config.repo : resolve(deps.scriptDir || ".", config.repoFromScript || "."));
  const roots = config.roots === undefined ? undefined : config.roots.map((r) => real(join(repo, r)));
  const words = config.words;
  const rules = config.rules;
  const inside = (at: string, dir: string): boolean => at === dir || at.startsWith(dir === sep ? dir : dir + sep);
  const bare = (f: string): string => f.replace(/^--?/, "");
  const flagIs = (a: string, names: string[] | undefined): boolean => {
    if (!names || !/^--?[^-]/.test(a)) return false;
    const n = bare(a).replace(/=.*$/, "");
    return names.some((f) => bare(f) === n);
  };

  const message = (what: string, where: string | undefined): string => {
    const at = where === undefined ? "" : (words.where === undefined ? " in {root}" : words.where).split("{root}").join(where);
    return words.product + " guard: " + words.refusal.split("{what}").join(what).split("{where}").join(at);
  };

  function verdict(bin: string, args: string[], cwd: string): AgentGuardVerdict | undefined {
    const e = rules.engines[bin];
    if (!e) return undefined;
    let dir = cwd;
    let all = false;
    let refusedFlag: string | undefined;
    const ws: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (flagIs(a, e.dirFlags)) {
        const eq = a.indexOf("=");
        if (eq >= 0) dir = resolve(cwd, a.slice(eq + 1));
        else if (i + 1 < args.length) dir = resolve(cwd, args[++i]);
      } else if (e.allFlags && e.allFlags.indexOf(a) >= 0) all = true;
      else if (flagIs(a, e.refuseFlags)) refusedFlag = refusedFlag || a.replace(/=.*$/, "");
      else if (e.valuedFlags && e.valuedFlags.indexOf(a) >= 0) i++;
      else if (a !== "--" && !a.startsWith("-")) ws.push(a);
    }
    for (const p of e.prefixes || []) {
      if (p.words.every((w, i) => ws[i] === w)) {
        ws.splice(0, p.words.length);
        if (p.all) all = true;
        break;
      }
    }
    const cmd = ws[0];
    const sub = cmd !== undefined && e.refuseSub && Object.prototype.hasOwnProperty.call(e.refuseSub, cmd) ? e.refuseSub[cmd] : undefined;
    const command = cmd !== undefined && e.refuse.indexOf(cmd) >= 0 ? cmd : sub && ws[1] !== undefined && sub.indexOf(ws[1]) >= 0 ? cmd + " " + ws[1] : refusedFlag;
    if (command === undefined) return undefined;
    let where: string | undefined;
    if (roots !== undefined) {
      const at = real(dir);
      const hit = roots.find((r) => r === at || (all && inside(r, at)));
      if (!hit) return undefined;
      where = relative(repo, hit) || ".";
    }
    const what = bin + " " + command;
    return { bin, command, what, ...(where === undefined ? {} : { where }), message: message(what, where) };
  }

  function productVerdict(args: string[], cwd: string): AgentGuardVerdict | undefined {
    const p = rules.product;
    if (!p || !inside(real(cwd), repo)) return undefined;
    const ws = args.filter((a) => !a.startsWith("-"));
    const bin = words.product;
    const found = (command: string): AgentGuardVerdict => ({ bin, command, what: bin + " " + command, message: message(bin + " " + command, undefined) });
    for (const c of p.commands) if (c.every((w, i) => ws[i] === w)) return found(c.join(" "));
    for (const [flag, value] of p.flagValues || []) {
      const i = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
      if (i >= 0 && (args[i] === flag + "=" + value || (args[i] === flag && args[i + 1] === value))) return found(((ws[0] === undefined ? "" : ws[0] + " ") + flag + " " + value).trim());
    }
    return undefined;
  }

  type Token = { word?: string; op?: string };
  /** A shell command line's words and operators, quotes taken off. Enough for a guard, not a shell. */
  function lex(text: string): Token[] {
    const out: Token[] = [];
    let cur: string | null = null;
    const end = (): void => {
      if (cur !== null) out.push({ word: cur });
      cur = null;
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "'") {
        const j = text.indexOf("'", i + 1);
        cur = (cur === null ? "" : cur) + (j < 0 ? text.slice(i + 1) : text.slice(i + 1, j));
        i = j < 0 ? text.length : j;
      } else if (c === '"') {
        let s = "";
        for (i++; i < text.length && text[i] !== '"'; i++) {
          if (text[i] === "\\" && i + 1 < text.length) i++;
          s += text[i];
        }
        cur = (cur === null ? "" : cur) + s;
      } else if (c === "\\" && i + 1 < text.length) cur = (cur === null ? "" : cur) + text[++i];
      else if (c === "$" && text[i + 1] === "(") {
        end();
        out.push({ op: "$(" });
        i++;
      } else if (";&|\n()`".indexOf(c) >= 0) {
        end();
        out.push({ op: c });
      } else if (/\s/.test(c)) end();
      else cur = (cur === null ? "" : cur) + c;
    }
    end();
    return out;
  }

  /** Words that run the words after them as the command, with their flags that take a value. */
  const LAUNCHERS: Record<string, string[]> = {
    command: [],
    builtin: [],
    exec: ["-a"],
    env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
    sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"],
    doas: ["-u", "-C"],
    time: ["-f", "-o", "--format", "--output"],
    nohup: [],
    nice: ["-n", "--adjustment"],
    xargs: ["-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs"],
  };
  const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];
  const RUNNERS = ["npx", "bunx", "pnpx"];
  const RUNNER_VALUED = ["-p", "--package", "-c", "--call"];

  function checkCommand(text: string, cwd: string, depth = 0): AgentGuardVerdict | undefined {
    if (depth > 3) return undefined;
    let dir = cwd;
    const segments: string[][] = [[]];
    for (const t of lex(text)) {
      if (t.op) segments.push([]);
      else segments[segments.length - 1].push(t.word as string);
    }
    for (let seg of segments) {
      for (;;) {
        if (seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0])) seg = seg.slice(1);
        else if (seg.length && Object.prototype.hasOwnProperty.call(LAUNCHERS, basename(seg[0]))) {
          const valued = LAUNCHERS[basename(seg[0])];
          seg = seg.slice(1);
          while (seg.length && seg[0].startsWith("-") && seg[0] !== "-") {
            if (seg[0] === "--") {
              seg = seg.slice(1);
              break;
            }
            seg = seg.slice(valued.indexOf(seg[0]) >= 0 ? 2 : 1);
          }
        } else break;
      }
      if (!seg.length) continue;
      const head = basename(seg[0]);
      if (head === "cd") {
        const home = deps.home === undefined ? dir : deps.home;
        const to = seg[1] === undefined || seg[1] === "~" ? home : seg[1].startsWith("~/") ? join(home, seg[1].slice(2)) : seg[1];
        if (to !== "-") dir = resolve(dir, to);
        continue;
      }
      if (SHELLS.indexOf(head) >= 0) {
        const c = seg.findIndex((a, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        if (c >= 0 && seg[c + 1] !== undefined) {
          const v = checkCommand(seg[c + 1], dir, depth + 1);
          if (v) return v;
        }
        continue;
      }
      if (head === "eval") {
        const v = checkCommand(seg.slice(1).join(" "), dir, depth + 1);
        if (v) return v;
        continue;
      }
      let rest = seg;
      if (RUNNERS.indexOf(head) >= 0) {
        rest = rest.slice(1);
        while (rest.length && rest[0].startsWith("-")) rest = rest.slice(RUNNER_VALUED.indexOf(rest[0]) >= 0 ? 2 : 1);
        if (!rest.length) continue;
      }
      // npx names a package as @scope/name, with a version after an @.
      const name = basename(rest[0]).replace(/@.*$/, "");
      const v = Object.prototype.hasOwnProperty.call(rules.engines, name) ? verdict(name, rest.slice(1), dir) : name === words.product ? productVerdict(rest.slice(1), dir) : undefined;
      if (v) return v;
    }
    return undefined;
  }

  return { checkCommand: (text, cwd) => checkCommand(text, cwd), verdict, productVerdict, repo };
}

/** The guard in process, for a product's `guard check`: the rule the hook runs. */
export function agentGuard(spec: AgentGuardSpec, at: { repo: string; roots?: string[] }): AgentGuard {
  return makeGuard({ ...spec, repo: at.repo, ...(at.roots ? { roots: at.roots } : {}) }, nodeDeps());
}

function nodeDeps(scriptDir?: string): AgentGuardDeps {
  return { realpathSync, resolve, basename, join, relative, sep, home: process.env.HOME, ...(scriptDir ? { scriptDir } : {}) };
}

/** The guard's script: {@link makeGuard}'s source, the config, and the hook and wrapper entry points. */
export function agentGuardScript(config: AgentGuardConfig): string {
  const p = JSON.stringify(config.words.product);
  return `// Written by ${config.words.product} guard. Run it again after the pipeline's roots change.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = ${JSON.stringify(config)};
const PRODUCT = ${p};
// esbuild with keepNames (tsx) wraps the function's inner functions in __name.
const __name = (f) => f;
${makeGuard.toString()}
const guard = makeGuard(CONFIG, { realpathSync, resolve, basename, join, relative, sep, home: process.env.HOME, scriptDir: dirname(fileURLToPath(import.meta.url)) });
export const checkCommand = guard.checkCommand;
export const verdict = guard.verdict;

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The next binary of this name on PATH, past the wrappers' own directory. */
function realBinary(bin, self) {
  const skip = real(self);
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (!d || real(d) === skip) continue;
    const p = join(d, bin);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return undefined;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "wrap") {
    const [bin, self, ...args] = rest;
    const v = verdict(bin, args, process.cwd());
    if (v) {
      process.stderr.write(v.message + "\\n");
      process.exit(${config.rules.wrapperExit ?? 3});
    }
    const exe = realBinary(bin, self);
    if (!exe) {
      process.stderr.write(PRODUCT + " guard: no " + bin + " on PATH besides the guard's own\\n");
      process.exit(127);
    }
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});
    const r = spawnSync(exe, args, { stdio: "inherit" });
    if (r.error) {
      process.stderr.write(PRODUCT + " guard: " + r.error.message + "\\n");
      process.exit(127);
    }
    if (r.signal) {
      process.removeAllListeners(r.signal);
      process.kill(process.pid, r.signal);
    }
    process.exit(r.status ?? 1);
  } else if (mode === "hook" || mode === undefined) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    let event;
    try { event = JSON.parse(input); } catch { process.exit(0); }
    const command = event?.tool_input?.command;
    if (typeof command !== "string") process.exit(0);
    const v = checkCommand(command, typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd());
    if (v) {
      process.stderr.write(v.message + "\\n");
      process.exit(2);
    }
    process.exit(0);
  }
}
`;
}

const shq = (s: string): string => `'${s.split("'").join(`'\\''`)}'`;

/** A wrapper on PATH: the guard's script for one binary. `node` absolute (with `node` on PATH as the fallback) or undefined for `node`; `script` absolute, or relative to the wrapper's directory. */
export function agentGuardWrapper(product: string, bin: string, script: string, node?: string): string {
  const at = isAbsolute(script) ? shq(script) : `"$here/"${shq(script)}`;
  return `#!/bin/sh
# Written by ${product} guard: refuses what the guard refuses of ${bin}, and runs the next ${bin} on PATH for the rest.
here=$(cd "$(dirname "$0")" && pwd)
NODE=${node ? shq(node) : "node"}
${node ? `[ -x "$NODE" ] || NODE=node\n` : ""}exec "$NODE" ${at} wrap ${bin} "$here" "$@"
`;
}

/** Claude Code's settings files: the shared one, and the local one it keeps out of commits. */
export const CLAUDE_SETTINGS_SHARED = ".claude/settings.json";
export const CLAUDE_SETTINGS_LOCAL = ".claude/settings.local.json";

/**
 * A Claude Code settings file's text with the guard's PreToolUse hook on
 * Bash, in place of an earlier one (an entry naming `command` or any of
 * `markers`). Everything else in the file is kept. Throws when the file is
 * not a JSON object.
 */
export function withAgentGuardHook(text: string | undefined, command: string, at: string, markers: readonly string[] = [], fail: (message: string) => Error = (m) => new Error(m)): string {
  let doc: Record<string, unknown> = {};
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw fail(`${at} is not JSON (${(e as Error).message}); fix it, then write the guard again`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail(`${at} is not a JSON object`);
    doc = parsed as Record<string, unknown>;
  }
  const hooks = (doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks) ? doc.hooks : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  const needles = [JSON.stringify(command).slice(1, -1), ...markers.map((m) => JSON.stringify(m).slice(1, -1))];
  const kept = pre.filter((e) => !needles.some((n) => JSON.stringify(e).includes(n)));
  doc.hooks = { ...hooks, PreToolUse: [...kept, { matcher: "Bash", hooks: [{ type: "command", command }] }] };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface AgentGuardInstallOptions extends AgentGuardSpec {
  /** The checkout's top directory. */
  repo: string;
  /** `local` (under the git directory, kept out of commits) or `project` (in `.claude/`, to commit). */
  install: "local" | "project";
  /** Roots relative to the repo where engine commands are refused; absent refuses them anywhere. */
  roots?: string[];
  /** `local` only: where to write the script and `bin/`, in place of `<git-dir>/<product>/guard`. */
  dir?: string;
  /** `local` only: the Node the wrappers and the hook run. Default: this one. `project` runs `node`. */
  node?: string;
  /** Leave Claude Code's settings alone. */
  noHook?: boolean;
  /** The error the product throws for a broken settings file or a missing git checkout. */
  fail?: (message: string) => Error;
}

export interface AgentGuardInstall {
  /** The script, the wrappers' directory, absolute. */
  script: string;
  bin: string;
  /** The settings file the hook went into, when it did. */
  hook?: string;
  /** The hook's command as Claude Code runs it. */
  hookCommand: string;
  /** The files written, relative to the repo when inside it. */
  written: string[];
  /** The line the agent's shell runs to put the wrappers ahead of the binaries. */
  path: string;
}

/** Write the guard: the script, a wrapper per engine, and the hook. */
export function installAgentGuard(o: AgentGuardInstallOptions): AgentGuardInstall {
  const fail = o.fail ?? ((m: string) => new Error(m));
  const product = o.words.product;
  const repo = resolve(o.repo);
  const git = (args: string[]): string => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
    if (r.status !== 0) throw fail(`${product} guard runs in a git checkout (git ${args.join(" ")}: ${(r.stderr || "").trim()})`);
    return r.stdout.trim();
  };
  const spec: AgentGuardSpec = { words: o.words, rules: o.rules };
  const roots = o.roots ? { roots: o.roots } : {};
  const shown = (p: string): string => (p.startsWith(repo + sep) ? relative(repo, p) : p);
  const written: string[] = [];
  const put = (p: string, text: string, mode?: number): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    if (mode !== undefined) chmodSync(p, mode);
    written.push(shown(p));
  };

  let script: string;
  let bin: string;
  let settings: string;
  let hookCommand: string;
  let markers: string[];
  if (o.install === "local") {
    const dir = o.dir ? resolve(repo, o.dir) : join(git(["rev-parse", "--absolute-git-dir"]), product, "guard");
    const node = o.node ?? process.execPath;
    script = join(dir, "guard.mjs");
    bin = join(dir, "bin");
    put(script, agentGuardScript({ ...spec, repo, ...roots }));
    for (const b of Object.keys(o.rules.engines)) put(join(bin, b), agentGuardWrapper(product, b, script, node), 0o755);
    settings = CLAUDE_SETTINGS_LOCAL;
    hookCommand = `"${node}" "${script}" hook`;
    markers = [`${product}/guard/guard.mjs`];
  } else {
    const rel = `.claude/hooks/${product}-guard.mjs`;
    script = join(repo, rel);
    bin = join(repo, `.${product}`, "agent-bin");
    put(script, agentGuardScript({ ...spec, repoFromScript: "../..", ...roots }));
    for (const b of Object.keys(o.rules.engines)) put(join(bin, b), agentGuardWrapper(product, b, relative(bin, script)), 0o755);
    settings = CLAUDE_SETTINGS_SHARED;
    hookCommand = `node "$CLAUDE_PROJECT_DIR/${rel}" hook`;
    markers = [`${product}-guard.mjs`];
  }

  let hook: string | undefined;
  if (!o.noHook) {
    hook = join(repo, settings);
    put(hook, withAgentGuardHook(existsSync(hook) ? readFileSync(hook, "utf-8") : undefined, hookCommand, settings, markers, fail));
    // The local hook names paths on this machine: keep the file out of commits unless git already ignores it.
    if (o.install === "local" && spawnSync("git", ["-C", repo, "check-ignore", "-q", settings]).status !== 0) {
      const common = git(["rev-parse", "--git-common-dir"]);
      const exclude = join(isAbsolute(common) ? common : resolve(repo, common), "info", "exclude");
      mkdirSync(dirname(exclude), { recursive: true });
      const now = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
      writeFileSync(exclude, `${now}${now === "" || now.endsWith("\n") ? "" : "\n"}/${settings}\n`);
    }
  }
  return { script, bin, ...(hook ? { hook } : {}), hookCommand, written, path: `export PATH="${bin}:$PATH"` };
}

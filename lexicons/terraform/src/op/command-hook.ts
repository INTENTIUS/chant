/**
 * The hook a product puts around each engine command `terraform-apply`
 * runs (chant#4865), and the async-local scope that carries it to the
 * activities that run the binary. Kept apart from
 * `./activities/terraform.ts` so the composed group's runs
 * (`../components/compose-group.ts`, through `BinaryExec`) and the engine
 * timings (`../engine-timings.ts`) read the same scope (chant#4887).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BinaryExec, Ran } from "../state/exec";

/**
 * One engine command as a product's {@link TerraformCommandHook} sees it
 * before it runs (chant#4865).
 */
export interface TerraformCommand {
  /** The step's root the command runs for. */
  root: string;
  /** The upstream root whose state the command reads for `root`'s `reads`, when it runs for one. */
  upstream?: string;
  /**
   * The roots a composed group's command runs for (chant#4887): a group's
   * plan and apply run one engine command for all its members, in the
   * composed directory. `root` is then the first of them.
   */
  members?: string[];
  /** The step method that runs it: `plan`, `run` (the apply) or `outputs`. */
  method: string;
  /** The binary, as the command line names it. */
  binary: string;
  /** The subcommand, the first argument that is not a flag: `init`, `plan`, `show`, `apply`, `output`, `workspace`, `live-plan-set`. */
  name: string;
  /** The arguments after the binary, unquoted. */
  args: string[];
  /** The command line as the shell runs it. */
  line: string;
  /** The directory it runs in. */
  cwd: string;
  /** The variables chant sets for it over the job's environment, such as `TF_IN_AUTOMATION`, `TF_WORKSPACE` and the run hook's `processEnv`. */
  env: Record<string, string>;
}

/** How a {@link TerraformCommand} came out, for the hook's `after` (chant#4865). */
export interface TerraformCommandResult {
  /** The exit code; null when the command did not exit on its own (a signal, an abort, a spawn failure). */
  code: number | null;
  /** How long it ran, in seconds. */
  seconds: number;
  stdout: string;
  stderr: string;
  /**
   * When it ran, in Unix milliseconds, for a command timed apart from its
   * call (chant#4954): a Terragrunt unit's plan, from Terragrunt's run
   * report, whose `after` is called once the whole wave ends. Unset, it ran
   * from the hook's call to its `after`.
   */
  at?: { start: number; end: number };
}

/** What a {@link TerraformCommandHook} answers for one command (chant#4865). */
export interface TerraformCommandRun {
  /** Variables laid over the command's own, such as a span receiver's exporter or a trace parent. */
  env?: Record<string, string>;
  /** Called once the command ends, on a failure too, before the step reads its result. */
  after?: (result: TerraformCommandResult) => void | Promise<void>;
}

/**
 * A product's hook around each engine command a `terraform-apply` step runs
 * for a root (chant#4865), `terraformApplyCapabilityWith({ onCommand })`:
 * called before the command with what it is, and its answer's `after` once
 * it ends. terragucci times each root's plan and apply with it and sets its
 * span receiver's variables, as its own runs of the binary did.
 */
export type TerraformCommandHook = (command: TerraformCommand) => TerraformCommandRun | void | Promise<TerraformCommandRun | void>;

/** The hook, and the root and method it is for, that the commands run in an async call see (chant#4865). */
export interface CommandScope {
  hook: TerraformCommandHook;
  root: string;
  upstream?: string;
  /** The members of a composed group, for its commands (chant#4887). */
  members?: string[];
  method: string;
}

/**
 * The command scope of the step call that runs the engine (chant#4865). An
 * async-local store, so each root a wave runs at once (chant#4864) sees its
 * own, and the activities need no hook argument threaded through.
 */
const commandScope = new AsyncLocalStorage<CommandScope>();

/**
 * Run `fn` with every engine command it runs going through `hook`, as
 * commands for `scope.root` (chant#4865). Inside another scope, a field this
 * one leaves out (`upstream`, `members`) is not kept from the outer.
 */
export function withTerraformCommandHook<T>(hook: TerraformCommandHook | undefined, scope: Omit<CommandScope, "hook">, fn: () => Promise<T>): Promise<T> {
  if (!hook) return fn();
  return commandScope.run({ hook, ...scope }, fn);
}

/** Run `fn` with the commands it runs marked as a read of `upstream`'s state for the scope's root (chant#4865). Outside a scope, `fn` as it is. */
export function asUpstreamCommands<T>(upstream: string, fn: () => Promise<T>): Promise<T> {
  const scope = commandScope.getStore();
  return scope ? commandScope.run({ ...scope, upstream }, fn) : fn();
}

/** The scope the current async call runs in, or undefined outside one. */
export function currentCommandScope(): CommandScope | undefined {
  return commandScope.getStore();
}

/** The fields of a {@link TerraformCommand} that come from the scope. */
export function scopedCommand(scope: CommandScope): Pick<TerraformCommand, "root" | "upstream" | "members" | "method"> {
  return {
    root: scope.root,
    ...(scope.upstream !== undefined ? { upstream: scope.upstream } : {}),
    ...(scope.members !== undefined ? { members: [...scope.members] } : {}),
    method: scope.method,
  };
}

/**
 * `exec` with each run going through the command hook of the step call it
 * runs in (chant#4887), as the activities' own commands do: a composed
 * group's `init`, `plan`, `show` and `apply`, and the `version` its estate
 * check asks. The hook sees the variables the run sets over the job's
 * environment, its variables are laid over the run's, and its `after` gets
 * the exit code, time and output. Outside a scope, `exec` as it is.
 */
export function hookedBinaryExec(exec: BinaryExec): BinaryExec {
  return async (binary, args, dir, env, io) => {
    const scope = commandScope.getStore();
    if (!scope) return exec(binary, args, dir, env, io);
    const own: Record<string, string> = { TF_IN_AUTOMATION: "1" };
    for (const [k, v] of Object.entries(env)) if (v !== undefined && process.env[k] !== v) own[k] = v;
    const command: TerraformCommand = {
      ...scopedCommand(scope),
      binary,
      name: args.find((a) => !a.startsWith("-")) ?? "",
      args: [...args],
      line: [binary, `-chdir=${dir}`, ...args].map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : quoteWord(w))).join(" "),
      cwd: dir,
      env: own,
    };
    const given = (await scope.hook(command)) ?? {};
    const start = performance.now();
    let ran: Ran;
    try {
      ran = await exec(binary, args, dir, given.env ? { ...env, ...given.env } : env, io);
    } catch (err) {
      await given.after?.({ code: null, seconds: (performance.now() - start) / 1000, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    // `out` holds stdout and stderr together, as they came; stderr alone is what is left once stdout is taken out of it.
    const stderr = ran.out.startsWith(ran.stdout) ? ran.out.slice(ran.stdout.length) : ran.out;
    await given.after?.({ code: ran.code, seconds: (performance.now() - start) / 1000, stdout: ran.stdout, stderr });
    return ran;
  };
}

/** A word single-quoted for a shell, as `quoteArg` writes it. */
const quoteWord = (w: string): string => `'${w.replace(/'/g, `'\\''`)}'`;

/** The words of a command line the builders here wrote: plain words, and `quoteArg`'s single-quoted ones. */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === " ") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end < 0 ? line.length : end;
      word = (word ?? "") + line.slice(i + 1, stop);
      i = stop;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

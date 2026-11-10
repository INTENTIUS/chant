/**
 * One runner of the engine for a product (chant#4954): every way a product
 * runs tofu, terraform, choudoufu or Terragrunt, with the forge's tokens left
 * out of its environment ({@link engineEnv}), and the trace parent each
 * engine command gets.
 *
 * - {@link engineRunner} gives the runners for one set of product token
 *   variables: `exec`, a `BinaryExec` whose runs go through the command hook
 *   of the step call they run in (`withTerraformCommandHook`, chant#4865), so
 *   a product's plan stage sends its own `init`, `plan` and `show` through
 *   the same `onCommand` as `terraform-apply`'s; `execSync`, the same run
 *   for a caller that cannot wait; `terragrunt`, a `TerragruntExec`;
 *   `script`, a same-named script that drops the tokens and runs the binary,
 *   for a step chant runs with the job's environment; and `env`.
 * - {@link commandTrace} is a `TerraformCommandHook` that opens a span per
 *   engine command under the product's span for its root, and gives the
 *   command `TRACEPARENT` and the resource attributes that name the span
 *   ({@link commandTraceEnv}). Pass it as `engineTimings({ inner })`.
 *
 * A Terragrunt unit's plan reaches the same hook through
 * `planTerragruntWave({ onCommand })` (`./terragrunt/run.ts`).
 *
 * Lifted from terragucci's `binary-env.ts` (`binaryEnv`, `tokenlessBinary`,
 * `terragruntExec`), the runs of the binary in its `action.ts`, `apply.ts`,
 * `ephemeral.ts`, `unlock.ts` and `plan.ts`, and the trace half of its
 * `telemetry.ts` (`binaryEnv`) and `report/observe.ts` (`commandHook`).
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { formatOtlpPairs, parseOtlpPairs, type OtlpSpan, type OtlpTrace } from "@intentius/chant/otlp";
import { hookedBinaryExec, type TerraformCommand, type TerraformCommandHook } from "./op/command-hook";
import { engineEnv, runBinary, tokenlessBinaryExec, type BinaryExec, type Ran } from "./state/exec";
import type { TerragruntExec } from "./terragrunt/run";

export { withTerraformCommandHook, asUpstreamCommands, type TerraformCommand, type TerraformCommandHook, type TerraformCommandResult, type TerraformCommandRun } from "./op/command-hook";

/** A run of the binary that blocks: `-chdir=<dir>`, `TF_IN_AUTOMATION=1`, as {@link runBinary} runs it. */
export type BinaryExecSync = (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => Ran;

/** What {@link engineRunner} takes. */
export interface EngineRunnerOptions {
  /** The product's own token variables, left out beside chant's forge token variables (terragucci's `TG_TOKEN`, `TG_MERGE_TOKEN`). */
  tokens?: readonly string[];
  /** The run under `exec`, for tests. Default {@link runBinary}. */
  exec?: BinaryExec;
}

/** The product's runners of the engine, every one with the forge's tokens left out (chant#4954). */
export interface EngineRunner {
  /** The token variables left out: chant's forge token variables and the product's. */
  readonly tokens: readonly string[];
  /** `env` less every forge token, by name and by value ({@link engineEnv}). */
  env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /**
   * The binary, run without blocking. Inside `withTerraformCommandHook(hook,
   * { root, method })` each run goes through `hook` as a command for that
   * root, as `terraform-apply`'s own do; outside one it just runs.
   */
  exec: BinaryExec;
  /** The binary, run to its end before it returns, for a caller that cannot wait. Goes through no hook. */
  execSync: BinaryExecSync;
  /** Terragrunt, as `planTerragruntWave` and the other Terragrunt calls take it, with the job's environment under the call's. */
  terragrunt: TerragruntExec;
  /**
   * The path of a script named as `binary` under `dir` that leaves the forge
   * tokens `env` holds out, by name and by value, then runs `binary` with
   * what it was given: for a step chant runs with the job's environment
   * (`terraform-apply`'s `resolveRoot`), or a `TG_TF_PATH`. A bare name is
   * resolved on `env.PATH` first, so the script never runs itself. One
   * script per binary and set of variables; written once.
   */
  script(dir: string, binary: string, env: NodeJS.ProcessEnv): string;
}

/** Whether `p` is a file this process may run. */
function runnable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A word single-quoted for `sh`. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The runners of the engine for a product whose own token variables are
 * `tokens` (chant#4954). A product makes one and runs the binary and
 * Terragrunt only through it.
 */
export function engineRunner(options: EngineRunnerOptions = {}): EngineRunner {
  const own = [...(options.tokens ?? [])];
  const tokens = [...new Set([...own, ...FORGE_TOKEN_VARS])];
  const env = (e: NodeJS.ProcessEnv): NodeJS.ProcessEnv => engineEnv(e, own);
  // The hook's variables are laid over the run's before the tokens are taken out, so no hook puts one back.
  const exec = hookedBinaryExec(tokenlessBinaryExec(own, options.exec ?? runBinary));
  const execSync: BinaryExecSync = (binary, args, dir, given) => {
    const p = spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", env: { ...env(given), TF_IN_AUTOMATION: "1" }, maxBuffer: 512 * 1024 * 1024 });
    const stdout = p.stdout ?? "";
    return { code: p.error && p.status === null ? 127 : (p.status ?? 1), stdout, out: `${stdout}${p.stderr ?? ""}${p.error ? p.error.message : ""}` };
  };
  const terragrunt: TerragruntExec = (file, args, opts) =>
    new Promise((done) => {
      execFile(file, [...args], { cwd: opts.cwd, env: env({ ...process.env, ...opts.env }), maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
        done({ code, stdout: String(stdout), stderr: err && code === null ? `${String(stderr)}${err.message}` : String(stderr) });
      });
    });
  const script = (dir: string, given: string, e: NodeJS.ProcessEnv): string => {
    const binary = given.includes("/") ? given : ((e.PATH ?? "").split(delimiter).map((d) => join(d, given)).find((p) => runnable(p)) ?? given);
    const kept = env(e);
    const drop = [...new Set([...tokens, ...Object.keys(e).filter((k) => !(k in kept))])].filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).sort();
    const at = join(dir, createHash("sha256").update(`${binary}\n${drop.join(" ")}`).digest("hex").slice(0, 16));
    const path = join(at, basename(binary) || "terraform");
    if (!existsSync(path)) {
      mkdirSync(at, { recursive: true });
      writeFileSync(path, `#!/bin/sh\nexec env ${drop.map((k) => `-u ${k}`).join(" ")} ${shq(binary)} "$@"\n`, { mode: 0o755 });
    }
    return path;
  };
  return { tokens, env, exec, execSync, terragrunt, script };
}

/**
 * The variables a command run inside `span` gets (chant#4954): `TRACEPARENT`,
 * so the engine's spans join the trace where it reads it (OpenTofu and
 * choudoufu), the trace's and span's ids and the root as resource attributes
 * (`<prefix>.trace_id`, `<prefix>.span_id`, `<prefix>.root`) over the
 * `OTEL_RESOURCE_ATTRIBUTES` `env` has, so a binary that ignores
 * `TRACEPARENT` still names the span that ran it, and `OTEL_TRACES_EXPORTER`
 * `otlp` unless `env` chose one (`none` keeps it off). Lifted from
 * terragucci's `binaryEnv` (telemetry.ts).
 */
export function commandTraceEnv(env: NodeJS.ProcessEnv, trace: OtlpTrace, span: OtlpSpan, options: { prefix: string; root: string }): Record<string, string> {
  const resource = {
    ...parseOtlpPairs(env.OTEL_RESOURCE_ATTRIBUTES),
    [`${options.prefix}.trace_id`]: trace.traceId,
    [`${options.prefix}.span_id`]: span.spanId,
    [`${options.prefix}.root`]: options.root,
  };
  return {
    TRACEPARENT: trace.traceparent(span),
    OTEL_TRACES_EXPORTER: env.OTEL_TRACES_EXPORTER || "otlp",
    OTEL_RESOURCE_ATTRIBUTES: formatOtlpPairs(resource),
  };
}

/** What {@link commandTrace} takes. */
export interface CommandTraceOptions {
  /** The run's trace. */
  trace: OtlpTrace;
  /** The product, which names the resource attributes (`terragucci.trace_id`). */
  prefix: string;
  /** The span a command's span hangs under, such as the product's span for its root. Undefined, or no function, hangs it under the trace's parent. */
  parent?: (command: TerraformCommand) => OtlpSpan | undefined;
  /** The environment the commands run over, whose `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_TRACES_EXPORTER` are kept. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Trace an upstream's reads for a root too. Default false: they are the upstream's, not the root's. */
  upstreams?: boolean;
}

/**
 * A command hook that traces each engine command (chant#4954): a span
 * `<binary> <name>` (kind client, with `process.executable.name` and
 * `process.command_args`) under `parent(command)`, the variables
 * {@link commandTraceEnv} gives for it, and the span ended with
 * `process.exit.code` once the command ends, failed unless it exited 0 (or 2
 * for a `plan`, `-detailed-exitcode`'s changes). A command timed apart from
 * its call (`at`, a Terragrunt unit's plan) spans the time it ran. Pass it as
 * `engineTimings({ inner })`, so the engine's spans join the trace and reach
 * the timings' receiver.
 */
export function commandTrace(options: CommandTraceOptions): TerraformCommandHook {
  return (c) => {
    if (c.upstream !== undefined && !options.upstreams) return;
    const span = options.trace.start(`${c.binary} ${c.name}`, options.parent?.(c), { "process.executable.name": c.binary, "process.command_args": c.args.join(" ") }, { kind: 3 });
    return {
      env: commandTraceEnv({ ...(options.env ?? process.env), ...c.env }, options.trace, span, { prefix: options.prefix, root: c.root }),
      after: (r) => {
        if (r.at) span.start = BigInt(Math.round(r.at.start)) * 1_000_000n;
        const ok = r.code === 0 || (c.name === "plan" && r.code === 2);
        options.trace.end(span, { "process.exit.code": r.code ?? -1 }, ok ? undefined : `exit ${r.code}`, r.at?.end);
      },
    };
  };
}

/**
 * Compiling a release (#4026, ws-104 question 5): what one environment
 * compiles to, and the artifacts built once.
 *
 * A template is synthesized for one environment per invocation: `--env` sets
 * `CHANT_ENV` before the project is imported, and `*.component.ts` files are
 * imported with a plain `import()`, which caches the module. So each
 * environment is compiled in a child process of its own
 * ({@link spawnTargetCompiler}), running `chant release compile --env <env>`,
 * which calls {@link compileEnvironment} in that process and prints the
 * result as JSON. The artifacts are built in one more child, for the first
 * environment in which each component is enabled ({@link buildReleaseArtifacts}).
 *
 * What counts as a template is data, as the build and publish kinds are in
 * ./promote.ts: a literal path in a deploy step's `template`, `manifest` or
 * `values` field ({@link TEMPLATE_FIELDS}), read after the environment's build
 * command has run. A path with the `archive:` prefix names the file after it.
 * A path that names a directory, such as a chart, is not a template.
 *
 * A project with no components (#4046) is compiled the way `chant build --env
 * <env> -o <output>` builds it ({@link compileBuildOutput}): every file that
 * build writes is a template with `component: null`, and the target's params
 * are the build's `buildParams`. The files are kept in memory rather than read
 * back from disk, so a file an earlier build left behind is never recorded.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadChantConfig, type ChantConfig } from "../config";
import { resolveFlaggedBuildParams } from "../flag-params";
import { discoverComponents } from "./discover";
import { withoutDisabled } from "./cli-support";
import { applyConfigDefaults } from "./config-defaults";
import { fanOutRegistry } from "./fan-out-support";
import { ARCHIVE_STEP_KINDS, BUILD_STEP_KINDS, PUBLISH_STEP_KINDS } from "./promote";
import { DriverRunFailure, runInterpretDriver, type DriverComponent, type DriverGate, type DriverPhase, type DriverStep } from "./driver";
import type { CapabilityRegistry } from "./capability";
import { memoryGateLedgerPort } from "../op/gate";
import type { ReleaseArtifact, ReleaseParam } from "../lifecycle/release-store";

/** The deploy step fields whose literal file paths are a component's templates. */
export const TEMPLATE_FIELDS: readonly string[] = ["template", "manifest", "values"];

/** The prefix a step may write before an archive-relative template path. */
const ARCHIVE_PREFIX = "archive:";

/** One template a component's deploy reads, as the step names it. */
export interface TemplateRef {
  component: string;
  phase: string;
  kind: string;
  field: string;
  /** The value as written in the step. */
  value: string;
  /** The file it names, relative to the member's directory as written (the `archive:` prefix removed). */
  path: string;
}

/** A compiled template: its path and its bytes. */
export interface CompiledTemplate {
  component: string | null;
  path: string;
  content: string;
}

/** What one environment compiles to. */
export interface CompiledTarget {
  env: string;
  params: ReleaseParam[];
  /** The components enabled in this environment, by name. */
  components: string[];
  /** Each component's build-time steps, as declared for this environment, in composition order. */
  buildSteps: Record<string, unknown[]>;
  /**
   * Each component's publish steps (`PUBLISH_STEP_KINDS`), as declared for
   * this environment, in composition order (#4027). The cut's dry run shows
   * them as what each environment's deploy publishes. Absent from a compiler
   * that does not report them.
   */
  publishSteps?: Record<string, unknown[]>;
  /** For each component, the files its build steps read, relative to the member's directory. Used to tell whether an artifact's source changed. */
  buildInputs: Record<string, string[]>;
  /** For each component, the file that declares it, relative to the member's directory. */
  componentFiles: Record<string, string>;
  templates: CompiledTemplate[];
}

/** Compiles a member for one environment, and builds its artifacts. The cut talks to a compiler only, so a test can hand it fixtures. */
export interface TargetCompiler {
  compile(env: string): Promise<CompiledTarget>;
  buildArtifacts(env: string, components: readonly string[]): Promise<ReleaseArtifact[]>;
}

function isGate(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhase(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/** Every step of a composition with the phase it sits in, nested phases included, in order. */
function stepsOf(phases: readonly DriverPhase[]): Array<{ phase: string; step: DriverStep }> {
  const out: Array<{ phase: string; step: DriverStep }> = [];
  const walk = (phase: DriverPhase): void => {
    for (const step of phase.steps) {
      if (isPhase(step)) walk(step);
      else if (!isGate(step)) out.push({ phase: phase.phase, step });
    }
  };
  phases.forEach(walk);
  return out;
}

const isLiteralPath = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && !v.startsWith("@") && !v.startsWith("$");

/** The templates a component's deploy reads: literal paths in {@link TEMPLATE_FIELDS} of its steps other than build and publish steps. */
export function templateRefs(component: DriverComponent): TemplateRef[] {
  const out: TemplateRef[] = [];
  for (const { phase, step } of stepsOf(component.deploy)) {
    if (BUILD_STEP_KINDS.includes(step.kind) || PUBLISH_STEP_KINDS.includes(step.kind)) continue;
    for (const field of TEMPLATE_FIELDS) {
      const raw = step[field];
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (!isLiteralPath(value)) continue;
        const path = value.startsWith(ARCHIVE_PREFIX) ? value.slice(ARCHIVE_PREFIX.length) : value;
        out.push({ component: component.name, phase, kind: step.kind, field, value, path });
      }
    }
  }
  return out;
}

/** A component's build-time steps ({@link BUILD_STEP_KINDS}), each as declared, in composition order. */
export function buildStepsOf(component: DriverComponent): DriverStep[] {
  return stepsOf(component.deploy).map((s) => s.step).filter((s) => BUILD_STEP_KINDS.includes(s.kind));
}

/** A component's publish steps ({@link PUBLISH_STEP_KINDS}), each as declared, in composition order. */
export function publishStepsOf(component: DriverComponent): DriverStep[] {
  return stepsOf(component.deploy).map((s) => s.step).filter((s) => PUBLISH_STEP_KINDS.includes(s.kind));
}

/** The literal paths a component's archive steps read: `docker-build`'s `context` and `dockerfile`, `zip-package`'s `source`, `jvm-build`'s `path`. */
export function buildInputPaths(component: DriverComponent): string[] {
  const out: string[] = [];
  for (const step of buildStepsOf(component)) {
    if (step.kind === "docker-build") {
      if (isLiteralPath(step.context)) {
        out.push(step.context);
        out.push(isLiteralPath(step.dockerfile) ? `${step.context}/${step.dockerfile}` : `${step.context}/Dockerfile`);
      }
    } else if (step.kind === "zip-package" && isLiteralPath(step.source)) out.push(step.source);
    else if (step.kind === "jvm-build" && isLiteralPath(step.path)) out.push(step.path);
  }
  return [...new Set(out)];
}

/** A component's composition with only its archive steps ({@link ARCHIVE_STEP_KINDS}) left, gates and every other step taken out. */
export function withOnlyArchiveSteps(component: DriverComponent): DriverComponent | undefined {
  const keep = (phase: DriverPhase): DriverPhase | undefined => {
    const steps: DriverPhase["steps"] = [];
    for (const step of phase.steps) {
      if (isPhase(step)) {
        const nested = keep(step);
        if (nested) steps.push(nested);
      } else if (!isGate(step) && ARCHIVE_STEP_KINDS.includes(step.kind)) steps.push(step);
    }
    return steps.length > 0 ? { phase: phase.phase, steps } : undefined;
  };
  const deploy = component.deploy.map(keep).filter((p): p is DriverPhase => p !== undefined);
  return deploy.length > 0 ? { name: component.name, dependsOn: [], deploy } : undefined;
}

/** How one environment is compiled: the build command, and the parameter inputs `chant build` takes. */
export interface CompileInputs {
  /** The member's directory. */
  projectDir: string;
  /** A shell command run in the member's directory before the templates are read, with `CHANT_ENV` set to the environment. */
  buildCommand?: string;
  /** `--param name=value` values, the same for every environment. */
  params?: Record<string, string>;
  /** `--params-file`, with `{env}` replaced by the environment's name. */
  paramsFile?: string;
  /** For a project with no components: the build root, relative to the member's directory. Defaults to `chant.config.ts` `sourceDir`, then the member's directory, as `chant lifecycle` resolves it. */
  src?: string;
  /** For a project with no components: the build's output file, relative to the member's directory, as `chant build -o` takes it. Defaults to {@link DEFAULT_BUILD_OUTPUT}. */
  output?: string;
  /** For a project with no components: build only this lexicon, as `chant build --lexicon` does. */
  lexicon?: string;
}

/**
 * Where a project with no components writes its build output when the cut
 * names no `-o`. YAML, since the k8s and helm serializers write YAML whatever
 * the extension, and a JSON output converts to it.
 */
export const DEFAULT_BUILD_OUTPUT = "dist/build.yaml";

/** Thrown when an environment can't be compiled. */
export class ReleaseCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseCompileError";
  }
}

async function loadComponents(
  inputs: CompileInputs,
  env: string,
): Promise<{ config: ChantConfig; params: ReleaseParam[]; declared: number; components: Array<{ component: DriverComponent; file: string }> }> {
  const { config } = await loadChantConfig(inputs.projectDir).catch(() => ({ config: {} as ChantConfig }));
  // #4024: a workspace member's flag records back their parameters, so a flag's value is a param with source flag:<name>.
  const resolved = await resolveFlaggedBuildParams(inputs.projectDir, config.buildParams, {
    ...(inputs.params ? { cli: inputs.params } : {}),
    ...(inputs.paramsFile ? { paramsFile: inputs.paramsFile.replaceAll("{env}", env) } : {}),
  }, env);
  if (!resolved.success) throw new ReleaseCompileError(`build parameters for "${env}" did not resolve:\n${resolved.errors.join("\n")}`);
  const discovered = await discoverComponents(inputs.projectDir, { buildParams: resolved.provenance });
  if (discovered.errors.length > 0) throw new ReleaseCompileError(discovered.errors.map((e) => e.message).join("\n"));
  const all = [...discovered.components.values()];
  const plain = all.map(({ component }) => ({
    name: component.name,
    dependsOn: component.dependsOn,
    deploy: component.deploy as DriverPhase[],
    ...(component.rollback ? { rollback: component.rollback as DriverPhase[] } : {}),
  }));
  const enabled = withoutDisabled(all.map((d) => d.component), plain);
  const fileOf = new Map(all.map((d) => [d.component.name, d.filePath]));
  return {
    config,
    params: resolved.provenance.map(({ name, value, source }) => ({ name, value, source })),
    declared: all.length,
    components: enabled.map((c) => ({ component: applyConfigDefaults(c, config), file: fileOf.get(c.name)! })),
  };
}

/**
 * Compile the member for `env` in this process: run the build command, resolve
 * the build parameters, discover the components enabled under them, and read
 * the templates their deploys name. Call it once per process, with
 * `CHANT_ENV` already set to `env`, since component modules are cached.
 */
export async function compileEnvironment(inputs: CompileInputs, env: string): Promise<CompiledTarget> {
  if (inputs.buildCommand) {
    const run = spawnSync(inputs.buildCommand, {
      cwd: inputs.projectDir,
      shell: true,
      stdio: ["ignore", 2, 2],
      env: { ...process.env, CHANT_ENV: env },
    });
    if (run.status !== 0) throw new ReleaseCompileError(`the build command for "${env}" exited ${run.status ?? "with a signal"}: ${inputs.buildCommand}`);
  }
  const { config, params, declared, components } = await loadComponents(inputs, env);
  if (declared === 0) return compileBuildOutput(inputs, env, config);
  const rel = (p: string): string => (isAbsolute(p) ? relative(inputs.projectDir, p) : p);
  const templates: CompiledTemplate[] = [];
  const seen = new Set<string>();
  for (const { component } of components) {
    for (const ref of templateRefs(component)) {
      const key = `${ref.component}\u0000${ref.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = resolve(inputs.projectDir, ref.path);
      if (!existsSync(file)) {
        throw new ReleaseCompileError(
          `component "${ref.component}": its ${ref.kind} step in phase "${ref.phase}" reads ${ref.field} "${ref.value}", ` +
            `and no such file exists after the build for "${env}"`,
        );
      }
      if (!statSync(file).isFile()) continue;
      templates.push({ component: ref.component, path: ref.path, content: readFileSync(file, "utf-8") });
    }
  }
  return {
    env,
    params,
    components: components.map((c) => c.component.name),
    buildSteps: Object.fromEntries(components.map(({ component }) => [component.name, buildStepsOf(component)])),
    publishSteps: Object.fromEntries(components.map(({ component }) => [component.name, publishStepsOf(component)])),
    buildInputs: Object.fromEntries(components.map(({ component }) => [component.name, buildInputPaths(component)])),
    componentFiles: Object.fromEntries(components.map(({ component, file }) => [component.name, rel(file)])),
    templates,
  };
}

/**
 * Compile a project with no components for `env` (#4046, ws-104 question 5):
 * build it as `chant build <src> --env <env> -o <output>` would, and record
 * each file that build writes as a template with `component: null`, by its
 * path relative to the member's directory. The params are the build's own
 * `buildParams`. Nothing is written to disk.
 */
export async function compileBuildOutput(inputs: CompileInputs, env: string, config: ChantConfig): Promise<CompiledTarget> {
  if (!inputs.src && config.stacks && config.stacks.length > 0) {
    throw new ReleaseCompileError(
      `this project declares ${config.stacks.length} stack(s) in chant.config.ts and no component, and a release of a project with no components compiles one build root; ` +
        "name it with --src <dir>",
    );
  }
  const projectDir = resolve(inputs.projectDir);
  const root = resolve(projectDir, inputs.src ?? config.sourceDir ?? ".");
  const output = resolve(projectDir, inputs.output ?? DEFAULT_BUILD_OUTPUT);
  const rel = relative(projectDir, output);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ReleaseCompileError(`the build output "${inputs.output}" is outside the member's directory; name a file inside it`);
  }
  // Loaded here: a project with components never needs the lexicon plugins in this process.
  const { loadPlugins, resolveProjectLexicons } = await import("../cli/plugins");
  const { buildCommand, printWarnings, resolveBuildFormat } = await import("../cli/commands/build");
  const plugins = await loadPlugins(await resolveProjectLexicons(projectDir, inputs.lexicon ? { lexicon: inputs.lexicon } : {}));
  const serializers = plugins.map((p) => p.serializer).filter((s) => !inputs.lexicon || s.name === inputs.lexicon);
  if (serializers.length === 0) {
    throw new ReleaseCompileError(
      inputs.lexicon ? `no serializer found for lexicon "${inputs.lexicon}"` : "this project has no component and no lexicon, so there is nothing to compile a release from",
    );
  }
  const files = new Map<string, string>();
  const result = await buildCommand({
    path: root,
    output,
    format: resolveBuildFormat(undefined, output).format,
    serializers,
    plugins,
    env,
    ...(inputs.params ? { params: inputs.params } : {}),
    ...(inputs.paramsFile ? { paramsFile: inputs.paramsFile.replaceAll("{env}", env) } : {}),
    writeFile: (path, content) => files.set(path, content),
  });
  printWarnings(result.warnings);
  if (!result.success) {
    throw new ReleaseCompileError(`the build for "${env}" failed:\n${result.errors.join("\n")}`);
  }
  if (result.fileCount === 0 && result.resourceCount === 0) {
    throw new ReleaseCompileError(`no source files were found under ${relative(projectDir, root) || "."}, so there is nothing to compile a release from`);
  }
  const templates: CompiledTemplate[] = [];
  for (const [path, content] of files) {
    const p = relative(projectDir, path);
    if (p.startsWith("..") || isAbsolute(p)) {
      throw new ReleaseCompileError(`the build for "${env}" writes ${path}, outside the member's directory, so the release can't record it`);
    }
    templates.push({ component: null, path: p.split("\\").join("/"), content });
  }
  templates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    env,
    params: (result.buildParams ?? []).map(({ name, value, source }) => ({ name, value, source })),
    components: [],
    buildSteps: {},
    buildInputs: {},
    componentFiles: {},
    templates,
  };
}

/**
 * Build the artifacts of `names` once, for `env`: run each component's archive
 * steps, and nothing else, through the driver. `docker-build` gives an `image`
 * entry, `zip-package` and `jvm-build` an `asset` entry, each with the path it
 * wrote and its digest.
 */
export async function buildReleaseArtifacts(
  inputs: CompileInputs,
  env: string,
  names: readonly string[],
  registry?: CapabilityRegistry,
): Promise<ReleaseArtifact[]> {
  const { config, components } = await loadComponents(inputs, env);
  const wanted = new Set(names);
  const targets = components
    .filter(({ component }) => wanted.has(component.name))
    .map(({ component }) => withOnlyArchiveSteps(component))
    .filter((c): c is DriverComponent => c !== undefined);
  if (targets.length === 0) return [];
  const reg = registry ?? (await fanOutRegistry(inputs.projectDir, config));
  let run;
  try {
    run = await runInterpretDriver(targets, reg, { env, gates: memoryGateLedgerPort() });
  } catch (err) {
    if (err instanceof DriverRunFailure) {
      const failed = err.result.results.find((r) => r.status === "fail");
      const step = failed?.records.find((r) => r.status === "fail");
      throw new ReleaseCompileError(`building the artifacts of "${failed?.component ?? "?"}" failed${step?.error ? `: ${step.error}` : ""}`);
    }
    throw err;
  }
  const artifacts: ReleaseArtifact[] = [];
  for (const result of run.results) {
    for (const record of result.records) {
      if (record.status !== "ok" || !ARCHIVE_STEP_KINDS.includes(record.kind)) continue;
      const out = record.output as { archivePath?: unknown; digest?: unknown } | undefined;
      if (typeof out?.archivePath !== "string" || typeof out.digest !== "string") {
        throw new ReleaseCompileError(`component "${result.component}": its ${record.kind} step returned no archive path and digest`);
      }
      artifacts.push({ component: result.component, kind: record.kind === "docker-build" ? "image" : "asset", path: out.archivePath, digest: out.digest });
    }
  }
  return artifacts;
}

/** How {@link spawnTargetCompiler} starts this chant. */
export function ownChantCommand(): string[] {
  const main = process.argv[1] ?? "";
  return [process.execPath, ...process.execArgv, main];
}

function runChild(command: readonly string[], args: readonly string[], cwd: string, env: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const [bin, ...lead] = command;
    const child = spawn(bin, [...lead, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CHANT_ENV: env } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      err.push(c);
      process.stderr.write(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") }));
  });
}

/**
 * The compiler the CLI uses: each environment in a child process of this same
 * chant (`chant release compile --env <env> --json`), with `CHANT_ENV` set to
 * that environment before anything imports the project.
 */
export function spawnTargetCompiler(inputs: CompileInputs, command: readonly string[] = ownChantCommand()): TargetCompiler {
  const common = (): string[] => {
    const args: string[] = [];
    if (inputs.src) args.push("--src", inputs.src);
    if (inputs.output) args.push("--output", inputs.output);
    if (inputs.lexicon) args.push("--lexicon", inputs.lexicon);
    for (const [k, v] of Object.entries(inputs.params ?? {})) args.push("--param", `${k}=${v}`);
    if (inputs.paramsFile) args.push("--params-file", inputs.paramsFile);
    return args;
  };
  const call = async (env: string, extra: string[]): Promise<unknown> => {
    const run = await runChild(command, ["release", "compile", "--env", env, ...common(), ...extra, "--json"], inputs.projectDir, env);
    if (run.code !== 0) throw new ReleaseCompileError(`compiling "${env}" failed (exit ${run.code})`);
    try {
      return JSON.parse(run.stdout);
    } catch {
      throw new ReleaseCompileError(`compiling "${env}" printed something that is not JSON`);
    }
  };
  return {
    async compile(env) {
      return (await call(env, inputs.buildCommand ? ["--build", inputs.buildCommand] : [])) as CompiledTarget;
    },
    async buildArtifacts(env, components) {
      return ((await call(env, ["--artifacts", "--component", components.join(",")])) as { artifacts: ReleaseArtifact[] }).artifacts;
    },
  };
}

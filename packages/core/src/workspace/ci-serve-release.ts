/**
 * Releases on a `chant ci serve` host (#5462): the publish job `chant release
 * workflow` renders, run on the host for each release tag, so a release
 * served there gets the steps a forge's workflow gives it.
 *
 * - The steps. The host renders the release workflow from the same input
 *   `chant release workflow` reads ({@link releaseWorkflowInputAt}), with the
 *   tag trigger, and runs the `publish` job's steps in order: the install,
 *   the doctor, the stamp, the images, the build, the fetches, verify and
 *   `chant release publish` with the flags the security groups add (or, for
 *   a train, `chant workspace train prepare` and `publish`). It renders the
 *   Forgejo file, whose steps are a GitHub job's without the GitHub-hosted
 *   extras (the job token, the npm upgrade for trusted publishing). The
 *   checkout is a fresh detached worktree of the tag, and the toolchain
 *   set-up actions are the host's own toolchains; any other action refuses
 *   the release, since a host runs no actions.
 * - The tools. cosign, and the scanner and syft, are installed from
 *   {@link TOOL_PINS} into the state directory, each checked against its
 *   SHA-256, and named to the job by `CHANT_COSIGN`, `CHANT_GRYPE` and
 *   `CHANT_SYFT`, as the job's own install steps would. With those set the
 *   rendered job has no install steps. A host that already sets one of the
 *   variables brings its own. A platform with no pin, or a download that
 *   fails, names the tool and stops before anything stages.
 * - A step runs as a forge runs it: `bash -eo pipefail`, in the job's
 *   working directory, with `RUNNER_TEMP`, `GITHUB_ENV`, `GITHUB_OUTPUT`,
 *   `GITHUB_PATH`, `GITHUB_REF_NAME` and `GITHUB_SHA` set and read back after
 *   it, and with the runner's base variables, never the forge's run
 *   variables, so the publish takes the host for what it is.
 * - The builder. Every step gets the runner key's fingerprint
 *   ({@link RUNNER_FINGERPRINT_ENV}), so the SLSA statement names the host as
 *   its builder, and the run id `ci serve` gave it, so the publish record
 *   names both.
 * - Secrets. `${{ secrets.NAME }}` in the job reads the host's secrets file,
 *   as a forge reads the repository's secrets, and only where the job names
 *   it. The step that publishes also gets the file's secrets for `release`
 *   (`jobs.release`, else every one): the registry credentials, which no
 *   other step gets.
 * - Dispatch requests (PR 2). A `ci/release/<sha>` tag asks for a release
 *   of a commit, as `ci/build/<sha>` asks for a build. The host renders the
 *   dispatch shape of the release workflow with `gate: "head"` and runs its
 *   `gate` and `cut` jobs: the gate refuses a commit that is not green,
 *   and the cut runs the doctor, the stamp, the images and the cut, and
 *   pushes the release's tag, which the host then publishes as any tag.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseYAML } from "../yaml";
import { TOOL_PINS, type ToolPin } from "../tool-pins";
import { tagShape } from "../lifecycle/release-tag";
import { RUNNER_FINGERPRINT_ENV, resolveSigning } from "../lifecycle/publish-signing";
import { CHANT_CI_RUN_FORGE_ENV, CHANT_CI_RUN_ID_ENV } from "../lifecycle/release-ledger";
import { redactorOf } from "../op/redact";
import { CI_RUN_BASE_ENV } from "./ci-run";
import { ciSecretsFor, type CiSecrets } from "./ci-secrets";
import { releaseWorkflowInputAt, renderReleaseWorkflow, ReleaseWorkflowInputError, type ReleaseWorkflowRead } from "./release-workflow";

/** The forge whose release workflow a host runs: Forgejo's steps are a GitHub job's, without what only GitHub's hosted runners have. */
export const HOST_RELEASE_RENDER_FORGE = "forgejo" as const;

/** Why a release can't be served on this host, in a sentence, and what to do. */
export class HostReleaseError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = "HostReleaseError";
  }
}

// ── Which tags are releases ──────────────────────────────────────────────────

/**
 * Whether a tag starts a publish, as the rendered workflow's trigger reads
 * tags: `release-train/<env>/<id>` at a train's root, `release/**` for the
 * legacy template, else the tags a `release.tag` template makes, without
 * its floating tag.
 */
export function releaseTagMatcher(read: Pick<ReleaseWorkflowRead, "release" | "tags">): (tag: string) => boolean {
  const train = read.release?.train;
  if (train) {
    const prefix = `release-train/${train.env}/`;
    return (t) => t.startsWith(prefix) && t.length > prefix.length && !t.slice(prefix.length).includes("/");
  }
  const { template, place } = read.tags;
  if (template.legacy) return (t) => t.startsWith("release/") && t.length > "release/".length;
  const name = tagShape(template.name, place);
  const floating = template.floating ? tagShape(template.floating, place) : null;
  const between = (t: string, s: { prefix: string; suffix: string }): string | null =>
    t.startsWith(s.prefix) && t.endsWith(s.suffix) && t.length > s.prefix.length + s.suffix.length ? t.slice(s.prefix.length, t.length - s.suffix.length) : null;
  return (t) => {
    const mid = between(t, name);
    if (mid === null || mid.includes("/")) return false;
    const moved = floating ? between(t, floating) : null;
    return !(moved !== null && /^[0-9]+$/.test(moved));
  };
}

// ── Signing on a host ────────────────────────────────────────────────────────

/**
 * Why this host can't sign what its releases publish, or null (#5458): it
 * has no CI OIDC token, so a keyless signer can't sign here, and under
 * `supply-chain` each release that publishes must sign with `kms` or `key`,
 * whose signed SLSA statement is the provenance `--require-provenance`
 * asks for.
 */
export function hostSigningRefusal(read: Pick<ReleaseWorkflowRead, "release" | "memberReleases" | "input">): HostReleaseError | null {
  const groups = read.input.groups;
  const configs = [read.release, ...read.memberReleases].filter((r) => (r?.publish?.length ?? 0) > 0);
  const fix = "Sign with a KMS key (release.signing.kms) or a key (release.signing.key) in chant.config.ts, or publish from the forge's release workflow.";
  for (const r of configs) {
    const setting = resolveSigning(r?.signing, groups);
    if (setting.on && setting.mode === "keyless") {
      return new HostReleaseError(`a release here signs keylessly (${setting.from === "config" ? "release.signing" : "the supply-chain group"}), and a ci serve host has no CI OIDC token to sign with`, fix);
    }
    if (groups.has("supply-chain") && !setting.on) {
      return new HostReleaseError("the workspace opts into supply-chain, so a publish needs provenance, and with release.signing off nothing on a ci serve host signs the SLSA statement that would be it", fix);
    }
  }
  return null;
}

// ── The job ──────────────────────────────────────────────────────────────────

/** One step of a rendered job. */
export interface HostStep {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env: Record<string, string>;
}

/** One job of a rendered workflow, as the host runs it. */
export interface HostJob {
  job: string;
  /** The workflow's and the job's `env:`, the job's last. */
  env: Record<string, string>;
  /** `defaults.run.working-directory`, from the repository root. */
  workingDirectory?: string;
  /** The job's `outputs:`, as expressions over its steps' outputs. */
  outputs?: Record<string, string>;
  steps: HostStep[];
}

const strings = (o: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((o ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));

/** The job `job` of a rendered workflow's text. */
export function workflowJob(text: string, job: string): HostJob {
  const doc = parseYAML(text) as { env?: unknown; jobs?: Record<string, Record<string, unknown>> };
  const j = doc.jobs?.[job];
  if (!j) throw new HostReleaseError(`the rendered release workflow has no ${job} job`);
  const dir = ((j.defaults as { run?: Record<string, unknown> } | undefined)?.run ?? {})["working-directory"];
  const steps = ((j.steps ?? []) as Array<Record<string, unknown>>).map(
    (s): HostStep => ({
      ...(typeof s.name === "string" ? { name: s.name } : {}),
      ...(typeof s.id === "string" ? { id: s.id } : {}),
      ...(s.if !== undefined ? { if: String(s.if) } : {}),
      ...(typeof s.run === "string" ? { run: s.run } : {}),
      ...(typeof s.uses === "string" ? { uses: s.uses } : {}),
      ...(s.with !== undefined ? { with: strings(s.with) } : {}),
      env: strings(s.env),
    }),
  );
  return { job, env: { ...strings(doc.env), ...strings(j.env) }, ...(typeof dir === "string" ? { workingDirectory: dir } : {}), ...(j.outputs !== undefined ? { outputs: strings(j.outputs) } : {}), steps };
}

/** The checkout and the toolchain set-up actions: the host's worktree and its own toolchains stand for them. */
const HOST_ACTIONS = /^(actions\/checkout|actions\/setup-(node|go|python|java)|actions-rust-lang\/setup-rust-toolchain|oven-sh\/setup-bun)@/;
/** The actions that hand files from one job to the next: on one host the jobs share the files. */
const HANDING_ACTIONS = /^actions\/(upload|download)-artifact@/;

/** What the host does with a step: run it, or skip an action the host stands in for, and why. */
export function hostStepAction(step: HostStep): { run: true } | { run: false; why: string } {
  if (step.run !== undefined) return { run: true };
  const uses = step.uses ?? "";
  if (HOST_ACTIONS.test(uses)) return { run: false, why: uses.startsWith("actions/checkout@") ? "the worktree of the release" : "the host's own toolchain" };
  if (HANDING_ACTIONS.test(uses)) return { run: false, why: "files the jobs share on this host" };
  throw new HostReleaseError(`the release job runs the action ${uses}, and a ci serve host runs no actions`, "Give the step as { run } in release.workflow.setup, or publish from the forge's release workflow.");
}

/** Whether a step is the one that publishes: it alone gets the release's secrets. */
export const isPublishStep = (step: HostStep): boolean => /\b(release publish|workspace train publish)\b/.test(step.run ?? "");

/** The variables that name the release tools, which the rendered job's install steps set. */
export const HOST_TOOL_VARIABLES = { cosign: "CHANT_COSIGN", grype: "CHANT_GRYPE", syft: "CHANT_SYFT" } as const;

/**
 * The publish job the host runs for a release: the release workflow rendered
 * for {@link HOST_RELEASE_RENDER_FORGE} with the tag trigger, with `tools`
 * (the release tools' variables) in its env, so it has no install steps.
 * Per-platform builds need runners of their own and refuse.
 */
export function hostReleaseJob(read: Pick<ReleaseWorkflowRead, "input">, tools: Record<string, string> = {}): HostJob {
  const p = read.input.pipeline ?? {};
  if ((p.builds?.length ?? 0) > 0 || (read.input.train?.builds?.length ?? 0) > 0) {
    throw new HostReleaseError("release.workflow.builds runs each build on a runner of its own, and a ci serve host is one runner", "Publish from the forge's release workflow, or build the files in the cut.");
  }
  const pipeline = { ...p, trigger: "tag" as const, ...(Object.keys(tools).length > 0 ? { env: { ...p.env, ...tools } } : {}) };
  let text: string;
  try {
    text = renderReleaseWorkflow({ ...read.input, forge: HOST_RELEASE_RENDER_FORGE, pipeline });
  } catch (err) {
    throw new HostReleaseError(`the release workflow could not be rendered: ${err instanceof Error ? err.message : String(err)}`, "Fix release.workflow in chant.config.ts.");
  }
  return workflowJob(text, "publish");
}

// ── Expressions ──────────────────────────────────────────────────────────────

/** What a `${{ }}` in a job reads on a host. */
export interface HostScope {
  secrets: Record<string, string>;
  inputs?: Record<string, string>;
  needs?: Record<string, Record<string, string>>;
  steps?: Record<string, Record<string, string>>;
  runnerTemp?: string;
}

function evalTerm(term: string, scope: HostScope): string | undefined {
  const t = term.trim();
  const q = /^'(.*)'$/.exec(t);
  if (q) return q[1]!;
  let m = /^secrets\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(t);
  if (m) return scope.secrets[m[1]!] ?? "";
  m = /^inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(t);
  if (m) return scope.inputs?.[m[1]!] ?? "";
  m = /^needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/.exec(t);
  if (m) return scope.needs?.[m[1]!]?.[m[2]!] ?? "";
  m = /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/.exec(t);
  if (m) return scope.steps?.[m[1]!]?.[m[2]!] ?? "";
  if (t === "runner.temp" && scope.runnerTemp !== undefined) return scope.runnerTemp;
  return undefined;
}

/** One expression's value: a term, or `a || b`, the first that is not empty. Undefined for one a host has no value for. */
export function evalExpression(expr: string, scope: HostScope): string | undefined {
  let last = "";
  for (const term of expr.split("||")) {
    const v = evalTerm(term, scope);
    if (v === undefined) return undefined;
    if (v !== "") return v;
    last = v;
  }
  return last;
}

const EXPRESSION = /\$\{\{\s*(.+?)\s*\}\}/g;

/** `text` with each `${{ }}` replaced. Throws for one a host has no value for, naming `where`. */
export function resolveExpressions(text: string, scope: HostScope, where: string): string {
  return text.replace(EXPRESSION, (whole, expr: string) => {
    const v = evalExpression(expr, scope);
    if (v === undefined) throw new HostReleaseError(`${where} reads ${whole}, which a ci serve host has no value for`, "Set the variable in release.workflow.env from a secret (${{ secrets.NAME }}), and give the secret in the --secrets file.");
    return v;
  });
}

/**
 * The variables a forge job that hands files on gives its git in place of
 * the checkout's stored token (`GIT_TOKEN_ENV` in ./release-workflow.ts).
 * A host's git has its own credentials, so they are left out.
 */
export const FORGE_GIT_CREDENTIAL_ENV: readonly string[] = ["CHANT_RELEASE_GIT_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];

/**
 * A job's or a step's variables with their expressions resolved. A variable
 * whose expression a host can't read takes the secret of its own name, as
 * `ci run` fills a job's variables, and refuses when there is none.
 */
export function resolveEnv(env: Record<string, string>, scope: HostScope, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (FORGE_GIT_CREDENTIAL_ENV.includes(name)) continue;
    try {
      out[name] = resolveExpressions(value, scope, `${where} variable ${name}`);
    } catch (err) {
      if (scope.secrets[name] === undefined) throw err;
      out[name] = scope.secrets[name]!;
    }
  }
  return out;
}

/** A step's `if:`, as far as a release job asks: `always()`, `success()`, and an output compared with a quoted string. Throws for anything else. */
export function evalCondition(cond: string, scope: HostScope): boolean {
  const c = cond.trim().replace(/^\$\{\{\s*(.*?)\s*\}\}$/, "$1");
  if (c === "always()" || c === "success()") return true;
  const m = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(c);
  if (m) {
    const a = evalTerm(m[1]!, scope);
    const b = evalTerm(m[3]!, scope);
    if (a !== undefined && b !== undefined) return m[2] === "==" ? a === b : a !== b;
  }
  throw new HostReleaseError(`a step of the release job runs if ${cond}, which a ci serve host can't decide`);
}

// ── The tools ────────────────────────────────────────────────────────────────

/** This host's platform as {@link TOOL_PINS} names one, such as `linux/amd64`. */
export function hostPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const a = arch === "x64" ? "amd64" : arch;
  return `${platform}/${a}`;
}

/** Fetches a tool's release file. The default asks the network. */
export type ToolDownload = (url: string) => Promise<Buffer>;

const fetchDownload: ToolDownload = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

/** Where a tool is cached: its name, version and platform under `cacheDir`. */
export const toolCacheDir = (cacheDir: string, pin: ToolPin, platform: string): string => join(cacheDir, `${pin.name}-${pin.version}-${platform.replace("/", "-")}`);

/**
 * Install `pin` for `platform` into the cache, checked against its SHA-256,
 * unless it is there already, and return the executable's path. Throws a
 * {@link HostReleaseError} naming the tool.
 */
export async function installHostTool(pin: ToolPin, o: { cacheDir: string; platform: string; download?: ToolDownload }): Promise<string> {
  const file = pin.platforms[o.platform];
  if (!file) throw new HostReleaseError(`${pin.name} ${pin.version} is pinned for ${Object.keys(pin.platforms).join(", ")}, and this host is ${o.platform}`);
  const dir = toolCacheDir(o.cacheDir, pin, o.platform);
  const exe = join(dir, pin.name);
  if (existsSync(join(dir, ".installed")) && existsSync(exe)) return exe;
  let bytes: Buffer;
  try {
    bytes = await (o.download ?? fetchDownload)(file.url);
  } catch (err) {
    throw new HostReleaseError(`${pin.name} ${pin.version} could not be downloaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== file.sha256) throw new HostReleaseError(`${pin.name} ${pin.version} from ${file.url} has SHA-256 ${sum}, and chant pins ${file.sha256}, so it was not installed`);
  mkdirSync(o.cacheDir, { recursive: true });
  const work = mkdtempSync(join(o.cacheDir, `.${pin.name}-`));
  if (pin.archive) {
    const tgz = join(work, `${pin.name}.tar.gz`);
    writeFileSync(tgz, bytes);
    try {
      execFileSync("tar", ["-xzf", tgz, "-C", work, pin.name], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      throw new HostReleaseError(`${pin.name} ${pin.version} could not be unpacked: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    writeFileSync(join(work, pin.name), bytes);
  }
  chmodSync(join(work, pin.name), 0o755);
  writeFileSync(join(work, ".installed"), `${file.sha256}\n`);
  if (!existsSync(join(dir, ".installed"))) {
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
  } else rmSync(work, { recursive: true, force: true });
  return exe;
}

/**
 * The release tools a publish needs on this host (#5462): cosign when it
 * signs, grype and syft when it scans. Each comes from the host's own
 * variable when it sets one, else from {@link installHostTool}. Throws a
 * {@link HostReleaseError} naming the tool that can't be had.
 */
export async function hostReleaseTools(req: { signing: boolean; scan: boolean; cacheDir: string; hostEnv: Record<string, string | undefined>; platform?: string; download?: ToolDownload }): Promise<Record<string, string>> {
  const want = [...(req.signing ? (["cosign"] as const) : []), ...(req.scan ? (["grype", "syft"] as const) : [])];
  const out: Record<string, string> = {};
  for (const tool of want) {
    const variable = HOST_TOOL_VARIABLES[tool];
    const own = req.hostEnv[variable];
    if (own) {
      out[variable] = own;
      continue;
    }
    try {
      out[variable] = await installHostTool(TOOL_PINS[tool], { cacheDir: req.cacheDir, platform: req.platform ?? hostPlatform(), ...(req.download ? { download: req.download } : {}) });
    } catch (err) {
      const e = err instanceof HostReleaseError ? err : new HostReleaseError(String(err));
      throw new HostReleaseError(`the release needs ${tool}, and ${e.message}`, `Install ${tool} ${TOOL_PINS[tool].version} on the host and set ${variable} to it, or let the host reach ${new URL(TOOL_PINS[tool].platforms["linux/amd64"]!.url).host}.`);
    }
  }
  return out;
}

// ── Running a job ────────────────────────────────────────────────────────────

/** Runs one step's script; resolves to its exit code. */
export type HostStepRunner = (input: { script: string; cwd: string; env: Record<string, string>; output: (line: string) => void }) => Promise<number>;

/** `bash -eo pipefail`, as a forge runs a step, its output line by line. */
export const bashStepRunner: HostStepRunner = (input) =>
  new Promise<number>((done) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", input.script], { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.setEncoding("utf-8");
      stream.on("data", (chunk: string) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) input.output(l);
      });
      stream.on("end", () => {
        if (rest) input.output(rest);
      });
    }
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });

/** The `NAME=value` and `NAME<<DELIM` entries of a `GITHUB_ENV` or `GITHUB_OUTPUT` file. */
export function readCommandFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heredoc = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(line);
    if (heredoc) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]!);
      out[heredoc[1]!] = body.join("\n");
      continue;
    }
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

/** What a host job runs with. */
export interface HostJobContext {
  /** The worktree of the release, from the repository root. */
  top: string;
  commit: string;
  /** The tag that started it. */
  tag: string;
  /** The run id `ci serve` gave it. */
  runId: string;
  /** The runner key's ssh fingerprint, `SHA256:...`. */
  fingerprint: string;
  hostEnv: Record<string, string | undefined>;
  passEnv?: readonly string[];
  secrets?: CiSecrets;
  /** The job's temp directory, shared by the jobs of one run. */
  runnerTemp: string;
  inputs?: Record<string, string>;
  needs?: Record<string, Record<string, string>>;
  output?: (line: string) => void;
  runStep?: HostStepRunner;
}

/** How a job ended, with the outputs of its steps that have an id. */
export interface HostJobResult {
  status: "ok" | "fail";
  failure?: string;
  steps: Record<string, Record<string, string>>;
  /** The job's `outputs:`, resolved, when it ended ok. */
  outputs?: Record<string, string>;
  /** The last line the failing step printed, which says why. */
  reason?: string;
  /** Each step, in order, run or skipped. */
  ran: Array<{ step: string; status: "ok" | "fail" | "skipped"; why?: string }>;
}

const stepLabel = (s: HostStep): string => s.name ?? (s.run ?? s.uses ?? "a step").split("\n")[0]!.slice(0, 120);

/**
 * The variables one step gets: the runner's base variables and `passEnv`,
 * the release's secrets for the step that publishes, the job's, those
 * earlier steps wrote to `GITHUB_ENV`, the step's own, and what a forge
 * runner sets. The forge's run variables (`GITHUB_ACTIONS`, `GITLAB_CI`,
 * Forgejo's) are never set, so the publish takes this for a host.
 */
export function hostStepEnv(input: { ctx: HostJobContext; job: Record<string, string>; carried: Record<string, string>; step: Record<string, string>; files: { env: string; output: string; path: string }; paths: readonly string[]; publish: boolean }): Record<string, string> {
  const { ctx } = input;
  const env: Record<string, string> = {};
  for (const name of [...CI_RUN_BASE_ENV, ...(ctx.passEnv ?? [])]) {
    const v = ctx.hostEnv[name];
    if (v !== undefined) env[name] = v;
  }
  if (input.publish) Object.assign(env, ciSecretsFor(ctx.secrets, "release"));
  Object.assign(env, input.job, input.carried, input.step, {
    CI: "true",
    RUNNER_TEMP: ctx.runnerTemp,
    GITHUB_ENV: input.files.env,
    GITHUB_OUTPUT: input.files.output,
    GITHUB_PATH: input.files.path,
    GITHUB_WORKSPACE: ctx.top,
    GITHUB_REF: `refs/tags/${ctx.tag}`,
    GITHUB_REF_NAME: ctx.tag,
    GITHUB_REF_TYPE: "tag",
    GITHUB_SHA: ctx.commit,
    [CHANT_CI_RUN_ID_ENV]: ctx.runId,
    [CHANT_CI_RUN_FORGE_ENV]: "chant",
    [RUNNER_FINGERPRINT_ENV]: ctx.fingerprint,
  });
  if (input.paths.length > 0) env.PATH = [...input.paths, env.PATH ?? ""].filter(Boolean).join(":");
  for (const name of ["GITHUB_ACTIONS", "GITLAB_CI", "FORGEJO_ACTIONS", "GITHUB_RUN_ID", "CI_PIPELINE_ID"]) delete env[name];
  return env;
}

/**
 * Run a job's steps in order in the worktree, as a forge runner would, and
 * stop at the first that fails. Never throws for a step that fails; throws
 * {@link HostReleaseError} for a job the host can't run.
 */
export async function runHostJob(job: HostJob, ctx: HostJobContext): Promise<HostJobResult> {
  const secrets = ctx.secrets?.values ?? {};
  const redact = redactorOf(Object.values(secrets));
  const output = (line: string): void => ctx.output?.(redact ? redact(line) : line);
  const steps: Record<string, Record<string, string>> = {};
  const scope = (): HostScope => ({ secrets, ...(ctx.inputs ? { inputs: ctx.inputs } : {}), ...(ctx.needs ? { needs: ctx.needs } : {}), steps, runnerTemp: ctx.runnerTemp });
  const jobEnv = resolveEnv(job.env, scope(), `the ${job.job} job's`);
  const cwd = job.workingDirectory ? resolve(ctx.top, job.workingDirectory) : ctx.top;
  const carried: Record<string, string> = {};
  const paths: string[] = [];
  const ran: HostJobResult["ran"] = [];
  const runStep = ctx.runStep ?? bashStepRunner;
  mkdirSync(ctx.runnerTemp, { recursive: true });
  for (const [n, step] of job.steps.entries()) {
    const label = stepLabel(step);
    const action = hostStepAction(step);
    if (!action.run) {
      ran.push({ step: label, status: "skipped", why: action.why });
      continue;
    }
    if (step.if !== undefined && !evalCondition(step.if, scope())) {
      ran.push({ step: label, status: "skipped", why: `if ${step.if}` });
      continue;
    }
    const script = resolveExpressions(step.run!, scope(), `the step ${JSON.stringify(label)}`);
    const files = { env: join(ctx.runnerTemp, `_step-${n}.env`), output: join(ctx.runnerTemp, `_step-${n}.output`), path: join(ctx.runnerTemp, `_step-${n}.path`) };
    for (const f of Object.values(files)) writeFileSync(f, "");
    const env = hostStepEnv({ ctx, job: jobEnv, carried, step: resolveEnv(step.env, scope(), `the step ${JSON.stringify(label)}'s`), files, paths, publish: isPublishStep(step) });
    output(`$ ${label}`);
    let last: string | undefined;
    const code = await runStep({ script, cwd, env, output: (line) => (line.trim() !== "" ? (last = redact ? redact(line) : line) : undefined, output(line)) });
    Object.assign(carried, readCommandFile(readFileSync(files.env, "utf-8")));
    if (step.id) steps[step.id] = { ...steps[step.id], ...readCommandFile(readFileSync(files.output, "utf-8")) };
    paths.unshift(...readFileSync(files.path, "utf-8").split("\n").filter(Boolean).reverse());
    if (code !== 0) {
      ran.push({ step: label, status: "fail" });
      return { status: "fail", failure: `${label} exited ${code}${last ? `: ${last}` : ""}`, ...(last ? { reason: last } : {}), steps, ran };
    }
    ran.push({ step: label, status: "ok" });
  }
  const outputs = job.outputs ? Object.fromEntries(Object.entries(job.outputs).map(([k, v]) => [k, resolveExpressions(v, scope(), `the ${job.job} job's output ${k}`)])) : undefined;
  return { status: "ok", steps, ...(outputs ? { outputs } : {}), ran };
}

// ── One release ──────────────────────────────────────────────────────────────

/** What `ci serve` asks of {@link runHostRelease}. */
export interface HostReleaseRequest {
  /** The host's clone, from the repository root. */
  top: string;
  /** Where `ci serve` runs, in the clone: the workspace root or a member. */
  cwd: string;
  tag: string;
  commit: string;
  runId: string;
  fingerprint: string;
  hostEnv: Record<string, string | undefined>;
  passEnv?: readonly string[];
  secrets?: CiSecrets;
  /** What runs chant, when `--chant` names it. */
  chant?: string;
  /** Where the tools are cached. */
  toolCache: string;
  download?: ToolDownload;
  platform?: string;
  output?: (line: string) => void;
  runStep?: HostStepRunner;
}

/**
 * The release input at the tag: read from its worktree, as a forge reads the
 * workflow at the tag's commit. A config that can't be read there (one that
 * imports packages the worktree has not installed yet) is read from the
 * host's clone, and the warning says so.
 */
async function readAt(worktreeCwd: string, cloneCwd: string, chant: string | undefined): Promise<{ read: ReleaseWorkflowRead; warning?: string }> {
  const o = chant ? { chant } : {};
  try {
    return { read: await releaseWorkflowInputAt(worktreeCwd, o) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      return { read: await releaseWorkflowInputAt(cloneCwd, o), warning: `the release config at the tag could not be read (${why}), so the steps come from the config in this clone` };
    } catch {
      throw err instanceof ReleaseWorkflowInputError ? new HostReleaseError(err.message, err.hint) : err;
    }
  }
}

/** What a job of a served release runs with, past what the request gives: the worktree, the temp directory and the tools. */
interface ServedRelease {
  read: ReleaseWorkflowRead;
  tools: Record<string, string>;
  context: (job: Pick<HostJobContext, "tag">) => HostJobContext;
}

/**
 * A fresh detached worktree of the request's commit and a temp directory,
 * the release input read at the commit, the signing checked and the tools
 * installed; then `fn`, and both directories removed after.
 */
async function withServedRelease<T>(req: HostReleaseRequest, fn: (s: ServedRelease) => Promise<T>): Promise<T & { warning?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "chant-ci-release-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "chant-ci-release-temp-"));
  try {
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", dir, req.commit], { cwd: req.top, stdio: ["ignore", "pipe", "pipe"] });
    const { read, warning } = await readAt(join(dir, relative(req.top, req.cwd)), req.cwd, req.chant);
    const refused = hostSigningRefusal(read);
    if (refused) throw refused;
    const tools = await hostReleaseTools({ signing: read.signs, scan: read.scans, cacheDir: req.toolCache, hostEnv: req.hostEnv, ...(req.platform ? { platform: req.platform } : {}), ...(req.download ? { download: req.download } : {}) });
    const context = (job: Pick<HostJobContext, "tag">): HostJobContext => ({
      top: dir,
      commit: req.commit,
      tag: job.tag,
      runId: req.runId,
      fingerprint: req.fingerprint,
      hostEnv: req.hostEnv,
      runnerTemp,
      ...(req.passEnv ? { passEnv: req.passEnv } : {}),
      ...(req.secrets ? { secrets: req.secrets } : {}),
      ...(req.output ? { output: req.output } : {}),
      ...(req.runStep ? { runStep: req.runStep } : {}),
    });
    const result = await fn({ read, tools, context });
    return { ...result, ...(warning ? { warning } : {}) };
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: req.top, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // A worktree that was never added leaves only the directory.
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

/**
 * Serve one release on this host (#5462): a fresh detached worktree of the
 * tag's commit, the release tools, and the rendered publish job run in it.
 * The worktree and the job's temp directory are removed after. Throws
 * {@link HostReleaseError} for a release this host can't serve.
 */
export async function runHostRelease(req: HostReleaseRequest): Promise<HostJobResult & { warning?: string }> {
  return withServedRelease(req, async ({ read, tools, context }) => runHostJob(hostReleaseJob(read, tools), context({ tag: req.tag })));
}

// ── Dispatch requests ────────────────────────────────────────────────────────

/** Where release requests live: `ci/release/<sha>`, beside `ci/build/<sha>`. */
export const CI_RELEASE_TAG_PREFIX = "ci/release/";

/** A `ci/release/<sha>` tag's record: the commit to release, with what the release workflow's dispatch takes. */
export interface ReleaseRequest {
  schema: 1;
  tag: string;
  commit: string;
  /** The release's label, or `auto` for the one `chant release next` computes. */
  label: string;
  /** A train's levels, `auto` by default. */
  levels: string;
  /** When it was asked for, ISO 8601. */
  at: string;
}

/** The annotation of a request tag: a subject line, then the record. */
export function releaseRequestAnnotation(r: ReleaseRequest): string {
  return `ci: release this commit (label ${r.label}, levels ${r.levels})\n\n${JSON.stringify(r, null, 2)}\n`;
}

/** The release requests among the repository's tags, by commit. A tag whose record does not parse asks for nothing. */
export function readReleaseRequests(top: string): Map<string, ReleaseRequest> {
  const out = new Map<string, ReleaseRequest>();
  let raw = "";
  try {
    raw = execFileSync("git", ["for-each-ref", "--sort=creatordate", "--format=%(refname:lstrip=2)%00%(objecttype)%00%(contents)%01", `refs/tags/${CI_RELEASE_TAG_PREFIX}`], { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return out;
  }
  for (const entry of raw.split("\u0001")) {
    const [tag, type, contents] = entry.replace(/^\n/, "").split("\u0000");
    if (!tag || type !== "tag" || !contents?.includes("{")) continue;
    try {
      const r = JSON.parse(contents.slice(contents.indexOf("{"))) as ReleaseRequest;
      const sha = tag.slice(CI_RELEASE_TAG_PREFIX.length);
      if (r.schema === 1 && r.commit === sha && typeof r.label === "string" && typeof r.at === "string") out.set(sha, { ...r, levels: typeof r.levels === "string" ? r.levels : "auto", tag });
    } catch {
      // Not a record.
    }
  }
  return out;
}

const LABEL_OR_AUTO = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Ask a `ci serve --release` host to release `at` (#5462): an annotated
 * `ci/release/<sha>` tag holding the label and levels, pushed to `remote`.
 * A commit that already has a request keeps it. Throws for a revision this
 * repository does not have, or a label that is not one.
 */
export function requestRelease(req: { cwd: string; at: string; label?: string; levels?: string; remote?: string; now?: Date }): { request: ReleaseRequest; existed: boolean } {
  const remote = req.remote ?? "origin";
  const git = (args: string[]): string => execFileSync("git", args, { cwd: req.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const label = req.label ?? "auto";
  if (!LABEL_OR_AUTO.test(label)) throw new HostReleaseError(`--label ${JSON.stringify(label)} is not a release label of letters, digits and . _ + -`);
  try {
    git(["fetch", "--quiet", remote, `+refs/tags/${CI_RELEASE_TAG_PREFIX}*:refs/tags/${CI_RELEASE_TAG_PREFIX}*`]);
  } catch {
    // A remote with no requests, or none reachable: the push below says which.
  }
  let sha: string;
  try {
    if (req.at.startsWith("-")) throw new Error("not a revision");
    sha = git(["rev-parse", "--verify", "--quiet", `${req.at}^{commit}`]);
  } catch {
    throw new HostReleaseError(`--at ${req.at} names no commit in this repository`);
  }
  const existing = readReleaseRequests(req.cwd).get(sha);
  if (existing) return { request: existing, existed: true };
  const request: ReleaseRequest = { schema: 1, tag: `${CI_RELEASE_TAG_PREFIX}${sha}`, commit: sha, label, levels: req.levels ?? "auto", at: (req.now ?? new Date()).toISOString() };
  const ident = [...(tryConfig(req.cwd, "user.name") ? [] : ["-c", "user.name=chant"]), ...(tryConfig(req.cwd, "user.email") ? [] : ["-c", "user.email=chant@localhost"])];
  git([...ident, "tag", "-a", "-m", releaseRequestAnnotation(request), request.tag, sha]);
  try {
    git(["push", "--quiet", remote, `refs/tags/${request.tag}`]);
  } catch (err) {
    try {
      git(["tag", "-d", request.tag]);
    } catch {
      // Left for the next request to find.
    }
    throw new HostReleaseError(`could not push ${request.tag} to ${remote}: ${(err as { stderr?: string }).stderr?.toString().trim() || String(err)}`);
  }
  return { request, existed: false };
}

function tryConfig(cwd: string, key: string): boolean {
  try {
    return execFileSync("git", ["config", key], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * The jobs a host runs for a release request: the `gate` and `cut` jobs of
 * the release workflow's dispatch shape, rendered for
 * {@link HOST_RELEASE_RENDER_FORGE} with `gate: "head"`, so the requested
 * commit is the one cut and must itself be green, and with the release
 * tools in their env. The cut pushes the release's tag, and the host
 * publishes it as any tag, with {@link hostReleaseJob}.
 */
export function hostDispatchJobs(read: Pick<ReleaseWorkflowRead, "input">, tools: Record<string, string> = {}): { gate: HostJob; cut: HostJob } {
  const p = read.input.pipeline ?? {};
  if ((p.builds?.length ?? 0) > 0 || (read.input.train?.builds?.length ?? 0) > 0) {
    throw new HostReleaseError("release.workflow.builds runs each build on a runner of its own, and a ci serve host is one runner", "Release from the forge's release workflow, or build the files in the cut.");
  }
  const pipeline = { ...p, trigger: "dispatch" as const, gate: "head" as const, ...(Object.keys(tools).length > 0 ? { env: { ...p.env, ...tools } } : {}) };
  let text: string;
  try {
    text = renderReleaseWorkflow({ ...read.input, forge: HOST_RELEASE_RENDER_FORGE, pipeline });
  } catch (err) {
    throw new HostReleaseError(`the release workflow could not be rendered: ${err instanceof Error ? err.message : String(err)}`, "Fix release.workflow in chant.config.ts.");
  }
  return { gate: workflowJob(text, "gate"), cut: workflowJob(text, "cut") };
}

/** How a request ended: cut (its tag pushed), refused by the gate with why, or failed. */
export interface HostDispatchResult {
  status: "ok" | "refused" | "fail";
  /** Why the gate refused it, or why the cut failed, in a line. */
  reason?: string;
  failure?: string;
  warning?: string;
}

/**
 * Serve one release request on this host (#5462): in a fresh worktree of
 * its commit, the dispatch shape's gate job, then its cut job with the
 * gate's outputs. A gate that fails refuses the request with the line it
 * printed, such as the commit not being green. Throws
 * {@link HostReleaseError} for a release this host can't serve.
 */
export async function runHostDispatch(req: HostReleaseRequest & { request: ReleaseRequest }): Promise<HostDispatchResult> {
  return withServedRelease(req, async ({ read, tools, context }) => {
    const { gate, cut } = hostDispatchJobs(read, tools);
    const inputs = { label: req.request.label, levels: req.request.levels, train: "" };
    const gated = await runHostJob(gate, { ...context({ tag: req.request.tag }), inputs });
    if (gated.status !== "ok") return { status: "refused" as const, reason: gated.reason ?? gated.failure ?? "the gate failed" };
    const cutRun = await runHostJob(cut, { ...context({ tag: req.request.tag }), inputs, needs: { gate: gated.outputs ?? {} } });
    if (cutRun.status !== "ok") return { status: "fail" as const, failure: cutRun.failure ?? "the cut failed", ...(cutRun.reason ? { reason: cutRun.reason } : {}) };
    return { status: "ok" as const };
  });
}

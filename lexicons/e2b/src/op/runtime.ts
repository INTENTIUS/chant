/**
 * The e2b `opRuntime` provider: `chant run <op> --on e2b`.
 *
 * A steward is one sandbox that outlives every run: it keeps a clone of the
 * project and its installed tools on its disk, runs one op at a time, and
 * sleeps paused between runs, which costs nothing and survives anything that
 * doesn't delete it. Any API that speaks E2B's hosts one: hosted E2B, or a
 * platform of your own that serves the same API (loam does).
 *
 * A run here is the run a person would have typed in that clone:
 *
 * 1. Find the steward's sandbox by its `chant/steward` metadata, or make it.
 *    A sandbox already running an op is busy, and the run is refused rather
 *    than queued, as fountain refuses a busy steward conversation.
 * 2. Bring the clone to the commit this checkout is at (fetched from the
 *    repository, so the commit must be pushed) and install the project's
 *    dependencies when its lockfile changed.
 * 3. Run `chant run <op> --on local --json --progress-json` there, streaming
 *    each settled step back through `progress` and its stderr to ours. Gates,
 *    leases and the run ledger are the local runtime's, unchanged: they live on
 *    the repository's `chant/lifecycle` branch, which chant in the sandbox
 *    fetches and pushes with the git token the profile names, so `chant
 *    approve` on any checkout answers a gate a steward reached.
 * 4. Pause the sandbox.
 *
 * `status`, `log` and `list` read the run ledger in the steward's clone, and
 * report a run still in progress from the sandbox's process list. They wake
 * the sandbox to do it and leave it to pause itself a few minutes later.
 *
 * Nothing here remembers anything between processes: the sandbox's metadata
 * finds it, the ledger is the history, and the process list is what is running.
 */

import { loadChantConfig, type ChantConfig } from "@intentius/chant/config";
import type { OpConfig, OpRunHandle, OpRunRecord, OpRunStartOptions, OpRunStatus, OpRuntimeProvider, StepRecord } from "@intentius/chant/op";
import { runStateOf } from "@intentius/chant/op";
import { resolveProfile, type E2bProfile } from "../config";
import {
  e2bSandboxes,
  RUN_ID_ENV,
  RUN_OP_ENV,
  RUN_STARTED_ENV,
  type CommandResult,
  type StewardSandbox,
  type StewardSandboxes,
} from "./sandbox";

/** How long a sandbox is held awake at a time while a run is going. Renewed at a third of it. */
export const RUN_AWAKE_MS = 30 * 60_000;

/** How long a read (`status`, `log`, `list`) leaves a woken sandbox awake before it pauses itself. */
export const READ_AWAKE_MS = 5 * 60_000;

/** The template a steward is made from when the profile names none. */
export const DEFAULT_TEMPLATE = "base";

/** Where the steward keeps its clone, under the sandbox user's home. */
export const CLONE_DIR = "chant-steward";

export interface E2bOpRuntimeOptions {
  /** The project directory. Default `process.cwd()`. */
  cwd?: string;
  /** The project's chant config, when the caller already has it. */
  config?: ChantConfig;
  /** The sandbox provider. Default: the `e2b` SDK, connected per the profile. */
  sandboxes?: StewardSandboxes;
  /** Read the local checkout. Injectable so a test needs no repository. */
  git?: (args: string[]) => Promise<string>;
  /** Where the sandbox's stderr goes. Default `process.stderr`. */
  stderr?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** What a run needs to know about the profile, resolved once per process. */
interface Resolved {
  sandboxes: StewardSandboxes;
  steward: string;
  template: string;
  repo: string;
  gitToken?: string;
}

/** An ssh remote as the https URL a sandbox can fetch with a token. Anything else is returned as it is. */
export function httpsRemote(url: string): string {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url;
}

/** The repository's name, from its URL: the steward's default name. */
export function repoName(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "") || "steward";
}

/** A word as one shell argument. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9._:@+=/,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A bash function, `ledger_sync`, that leaves the clone's `chant/lifecycle`
 * branch and the repository's the same, run in the clone after a fetch.
 *
 * chant pushes the facts other checkouts have to see (a gate's pending fact,
 * an approval, a lease) as it writes them, but keeps each run record on the
 * local branch only. A checkout that lives on, as a steward's does, therefore
 * holds commits the repository lacks, and the first approval pushed from
 * anywhere else leaves the two branches diverged; chant then refuses to read
 * the ledger at all. So the steward reconciles before and after every run:
 *
 * - behind, or the same: nothing to do (chant fetches it itself);
 * - ahead: push;
 * - diverged: merge, then push. Every ledger file is append-only, so the
 *   merge keeps the repository's tree and adds, for each `.jsonl` file, the
 *   local lines it lacks after its own, and any file only the clone has. The
 *   merge commit has both tips as parents, so neither side loses a commit.
 *
 * A push that fails (the repository moved again in between, or there is no
 * token) is reported and left for the next run.
 */
export const LEDGER_SYNC_FN = [
  "ledger_sync() {",
  "  local L=refs/heads/chant/lifecycle R=refs/remotes/origin/chant/lifecycle",
  "  git rev-parse -q --verify \"$L\" >/dev/null || return 0",
  "  if git rev-parse -q --verify \"$R\" >/dev/null; then",
  "    git merge-base --is-ancestor \"$L\" \"$R\" && return 0",
  "    if ! git merge-base --is-ancestor \"$R\" \"$L\"; then",
  "      local idx; idx=\"$(git rev-parse --git-dir)/chant-e2b-merge-index\"",
  "      GIT_INDEX_FILE=\"$idx\" git read-tree \"$R\"",
  "      local p lb rb blob",
  "      while IFS= read -r p; do",
  "        lb=$(git rev-parse -q --verify \"$L:$p\") || continue",
  "        rb=$(git rev-parse -q --verify \"$R:$p\") || rb=",
  "        if [ -z \"$rb\" ]; then blob=$lb",
  "        elif [[ \"$p\" == *.jsonl ]]; then",
  "          blob=$( { git cat-file blob \"$rb\"; git cat-file blob \"$lb\" | grep -vxF -f <(git cat-file blob \"$rb\") || true; } | git hash-object -w --stdin )",
  "        else continue; fi",
  "        GIT_INDEX_FILE=\"$idx\" git update-index --add --cacheinfo \"100644,$blob,$p\"",
  "      done < <(git diff --name-only \"$R\" \"$L\")",
  "      local tree merged",
  "      tree=$(GIT_INDEX_FILE=\"$idx\" git write-tree); rm -f \"$idx\"",
  "      merged=$(git -c user.name=chant -c user.email=chant@localhost commit-tree \"$tree\" -p \"$R\" -p \"$L\" -m 'e2b steward: merge local run records with the repository ledger')",
  "      git update-ref \"$L\" \"$merged\"",
  "      echo 'e2b: merged the steward ledger with the repository one' >&2",
  "    fi",
  "  fi",
  "  local out; out=$(git push --quiet origin \"$L:$L\" 2>&1) || printf '%s\\ne2b: pushing the steward ledger failed; the next run tries again\\n' \"$out\" >&2",
  "}",
].join("\n");

/**
 * The script that brings the steward's clone to `commit`: clone it the first
 * time, fetch every branch after that, reconcile the ledger branch
 * ({@link LEDGER_SYNC_FN}), check the commit out over whatever is there, and
 * install dependencies when the lockfile changed. Ignored files
 * (`node_modules`, tool caches) are kept, which is the point of a steward.
 * The token, when there is one, reaches git through a credential helper that
 * reads it from the environment, so it is never written to the sandbox's disk.
 */
export function prepareScript(repo: string, commit: string): string {
  const dir = `"$HOME/${CLONE_DIR}"`;
  return [
    "set -euo pipefail",
    LEDGER_SYNC_FN,
    "command -v git >/dev/null || { echo 'e2b runtime: the sandbox has no git; use a template that has git and Node' >&2; exit 2; }",
    "command -v node >/dev/null || { echo 'e2b runtime: the sandbox has no Node; use a template that has git and Node' >&2; exit 2; }",
    `git config --global credential.helper '!f() { test "$1" = get && test -n "\${CHANT_GIT_TOKEN:-}" && echo username=x-access-token && echo "password=$CHANT_GIT_TOKEN"; }; f'`,
    `if [ ! -d ${dir}/.git ]; then git clone --quiet --no-checkout ${shellQuote(repo)} ${dir}; fi`,
    `cd ${dir}`,
    `git remote set-url origin ${shellQuote(repo)}`,
    "git fetch --quiet --prune origin '+refs/heads/*:refs/remotes/origin/*'",
    "ledger_sync",
    `git cat-file -e ${commit}^{commit} 2>/dev/null || { echo "e2b runtime: commit ${commit} is not on ${repo}; push it first" >&2; exit 2; }`,
    `git checkout --quiet --force --detach ${commit}`,
    "git clean -fdq",
    "if [ -f package-lock.json ]; then",
    "  sum=$(sha256sum package-lock.json | cut -d' ' -f1)",
    "  if [ \"$(cat .git/chant-e2b-lock 2>/dev/null)\" != \"$sum\" ] || [ ! -d node_modules ]; then",
    "    npm ci --no-audit --no-fund --loglevel=error >&2 && echo \"$sum\" > .git/chant-e2b-lock",
    "  fi",
    "elif [ -f package.json ] && [ ! -d node_modules ]; then",
    "  npm install --no-audit --no-fund --loglevel=error >&2",
    "fi",
    "test -x node_modules/.bin/chant || { echo 'e2b runtime: the project does not install chant (add @intentius/chant to its dependencies)' >&2; exit 2; }",
  ].join("\n");
}

/** Seconds a stopped run is given to end on SIGTERM before it is killed. */
export const STOP_GRACE_S = 10;

/** SIGTERM `pid`, wait for it to go, and exit non-zero if it is still there after the grace period. */
export function stopScript(pid: number): string {
  const p = Math.trunc(pid);
  return `kill -TERM ${p} 2>/dev/null || exit 0; for i in $(seq 1 ${STOP_GRACE_S * 2}); do kill -0 ${p} 2>/dev/null || exit 0; sleep 0.5; done; exit 1`;
}

/** After a run: fetch and reconcile the ledger branch, so the run's record reaches the repository. */
export function finishScript(): string {
  return [
    "set -uo pipefail",
    LEDGER_SYNC_FN,
    `cd "$HOME/${CLONE_DIR}" || exit 0`,
    "git fetch --quiet origin '+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle' 2>/dev/null || true",
    "ledger_sync",
  ].join("\n");
}

/** The command line one run is, in the clone. `exec` so the process the sandbox lists is chant itself. */
export function runScript(op: string, opts: Pick<OpRunStartOptions, "env" | "params" | "work">): string {
  const words = ["chant", "run", op];
  if (opts.env) words.push("--env", opts.env);
  for (const [name, value] of Object.entries(opts.params ?? {})) {
    words.push("--param", `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  if (opts.work?.item) words.push("--work", opts.work.item);
  if (opts.work?.holder) words.push("--holder", opts.work.holder);
  words.push("--on", "local", "--json", "--progress-json");
  return `cd "$HOME/${CLONE_DIR}" && exec node_modules/.bin/${words.map(shellQuote).join(" ")}`;
}

/**
 * The script that prints every run record the clone's ledger holds for `ops`
 * (all of them when empty), one JSON line each, from every environment
 * directory on `chant/lifecycle`. Root-level ledgers only: a workspace
 * member's runs (`_members/<m>/...`) are not read.
 */
export function ledgerScript(ops: string[]): string {
  const pattern = ops.length === 0 ? "runs__*.jsonl" : ops.map((op) => `runs__${op}.jsonl`).join(" ");
  return [
    `cd "$HOME/${CLONE_DIR}" 2>/dev/null || exit 0`,
    "git rev-parse --verify --quiet chant/lifecycle >/dev/null || exit 0",
    "git ls-tree -r --name-only chant/lifecycle | while read -r path; do",
    "  case \"$path\" in _*) continue;; */*/*) continue;; esac",
    "  base=${path##*/}",
    `  for p in ${pattern}; do case "$base" in $p) git show "chant/lifecycle:$path"; echo;; esac; done`,
    "done",
  ].join("\n");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A ledger line, or a run's final `--json` line, as an {@link OpRunRecord}; anything else `undefined`. */
export function asRunRecord(v: unknown): OpRunRecord | undefined {
  if (!isRecord(v)) return undefined;
  if (v.version !== 1 || typeof v.id !== "string" || typeof v.op !== "string" || typeof v.status !== "string") return undefined;
  return v as unknown as OpRunRecord;
}

/** A `--progress-json` line as a {@link StepRecord}; anything else `undefined`. */
export function asStepRecord(v: unknown): StepRecord | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.phase !== "string" || typeof v.fn !== "string" || typeof v.status !== "string") return undefined;
  return v as unknown as StepRecord;
}

/** Every record in `text`, one JSON object per line, newest first. */
export function parseLedger(text: string): OpRunRecord[] {
  const records: OpRunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = asRunRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // A malformed line is skipped, as the local ledger reader skips it.
    }
  }
  return records.sort((a, b) => b.started.localeCompare(a.started));
}

/**
 * Splits a byte stream into lines, handing each whole line to `line`. `flush`
 * hands over what is left.
 */
function lineSplitter(line: (text: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    },
    flush() {
      if (buffer) line(buffer);
      buffer = "";
    },
  };
}

export function statusFromRecord(record: OpRunRecord): OpRunStatus {
  return {
    op: record.op,
    runId: record.id,
    state: runStateOf(record.status),
    startedAt: record.started,
    endedAt: record.ended,
    ...(record.gate ? { gate: record.gate } : {}),
    ...(record.point ? { point: record.point } : {}),
    ...(record.status === "fail" ? { error: failureOf(record) } : {}),
  };
}

function failureOf(record: OpRunRecord): string | undefined {
  for (const phase of record.phases) {
    for (const step of phase.steps) if (step.status === "fail" && step.error) return `${phase.name}: ${step.error}`;
  }
  return undefined;
}

/** The last few lines of a failed command's output, for an error message. */
function tail(result: CommandResult, lines = 15): string {
  const text = `${result.stderr}\n${result.stdout}`.trim().split("\n");
  return text.slice(-lines).join("\n");
}

export function createE2bOpRuntime(opts: E2bOpRuntimeOptions = {}): OpRuntimeProvider {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const writeStderr = opts.stderr ?? ((chunk: string) => void process.stderr.write(chunk));

  const git = opts.git ?? (async (args: string[]) => {
    const { execFile } = await import("node:child_process");
    return new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || err.message}`));
        else resolve(stdout.trim());
      });
    });
  });

  let activeProfile: string | undefined;
  let resolved: Promise<Resolved> | undefined;

  const resolve = (): Promise<Resolved> => {
    resolved ??= (async () => {
      let config = opts.config;
      if (!config) {
        try {
          config = (await loadChantConfig(cwd)).config;
        } catch {
          config = {} as ChantConfig;
        }
      }
      const profile: E2bProfile = resolveProfile(config, activeProfile) ?? {};

      let sandboxes = opts.sandboxes;
      if (!sandboxes) {
        const keyVar = profile.apiKey?.env ?? "E2B_API_KEY";
        const apiKey = env[keyVar];
        if (!apiKey) {
          throw new Error(`e2b runtime: ${keyVar} is not set. Set it, or name another variable in e2b.profiles.<name>.apiKey.`);
        }
        const domain = profile.domain ?? env.E2B_DOMAIN;
        sandboxes = e2bSandboxes({ apiKey, ...(domain ? { domain } : {}) });
      }

      const repo = profile.repo ?? httpsRemote(await git(["remote", "get-url", "origin"]).catch(() => {
        throw new Error("e2b runtime: this checkout has no `origin` remote for the sandbox to clone. Add one, or set e2b.profiles.<name>.repo.");
      }));
      const tokenVar = profile.gitToken?.env ?? "CHANT_GIT_TOKEN";
      const gitToken = env[tokenVar];
      if (profile.gitToken && !gitToken) {
        throw new Error(`e2b runtime: the profile's git token variable ${tokenVar} is not set.`);
      }
      return {
        sandboxes,
        steward: profile.steward ?? repoName(repo),
        template: profile.template ?? DEFAULT_TEMPLATE,
        repo,
        ...(gitToken ? { gitToken } : {}),
      };
    })();
    return resolved;
  };

  const selectProfile = (name: string | undefined): void => {
    if (name === undefined || name === activeProfile) return;
    activeProfile = name;
    resolved = undefined;
  };

  /** The steward's sandbox, awake, or `undefined` when it has none and `create` is false. */
  const reach = async (r: Resolved, awakeMs: number, create: boolean): Promise<StewardSandbox | undefined> => {
    const found = await r.sandboxes.find(r.steward);
    if (found) return r.sandboxes.connect(found.id, { awakeMs });
    if (!create) return undefined;
    writeStderr(`e2b: making steward "${r.steward}" from template "${r.template}"\n`);
    return r.sandboxes.create(r.steward, { template: r.template, awakeMs });
  };

  /** The chant run in progress in the sandbox, if any. */
  const liveRun = async (sb: StewardSandbox) => (await sb.processes()).find((p) => p.envs[RUN_OP_ENV] !== undefined);

  /**
   * Stop a run the way Ctrl-C stops a local one: SIGTERM, which chant turns
   * into an abort that kills the op's children and records the run, then
   * SIGKILL if it is still there after {@link STOP_GRACE_S} seconds.
   */
  const stop = async (sb: StewardSandbox, pid: number): Promise<void> => {
    const result = await sb.run(stopScript(pid)).catch(() => undefined);
    if (!result || result.exitCode !== 0) await sb.kill(pid).catch(() => {});
  };

  const readLedger = async (sb: StewardSandbox, ops: string[]): Promise<OpRunRecord[]> => {
    const result = await sb.run(ledgerScript(ops));
    if (result.exitCode !== 0) throw new Error(`e2b runtime: reading the steward's run ledger failed:\n${tail(result)}`);
    return parseLedger(result.stdout);
  };

  return {
    name: "e2b",
    carriesWork: true,

    async start(op: OpConfig, startOpts: OpRunStartOptions): Promise<OpRunHandle> {
      selectProfile(startOpts.profile);
      const r = await resolve();

      const commit = await git(["rev-parse", "HEAD"]);
      if ((await git(["status", "--porcelain", "--untracked-files=no"]).catch(() => "")) !== "") {
        writeStderr(`e2b: this checkout has uncommitted changes; the steward runs commit ${commit.slice(0, 12)} without them\n`);
      }

      const sb = (await reach(r, RUN_AWAKE_MS, true))!;
      const busy = await liveRun(sb);
      if (busy) {
        throw new Error(
          `e2b runtime: steward "${r.steward}" (${sb.id}) is running op "${busy.envs[RUN_OP_ENV]}" (run ${busy.envs[RUN_ID_ENV] ?? "?"}). ` +
            `One run at a time: wait for it, or \`chant run cancel ${busy.envs[RUN_OP_ENV]} --on e2b\`.`,
        );
      }

      const runId = startOpts.runId ?? crypto.randomUUID();
      const startedAt = now().toISOString();
      const secretEnv: Record<string, string> = r.gitToken ? { CHANT_GIT_TOKEN: r.gitToken } : {};

      // Renew the awake window while the run goes; a client that dies leaves
      // the sandbox to finish and then pause itself when the window runs out.
      const renew = setInterval(() => void sb.keepAwake(RUN_AWAKE_MS).catch(() => {}), RUN_AWAKE_MS / 3);
      renew.unref?.();

      let pid: number | undefined;
      const onAbort = () => {
        if (pid !== undefined) void stop(sb, pid);
      };
      startOpts.signal?.addEventListener("abort", onAbort, { once: true });

      const settle = async (): Promise<OpRunStatus> => {
        try {
          const prepared = await sb.run(prepareScript(r.repo, commit), {
            envs: secretEnv,
            onStderr: writeStderr,
          });
          if (prepared.exitCode !== 0) {
            return { op: op.name, runId, state: "failed", startedAt, endedAt: now().toISOString(), error: tail(prepared) };
          }
          if (startOpts.signal?.aborted) {
            return { op: op.name, runId, state: "cancelled", startedAt, endedAt: now().toISOString() };
          }

          let record: OpRunRecord | undefined;
          const lines = lineSplitter((text) => {
            if (!text.trim().startsWith("{")) return;
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            const step = asStepRecord(parsed);
            if (step) {
              startOpts.progress?.(step);
              return;
            }
            record = asRunRecord(parsed) ?? record;
          });
          const ran = await sb.run(runScript(op.name, startOpts), {
            envs: { ...secretEnv, [RUN_OP_ENV]: op.name, [RUN_ID_ENV]: runId, [RUN_STARTED_ENV]: startedAt },
            onStdout: (chunk) => lines.push(chunk),
            onStderr: writeStderr,
            onStart: (p) => {
              pid = p;
              if (startOpts.signal?.aborted) onAbort();
            },
          });
          lines.flush();
          await sb.run(finishScript(), { envs: secretEnv, onStderr: writeStderr }).catch((err) => {
            writeStderr(`e2b: syncing the steward ledger failed (${err instanceof Error ? err.message : String(err)}); the next run tries again\n`);
          });

          if (record) return statusFromRecord(record);
          // Killed with no record: Ctrl-C here, or `chant run cancel` from another checkout.
          if (startOpts.signal?.aborted || ran.exitCode < 0) {
            return { op: op.name, runId, state: "cancelled", startedAt, endedAt: now().toISOString() };
          }
          return {
            op: op.name,
            runId,
            state: "failed",
            startedAt,
            endedAt: now().toISOString(),
            error: `chant exited ${ran.exitCode} in steward "${r.steward}" without a run record:\n${tail(ran)}`,
          };
        } finally {
          clearInterval(renew);
          startOpts.signal?.removeEventListener("abort", onAbort);
          await sb.pause().catch((err) => {
            writeStderr(`e2b: pausing steward "${r.steward}" failed (${err instanceof Error ? err.message : String(err)}); it pauses itself when its awake window runs out\n`);
          });
        }
      };

      const result = settle();
      return { op: op.name, runId, result: () => result };
    },

    async status(op: string): Promise<OpRunStatus | undefined> {
      const r = await resolve();
      const sb = await reach(r, READ_AWAKE_MS, false);
      if (!sb) return undefined;
      const live = await liveRun(sb);
      if (live && live.envs[RUN_OP_ENV] === op) {
        return { op, runId: live.envs[RUN_ID_ENV] ?? "", state: "running", startedAt: live.envs[RUN_STARTED_ENV] ?? "" };
      }
      const [latest] = await readLedger(sb, [op]);
      return latest ? statusFromRecord(latest) : undefined;
    },

    async log(op: string, logOpts?: { limit?: number }): Promise<OpRunRecord[]> {
      const r = await resolve();
      const sb = await reach(r, READ_AWAKE_MS, false);
      if (!sb) return [];
      const records = await readLedger(sb, [op]);
      return logOpts?.limit !== undefined ? records.slice(0, logOpts.limit) : records;
    },

    async list(ops: OpConfig[]): Promise<Map<string, OpRunStatus | undefined>> {
      const states = new Map<string, OpRunStatus | undefined>(ops.map((o) => [o.name, undefined]));
      if (ops.length === 0) return states;
      const r = await resolve();
      const sb = await reach(r, READ_AWAKE_MS, false);
      if (!sb) return states;
      for (const record of (await readLedger(sb, ops.map((o) => o.name))).reverse()) {
        states.set(record.op, statusFromRecord(record));
      }
      const live = await liveRun(sb);
      const liveOp = live?.envs[RUN_OP_ENV];
      if (live && liveOp && states.has(liveOp)) {
        states.set(liveOp, { op: liveOp, runId: live.envs[RUN_ID_ENV] ?? "", state: "running", startedAt: live.envs[RUN_STARTED_ENV] ?? "" });
      }
      return states;
    },

    async cancel(op: string): Promise<void> {
      const r = await resolve();
      const sb = await reach(r, READ_AWAKE_MS, false);
      const live = sb ? await liveRun(sb) : undefined;
      if (!sb || !live || live.envs[RUN_OP_ENV] !== op) {
        throw new Error(`e2b runtime: steward "${r.steward}" is not running op "${op}".`);
      }
      await stop(sb, live.pid);
    },
  };
}

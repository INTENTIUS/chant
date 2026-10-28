/**
 * `chant agent prepare|run|land` (#4616): the three steps of the agent jobs
 * the Op generator writes for a scheduled Op spec's `agent`
 * (../../ci-agent.ts says what each does and which token each holds).
 *
 * ```
 * chant agent prepare --forge <kind> [--output <dir>]   the agent job, read token: decide
 * chant agent run     --forge <kind> [--output <dir>]   the agent job, the model's key and no forge token
 * chant agent land    --forge <kind> [--output <dir>]   the push job, write token: commit, push, pull request, record
 * ```
 *
 * The settings come from the job's `CHANT_AGENT_*` variables, which the
 * generator wrote into the workflow file of the base branch.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_DIR,
  AgentError,
  agentSettingsFromEnv,
  landAgentChange,
  prepareAgentRun,
  runAgent,
  runAgentCommand,
  type AgentGit,
} from "../../ci-agent";
import { activeProductWords } from "../../ci-product-words";
import { CHANT_EXIT } from "../../exit-codes";
import { appendRunRecord, readRunLedger } from "../../lifecycle/run-ledger";
import { pushLifecycle } from "../../lifecycle/git";
import { resolveCiRun } from "../../lifecycle/release-ledger";
import { FORGE_KINDS, forgeFromEnv, type ForgeKind, type PrForge } from "../../pr-forge";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant agent prepare|run|land --forge github|gitlab|forgejo [--output <dir>]";

function fail(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return CHANT_EXIT.failed;
}

/** git with hooks and fsmonitor off: nothing here runs code from the repository. */
const git: AgentGit = (args, opts = {}) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 << 20,
  });

function eventOf(): unknown {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function workDir(name: string): string {
  return join(process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir(), name);
}

export async function runAgentCommandLine(ctx: CommandContext): Promise<number> {
  const action = ctx.args.path;
  if (action !== "prepare" && action !== "run" && action !== "land") return fail(action ? `agent ${action} is not one of prepare, run or land` : "agent needs an action: prepare, run or land");
  const kind = ctx.args.forge;
  if (!kind || !(FORGE_KINDS as readonly string[]).includes(kind)) return fail(`--forge is one of ${FORGE_KINDS.join(", ")}`);
  const words = activeProductWords();
  const dir = resolve(ctx.args.output ?? AGENT_DIR);
  let settings;
  try {
    settings = agentSettingsFromEnv(process.env, words.product);
  } catch (e) {
    return fail((e as Error).message);
  }
  const readRuns = async () => (await readRunLedger(settings.env, settings.name)).records;
  const forge = (): PrForge => forgeFromEnv(kind as ForgeKind);

  try {
    if (action === "prepare") {
      const d = await prepareAgentRun({ settings, words, dir, env: process.env, event: eventOf(), forge: settings.on === "comment" && kind !== "gitlab" ? forge() : undefined, readRuns, git, now: new Date() });
      console.error(formatInfo(d.go ? `${words.product} agent: runs on ${d.sha?.slice(0, 12)}${d.pr ? ` for #${d.pr}` : ""}` : `${words.product} agent: does not run: ${d.reason}`));
      return CHANT_EXIT.done;
    }
    if (action === "run") {
      const r = await runAgent({ settings, dir, workDir: workDir("chant-agent-work"), env: process.env, git, runCommand: runAgentCommand });
      console.error(formatInfo(`${words.product} agent: exited ${r.rc}${r.changed ? ", with a change" : ", changing nothing"}`));
      // The push job says why on the pull request; this job stays green so it runs.
      return CHANT_EXIT.done;
    }
    const ci = resolveCiRun(process.env);
    const out = await landAgentChange({
      settings,
      words,
      dir,
      workDir: workDir("chant-agent-land"),
      env: process.env,
      event: eventOf(),
      forge: forge(),
      git,
      push: ({ cwd, ref, lease }) => {
        git(["push", "-q", ...(lease ? [`--force-with-lease=${lease}`] : []), "origin", `HEAD:${ref}`], { cwd });
      },
      readRuns,
      record: async (input) => {
        await appendRunRecord(input);
        await pushLifecycle();
      },
      now: () => new Date(),
      ...(ci ? { runOrigin: ci.runOrigin } : {}),
    });
    console.error(formatInfo(`${words.product} agent: ${out.result}: ${out.reason}`));
    return out.code;
  } catch (e) {
    if (e instanceof AgentError) return fail(e.message);
    return fail(`agent ${action}: ${(e as Error).message}`);
  }
}

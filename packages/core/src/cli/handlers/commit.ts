/**
 * `chant commit prepare|run|land` (#4722): the three steps of the commit jobs
 * the Op generator writes for a scheduled Op spec's `commit`
 * (../../ci-commit.ts says what each does and which token each holds).
 *
 * ```
 * chant commit prepare --forge <kind> [--output <dir>]   the commit job, read token: decide
 * chant commit run     --forge <kind> [--output <dir>]   the commit job, no forge token: run the command
 * chant commit land    --forge <kind> [--output <dir>]   the push job, push token: commit, push, reply, record
 * ```
 *
 * The settings come from the job's `CHANT_COMMIT_*` variables, which the
 * generator wrote into the workflow file of the base branch.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentError, type AgentGit } from "../../ci-agent";
import {
  COMMIT_DIR,
  commitSettingsFromEnv,
  landCommitChange,
  prepareCommitRun,
  runCommit,
  runCommitArgv,
  type HeadApproval,
  COMMIT_PUSHED_FILE,
} from "../../ci-commit";
import { activeProductWords, type CiProductWords } from "../../ci-product-words";
import { CHANT_EXIT } from "../../exit-codes";
import { appendRunRecord, readRunLedger } from "../../lifecycle/run-ledger";
import { listFilesInDir, pushLifecycleRebasing, readBlobFromPath, type LedgerLocation } from "../../lifecycle/git";
import { parseGateLedger } from "../../lifecycle/gate-ledger";
import { resolveCiRun } from "../../lifecycle/release-ledger";
import { FORGE_KINDS, forgeFromEnv, type ForgeKind, type PrForge } from "../../pr-forge";
import { pullRequestBaseFromEnv } from "../../pr-forge-base";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";

const USAGE = "chant commit prepare|run|land --forge github|gitlab|forgejo [--output <dir>]";

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

/**
 * Who approved the plan of pull request `pr` at `sha`, read from the gate
 * ledger: a resolution of the pull request's gates (`pr-<n>`, `pr-<n>-<member>`)
 * or the waves' op, made for that commit. Undefined when there is none.
 */
export function ledgerHeadApproval(words: CiProductWords, location?: LedgerLocation): HeadApproval {
  return async (pr, sha) => {
    const own = new RegExp(`^pr-${pr}(-[a-z0-9][a-z0-9-]*)?\\.jsonl$`);
    const files = (await listFilesInDir("_gates", location)).filter((f) => own.test(f) || (words.op !== undefined && f === `${words.op}.jsonl`));
    for (const f of files) {
      const text = await readBlobFromPath("_gates", f, location);
      if (!text) continue;
      const hit = parseGateLedger(text).resolutions.find((r) => r.gitSha === sha);
      if (hit) return hit.resolvedBy;
    }
    return undefined;
  };
}

export async function runCommitCommandLine(ctx: CommandContext): Promise<number> {
  const action = ctx.args.path;
  if (action !== "prepare" && action !== "run" && action !== "land") return fail(action ? `commit ${action} is not one of prepare, run or land` : "commit needs an action: prepare, run or land");
  const kind = ctx.args.forge;
  if (!kind || !(FORGE_KINDS as readonly string[]).includes(kind)) return fail(`--forge is one of ${FORGE_KINDS.join(", ")}`);
  const words = activeProductWords();
  const dir = resolve(ctx.args.output ?? COMMIT_DIR);
  let settings;
  try {
    settings = commitSettingsFromEnv(process.env, words.product);
  } catch (e) {
    return fail((e as Error).message);
  }
  const readRuns = async () => (await readRunLedger(settings.env, settings.name)).records;
  const forge = (): PrForge => forgeFromEnv(kind as ForgeKind);
  const approval = ledgerHeadApproval(words);

  try {
    if (action === "prepare") {
      const base = kind !== "gitlab" ? pullRequestBaseFromEnv(kind as ForgeKind) : undefined;
      const d = await prepareCommitRun({ settings, words, dir, env: process.env, event: eventOf(), ...(kind !== "gitlab" ? { forge: forge() } : {}), ...(base ? { pullRequestBase: base } : {}), readRuns, approval, git, now: new Date() });
      console.error(formatInfo(d.go ? `${settings.name}: runs on ${d.sha?.slice(0, 12)} for #${d.pr}` : `${settings.name}: does not run: ${d.reason}`));
      return CHANT_EXIT.done;
    }
    if (action === "run") {
      const r = await runCommit({ settings, dir, checkout: process.cwd(), workDir: workDir("chant-commit-work"), env: process.env, git, runCommand: runCommitArgv });
      console.error(formatInfo(`${settings.name}: exited ${r.rc}${r.changed ? ", with a change" : ", changing nothing"}`));
      // The push job says why on the pull request; this job stays green so it runs.
      return CHANT_EXIT.done;
    }
    const ci = resolveCiRun(process.env);
    const landBase = pullRequestBaseFromEnv(kind as ForgeKind);
    const out = await landCommitChange({
      ...(landBase ? { pullRequestBase: landBase } : {}),
      settings,
      words,
      dir,
      workDir: workDir("chant-commit-land"),
      env: process.env,
      event: eventOf(),
      forge: forge(),
      git,
      push: ({ cwd, ref }) => {
        git(["push", "-q", "origin", `HEAD:${ref}`], { cwd });
      },
      readRuns,
      approval,
      record: async (input) => {
        await appendRunRecord(input);
        await pushLifecycleRebasing();
      },
      now: () => new Date(),
      ...(ci ? { runOrigin: ci.runOrigin } : {}),
    });
    // #4749: what was pushed, for the push job's `after` lines.
    if (out.result === "pushed" && out.commit) writeFileSync(join(dir, COMMIT_PUSHED_FILE), `${out.commit}\n`);
    console.error(formatInfo(`${settings.name}: ${out.result}: ${out.reason}`));
    return out.code;
  } catch (e) {
    if (e instanceof AgentError) return fail(e.message);
    return fail(`commit ${action}: ${(e as Error).message}`);
  }
}

/**
 * `chant ci check --base <rev> [<target>...] [--output <dir>] [--json]`
 * (#4556): run the `ci.hooks.check` hooks the workspace declaration at
 * `--base` names, as a product's check job does. Each target is a root,
 * stack or component the change touches; a `perRun` hook runs once per
 * target. Then each lexicon the project lists runs its own check steps for
 * the members of its kinds (#4633, `LexiconPlugin.checkSteps`): the pulumi
 * lexicon's `pulumi install`, stack config check and `pulumi about`. Exits 0
 * when every hook and step passed or there were none, 1 (`failed`) when one
 * failed. See `../../components/check-hooks.ts` and
 * `../../components/check-steps.ts`.
 *
 * With a runner key in `CHANT_RUNNER_KEY` (#4870), or `CHANT_RUNNER_IDENTITY=oidc`
 * to sign keyless from the job's OIDC identity (#4869), each hook that passed is
 * signed as a named check over `HEAD` and attached under `refs/notes/chant/evidence`, which
 * is pushed unless `--no-push`; neither the key nor the token request reaches a hook.
 *
 * #4868: with a local key in `CHANT_LOCAL_EVIDENCE_KEY` (a developer's or an
 * agent session's, listed under `local.keys` at base) each hook that passed
 * is signed as local evidence instead, under `refs/notes/chant/local-evidence`.
 * Without one, a hook whose check `local.checks` at base names is skipped
 * when current local evidence for the tree stands in for it; the rest run.
 *
 * #4914: `--summary <file>` appends the report's markdown section
 * (`checkReportSummary`) to the file, as a product's check report keeps it,
 * and a job with `GITHUB_STEP_SUMMARY` set gets it in its summary too.
 *
 * #4966: `--base` defaults to the job's base (`ciBaseRef`,
 * `@intentius/chant/ci-base`), `--branch` naming the default branch on a
 * forge whose job does not carry it.
 */
import { resolve } from "node:path";
import { ciBaseRef } from "../../ci-base";
import type { CheckStageEvidence, CheckStepsAdapter } from "../../components/check-steps";
import { CHANT_EXIT } from "../../exit-codes";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

/**
 * The check steps of the lexicons the project at `cwd` lists, best effort:
 * a directory with no chant project, or a lexicon that does not load, gives
 * none, and the hooks still run.
 */
async function lexiconCheckSteps(ctx: CommandContext, cwd: string): Promise<CheckStepsAdapter[]> {
  let plugins = ctx.plugins ?? [];
  if (plugins.length === 0) {
    try {
      const { loadPlugins, resolveProjectLexicons } = await import("../plugins");
      plugins = await loadPlugins(await resolveProjectLexicons(resolve(cwd)));
    } catch {
      plugins = [];
    }
  }
  return plugins.map((p) => p.checkSteps?.()).filter((a): a is CheckStepsAdapter => a !== undefined);
}

const USAGE = "chant ci check [--base <rev>] [--branch <default branch>] [<target>...] [--output <dir>] [--summary <file>] [--no-push] [--json]";

/**
 * The check stage's signer (#4870), when the job has a runner identity: a
 * runner key in `CHANT_RUNNER_KEY`, or its OIDC identity with
 * `CHANT_RUNNER_IDENTITY=oidc` (#4869), as `.chant/trust.json` at `base`
 * lists it. Throws when the job has one and the policy at base does not
 * list it, so a job asked to sign never passes while signing nothing.
 */
async function checkEvidenceSigner(base: string, noPush: boolean): Promise<CheckStageEvidence | undefined> {
  const { CHECK_EVIDENCE_KEY_ENV, LOCAL_EVIDENCE_KEY_ENV, RUNNER_IDENTITY_ENV } = await import("../../workspace/trust/check-evidence-report");
  const runner = process.env[CHECK_EVIDENCE_KEY_ENV] || process.env[RUNNER_IDENTITY_ENV];
  const localPem = process.env[LOCAL_EVIDENCE_KEY_ENV];
  if (!runner && !localPem) return undefined;
  if (runner && localPem) throw new Error(`${process.env[CHECK_EVIDENCE_KEY_ENV] ? CHECK_EVIDENCE_KEY_ENV : RUNNER_IDENTITY_ENV} and ${LOCAL_EVIDENCE_KEY_ENV} are both set; a job signs as a runner or as a person or agent, never both`);
  const { top, commit } = await baseCommit(base);
  if (localPem) {
    const { localKeyEvidenceSigner } = await import("../../workspace/trust/local-evidence");
    return { signer: localKeyEvidenceSigner(top, commit, localPem), ...(noPush ? { push: false } : {}) };
  }
  // #4869: the runner key, or the job's OIDC identity, read in one place.
  const { runnerEvidenceSigner } = await import("../../workspace/trust/check-evidence");
  const signer = await runnerEvidenceSigner(top, commit);
  return signer ? { signer, ...(noPush ? { push: false } : {}) } : undefined;
}

async function baseCommit(base: string): Promise<{ top: string; commit: string }> {
  const { execFileSync } = await import("node:child_process");
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { top, commit };
}

/** Skipping on local evidence (#4868), judged by the policy at `base`; undefined outside a git repository. */
async function localEvidenceAt(base: string): Promise<{ base: string } | undefined> {
  try {
    return { base: (await baseCommit(base)).commit };
  } catch {
    return undefined;
  }
}

export async function runCiCheck(ctx: CommandContext, env: Record<string, string | undefined> = process.env): Promise<number> {
  const { args } = ctx;
  // #4966: with no --base, the job's own (`ciBaseRef`): a pull request's target branch, else the default branch (--branch) for a push to another branch.
  const base = args.base ?? ciBaseRef(env, args.branch ? { defaultBranch: args.branch } : {});
  if (!base) {
    console.error(
      formatError({
        message: "chant ci check needs --base <rev>, the commit the change is measured from, and the job names no pull request target or default branch to take it from",
        hint: `${USAGE}. The hooks are read at base, so a change cannot remove a required check.`,
      }),
    );
    return 1;
  }
  const targets = (args.positionals ?? []).slice(1);
  const { runCheckStage } = await import("../../components/check-steps");
  let report;
  try {
    const adapters = await lexiconCheckSteps(ctx, process.cwd());
    const evidence = await checkEvidenceSigner(base, args.noPush === true);
    // #4868: a job that signs local evidence runs every hook; any other may skip one on local evidence.
    const local = evidence && "class" in evidence.signer ? undefined : await localEvidenceAt(base);
    report = await runCheckStage({ base, targets, adapters, ...(args.output ? { dir: args.output } : {}), ...(evidence ? { evidence } : {}), ...(local ? { localEvidence: local } : {}) });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return CHANT_EXIT.failed;
  }
  // #4914: the report's markdown section, in the product's own report and the job summary of a forge that keeps one.
  for (const file of [...new Set([args.checkSummary, process.env.GITHUB_STEP_SUMMARY].filter((f): f is string => Boolean(f)))]) {
    const { checkReportSummary } = await import("../../components/check-hooks");
    const lines = checkReportSummary(report);
    if (lines.length === 0) continue;
    try {
      const { appendFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(resolve(file)), { recursive: true });
      appendFileSync(file, `${lines.join("\n")}\n`);
    } catch (err) {
      console.error(`ci check: could not write the summary to ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (report.status === "none") console.error("ci check: no ci.hooks.check at base and no lexicon check step, so nothing ran");
  else {
    const all = [...report.hooks, ...(report.steps ?? [])];
    console.error(`ci check: ${all.filter((h) => h.outcome === "passed").length} passed, ${all.filter((h) => h.outcome === "failed").length} failed, ${all.filter((h) => h.outcome === "skipped").length} skipped`);
    if (report.failed) console.error(`ci check: ${report.failed}`);
    if (report.evidence) console.error(`ci check: signed ${report.evidence.signed.join(", ")} as ${report.evidence.runner}`);
    const onLocal = report.hooks.filter((h) => h.localEvidence);
    if (onLocal.length > 0) console.error(`ci check: skipped on local evidence: ${onLocal.map((h) => `${h.name} (${h.localEvidence!.class} ${h.localEvidence!.signer})`).join(", ")}`);
  }
  return report.status === "failed" ? CHANT_EXIT.failed : CHANT_EXIT.done;
}

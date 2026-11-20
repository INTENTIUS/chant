/**
 * `chant components replan --env <env> --component <a,b>` (#5345): after
 * those components applied in `<env>`, compare their outputs with the ones
 * their last apply recorded, list the dependents that read a changed output,
 * and plan the dependents of the members `replanDependents` names. The plan
 * waits at `<gate>-replan` under `--op` (default `replan-<env>`); nothing
 * applies here. See ../../components/upstream-replan.ts.
 *
 * `replanDependents` is read from the pipeline (`.chant/pipeline.ts`) as it
 * stands on the default branch, the stage named `--env`, else the
 * pipeline's `defaults`. A wave job runs the same step in its own process
 * once a wave applied, with the op-waves spec's `replanDependents` at base
 * ({@link replanStep}, `../../op/op-waves-run.ts`). Absent, the dependents
 * are listed and nothing is planned.
 */

import { resolve } from "node:path";
import type { CommandContext } from "../registry";
import { formatError, formatWarning } from "../format";
import { ENV_VAR } from "../../env";
import { loadChantConfig, type ChantConfig } from "../../config";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import type { BuildParamProvenance } from "../../provenance";
import { resolveComponentTargets } from "../../components/cli-support";
import { fanOutRegistry } from "../../components/fan-out-support";
import { withDeclaredReads } from "../../components/declared-reads";
import { gitOutputRecordPort, readMarkedOutputs, replanAfterApply, replanNote, type ReplanResult } from "../../components/upstream-replan";
import { PR_APPLY_GATE } from "../../pr-loop";

const USAGE = "chant components replan --env <env> --component <name>[,<name>...] [--gate <gate>] [--op <op>] [--dry-run] [--json]";

/** The members `replanDependents` names for stage `env`, from the pipeline on the default branch. */
async function replanDependentsAt(cwd: string, env: string): Promise<string[]> {
  const { promoteBase, readPipelineAt } = await import("../../pipeline/read");
  const { stageReplanDependents } = await import("../../pipeline/spec");
  const base = promoteBase(cwd);
  if (!base) return [];
  const read = readPipelineAt(base, cwd);
  if (read.status === "refused") console.error(formatWarning({ message: `${read.line}; no dependents are planned` }));
  return read.status === "folded" ? stageReplanDependents(read.spec, env) : [];
}

/** What {@link runReplan} is asked. */
export interface ReplanRequest {
  cwd: string;
  env: string;
  /** The components that applied. */
  components: string[];
  /** The members whose dependents are planned. Default: the pipeline's, on the default branch. */
  replanDependents?: string[];
  gate?: string;
  op?: string;
  dryRun?: boolean;
  buildParams?: BuildParamProvenance[];
  sandbox?: boolean;
  /** A name that is no component: refuse (the command), or leave it out with a warning (a wave's runs). */
  unknown?: "refuse" | "skip";
}

/** Run the replan for `request`; a string is a refusal. */
export async function runReplan(request: ReplanRequest): Promise<{ result: ReplanResult; op: string } | string> {
  const { cwd, env } = request;
  const before = process.env[ENV_VAR];
  process.env[ENV_VAR] = env;
  try {
    const { config } = await loadChantConfig(cwd).catch(() => ({ config: {} as ChantConfig }));
    const targets = await resolveComponentTargets(cwd, "all", request.sandbox, request.buildParams);
    if (!targets.success) return targets.error ?? "Could not discover components";
    const registry = await fanOutRegistry(cwd, config);
    const components = await withDeclaredReads(targets.targets, registry, cwd);
    const byName = new Map(components.map((c) => [c.name, c]));
    const unknown = request.components.filter((n) => !byName.has(n));
    if (unknown.length > 0 && request.unknown !== "skip") return `no component named ${unknown.join(", ")}`;
    if (unknown.length > 0) console.error(formatWarning({ message: `${unknown.join(", ")}: no component of that name, so no outputs to compare` }));

    const { fetchLifecycle, getHeadCommit } = await import("../../lifecycle/git");
    await fetchLifecycle({ cwd }).catch(() => false);
    const applied: Record<string, Record<string, unknown>> = {};
    const sensitive: Record<string, string[]> = {};
    for (const name of request.components.filter((n) => byName.has(n))) {
      const found = await readMarkedOutputs(byName.get(name)!, registry, { env, component: name });
      if (!found) {
        console.error(formatWarning({ message: `${name}: its steps say no outputs, so there is nothing to compare` }));
        continue;
      }
      applied[name] = found.outputs;
      if (found.sensitive.length > 0) sensitive[name] = found.sensitive;
    }

    const gitSha = await getHeadCommit({ cwd }).catch(() => undefined);
    const op = request.op ?? `replan-${env}`;
    const { gitGateLedgerPort } = await import("../../op/gate");
    const { decidePrGate, approvalOf } = await import("../../components/pr-run");
    const result = await replanAfterApply({
      components,
      registry,
      root: cwd,
      env,
      applied,
      sensitive,
      replanDependents: request.replanDependents ?? (await replanDependentsAt(cwd, env)),
      records: gitOutputRecordPort({ cwd }),
      gate: request.gate ?? PR_APPLY_GATE,
      ...(gitSha ? { gitSha } : {}),
      ...(request.dryRun ? { dryRun: true } : {}),
      decide: async ({ gate, set, description }) => {
        const { storeGateChangeSet } = await import("../../lifecycle/gate-change-set");
        try {
          const stored = await storeGateChangeSet({ doc: set.doc, cwd, ...(gitSha ? { at: gitSha } : {}) });
          if (stored.warning) console.error(formatWarning({ message: stored.warning }));
        } catch (err) {
          console.error(formatWarning({ message: `could not store the change set ${set.doc.digest}: ${err instanceof Error ? err.message : String(err)}` }));
        }
        return approvalOf(await decidePrGate(gitGateLedgerPort({ cwd }), { op, gate, digest: set.doc.digest, description }));
      },
    });
    if (!request.dryRun) {
      const { pushLifecycleRebasing } = await import("../../lifecycle/git");
      const pushed = await pushLifecycleRebasing({ cwd }).catch((err: unknown) => ({ pushed: false, pushWarning: err instanceof Error ? err.message : String(err) }));
      if (!pushed.pushed && pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
    }
    return { result, op };
  } finally {
    if (before === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = before;
  }
}

/** The one line a run's outcome reads as in a wave job's log. */
export function replanLine(result: ReplanResult): string {
  const moved = result.changes.filter((c) => c.dependents.length > 0);
  if (moved.length === 0) return "replan: no applied member changed an output another member reads";
  const listed = moved.map((c) => `${c.member} (${c.changed.join(", ")}) read by ${c.dependents.map((d) => d.member).join(", ")}`).join("; ");
  const p = result.planned;
  return p ? `replan: ${listed}; plan ${p.digest} ${p.failed ? "failed to plan" : `waits at ${p.gate} (${p.approval.status})`}` : `replan: ${listed}; listed, none planned`;
}

/**
 * The replan step a wave job runs once a wave applied (#5345), in its own
 * process: the wave's spec read at base named the members, and `components`
 * are the runs it applied. Answers the log line. A run that names no
 * component is left out.
 */
export async function replanStep(input: { cwd: string; env: string; components: string[]; replanDependents?: string[] }): Promise<string> {
  const ran = await runReplan({ ...input, unknown: "skip" });
  if (typeof ran === "string") return `replan: ${ran}`;
  return replanLine(ran.result);
}

export async function runComponentsReplan(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.env;
  const named = (args.component ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!env || named.length === 0) {
    console.error(formatError({ message: "--env and --component are required", hint: USAGE }));
    return 1;
  }
  const root = resolve(".");
  const { config } = await loadChantConfig(root).catch(() => ({ config: {} as ChantConfig }));
  const params = resolveCliBuildParams(config.buildParams, { cli: parseParamFlags(args.param), paramsFile: args.paramsFile, verbose: args.verbose });
  if (!params.success) {
    for (const message of params.errors) console.error(message);
    return 1;
  }
  let ran: Awaited<ReturnType<typeof runReplan>>;
  try {
    ran = await runReplan({
      cwd: root,
      env,
      components: named,
      buildParams: params.provenance,
      ...(args.sandbox ? { sandbox: true } : {}),
      ...(args.gate ? { gate: args.gate } : {}),
      ...(args.op ? { op: args.op } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
    });
  } catch (err) {
    ran = err instanceof Error ? err.message : String(err);
  }
  if (typeof ran === "string") {
    console.error(formatError({ message: ran, hint: USAGE }));
    return 1;
  }
  if (args.json) console.log(JSON.stringify({ ...ran.result, op: ran.op }, null, 2));
  else process.stdout.write(replanNote(ran.result, ran.op));
  return ran.result.planned?.failed ? 1 : 0;
}

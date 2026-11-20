/**
 * `chant components replan --env <env> --component <a,b>` (#5345): after
 * those components applied in `<env>`, compare their outputs with the ones
 * their last apply recorded, list the dependents that read a changed output,
 * and plan the dependents of the members the stage's `replanDependents`
 * names. The plan waits at `<gate>-replan` under `--op` (default
 * `replan-<env>`); nothing applies here. See
 * ../../components/upstream-replan.ts.
 *
 * `replanDependents` is read from the pipeline (`.chant/pipeline.ts`) as it
 * stands on the default branch, the stage named `--env`, else the
 * pipeline's `defaults`. Absent, the dependents are listed and nothing is
 * planned.
 */

import { resolve } from "node:path";
import type { CommandContext } from "../registry";
import { formatError, formatWarning } from "../format";
import { ENV_VAR } from "../../env";
import { loadChantConfig, type ChantConfig } from "../../config";
import { resolveCliBuildParams, parseParamFlags } from "../build-params-cli";
import { resolveComponentTargets } from "../../components/cli-support";
import { fanOutRegistry } from "../../components/fan-out-support";
import { withDeclaredReads } from "../../components/declared-reads";
import { readComponentOutputs } from "../../components/wave-plan";
import { gitOutputRecordPort, replanAfterApply, replanNote, type ReplanResult } from "../../components/upstream-replan";
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

export async function runComponentsReplan(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const env = args.env;
  const named = (args.component ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!env || named.length === 0) {
    console.error(formatError({ message: "--env and --component are required", hint: USAGE }));
    return 1;
  }
  process.env[ENV_VAR] = env;
  const root = resolve(".");
  const { config } = await loadChantConfig(root).catch(() => ({ config: {} as ChantConfig }));
  const params = resolveCliBuildParams(config.buildParams, { cli: parseParamFlags(args.param), paramsFile: args.paramsFile, verbose: args.verbose });
  if (!params.success) {
    for (const message of params.errors) console.error(message);
    return 1;
  }
  const targets = await resolveComponentTargets(root, "all", args.sandbox, params.provenance);
  if (!targets.success) {
    console.error(formatError({ message: targets.error ?? "Could not discover components" }));
    return 1;
  }
  const registry = await fanOutRegistry(root, config);
  const components = await withDeclaredReads(targets.targets, registry, root);
  const byName = new Map(components.map((c) => [c.name, c]));
  const unknown = named.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    console.error(formatError({ message: `no component named ${unknown.join(", ")}`, hint: USAGE }));
    return 1;
  }

  const { fetchLifecycle, getHeadCommit, pushLifecycleRebasing } = await import("../../lifecycle/git");
  await fetchLifecycle().catch(() => false);
  const applied: Record<string, Record<string, unknown>> = {};
  for (const name of named) {
    const found = await readComponentOutputs(byName.get(name)!, registry, { env, component: name }, {});
    if (found) applied[name] = found;
    else console.error(formatWarning({ message: `${name}: its steps say no outputs, so there is nothing to compare` }));
  }

  const gitSha = await getHeadCommit().catch(() => undefined);
  const op = args.op ?? `replan-${env}`;
  const gate = args.gate ?? PR_APPLY_GATE;
  const { gitGateLedgerPort } = await import("../../op/gate");
  const { decidePrGate, approvalOf } = await import("../../components/pr-run");
  let result: ReplanResult;
  try {
    result = await replanAfterApply({
      components,
      registry,
      root,
      env,
      applied,
      replanDependents: await replanDependentsAt(root, env),
      records: gitOutputRecordPort(),
      gate,
      ...(gitSha ? { gitSha } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
      decide: async ({ gate: at, set, description }) => {
        const { storeGateChangeSet } = await import("../../lifecycle/gate-change-set");
        try {
          const stored = await storeGateChangeSet({ doc: set.doc, cwd: root, ...(gitSha ? { at: gitSha } : {}) });
          if (stored.warning) console.error(formatWarning({ message: stored.warning }));
        } catch (err) {
          console.error(formatWarning({ message: `could not store the change set ${set.doc.digest}: ${err instanceof Error ? err.message : String(err)}` }));
        }
        return approvalOf(await decidePrGate(gitGateLedgerPort(), { op, gate: at, digest: set.doc.digest, description }));
      },
    });
  } catch (err) {
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: USAGE }));
    return 1;
  }
  if (!args.dryRun) {
    const pushed = await pushLifecycleRebasing().catch((err: unknown) => ({ pushed: false, pushWarning: err instanceof Error ? err.message : String(err) }));
    if (!pushed.pushed && pushed.pushWarning) console.error(formatWarning({ message: pushed.pushWarning }));
  }
  if (args.json) console.log(JSON.stringify({ ...result, op }, null, 2));
  else process.stdout.write(replanNote(result, op));
  return result.planned?.failed ? 1 : 0;
}

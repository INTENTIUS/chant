import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ownershipKeys, OWNERSHIP_MANAGED_BY_VALUE } from "@intentius/chant/ownership";

const execAsync = promisify(exec);

/** The native apply mechanism for a target. */
export type ApplyTarget = "cloudformation" | "kubectl" | "arm";

/**
 * How apply treats resources no longer declared.
 * - `never` — additive only; never deletes.
 * - `owned-only` — deletes only chant-owned orphans, via the target's native
 *   prune/complete mechanism scoped to the ownership marker.
 * - `gated` — same delete scope as `owned-only`, but the workflow pauses for
 *   approval before the destructive apply (the gate lives in the composite).
 */
export type DeleteMode = "never" | "owned-only" | "gated";

export interface NativeApplyArgs {
  /** Native mechanism to delegate to. */
  target: ApplyTarget;
  /** Environment — CFN stack name / ARM resource group. */
  env: string;
  /** Built manifest/template path (or directory for kubectl). Default: dist. */
  output?: string;
  /** Delete handling. Default: never. */
  deleteMode?: DeleteMode;
}

/**
 * Build the native apply command. Pure — exported for testing.
 *
 * Authority stays with the platform: the CloudFormation stack, the Kubernetes
 * API server, the ARM resource group. chant hosts no state file. Owned-only
 * deletes ride the native delete path, scoped to the ownership marker so a
 * foreign resource is never touched:
 * - kubectl: `--prune --selector <managed-by>=chant` prunes only chant-owned
 *   objects absent from the apply set.
 * - CloudFormation: the stack is the boundary; `deploy` deletes resources
 *   removed from the template within it.
 * - ARM: `--mode Complete` removes resources not in the template from the RG.
 */
export function applyCommand(
  target: ApplyTarget,
  env: string,
  output: string,
  deleteMode: DeleteMode,
): string {
  const deletes = deleteMode !== "never";
  switch (target) {
    case "kubectl": {
      const prune = deletes
        ? ` --prune --selector ${ownershipKeys("label").managedBy}=${OWNERSHIP_MANAGED_BY_VALUE}`
        : "";
      return `kubectl apply -f ${output}${prune} --wait=true`;
    }
    case "cloudformation":
      // CFN deletes resources removed from the template within the stack itself.
      return `aws cloudformation deploy --template-file ${output} --stack-name ${env} --capabilities CAPABILITY_NAMED_IAM`;
    case "arm": {
      const mode = deletes ? " --mode Complete" : " --mode Incremental";
      return `az deployment group create --resource-group ${env} --template-file ${output}${mode}`;
    }
  }
}

/**
 * Apply declared source to the cloud via the target's native mechanism.
 * Deletes (when enabled) are limited to chant-owned orphans by construction —
 * the native prune/complete path is scoped to the ownership marker.
 */
export async function nativeApply(args: NativeApplyArgs, signal?: AbortSignal): Promise<{ command: string }> {
  const output = args.output ?? "dist";
  const deleteMode = args.deleteMode ?? "never";
  const command = applyCommand(args.target, args.env, output, deleteMode);
  const { stdout, stderr } = await execAsync(command, { signal });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  return { command };
}

/**
 * The native rollback command for a target, or undefined when the target has
 * no single-command rollback. Pure — exported for testing.
 *
 * Only CloudFormation has a native "return to last known good state" command.
 * For kubectl/ARM the caller must supply a rollback command; otherwise the
 * compensation degrades to a logged warning rather than silently doing nothing.
 */
export function rollbackCommand(target: ApplyTarget, env: string): string | undefined {
  switch (target) {
    case "cloudformation":
      return `aws cloudformation rollback-stack --stack-name ${env}`;
    case "kubectl":
    case "arm":
      return undefined;
  }
}

export interface CompensateApplyArgs {
  /** Native mechanism that was applied. */
  target: ApplyTarget;
  /** Environment — CFN stack name / ARM resource group. */
  env: string;
  /** Explicit rollback command, used in preference to the native default. */
  command?: string;
}

/**
 * Compensation step (saga rollback) for a partial apply failure. Runs the
 * explicit `command` if given, else the target's native rollback. Where no
 * automatic rollback exists, it warns rather than silently no-op'ing — partial
 * state should never look reverted when it isn't.
 */
export async function compensateApply(args: CompensateApplyArgs, signal?: AbortSignal): Promise<{ command?: string }> {
  const command = args.command ?? rollbackCommand(args.target, args.env);
  if (!command) {
    console.warn(
      `[apply] no automatic rollback for target "${args.target}" — partial apply to ${args.env} was NOT reverted; supply compensate.command to enable rollback`,
    );
    return {};
  }
  const { stdout, stderr } = await execAsync(command, { signal });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  return { command };
}

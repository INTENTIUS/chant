/**
 * `nativeApply` — push declared source to the cloud through the target's own
 * mechanism. Authority stays with the platform; chant hosts no state file.
 *
 * ## Where the Kubernetes half went (chant #1075)
 *
 * This used to build a shell command for all three targets, `kubectl apply -f`
 * among them. Two things were wrong with that. `kubectl apply` defaults to a
 * client-side three-way merge, which leaves field ownership implicit and gives
 * the diff engine nothing to key on — the defect chant #1075 exists to fix.
 * And the kubectl branch was Kubernetes product knowledge living in the
 * Temporal lexicon, against the one-lexicon-per-product rule that already
 * moved `kubectlApply`, `k3dUp`/`k3dDown` and `waitForArgoSync` out (chant
 * #809).
 *
 * So the kubectl branch moved to `@intentius/chant-lexicon-k8s`, where it is a
 * server-side apply over the typed client with chant's own field manager, and
 * the prune moved with it. **The dispatcher stayed here**, because "which
 * mechanism applies this target" is not any one product's knowledge — and
 * because the activity keeps its name, its arguments and its place in
 * `ApplyOp`, so no existing Op changes shape.
 *
 * The k8s lexicon is reached by dynamic import at call time, never by a static
 * one: this package must not depend on that one. A project applying a kubectl
 * target already lists `k8s` in its lexicons, so the module is there; when it
 * is not, the failure names the package to install.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** The native apply mechanism for a target. */
export type ApplyTarget = "cloudformation" | "kubectl" | "arm";

/**
 * The targets that are still a shell command. `kubectl` is not one of them
 * since chant #1075 — it goes through the k8s lexicon's typed client.
 */
export type ShellApplyTarget = "cloudformation" | "arm";

/**
 * How apply treats resources no longer declared.
 * - `never` — additive only; never deletes.
 * - `owned-only` — enables the target's own delete path. What that path is
 *   bounded by differs per target, and only two of the three are owned-only:
 *   `kubectl` sweeps by the ownership marker, `cloudformation` is bounded by
 *   the stack, and `arm` is `--mode Complete`, which is bounded by the resource
 *   group and deletes resources chant never applied (chant #1448).
 * - `gated` — same delete scope as `owned-only`, but the workflow pauses for
 *   approval before the destructive apply (the gate lives in the composite).
 */
export type DeleteMode = "never" | "owned-only" | "gated";

export interface NativeApplyArgs {
  /** Native mechanism to delegate to. */
  target: ApplyTarget;
  /** Environment — CFN stack name / ARM resource group / chant environment. */
  env: string;
  /** Built manifest/template path. Default per target ({@link defaultOutput}):
   * `dist` (a dir) for kubectl, `template.json` (a file) for CloudFormation/ARM. */
  output?: string;
  /** Delete handling. Default: never. */
  deleteMode?: DeleteMode;
  /**
   * kubectl target only (chant #1075). Take ownership of fields another field
   * manager owns instead of failing with a conflict that names them.
   * **Opt-in, and never defaulted on**: transferring ownership of a live field
   * is a decision, not a retry.
   */
  forceConflicts?: boolean;
}

/** What an apply did. Shaped by the target, since the targets differ. */
export interface NativeApplyResult {
  /** The shell command that ran — CloudFormation and ARM. */
  command?: string;
  /** Objects server-side applied — kubectl. */
  applied?: number;
  /** Objects pruned because they carried chant's marker and are no longer declared — kubectl. */
  pruned?: number;
  /** The field manager the apply claimed ownership as — kubectl. */
  fieldManager?: string;
}

/**
 * The k8s lexicon's server-side apply, as this module needs to call it.
 * Structural, so nothing here imports the k8s lexicon's types.
 */
export type K8sApplier = (
  args: {
    manifest: string;
    environment?: string;
    deleteMode?: DeleteMode;
    force?: boolean;
  },
  signal?: AbortSignal,
) => Promise<{ applied: unknown[]; pruned: unknown[]; fieldManager: string }>;

/**
 * Build the native apply command for the shell targets. Pure — exported for
 * testing.
 *
 * Authority stays with the platform: the CloudFormation stack, the ARM
 * resource group. chant hosts no state file. Deletes ride the native delete
 * path, and its scope is the platform's, not chant's:
 * - CloudFormation: the stack is the boundary; `deploy` deletes resources
 *   removed from the template within it. A resource CFN did not create is not
 *   in the stack, so owned-only holds.
 * - ARM: `--mode Complete` removes resources not in the template from the RG —
 *   ALL of them, marked or not. Owned-only does NOT hold here; the ownership
 *   marker is not consulted (chant #1448). The azure lexicon's own `azApply`
 *   prunes marker-scoped via `pruneArmOrphans`; this shell path does not reach
 *   it (chant #1449).
 *
 * The kubectl target has no command: it is a server-side apply through the k8s
 * lexicon (chant #1075), whose marker-scoped prune replaces
 * `--prune --selector <managed-by>=chant`.
 */
export function applyCommand(
  target: ShellApplyTarget,
  env: string,
  output: string,
  deleteMode: DeleteMode,
): string {
  const deletes = deleteMode !== "never";
  switch (target) {
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
 * Load the k8s lexicon's apply. A variable specifier, so `tsc` does not
 * statically resolve a package this one deliberately does not depend on — the
 * same mechanism core's activity registry uses to load a lexicon's activities.
 */
async function loadK8sApplier(): Promise<K8sApplier> {
  const spec = "@intentius/chant-lexicon-k8s/op/activities";
  let mod: { applyManifest?: K8sApplier };
  try {
    mod = (await import(spec)) as { applyManifest?: K8sApplier };
  } catch (err) {
    throw new Error(
      `apply target "kubectl" needs @intentius/chant-lexicon-k8s, which could not be loaded ` +
        `(${err instanceof Error ? err.message : String(err)}). Kubernetes applies moved out of the ` +
        `Temporal lexicon in chant #1075; install the k8s lexicon and list it in chant.config.ts.`,
    );
  }
  if (typeof mod.applyManifest !== "function") {
    throw new Error(
      "the installed @intentius/chant-lexicon-k8s exports no applyManifest — it predates chant #1075",
    );
  }
  return mod.applyManifest;
}

/**
 * Inject `--endpoint-url <endpoint>` into a CloudFormation `aws …` command when an
 * endpoint is set (from AWS_ENDPOINT_URL), so `ApplyOp(target: "cloudformation")`
 * deploys to a local emulator (Floci) instead of real AWS — regardless of aws-CLI
 * version, which only reads AWS_ENDPOINT_URL itself on ≥2.13 (#926). Only the
 * cloudformation target uses the aws CLI; kubectl/arm pass through. Pure.
 */
export function applyEndpoint(command: string, target: ApplyTarget, endpoint: string | undefined): string {
  if (target !== "cloudformation" || !endpoint || !/^aws\s/.test(command)) return command;
  return command.replace(/^aws\s/, `aws --endpoint-url '${endpoint}' `);
}

/**
 * Sensible default build output per target. kubectl `apply -f` takes a directory
 * (all manifests), so `dist`. CloudFormation/ARM `--template-file` needs a single
 * template *file* — a directory is rejected ("Invalid template path") — so the
 * conventional `template.json`. Pure — exported for testing.
 */
export function defaultOutput(target: ApplyTarget): string {
  return target === "kubectl" ? "dist" : "template.json";
}

/**
 * Apply declared source to the cloud via the target's native mechanism.
 * Deletes (when enabled) ride that mechanism's own delete path — marker-scoped
 * on `kubectl`, stack-scoped on `cloudformation`, and resource-group-scoped on
 * `arm`, which is NOT owned-only (chant #1448). See {@link DeleteMode}.
 *
 * `applier` is injectable so this dispatcher can be tested without the k8s
 * lexicon present; production resolves it through {@link loadK8sApplier}.
 */
export async function nativeApply(
  args: NativeApplyArgs,
  signal?: AbortSignal,
  applier?: K8sApplier,
): Promise<NativeApplyResult> {
  const output = args.output ?? defaultOutput(args.target);
  const deleteMode = args.deleteMode ?? "never";

  if (args.target === "kubectl") {
    const apply = applier ?? (await loadK8sApplier());
    const result = await apply(
      {
        manifest: output,
        environment: args.env,
        deleteMode,
        ...(args.forceConflicts !== undefined ? { force: args.forceConflicts } : {}),
      },
      signal,
    );
    console.log(
      `applied ${result.applied.length} object(s) as field manager "${result.fieldManager}"` +
        (result.pruned.length > 0 ? `; pruned ${result.pruned.length}` : ""),
    );
    return {
      applied: result.applied.length,
      pruned: result.pruned.length,
      fieldManager: result.fieldManager,
    };
  }

  const command = applyEndpoint(
    applyCommand(args.target, args.env, output, deleteMode),
    args.target,
    process.env.AWS_ENDPOINT_URL,
  );
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

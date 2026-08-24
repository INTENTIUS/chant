/**
 * `nativeApply` — push declared source to the cloud through the target's own
 * mechanism. Authority stays with the platform; chant hosts no state file.
 *
 * ## Where the shell went (chant #1075, #1448, #1449)
 *
 * This used to build a shell command for every target — `kubectl apply -f`,
 * `az deployment group create`, `aws cloudformation deploy`. Two things were
 * wrong with that. The shell commands carried product knowledge that belongs to
 * each product's lexicon, against the one-lexicon-per-product rule that already
 * moved `kubectlApply`, `k3dUp`/`k3dDown` and `waitForArgoSync` out (chant
 * #809). And each CLI's semantics diverged from what the docblocks promised —
 * `kubectl apply`'s client-side merge gave the diff engine nothing to key on
 * (#1075), and ARM Complete mode deleted resources chant never applied (#1448).
 *
 * So each branch moved to its product's lexicon: `kubectl`/`kustomize` are a
 * server-side apply over the k8s lexicon's typed client (#1075, #1548), `arm`
 * is the azure lexicon's per-resource `azApply` (#1448), `cloudformation`
 * is the aws lexicon's `awsApply` — the CloudFormation Query API directly, no
 * CLI in the path (#1449) — and `gcp`/`fly` are the gcp lexicon's
 * per-resource `gcpApply` and the fly lexicon's `flyApply`, which never had a
 * CLI in the path to begin with: gcp maps each CNRM kind to its REST API
 * itself, and fly speaks the Machines API (flaps) directly, no flyctl.
 * **The dispatcher stayed here**, because "which
 * mechanism applies this target" is not any one product's knowledge — and
 * because the activity keeps its name, its arguments and its place in
 * `ApplyOp`, so no existing Op changes shape.
 *
 * The lexicons are reached by dynamic import at call time, never by a static
 * one: this package must not depend on them. A project applying a target
 * already lists that lexicon in its config, so the module is there; when it is
 * not, the failure names the package to install.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** The native apply mechanism for a target. */
export type ApplyTarget = "cloudformation" | "kubectl" | "arm" | "kustomize" | "gcp" | "fly";

/**
 * How apply treats resources no longer declared.
 * - `never` — additive only; never deletes.
 * - `owned-only` — enables the target's own delete path. What bounds that path
 *   differs per target, and all of them are genuinely owned-only: `kubectl`
 *   sweeps by the ownership marker, `arm` prunes by the ownership tag
 *   (`isChantOwned`, via the azure lexicon's `azApply`), `gcp` prunes by the
 *   ownership label (via the gcp lexicon's `gcpApply` — only kinds it can
 *   list; the rest are reported not-prunable), `fly` prunes machines by the
 *   metadata marker and the metadata-less types (volumes/ips/certs/secrets)
 *   app-scoped under a managed app (via the fly lexicon's `flyApply`), and
 *   `cloudformation` is bounded by the stack — which holds, because a
 *   resource CFN did not create is not in the stack.
 * - `gated` — same delete scope as `owned-only`, but the workflow pauses for
 *   approval before the destructive apply (the gate lives in the composite).
 */
export type DeleteMode = "never" | "owned-only" | "gated";

export interface NativeApplyArgs {
  /** Native mechanism to delegate to. */
  target: ApplyTarget;
  /** Environment. What it means is per target: the CFN stack name on
   * `cloudformation`, the ARM resource group on `arm`, the chant environment
   * on `kubectl`/`kustomize`. On `gcp` and `fly` it is a log label only — the
   * gcp applier resolves the project (`GOOGLE_CLOUD_PROJECT` env / CNRM
   * annotation) and endpoint (`GCP_ENDPOINT_URL` env) itself, and the fly
   * applier resolves its endpoint (`FLY_FLAPS_BASE_URL` env) and token
   * (`FLY_API_TOKEN` env) itself, with the app names coming from the plan. */
  env: string;
  /** Built manifest/template path. Default per target ({@link defaultOutput}):
   * `dist` (a dir) for kubectl, `template.json` (a file) for
   * CloudFormation/ARM, `dist/gcp.yaml` for gcp, `dist/fly.json` for fly. */
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
  /** Objects server-side applied — kubectl/kustomize; resources PUT — arm/gcp/fly. */
  applied?: number;
  /** Objects pruned because they carried chant's marker and are no longer declared — kubectl/arm/gcp/fly. */
  pruned?: number;
  /** Declared resources no call was made for (#1447) — gcp. Zero on a complete apply. */
  notAttempted?: number;
  /** Kinds the prune could not consider — gcp. Zero when the prune is off. */
  notPrunable?: number;
  /** The field manager the apply claimed ownership as — kubectl. */
  fieldManager?: string;
  /** The stack deployed — cloudformation. */
  stackName?: string;
  /** The settled stack status — cloudformation. */
  status?: string;
  /** What the deploy did to the stack — cloudformation. */
  action?: "created" | "updated" | "unchanged";
}

/**
 * The k8s lexicon's server-side apply, as this module needs to call it.
 * Structural, so nothing here imports the k8s lexicon's types.
 */
export type K8sApplier = (
  args: {
    manifest: string;
    /** Already-rendered documents (#1548) — the kustomize target hands the
     * render straight in; `manifest` is then only the log label. */
    documents?: Array<Record<string, unknown>>;
    environment?: string;
    deleteMode?: DeleteMode;
    force?: boolean;
  },
  signal?: AbortSignal,
) => Promise<{ applied: unknown[]; pruned: unknown[]; fieldManager: string }>;

/**
 * The azure lexicon's per-resource ARM applier, as this module needs to call it.
 * Structural, so nothing here imports the azure lexicon's types — same shape as
 * {@link K8sApplier}.
 */
export type AzureApplier = (
  args: {
    templatePath: string;
    resourceGroup: string;
    endpoint?: string;
    prune?: boolean;
  },
  signal?: AbortSignal,
) => Promise<{ applied: unknown[]; pruned: unknown[] }>;

/**
 * The gcp lexicon's per-resource applier, as this module needs to call it
 * (#1449). Structural, so nothing here imports the gcp lexicon's types — same
 * shape as {@link K8sApplier} and {@link AzureApplier}.
 *
 * Deliberately narrow: no `endpoint`, because `gcpApply` resolves
 * `GCP_ENDPOINT_URL` itself — the same variable gcp's read path honours, so an
 * apply lands wherever `--live` is already looking (floci-gcp, or real GCP
 * when unset); and no `project`, because `gcpApply` resolves
 * `GOOGLE_CLOUD_PROJECT` / the CNRM project-id annotation itself.
 */
export type GcpApplier = (
  args: {
    manifestPath: string;
    prune?: boolean;
  },
  signal?: AbortSignal,
) => Promise<{
  applied: unknown[];
  pruned: unknown[];
  /** Declared resources no REST call was made for (#1447). */
  notAttempted: unknown[];
  /** Kinds the prune could not consider. */
  notPrunable: unknown[];
}>;

/**
 * The fly lexicon's flaps applier, as this module needs to call it (#1449).
 * Structural, so nothing here imports the fly lexicon's types — same shape as
 * {@link K8sApplier} and {@link AzureApplier}. The eleven arrays are flyApply's
 * own contract: six entity classes applied, five pruned; this module only
 * counts them.
 *
 * Deliberately narrow: no `endpoint`, because `flyApply` resolves
 * `FLY_FLAPS_BASE_URL` itself — mudflaps locally, real Fly when unset; and no
 * `token`, because it resolves `FLY_API_TOKEN` itself.
 */
export type FlyApplier = (
  args: {
    planPath: string;
    prune?: boolean;
  },
  signal?: AbortSignal,
) => Promise<{
  apps: unknown[];
  machines: unknown[];
  volumes: unknown[];
  ips: unknown[];
  certs: unknown[];
  secrets: unknown[];
  pruned: unknown[];
  prunedVolumes: unknown[];
  prunedIps: unknown[];
  prunedCerts: unknown[];
  prunedSecrets: unknown[];
}>;

/**
 * The aws lexicon's CloudFormation applier, as this module needs to call it
 * (#1449). Structural, like {@link K8sApplier} and {@link AzureApplier}.
 *
 * Deliberately narrow: no `endpoint`, because `awsApply` resolves
 * `AWS_ENDPOINT_URL_CLOUDFORMATION` then `AWS_ENDPOINT_URL` itself (#1694) —
 * the rule that used to live here as `applyEndpoint` (#926); and no
 * `capabilities`, because `awsApply` derives them from the template body
 * (`CAPABILITY_NAMED_IAM`, plus `CAPABILITY_AUTO_EXPAND` for a top-level
 * `Transform` — #980), the rule that used to live here as `cfnCapabilities`.
 */
export type AwsApplier = (
  args: { templatePath: string; stackName: string },
  signal?: AbortSignal,
) => Promise<{ stackName: string; status: string; action: "created" | "updated" | "unchanged" }>;

/**
 * The aws lexicon's CloudFormation rollback (saga compensation), as
 * {@link compensateApply} needs to call it. Structural, like the appliers.
 */
export type AwsRollback = (
  args: { stackName: string },
  signal?: AbortSignal,
) => Promise<{ stackName: string; rolledBack: boolean; status?: string }>;

/**
 * Render a kustomization directory to parsed documents (#1548): `kustomize
 * build`, falling back to kubectl's vendored kustomize when the standalone
 * binary is absent. The 64MiB buffer matches the k8s/helm lexicons' bound —
 * a big overlay renders megabytes. YAML parsing is js-yaml's multi-doc
 * loader, the same one the k8s applier uses on files.
 */
async function renderKustomization(dir: string): Promise<Array<Record<string, unknown>>> {
  const quoted = `'${dir.replace(/'/g, "'\\''")}'`;
  const run = (cmd: string) => execAsync(cmd, { maxBuffer: 64 * 1024 * 1024 });
  let stdout: string;
  try {
    ({ stdout } = await run(`kustomize build ${quoted}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/ENOENT|not found|command not found|127/.test(message)) throw err;
    ({ stdout } = await run(`kubectl kustomize ${quoted}`));
  }
  const { loadAll } = await import("js-yaml");
  const documents: Array<Record<string, unknown>> = [];
  for (const doc of loadAll(stdout)) {
    if (doc && typeof doc === "object" && !Array.isArray(doc)) documents.push(doc as Record<string, unknown>);
  }
  return documents;
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
 * Load the azure lexicon's `azApply` (#1448). Same variable-specifier trick as
 * {@link loadK8sApplier}, for the same reason.
 */
async function loadAzureApplier(): Promise<AzureApplier> {
  const spec = "@intentius/chant-lexicon-azure/op/activities";
  let mod: { azApply?: AzureApplier };
  try {
    mod = (await import(spec)) as { azApply?: AzureApplier };
  } catch (err) {
    throw new Error(
      `apply target "arm" needs @intentius/chant-lexicon-azure, which could not be loaded ` +
        `(${err instanceof Error ? err.message : String(err)}). ARM applies go through the azure ` +
        `lexicon's per-resource applier since chant #1448; install the azure lexicon and list it ` +
        `in chant.config.ts.`,
    );
  }
  if (typeof mod.azApply !== "function") {
    throw new Error(
      "the installed @intentius/chant-lexicon-azure exports no azApply — it predates chant #707",
    );
  }
  return mod.azApply;
}

/**
 * Load the gcp lexicon's `gcpApply` (#1449). Same variable-specifier trick as
 * {@link loadK8sApplier}, for the same reason.
 */
async function loadGcpApplier(): Promise<GcpApplier> {
  const spec = "@intentius/chant-lexicon-gcp/op/activities";
  let mod: { gcpApply?: GcpApplier };
  try {
    mod = (await import(spec)) as { gcpApply?: GcpApplier };
  } catch (err) {
    throw new Error(
      `apply target "gcp" needs @intentius/chant-lexicon-gcp, which could not be loaded ` +
        `(${err instanceof Error ? err.message : String(err)}). GCP applies go through the gcp ` +
        `lexicon's native applier since chant #1449; install the gcp lexicon and list it ` +
        `in chant.config.ts.`,
    );
  }
  if (typeof mod.gcpApply !== "function") {
    throw new Error(
      "the installed @intentius/chant-lexicon-gcp exports no gcpApply — it predates chant #706",
    );
  }
  return mod.gcpApply;
}

/**
 * Load the fly lexicon's `flyApply` (#1449). Same variable-specifier trick as
 * {@link loadK8sApplier}, for the same reason.
 */
async function loadFlyApplier(): Promise<FlyApplier> {
  const spec = "@intentius/chant-lexicon-fly/op/activities";
  let mod: { flyApply?: FlyApplier };
  try {
    mod = (await import(spec)) as { flyApply?: FlyApplier };
  } catch (err) {
    throw new Error(
      `apply target "fly" needs @intentius/chant-lexicon-fly, which could not be loaded ` +
        `(${err instanceof Error ? err.message : String(err)}). Fly applies go through the fly ` +
        `lexicon's native flaps applier since chant #1449; install the fly lexicon and list it ` +
        `in chant.config.ts.`,
    );
  }
  if (typeof mod.flyApply !== "function") {
    throw new Error(
      "the installed @intentius/chant-lexicon-fly exports no flyApply — it predates chant #739",
    );
  }
  return mod.flyApply;
}

/**
 * Load the aws lexicon's `awsApply` (#1449). Same variable-specifier trick as
 * {@link loadK8sApplier}, for the same reason.
 */
async function loadAwsApplier(): Promise<AwsApplier> {
  const spec = "@intentius/chant-lexicon-aws/op/activities";
  let mod: { awsApply?: AwsApplier };
  try {
    mod = (await import(spec)) as { awsApply?: AwsApplier };
  } catch (err) {
    throw new Error(
      `apply target "cloudformation" needs @intentius/chant-lexicon-aws, which could not be loaded ` +
        `(${err instanceof Error ? err.message : String(err)}). CloudFormation applies go through the ` +
        `aws lexicon's native applier since chant #1449; install the aws lexicon and list it ` +
        `in chant.config.ts.`,
    );
  }
  if (typeof mod.awsApply !== "function") {
    throw new Error(
      "the installed @intentius/chant-lexicon-aws exports no awsApply — it predates chant #1446",
    );
  }
  return mod.awsApply;
}

/**
 * Load the aws lexicon's `rollbackStack` (#1449) — the compensation twin of
 * {@link loadAwsApplier}.
 */
async function loadAwsRollback(): Promise<AwsRollback> {
  const spec = "@intentius/chant-lexicon-aws/op/activities";
  let mod: { rollbackStack?: AwsRollback };
  try {
    mod = (await import(spec)) as { rollbackStack?: AwsRollback };
  } catch (err) {
    throw new Error(
      `rollback for target "cloudformation" needs @intentius/chant-lexicon-aws, which could not be ` +
        `loaded (${err instanceof Error ? err.message : String(err)}). CloudFormation rollback goes ` +
        `through the aws lexicon's rollbackStack since chant #1449; install the aws lexicon and ` +
        `list it in chant.config.ts.`,
    );
  }
  if (typeof mod.rollbackStack !== "function") {
    throw new Error(
      "the installed @intentius/chant-lexicon-aws exports no rollbackStack — it predates chant #1449",
    );
  }
  return mod.rollbackStack;
}

/**
 * Sensible default build output per target. kubectl takes a directory (all
 * manifests), so `dist`; kustomize's "output" is the kustomization DIRECTORY
 * the render reads. The file targets take the file their lexicon's build
 * conventionally emits: `template.json` for CloudFormation/ARM, `dist/gcp.yaml`
 * (the CNRM manifest) for gcp, `dist/fly.json` (the serialized plan) for fly.
 * Pure — exported for testing.
 */
export function defaultOutput(target: ApplyTarget): string {
  switch (target) {
    case "kubectl":
    case "kustomize":
      return "dist";
    case "gcp":
      return "dist/gcp.yaml";
    case "fly":
      return "dist/fly.json";
    default:
      return "template.json";
  }
}

/**
 * Apply declared source to the cloud via the target's native mechanism.
 * Deletes (when enabled) ride that mechanism's own delete path — marker-scoped
 * on `kubectl`, tag-scoped on `arm`, label-scoped on `gcp`, marker- and
 * app-scoped on `fly`, and stack-scoped on `cloudformation`, where the deploy
 * itself removes resources dropped from the template and `deleteMode` changes
 * nothing: a resource CFN did not create is not in the stack. See
 * {@link DeleteMode}.
 *
 * The appliers are injectable so this dispatcher can be tested without the
 * product lexicons present; production resolves them through
 * {@link loadK8sApplier} / {@link loadAzureApplier} / {@link loadAwsApplier} /
 * {@link loadGcpApplier} / {@link loadFlyApplier}.
 */
export async function nativeApply(
  args: NativeApplyArgs,
  signal?: AbortSignal,
  applier?: K8sApplier,
  azureApplier?: AzureApplier,
  renderer: (dir: string) => Promise<Array<Record<string, unknown>>> = renderKustomization,
  awsApplier?: AwsApplier,
  gcpApplier?: GcpApplier,
  flyApplier?: FlyApplier,
): Promise<NativeApplyResult> {
  const output = args.output ?? defaultOutput(args.target);
  const deleteMode = args.deleteMode ?? "never";

  if (args.target === "kubectl" || args.target === "kustomize") {
    const apply = applier ?? (await loadK8sApplier());
    // kustomize (#1548): `output` is the kustomization DIRECTORY; render it
    // and hand the documents to the SAME k8s applier inline — stamping, the
    // marker-scoped prune, and the conflict semantics are identical.
    const kustomized =
      args.target === "kustomize"
        ? { documents: await renderer(output), manifest: `kustomize:${output}` }
        : { manifest: output };
    const result = await apply(
      {
        ...kustomized,
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

  if (args.target === "arm") {
    const apply = azureApplier ?? (await loadAzureApplier());
    const result = await apply(
      {
        templatePath: output,
        resourceGroup: args.env,
        // The same variable azure's read path honours, so an ARM apply lands
        // wherever `--live` is already looking (floci-az, or real Azure when
        // unset).
        ...(process.env.AZURE_ENDPOINT_URL ? { endpoint: process.env.AZURE_ENDPOINT_URL } : {}),
        prune: deleteMode !== "never",
      },
      signal,
    );
    console.log(
      `applied ${result.applied.length} resource(s)` +
        (result.pruned.length > 0 ? `; pruned ${result.pruned.length}` : ""),
    );
    return { applied: result.applied.length, pruned: result.pruned.length };
  }

  if (args.target === "gcp") {
    // gcp (#1449): the gcp lexicon's per-resource applier. Only the manifest
    // path and the prune switch cross this seam — endpoint (`GCP_ENDPOINT_URL`)
    // and project (`GOOGLE_CLOUD_PROJECT` / CNRM annotation) are gcpApply's own
    // env resolution, and `env` is a log label here: GCP has no stack or
    // resource-group equivalent for it to name.
    const apply = gcpApplier ?? (await loadGcpApplier());
    const result = await apply({ manifestPath: output, prune: deleteMode !== "never" }, signal);
    console.log(
      `[${args.env}] applied ${result.applied.length} resource(s)` +
        (result.pruned.length > 0 ? `; pruned ${result.pruned.length}` : ""),
    );
    // #1447: a kind the applier has no mapper (or list capability) for is
    // reported, not dropped — otherwise a partial apply reads as a full one.
    if (result.notAttempted.length > 0) {
      console.warn(`[${args.env}] NOT applied (no mapper): ${result.notAttempted.length} resource(s)`);
    }
    if (result.notPrunable.length > 0) {
      console.warn(`[${args.env}] not prunable (no list capability): ${result.notPrunable.length} kind(s)`);
    }
    return {
      applied: result.applied.length,
      pruned: result.pruned.length,
      notAttempted: result.notAttempted.length,
      notPrunable: result.notPrunable.length,
    };
  }

  if (args.target === "fly") {
    // fly (#1449): the fly lexicon's flaps applier. Only the plan path and the
    // prune switch cross this seam — the endpoint (`FLY_FLAPS_BASE_URL`,
    // mudflaps locally) and token (`FLY_API_TOKEN`) are flyApply's own env
    // resolution, and `env` is a log label here: the app names live in the
    // plan itself.
    const apply = flyApplier ?? (await loadFlyApplier());
    const result = await apply({ planPath: output, prune: deleteMode !== "never" }, signal);
    const applied =
      result.apps.length +
      result.machines.length +
      result.volumes.length +
      result.ips.length +
      result.certs.length +
      result.secrets.length;
    const pruned =
      result.pruned.length +
      result.prunedVolumes.length +
      result.prunedIps.length +
      result.prunedCerts.length +
      result.prunedSecrets.length;
    console.log(
      `[${args.env}] applied ${applied} resource(s)` + (pruned > 0 ? `; pruned ${pruned}` : ""),
    );
    return { applied, pruned };
  }

  // cloudformation (#1449): the aws lexicon's native applier. env is the stack
  // name and output the template path; endpoint resolution (#1694) and
  // capability derivation (#980) are awsApply's own, so nothing else is passed.
  const apply = awsApplier ?? (await loadAwsApplier());
  const result = await apply({ templatePath: output, stackName: args.env }, signal);
  console.log(`${result.action}: stack ${result.stackName} (${result.status})`);
  return { stackName: result.stackName, status: result.status, action: result.action };
}

export interface CompensateApplyArgs {
  /** Native mechanism that was applied. */
  target: ApplyTarget;
  /** Environment — CFN stack name / ARM resource group. */
  env: string;
  /** Explicit rollback command, used in preference to the native default. */
  command?: string;
}

/** What a compensation did. */
export interface CompensateApplyResult {
  /** The explicit rollback command that ran, when one was supplied. */
  command?: string;
  /** The stack rolled back — cloudformation. */
  stackName?: string;
  /** Whether the native rollback actually ran — cloudformation. `false` when
   * the stack was absent or the target does not implement RollbackStack (Floci). */
  rolledBack?: boolean;
  /** The settled post-rollback stack status — cloudformation. */
  status?: string;
}

/**
 * Compensation step (saga rollback) for a partial apply failure. Runs the
 * explicit `command` if given; otherwise `cloudformation` rolls back natively
 * through the aws lexicon's `rollbackStack` (#1449 — CloudFormation
 * `RollbackStack` over the Query API, no CLI in the path). Where no automatic
 * rollback exists (kubectl/kustomize/arm/gcp/fly without a `command`), it warns rather
 * than silently no-op'ing — partial state should never look reverted when it
 * isn't.
 *
 * `rollback` is injectable for tests; production resolves it through
 * {@link loadAwsRollback}.
 */
export async function compensateApply(
  args: CompensateApplyArgs,
  signal?: AbortSignal,
  rollback?: AwsRollback,
): Promise<CompensateApplyResult> {
  if (args.command) {
    const { stdout, stderr } = await execAsync(args.command, { signal });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    return { command: args.command };
  }

  if (args.target === "cloudformation") {
    const roll = rollback ?? (await loadAwsRollback());
    const result = await roll({ stackName: args.env }, signal);
    return {
      stackName: result.stackName,
      rolledBack: result.rolledBack,
      ...(result.status !== undefined ? { status: result.status } : {}),
    };
  }

  console.warn(
    `[apply] no automatic rollback for target "${args.target}" — partial apply to ${args.env} was NOT reverted; supply compensate.command to enable rollback`,
  );
  return {};
}

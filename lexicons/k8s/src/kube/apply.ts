/**
 * `chant kube apply` (chant #1079) — "writes are not cloned": this calls
 * `applyManifest` (`../op/activities/kubectl.ts`) directly, the exact
 * function the k8s Op activity registers under `kubectlApply` — server-side
 * apply, chant's field-manager identity, the same `FieldManagerConflictError`
 * surface (chant #1075/#1178) — never a second implementation of `kubectl
 * apply`. An explicit manifest path is mandatory; there is no bare-sweep form.
 *
 * The one thing this verb adds on top of the activity is a confirmation
 * gate, matching the issue's "route through plan, gate, and ownership": a
 * bare `chant kube apply -f x.yaml` performs a server-side dry run — every
 * document validated and previewed, nothing persisted — and says so; only
 * `--yes` performs the real, persisting apply. That is a deliberate
 * divergence from `kubectl apply`, which persists by default; a terminal
 * command that can rewrite a live Deployment is worth one extra keystroke of
 * intent.
 */

import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure, isMissingClientPackage, MISSING_CLIENT_DETAIL } from "../api/classify";
import { applyManifest, type KubectlApplyArgs, type ApplyManifestResult } from "../op/activities/kubectl";
import { parseKubeFlags } from "./flags";

export type ApplyFn = (args: KubectlApplyArgs, signal?: AbortSignal, connect?: K8sConnector) => Promise<ApplyManifestResult>;

export interface ApplyDeps {
  connect?: K8sConnector;
  apply?: ApplyFn;
}

export async function runApply(rawArgs: string[], deps: ApplyDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const apply = deps.apply ?? applyManifest;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs, {
      value: { "-f": "filename", "--filename": "filename", "--field-manager": "fieldManager" },
      boolean: { "--force-conflicts": "forceConflicts", "--yes": "yes", "-y": "yes" },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const manifest = flags.values.filename;
  if (!manifest) {
    console.error(
      "error: --filename/-f is required — chant kube apply never applies without an explicit manifest path (no bare sweeps)",
    );
    return 1;
  }

  const dryRun = !(flags.flags.yes ?? false);
  const args: KubectlApplyArgs = {
    manifest,
    ...(flags.values.env !== undefined ? { environment: flags.values.env } : {}),
    ...(flags.values.context !== undefined ? { context: flags.values.context } : {}),
    ...(flags.values.fieldManager !== undefined ? { fieldManager: flags.values.fieldManager } : {}),
    force: flags.flags.forceConflicts ?? false,
    dryRun,
  };

  let result: ApplyManifestResult;
  try {
    result = await apply(args, undefined, connect);
  } catch (err) {
    if (err instanceof Error && err.name === "FieldManagerConflictError") {
      console.error(err.message);
      return 1;
    }
    if (err instanceof ClusterBindingMismatchError) {
      console.error(formatUnobserved(manifest, { reason: "no-binding", detail: err.message }));
      return 1;
    }
    if (isMissingClientPackage(err)) {
      console.error(formatUnobserved(manifest, { reason: "read-failed", detail: MISSING_CLIENT_DETAIL }));
      return 1;
    }
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(manifest, {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }

  // applyManifest already logged one line per applied object (including,
  // since chant #1079, whether it was a dry run) — this is the summary.
  if (dryRun) {
    console.log(`DRY RUN — ${result.applied.length} object(s) server-validated, nothing persisted. Pass --yes to apply for real.`);
  } else {
    console.log(`applied ${result.applied.length} object(s) as field manager "${result.fieldManager}"`);
    if (result.pruned.length > 0) console.log(`pruned ${result.pruned.length} chant-owned object(s) no longer declared`);
    if ((result.retained ?? []).length > 0) {
      console.log(
        `retained ${result.retained!.length} generated-once secret(s) no longer declared — never pruned; delete explicitly if you mean to`,
      );
    }
  }
  return 0;
}

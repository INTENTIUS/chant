/**
 * `ensureSecret` — the activity behind core's `ensureSecret(...)` op step
 * builder (#1829), provided by the store's lexicon as that builder promises
 * (#1830). Registered by name through the activity registry when a project's
 * `chant.config.ts` lists the `k8s` lexicon, exactly like `kubectlApply`.
 *
 * All it does is connect (the same environment→cluster binding every k8s
 * path uses), build the namespace-scoped store adapter, and run core's one
 * materialization engine over it. The contract — present means done, never
 * mint over an existing value, mismatches fail naming key names only, no
 * output carries material — lives in core (`secret-materialization.ts`) and
 * in the adapter (../../secret-store.ts), not here.
 */

import {
  ensureSecretMaterialization,
  type EnsureSecretOutcome,
} from "@intentius/chant/secret-materialization";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import { defaultK8sConnector, type K8sConnector } from "../../api/connect";
import { k8sSecretStore } from "../../secret-store";

export interface EnsureSecretActivityArgs {
  /** The Secret's `metadata.name`. */
  name: string;
  /** The declared key-set. Creation mints one value per key; verification compares names only. */
  keys: string[];
  /** Declared metadata (labels/annotations) an existing Secret must carry. Mismatches name the KEY. */
  metadata?: Record<string, string>;
  /** Target namespace. Omitted uses the connected context's default namespace. */
  namespace?: string;
  /** chant environment, resolved through `k8s.profiles.<env>.context`. */
  environment?: string;
  /** Explicit kubectl context — same precedence as `kubectlApply`. */
  context?: string;
  /** Project directory whose `chant.config.ts` carries the k8s profiles. */
  cwd?: string;
  /** Ownership stack to stamp on a minted Secret (with `env`, the full marker). */
  stack?: string;
  /** Ownership env to stamp alongside `stack`. */
  env?: string;
}

/**
 * Ensure a `generated-once` Secret exists in the target cluster. Returns
 * names only — see core's `EnsureSecretOutcome`.
 */
export async function ensureSecret(
  args: EnsureSecretActivityArgs,
  _signal?: AbortSignal,
  connect: K8sConnector = defaultK8sConnector,
): Promise<EnsureSecretOutcome> {
  const { client } = await connect({
    ...(args.environment !== undefined ? { environment: args.environment } : {}),
    ...(args.context !== undefined ? { context: args.context } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
  });

  const marker: OwnershipMarker | undefined = args.stack
    ? { stack: args.stack, ...(args.env ? { env: args.env } : {}) }
    : undefined;

  const store = k8sSecretStore(args.namespace ?? client.defaultNamespace, client, {
    ...(marker ? { marker } : {}),
  });
  return ensureSecretMaterialization(store, {
    name: args.name,
    keys: args.keys,
    ...(args.metadata ? { metadata: args.metadata } : {}),
  });
}

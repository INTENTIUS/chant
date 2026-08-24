/**
 * The Kubernetes row of the secret-store seam (chant #1830, epic #1365) — a
 * `SecretStoreAdapter` over the typed client, for the `ensure-secret`
 * capability verb and the `ensureSecret(...)` op step (both #1829, both
 * surfaces over core's one materialization engine).
 *
 * The constitutional line, held structurally:
 *
 * - `exists` and `describe` read the live Secret and report key NAMES and
 *   labels/annotations only. The `data` values are projected to their key
 *   names inside one function frame and the object is dropped — nothing
 *   value-shaped is returned, logged, or retained. The mismatch check in core
 *   therefore has nothing to compare but names, by construction.
 * - `create` is the only writer. It redeems each key's material through
 *   `consumeSecretMaterial` AT the write — the engine hands the generator
 *   through this seam and never calls it — and returns nothing.
 *
 * Every minted Secret carries chant's ownership marker plus the
 * `chant.intentius.io/generated-once` label (./secret-labels.ts), which is
 * what both prune paths key their `retained` outcome on: a generated-once
 * Secret is never in any prunable set, because the stored bytes are the only
 * copy of material chant never held.
 *
 * Not exported from the package entry point — like ./teardown.ts, this module
 * names the API client, which must stay off the build path (chant #1074,
 * examples/k8s-client-boundary.test.ts). Consumers reach it by subpath:
 * `@intentius/chant-lexicon-k8s/secret-store`.
 */

import type {
  SecretMaterialGenerator,
  SecretStoreAdapter,
  SecretStoreDescription,
} from "@intentius/chant/secret-materialization";
import { consumeSecretMaterial } from "@intentius/chant/secret-materialization";
import {
  createEnsureSecretCapability,
  type EnsureSecretInput,
  type EnsureSecretOutput,
} from "@intentius/chant/components/verbs/ensure-secret";
import type { Capability } from "@intentius/chant/components/capability";
import {
  LABEL_OWNERSHIP_KEYS,
  OWNERSHIP_MANAGED_BY_VALUE,
  ownershipEntries,
  type OwnershipMarker,
} from "@intentius/chant/ownership";
import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import { GENERATED_ONCE_LABEL_KEY, GENERATED_ONCE_LABEL_VALUE } from "./secret-labels";

const SECRET_REF = { apiVersion: "v1", kind: "Secret" } as const;

export interface K8sSecretStoreOptions {
  /**
   * Ownership identity to stamp on a minted Secret, next to the
   * generated-once label. Omitted stamps `managed-by=chant` alone — the
   * Secret is still chant-owned and still never prunable.
   */
  marker?: OwnershipMarker;
  /** chant environment, resolved through `k8s.profiles.<env>.context` when no client is handed in. */
  environment?: string;
  /** Explicit kubectl context, for the op write path. */
  context?: string;
  /** Project directory whose `chant.config.ts` carries the k8s profiles. Defaults to cwd. */
  cwd?: string;
  /** The connector to build a client with when none is handed in. Test seam. */
  connect?: K8sConnector;
}

/**
 * Build the k8s `SecretStoreAdapter` for one namespace.
 *
 * Pass a `client` where the caller already holds one (an activity that
 * connected for the rest of its work); omit it and the adapter connects
 * lazily through the same environment→cluster binding every other k8s path
 * uses (./api/connect.ts).
 */
export function k8sSecretStore(
  namespace: string,
  client?: K8sClient,
  options: K8sSecretStoreOptions = {},
): SecretStoreAdapter {
  let pending: Promise<K8sClient> | undefined = client ? Promise.resolve(client) : undefined;
  const clientOf = (): Promise<K8sClient> =>
    (pending ??= (options.connect ?? defaultK8sConnector)({
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    }).then((connected) => connected.client));

  return {
    async exists(name: string): Promise<boolean> {
      const c = await clientOf();
      return (await c.readIfPresent({ ...SECRET_REF, name, namespace })) !== undefined;
    },

    async describe(name: string): Promise<SecretStoreDescription> {
      const c = await clientOf();
      const live = await c.read({ ...SECRET_REF, name, namespace });
      // Project key names and drop the object in the same frame. The values
      // exist only in `live`, which nothing below touches again — the return
      // carries names and metadata, never a byte of `data`.
      const keys = Object.keys((live.data as Record<string, unknown> | undefined) ?? {}).sort();
      const metadata: Record<string, string> = {
        ...(live.metadata?.annotations ?? {}),
        ...(live.metadata?.labels ?? {}),
      };
      return { keys, metadata };
    },

    async create(name: string, keys: readonly string[], generate: SecretMaterialGenerator): Promise<void> {
      const c = await clientOf();
      // Mint and consume per key, at the write. `consumeSecretMaterial` burns
      // each handle, so the material cannot be redeemed a second time by
      // anything, this adapter included.
      const data: Record<string, string> = {};
      for (const key of keys) {
        data[key] = Buffer.from(consumeSecretMaterial(await generate(key)), "utf-8").toString("base64");
      }
      const secret: K8sObject = {
        apiVersion: SECRET_REF.apiVersion,
        kind: SECRET_REF.kind,
        metadata: {
          name,
          namespace,
          labels: {
            ...(options.marker
              ? ownershipEntries(LABEL_OWNERSHIP_KEYS, options.marker)
              : { [LABEL_OWNERSHIP_KEYS.managedBy]: OWNERSHIP_MANAGED_BY_VALUE }),
            [GENERATED_ONCE_LABEL_KEY]: GENERATED_ONCE_LABEL_VALUE,
          },
        },
        type: "Opaque",
        data,
      };
      // Server-side apply as chant's field manager — the same write path every
      // other chant mutation takes. The result (which echoes `data`) is
      // deliberately discarded.
      await c.apply(secret, {
        ...(options.marker ? { fieldManager: `chant:${options.marker.stack}` } : {}),
      });
    },
  };
}

/**
 * The real `ensure-secret` capability for a Kubernetes namespace — core's
 * factory (#1829) over this module's adapter. Replaces the starter set's
 * typed stub for a project whose secret store is the cluster:
 *
 * ```ts
 * registry.register(k8sEnsureSecretCapability("prod", undefined, {
 *   marker: { stack: "shop", env: "prod" },
 *   environment: "prod",
 * }));
 * ```
 */
export function k8sEnsureSecretCapability(
  namespace: string,
  client?: K8sClient,
  options: K8sSecretStoreOptions = {},
): Capability<EnsureSecretInput, EnsureSecretOutput> {
  return createEnsureSecretCapability({ store: k8sSecretStore(namespace, client, options) });
}

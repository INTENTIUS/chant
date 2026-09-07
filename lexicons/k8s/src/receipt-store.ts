/**
 * The k8s `ReceiptStore` (#2074, epic #1703): core's injectable receipt seam
 * (#1834, `@intentius/chant/op/receipt-store`) implemented over a core
 * `ConfigMap`, at the address ./effect-receipt-row.ts derives from the
 * ownership marker fields, plus the plan-side live read of the same rows.
 *
 * The transport is the lexicon's own typed client (./api/connect.ts), so a
 * receipt read and write take the same environment-to-cluster binding
 * (#1100/#1155), the same credential policy and the same field manager as
 * every other k8s mutation. No `kubectl` binary is involved.
 *
 * Write discipline (epic decision 3): `write` exists for the `effect()` step
 * alone, because the step's read-compare-run-write is the only path that reaches it,
 * on success, last. It is a server-side apply as `chant:<stack>`, stamping the
 * ownership marker labels and {@link RECEIPT_LABEL_KEY}, so a later write
 * updates the value in place and the owned-only prune retains rather than
 * deletes it (./op/activities/kubectl.ts).
 *
 * Identity: the ConfigMap name needs `<stack>` and `<env>`, which the activity
 * args deliberately do not carry (the `EffectReceiptRef` is
 * identity-of-the-effect, not identity-of-the-deployment). The store resolves
 * them once, lazily, at first use: an explicit option, else `CHANT_ENV` (what
 * `chant run --env` sets) and the project's `ownership` block, the same fields
 * that stamp markers (epic decision 4). Nothing resolving is an error, never a
 * guessed segment.
 *
 * Not exported from the package entry point. Like ./secret-store.ts and
 * ./teardown.ts, this module names the API client, which must stay off the
 * build path (chant #1074, examples/k8s-client-boundary.test.ts). Consumers
 * reach it by subpath: `@intentius/chant-lexicon-k8s/receipt-store`.
 */

import { loadChantConfigUpward, resolveOwnershipStack } from "@intentius/chant/config";
import {
  LABEL_OWNERSHIP_KEYS,
  ownershipEntries,
  classifyOwnership,
  readOwnership,
} from "@intentius/chant/ownership";
import type { EffectReceiptRef, ReceiptStore } from "@intentius/chant/op/receipt-store";
import type { ResourceMetadata, UnobservedEntity } from "@intentius/chant/lexicon";
import type { DeepResourceObservation } from "@intentius/chant/deep-observation";
import type { K8sClient, K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import { classifyApiFailure } from "./api/classify";
import {
  K8S_EFFECT_RECEIPT_ENTITY_TYPE,
  RECEIPT_CONFIGMAP_REF,
  RECEIPT_DATA_KEY,
  RECEIPT_LABEL_KEY,
  parseReceiptComment,
  receiptConfigMapRef,
  receiptNamespaceFrom,
  type RenderedReceiptRow,
} from "./effect-receipt-row";

/** Options for {@link k8sReceiptStore}. All optional: the default store reads
 * its identity and its namespace from the project, and its cluster from the
 * environment binding. */
export interface K8sReceiptStoreOptions {
  /** The name's `<stack>` segment. Omitted, the project's `ownership.stack`
   * (chant.config.ts, found upward from `cwd`) answers. */
  stack?: string;
  /** The name's `<env>` segment, explicit by decision 4. Omitted, `CHANT_ENV`
   * (set by `chant run --env`) answers, then a literal `ownership.env`. */
  environment?: string;
  /** Namespace the receipts live in. Omitted, `k8s.receipts.namespace`
   * answers, then `default`. */
  namespace?: string;
  /** Where to look for chant.config.ts. Defaults to the working directory. */
  cwd?: string;
  /** Explicit kubectl context, for a caller that already resolved one. */
  context?: string;
  /** The connector to build a client with. Test seam. */
  connect?: K8sConnector;
  /** Environment record the identity fallback reads. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** The resolved name identity. */
interface ReceiptIdentity {
  stack: string;
  env: string;
  namespace: string;
}

async function resolveIdentity(options: K8sReceiptStoreOptions): Promise<ReceiptIdentity> {
  const processEnv = options.env ?? process.env;
  let stack = options.stack;
  let env = options.environment ?? processEnv.CHANT_ENV;
  let namespace = options.namespace;
  if (!stack || !env || !namespace) {
    let config;
    try {
      config = (await loadChantConfigUpward(options.cwd ?? process.cwd())).config;
    } catch {
      config = undefined;
    }
    if (config) {
      stack = stack ?? resolveOwnershipStack(config);
      // Only a literal env can answer here: a `{ param }` reference resolves
      // per build, and an op run has no build parameters, and `--env` does.
      const configEnv = config.ownership?.env;
      env = env ?? (typeof configEnv === "string" ? configEnv : undefined);
      namespace = namespace ?? receiptNamespaceFrom(config as unknown as Record<string, unknown>);
    }
  }
  if (!stack) {
    throw new Error(
      "k8s receipt store: no stack identity. The receipt ConfigMap is named " +
        "chant-receipt.<stack>.<env>.<effect>, derived from the same ownership fields that stamp " +
        "markers (chant #1703, decision 4). Set ownership: { stack } in chant.config.ts.",
    );
  }
  if (!env) {
    throw new Error(
      "k8s receipt store: no environment resolved. The receipt name's <env> segment is explicit " +
        "(chant #1703, decision 4). Run with --env <name>, set CHANT_ENV, or set a literal " +
        "ownership.env in chant.config.ts.",
    );
  }
  return { stack, env, namespace: namespace ?? receiptNamespaceFrom(undefined) };
}

/** The stored expectation on a live receipt ConfigMap, or undefined when the
 * object holds none. */
export function receiptValueOf(object: K8sObject | undefined): string | undefined {
  const data = (object as { data?: Record<string, unknown> } | undefined)?.data;
  const value = data?.[RECEIPT_DATA_KEY];
  return typeof value === "string" ? value : undefined;
}

/**
 * The `ReceiptStore` over ConfigMaps. Bind it once in the op activities barrel
 * as `receiptActivities(k8sReceiptStore())`, and the registry resolves
 * `receiptRead`/`receiptWrite`/`receiptStaleness` by name, exactly like
 * `ensureSecret` (#1830). Identity and cluster resolve lazily at first use, so
 * module load never reads the project or connects to anything.
 */
export function k8sReceiptStore(options: K8sReceiptStoreOptions = {}): ReceiptStore {
  let identity: Promise<ReceiptIdentity> | undefined;
  const identityOf = () => (identity ??= resolveIdentity(options));

  let pending: Promise<K8sClient> | undefined;
  const clientOf = (): Promise<K8sClient> =>
    (pending ??= (options.connect ?? defaultK8sConnector)({
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    }).then((connected) => connected.client));

  return {
    async read(receipt: EffectReceiptRef): Promise<string | undefined> {
      const { stack, env, namespace } = await identityOf();
      const ref = receiptConfigMapRef(stack, env, receipt.effect, namespace);
      const client = await clientOf();
      const live = await client.readIfPresent({ ...RECEIPT_CONFIGMAP_REF, ...ref });
      return receiptValueOf(live);
    },

    async write(receipt: EffectReceiptRef, expectation: string): Promise<void> {
      const { stack, env, namespace } = await identityOf();
      const ref = receiptConfigMapRef(stack, env, receipt.effect, namespace);
      const client = await clientOf();
      const configMap: K8sObject = {
        ...RECEIPT_CONFIGMAP_REF,
        metadata: {
          ...ref,
          labels: {
            ...ownershipEntries(LABEL_OWNERSHIP_KEYS, { stack, env }),
            [RECEIPT_LABEL_KEY]: receipt.effect,
          },
        },
        data: { [RECEIPT_DATA_KEY]: expectation },
      } as K8sObject;
      await client.apply(configMap, { fieldManager: `chant:${stack}` });
    },
  };
}

/** What the observation leg learned about the declared receipt rows. */
export interface ReceiptRowObservation {
  resources: Record<string, ResourceMetadata>;
  unobserved: Record<string, UnobservedEntity>;
}

/** The receipt rows a build output carries, keyed by entity name. Only the
 * entities this observation was asked about. */
export function receiptRowsFor(
  entityNames: readonly string[],
  buildOutput: string | undefined,
): Map<string, RenderedReceiptRow> {
  const rows = parseReceiptComment(buildOutput ?? "");
  const wanted = new Set(entityNames);
  const out = new Map<string, RenderedReceiptRow>();
  for (const [name, row] of Object.entries(rows)) {
    if (!wanted.has(name)) continue;
    if (typeof row?.name !== "string" || typeof row?.namespace !== "string") continue;
    out.set(name, row);
  }
  return out;
}

/**
 * The plan-side live read of the receipt rows (#2074's observation leg).
 *
 * A receipt is not a document the applier ever wrote (#1832), and it carries
 * no `props` on the declared side, so the generic declared-entity sweep in
 * ./describe-resources.ts has neither a `metadata.name` to query by nor an
 * honest verdict to give. The serializer rendered each receipt's derived
 * ConfigMap address into the build output's receipt comment, so this leg reads
 * the addresses back from there, one derivation, decision 4, and asks the
 * cluster for each.
 *
 * Present maps the stored value onto `attributes.value` (core's
 * `RECEIPT_VALUE_ATTRIBUTE`); a genuine 404 is a real absence and stays one; a
 * failed read is an `unobserved` hole, never a wrong answer: a receipt nobody
 * could read must not arrive downstream as "the effect never ran".
 */
export async function observeReceiptRows(
  client: K8sClient,
  rows: ReadonlyMap<string, RenderedReceiptRow>,
): Promise<ReceiptRowObservation> {
  const out: ReceiptRowObservation = { resources: {}, unobserved: {} };
  await client.concurrently([...rows], async ([entityName, row]) => {
    try {
      const live = await client.read({
        ...RECEIPT_CONFIGMAP_REF,
        name: row.name,
        namespace: row.namespace,
      });
      out.resources[entityName] = {
        type: K8S_EFFECT_RECEIPT_ENTITY_TYPE,
        physicalId: live.metadata?.uid,
        // Live outside anything the applier wrote, by design. The same word
        // the aws row's observation uses for a receipt parameter (#1835).
        status: "EXTERNAL",
        ownership: classifyOwnership(live.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        marker: readOwnership(live.metadata?.labels, LABEL_OWNERSHIP_KEYS),
        attributes: {
          namespace: row.namespace,
          // Core's RECEIPT_VALUE_ATTRIBUTE, which is what `readReceiptValue` reads.
          value: receiptValueOf(live) ?? "",
        },
      };
    } catch (err) {
      const outcome = classifyApiFailure(err);
      if (outcome.kind === "unobserved") {
        out.unobserved[entityName] = {
          type: K8S_EFFECT_RECEIPT_ENTITY_TYPE,
          reason: outcome.reason,
          detail: `reading receipt ConfigMap ${row.namespace}/${row.name}: ${outcome.detail}`,
        };
      }
      // `absent` records nothing: in neither map is how the contract spells
      // "asked, and it is not there", which is what the plan reads as "the
      // effect has not fired for these inputs".
    }
  });
  return out;
}

/**
 * The deep read's answer for the receipt rows.
 *
 * A receipt is read back here for the same reason the thin path reads it: a
 * declared entity nobody looked at is a hole, and a hole in the deep read is
 * noise on every `lifecycle diff --live --deep` a project with receipts runs.
 * What it deliberately contributes is an EMPTY property tree: the declaration
 * has no `props`, so every live path would land outside the claimed-field set
 * (`@intentius/chant/claimed-fields`) and be reported unclaimed, and the
 * receipt's stored value is not drift on any reading, because a stale receipt is an
 * `effect` row from `planReceipts` (#1832), never an update. Presence and the
 * uid are the whole of what the deep read has to say about a receipt.
 */
export async function observeReceiptRowsDeep(
  client: K8sClient,
  rows: ReadonlyMap<string, RenderedReceiptRow>,
): Promise<{ resources: Record<string, DeepResourceObservation>; unobserved: Record<string, UnobservedEntity> }> {
  const thin = await observeReceiptRows(client, rows);
  const resources: Record<string, DeepResourceObservation> = {};
  for (const [name, meta] of Object.entries(thin.resources)) {
    resources[name] = {
      type: K8S_EFFECT_RECEIPT_ENTITY_TYPE,
      ...(meta.physicalId ? { physicalId: meta.physicalId } : {}),
      properties: {},
    };
  }
  return { resources, unobserved: thin.unobserved };
}

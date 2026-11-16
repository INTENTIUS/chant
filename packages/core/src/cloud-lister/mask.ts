/**
 * behold#1029: secret-bearing values are masked in the lister, before a
 * `ListingResult` exists, so no later stage (chant#4521's typing, the store,
 * LadybugDB) ever holds one (#1025 "Source interface").
 *
 * The key list is chant's `SENSITIVE_KEY_PATTERNS` (../sensitive-key.ts), the
 * one list chant's thin and deep observation paths share. behold carried a
 * copy while the lister lived there; in chant it is the same list.
 *
 * A Kubernetes pod spec's Secret references keep the Secret's name and mask
 * every other field (chant#5252, `podSecretNameView` in ../sensitive-key.ts),
 * so a live read can tell which Secret a workload mounts.
 *
 * Beyond key names, two things are masked whole because their values are
 * secrets whatever their keys are called:
 *  - a Kubernetes Secret's `data` and `stringData`, and its
 *    `kubectl.kubernetes.io/last-applied-configuration` annotation, which
 *    repeats them;
 *  - any tag or label whose key matches the patterns.
 */

import { isReferenceField, isSensitiveKey, podSecretNameView, SENSITIVE_KEY_PATTERNS } from "../sensitive-key";

export { isSensitiveKey, SENSITIVE_KEY_PATTERNS };

/** What a masked value becomes. A fixed string, so a masked value never diffs. */
export const MASKED = "<masked>";

/**
 * A deep copy of `value` with every value under a sensitive key replaced by
 * {@link MASKED}. Arrays of `{Key, Value}` / `{key, value}` pairs (AWS tags,
 * some ARM shapes) are masked by the pair's key as well.
 */
export function maskValue(value: unknown, pattern = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v, `${pattern}[]`));
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const pairKey = typeof obj.Key === "string" ? obj.Key : typeof obj.key === "string" ? obj.key : undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const at = pattern ? `${pattern}.${k}` : k;
    const view = isSensitiveKey(k) ? podSecretNameView(at, v, MASKED) : undefined;
    if (view !== undefined) {
      out[k] = view;
    } else if (isSensitiveKey(k) && !isReferenceField(k, v)) {
      out[k] = MASKED;
    } else if (pairKey !== undefined && isSensitiveKey(pairKey) && (k === "Value" || k === "value")) {
      out[k] = MASKED;
    } else {
      out[k] = maskValue(v, at);
    }
  }
  return out;
}

export function maskProperties(props: Record<string, unknown>): Record<string, unknown> {
  return maskValue(props) as Record<string, unknown>;
}

export function maskTags(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) out[k] = isSensitiveKey(k) ? MASKED : v;
  return out;
}

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/**
 * The maintainer's ruling on chant#5116, as a switch. An Argo CD cluster
 * Secret (label `argocd.argoproj.io/secret-type: cluster`) keeps its `name`
 * and `server` in `data` beside `config`, which holds credentials.
 *
 * - `false` (the default): the whole payload is masked, `name` and `server`
 *   included. A live read cannot join an Application to a cluster by name or
 *   server, and `argoCluster` is never emitted.
 * - `true`: the payload stays masked key by key, and the object gains an
 *   `argoCluster: { name, server }` view with those two values decoded.
 *   `config` and every other `data` key stay masked. A `server` that carries
 *   a user name or password in its URL is left out.
 *
 * Ruled `true` by the maintainer on 2026-11-15 (#5116): a cluster's name and
 * API server address are identifiers, as in any kubeconfig, not credentials,
 * and the live read needs them to join an Application to its cluster as the
 * files read does (#5101). Tests pass the option explicitly, so they hold
 * whichever way it is set.
 */
export const EXPOSE_ARGO_CLUSTER_IDENTITY = true;

const ARGO_CLUSTER_LABEL = "argocd.argoproj.io/secret-type";

export interface MaskKubernetesOptions {
  /** Overrides {@link EXPOSE_ARGO_CLUSTER_IDENTITY}. */
  exposeArgoClusterIdentity?: boolean;
}

function isArgoClusterSecret(obj: Record<string, unknown>): boolean {
  if (obj.kind !== "Secret") return false;
  const labels = (obj.metadata as { labels?: Record<string, unknown> } | undefined)?.labels;
  return labels?.[ARGO_CLUSTER_LABEL] === "cluster";
}

/** One field of a Secret's `stringData` (plain) or `data` (base64), as text. */
function secretText(obj: Record<string, unknown>, key: string): string | undefined {
  const plain = (obj.stringData as Record<string, unknown> | undefined)?.[key];
  if (typeof plain === "string") return plain;
  const encoded = (obj.data as Record<string, unknown> | undefined)?.[key];
  if (typeof encoded !== "string") return undefined;
  return Buffer.from(encoded, "base64").toString("utf8");
}

/** The `argoCluster` view of a cluster Secret: its name and server, never `config`. */
export function argoClusterView(obj: Record<string, unknown>): { name?: string; server?: string } | undefined {
  if (!isArgoClusterSecret(obj)) return undefined;
  const view: { name?: string; server?: string } = {};
  const name = secretText(obj, "name");
  if (name && !/[\u0000-\u001f]/.test(name)) view.name = name;
  const server = secretText(obj, "server");
  if (server) {
    try {
      const url = new URL(server);
      if (!url.username && !url.password) view.server = server;
    } catch {
      // not a URL: left out
    }
  }
  return view;
}

/** A Kubernetes object, masked: key names everywhere, and a Secret's payload whole. */
export function maskKubernetesObject(obj: Record<string, unknown>, options: MaskKubernetesOptions = {}): Record<string, unknown> {
  const masked = maskProperties(obj);
  if (obj.kind === "Secret") {
    for (const field of ["data", "stringData"]) {
      const payload = masked[field];
      if (payload && typeof payload === "object") {
        masked[field] = Object.fromEntries(Object.keys(payload as object).map((k) => [k, MASKED]));
      }
    }
  }
  const metadata = masked.metadata as Record<string, unknown> | undefined;
  const annotations = metadata?.annotations as Record<string, unknown> | undefined;
  if (annotations && LAST_APPLIED in annotations && obj.kind === "Secret") {
    annotations[LAST_APPLIED] = MASKED;
  }
  if (options.exposeArgoClusterIdentity ?? EXPOSE_ARGO_CLUSTER_IDENTITY) {
    const view = argoClusterView(obj);
    if (view) masked.argoCluster = view;
  }
  return masked;
}

/**
 * What a member's node carries for the reference catalog (#5330): the values
 * a resource's inputs and outputs name other resources by. The graph read
 * used to copy neither, since an export can hold secrets; the catalog needs
 * the names, ids and ARNs, so this copies those and nothing else.
 *
 * - `inputs` keep their Pulumi shape (`vpcId`, `metadata.namespace`), minus
 *   Pulumi's own `__` keys. A secret envelope and a value under a key that
 *   reads as a credential are left out, and so are the `data`, `stringData`
 *   and `binaryData` of a Kubernetes Secret or ConfigMap.
 * - `outputs` keep the top-level strings a resource is named by elsewhere
 *   (`arn`, `name`, `selfLink`, `email`), and the resource's `id`, under one
 *   `outputs` key so an output never replaces an input of the same name.
 *
 * A string longer than {@link MAX_VALUE} is a document, not a name, and is
 * left out. Pure.
 */
import { isObject, isSecret, isUnknown } from "./values";

/** Longest string worth matching: an ARN or a self link fits, a policy document does not. */
const MAX_VALUE = 1024;

/** Keys whose values are credentials or their carriers. */
const SENSITIVE_KEY = /(password|passwd|secret|token|credential|private|apikey|accesskey|connectionstring|userdata|sasurl|certificatebody|pem|kubeconfig)/i;
/** A key that ends like a reference to a thing, which a credential-sounding word may precede (`secretArn`, `tokenName`). */
const REFERENCE_KEY = /(Arns?|Ids?|IDs?|Names?|Uris?|Urls?)$/;

/** Kubernetes kinds whose payload is data, not references. */
const DATA_KINDS = new Set(["kubernetes:core/v1:Secret", "kubernetes:core/v1:ConfigMap"]);
const DATA_KEYS = new Set(["data", "stringData", "binaryData"]);

const sensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key) && !REFERENCE_KEY.test(key);

/**
 * Whether a property named `key` may be copied to a node (#5332): not a
 * Pulumi `__` key, not credential-like, and, at the top level of a Kubernetes
 * Secret or ConfigMap, not its payload. The preview observation
 * (`./preview-observation.ts`) asks this of every path it puts on a node.
 */
export function mayCarryKey(key: string, opts: { type?: unknown; topLevel?: boolean } = {}): boolean {
  if (key.startsWith("__") || sensitiveKey(key)) return false;
  const dataKind = typeof opts.type === "string" && DATA_KINDS.has(opts.type);
  return !(dataKind && opts.topLevel && DATA_KEYS.has(key));
}

/** Whether a string is short enough to be a name rather than a document. */
export const isNameSized = (value: string): boolean => value.length <= MAX_VALUE;

function clean(value: unknown, depth: number): unknown {
  if (depth > 8 || isSecret(value) || isUnknown(value) || value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.length <= MAX_VALUE ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => clean(v, depth + 1)).filter((v) => v !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("__") || sensitiveKey(k)) continue;
      const c = clean(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** The inputs and `outputs` a resource's node carries, as the node's props. */
export function referenceProps(resource: { type?: unknown; id?: unknown; inputs?: unknown; outputs?: unknown }): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const dataKind = typeof resource.type === "string" && DATA_KINDS.has(resource.type);
  if (isObject(resource.inputs)) {
    for (const [k, v] of Object.entries(resource.inputs)) {
      if (k.startsWith("__") || sensitiveKey(k) || (dataKind && DATA_KEYS.has(k))) continue;
      const c = clean(v, 0);
      if (c !== undefined) props[k] = c;
    }
  }
  const outputs: Record<string, unknown> = {};
  if (isObject(resource.outputs) && !dataKind) {
    for (const [k, v] of Object.entries(resource.outputs)) {
      if (k.startsWith("__") || sensitiveKey(k) || typeof v !== "string" || v.length > MAX_VALUE || isSecret(v) || isUnknown(v)) continue;
      outputs[k] = v;
    }
  }
  if (typeof resource.id === "string" && resource.id !== "" && outputs.id === undefined) outputs.id = resource.id;
  if (Object.keys(outputs).length > 0) props.outputs = outputs;
  return props;
}

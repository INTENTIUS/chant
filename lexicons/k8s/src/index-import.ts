/**
 * The k8s lexicon's index import seam (#4538, on #4524's
 * `chant import --index`).
 *
 * An indexed k8s object's `attrs` are its manifest without `apiVersion` and
 * `kind` (./listed-types.ts), normalized by this lexicon's deep hooks, so
 * the import IR is what the YAML parser (./import/parser.ts) writes for the
 * same object and `K8sGenerator` turns it into source.
 *
 * What is left out of the properties:
 * - what the deep hooks prune from a live object nobody declared: the
 *   envelope (`status`, `metadata.uid`, `resourceVersion`, ...), the
 *   controllers' bookkeeping labels and annotations, chant's own ownership
 *   labels (the serializer writes them again), server-assigned fields
 *   (`spec.clusterIP`) and values equal to the API server's defaults;
 * - `metadata.deletionTimestamp` and `metadata.deletionGracePeriodSeconds`.
 *
 * `apiVersion` is kept only when the listed version is not the one the
 * lexicon writes for the kind, as the YAML parser keeps an aliased one.
 *
 * Refused, by name:
 * - an object with `metadata.ownerReferences`: its controller makes it
 *   (a Deployment's ReplicaSets and Pods), so the owner is what to import;
 * - an `Event`, and a Secret of type `kubernetes.io/service-account-token`,
 *   which the cluster writes.
 *
 * References stay literals. A k8s object names another by its name, and
 * that literal is how the lexicon spells it.
 *
 * Masked values. k8s has no template parameters, so a masked value takes
 * one of two k8s forms:
 * - a Secret whose `data` or `stringData` the index masked (all of it is:
 *   the k8s mask hook masks every value of a Secret) is written as a
 *   referenced secret, `declareSecret({ name, provenance: "referenced",
 *   scope: <namespace> })`. The Secret object stays in the cluster and the
 *   user supplies it out of band (kubectl, sops through a
 *   `committed-encrypted` declaration, an external secrets operator). Its
 *   key names and type go into the header comment. Nothing value-shaped is
 *   written;
 * - any other masked value (a key-name match such as a ConfigMap's
 *   `db.password`, or a container's `secretKeyRef`) reads an environment
 *   variable at build time: `maskedValue("<ENV_VAR>")` in the generated
 *   file, which throws when the variable is unset. The variable is the
 *   parameter's name in upper snake case (`CONFIG_MAP_APP_DATA_DB_PASSWORD`). A value that starts with `{` or
 *   `[` is parsed as JSON, for an object the index masked whole.
 */
import { MASKED } from "@intentius/chant/deep-observation";
import type { IRNode } from "@intentius/chant/graph-ir";
import type { IndexImportCodegen } from "@intentius/chant/lifecycle/index-import";
import type { ParameterIR } from "@intentius/chant/import/parser";
import { SECRET_DECLARATION_ENTITY_TYPE } from "@intentius/chant/secret-provenance";
import { k8sDeepNormalizationHooks } from "./deep-observe-hooks";
import { operationFor } from "./api/operation-surface";
import { parseListedGvk } from "./listed-types";

/** A property value standing for a masked one: the generator writes `maskedValue("<ENV_VAR>")`. */
export interface K8sMaskedValueRef {
  /** The environment variable the value is read from. */
  __k8sMaskedValue: string;
}

export function isMaskedValueRef(v: unknown): v is K8sMaskedValueRef {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).__k8sMaskedValue === "string";
}

const SECRET_KIND = "K8s::Core::Secret";
const CLUSTER_WRITTEN_KINDS: ReadonlySet<string> = new Set(["K8s::Core::Event", "K8s::Events::Event"]);
const CLUSTER_WRITTEN_SECRET_TYPES: ReadonlySet<string> = new Set(["kubernetes.io/service-account-token"]);
const DROPPED_METADATA = new Set(["deletionTimestamp", "deletionGracePeriodSeconds"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function containsMasked(v: unknown): boolean {
  if (v === MASKED) return true;
  if (Array.isArray(v)) return v.some(containsMasked);
  if (isRecord(v)) return Object.values(v).some(containsMasked);
  return false;
}

/** `tree` without what the deep hooks prune from an undeclared live object. */
function pruneLive(entityType: string, tree: unknown, path: string, pattern: string): unknown {
  if (Array.isArray(tree)) return tree.map((v, i) => pruneLive(entityType, v, `${path}[${i}]`, `${pattern}[]`));
  if (!isRecord(tree)) return tree;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(tree).sort()) {
    const value = tree[key];
    const p = path === "" ? key : `${path}.${key}`;
    const pat = pattern === "" ? key : `${pattern}.${key}`;
    if (k8sDeepNormalizationHooks.prune?.({ entityType, path: p, pattern: pat, key, value, side: "live", counterpart: "absent" })) continue;
    out[key] = pruneLive(entityType, value, p, pat);
  }
  return out;
}

/** The properties a declaration of the node's kind can hold. */
export function k8sImportProperties(node: IRNode): Record<string, unknown> {
  const props = pruneLive(node.kind, node.attrs ?? {}, "", "") as Record<string, unknown>;
  if (isRecord(props.metadata)) {
    const metadata = Object.fromEntries(Object.entries(props.metadata).filter(([k]) => !DROPPED_METADATA.has(k)));
    for (const k of ["labels", "annotations"]) {
      if (isRecord(metadata[k]) && Object.keys(metadata[k] as object).length === 0) delete metadata[k];
    }
    props.metadata = metadata;
  }
  const gvk = node.listedType ? parseListedGvk(node.listedType) : undefined;
  if (gvk) {
    const listedApiVersion = gvk.group ? `${gvk.group}/${gvk.version}` : gvk.version;
    if (operationFor(node.kind)?.apiVersion !== listedApiVersion) return { apiVersion: listedApiVersion, ...props };
  }
  return props;
}

/** The referenced-secret declaration for a Secret whose data the index masked, and the note naming what it held. */
export function k8sReferencedSecret(node: IRNode): { properties: Record<string, unknown>; note: string } {
  const attrs = node.attrs ?? {};
  const metadata = isRecord(attrs.metadata) ? attrs.metadata : {};
  const name = typeof metadata.name === "string" ? metadata.name : (node.nativeId ?? node.id).split("/").pop()!;
  const namespace = typeof metadata.namespace === "string" ? metadata.namespace : undefined;
  const keys = [
    ...new Set(["data", "stringData"].flatMap((f) => (isRecord(attrs[f]) ? Object.keys(attrs[f] as object) : []))),
  ].sort();
  const type = typeof attrs.type === "string" ? attrs.type : "Opaque";
  return {
    properties: { name, provenance: "referenced", ...(namespace ? { scope: namespace } : {}) },
    note:
      `the Secret ${namespace ? `${namespace}/` : ""}${name} (type ${type}, keys ${keys.join(", ") || "none"}) was masked in the index, ` +
      `so it is declared as a referenced secret: supply it out of band`,
  };
}

/** The environment variable a masked value is read from: the parameter name in upper snake case. */
export function maskedValueEnvVar(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

export function createK8sIndexImport(): IndexImportCodegen {
  return {
    resource(node: IRNode) {
      if (!node.kind.startsWith("K8s::") || node.kind.split("::").length !== 3) {
        return { unsupported: `${node.kind} is not a Kubernetes kind of the k8s lexicon` };
      }
      if (CLUSTER_WRITTEN_KINDS.has(node.kind)) return { unsupported: `${node.kind} objects are written by the cluster` };
      const attrs = node.attrs ?? {};
      const metadata = isRecord(attrs.metadata) ? attrs.metadata : {};
      const owners = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences.filter(isRecord) : [];
      if (owners.length > 0) {
        const named = owners.map((o) => `${String(o.kind ?? "?")}/${String(o.name ?? "?")}`).join(", ");
        return { unsupported: `owned by ${named} (metadata.ownerReferences): its controller makes this object, so import the owner` };
      }
      if (node.kind === SECRET_KIND) {
        if (typeof attrs.type === "string" && CLUSTER_WRITTEN_SECRET_TYPES.has(attrs.type)) {
          return { unsupported: `a Secret of type ${attrs.type} is written by the cluster` };
        }
        if (containsMasked(attrs.data) || containsMasked(attrs.stringData)) {
          const { properties, note } = k8sReferencedSecret(node);
          return { type: SECRET_DECLARATION_ENTITY_TYPE, properties, notes: [note] };
        }
      }
      return { type: node.kind, properties: k8sImportProperties(node) };
    },
    // A k8s object names another by name; the literal is the lexicon's spelling.
    reference: () => undefined,
    secretParameter(name, context): ParameterIR {
      return {
        name,
        type: "String",
        description: `${context.path} of ${context.node.id}, masked in the index; set ${maskedValueEnvVar(name)} before building`,
        required: true,
      };
    },
    parameterReference: (name): K8sMaskedValueRef => ({ __k8sMaskedValue: maskedValueEnvVar(name) }),
    typeLabel: (node) => node.kind.split("::").pop() ?? "Resource",
  };
}

export const k8sIndexImport: IndexImportCodegen = createK8sIndexImport();
